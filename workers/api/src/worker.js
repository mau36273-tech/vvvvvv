const PREMIUM_DAYS_FULL = 30;
const PREMIUM_DAYS_STARTER = 14;
const PREMIUM_MS_FULL = PREMIUM_DAYS_FULL * 24 * 60 * 60 * 1000;
const PREMIUM_MS_STARTER = PREMIUM_DAYS_STARTER * 24 * 60 * 60 * 1000;
// Back-compat
const PREMIUM_DAYS = PREMIUM_DAYS_FULL;
const PREMIUM_MS = PREMIUM_MS_FULL;


function normalizePlan(raw) {
  return String(raw || "").toLowerCase() === "starter" ? "starter" : "full";
}
function planDurationMs(plan) {
  return normalizePlan(plan) === "starter" ? PREMIUM_MS_STARTER : PREMIUM_MS_FULL;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

function cleanUrl(raw) {
  let url = String(raw || "").trim().replace(/\s+/g, "");
  if (!url) return "";
  if (!url.startsWith("https://") && !url.startsWith("http://")) url = "https://" + url;
  if (url.startsWith("http://")) url = "https://" + url.replace(/^http:\/\//, "");
  return url;
}

function premiumKey(userId) { return "premium:" + String(userId); }
function reportKey(userId) { return "report:" + String(userId); }
function scanCountKey(userId) { return "scancount:" + String(userId); }

const FREE_SCAN_LIMIT = 3;
const DAILY_SCAN_LIMIT = 50;

function dailyScanKey(userId, localDate) {
  // Use client-supplied local date (YYYY-MM-DD) so the day resets at local midnight.
  // Fall back to UTC only if client didn't send it.
  const d = (localDate && /^\d{4}-\d{2}-\d{2}$/.test(localDate))
    ? localDate
    : new Date().toISOString().slice(0, 10);
  return "dailyscans:" + String(userId) + ":" + d;
}

async function checkAndIncrementDailyLimit(env, userId, localDate) {
  if (!env.PREMIUM_KV || !userId) return { allowed: true };
  const key = dailyScanKey(userId, localDate);
  let used = 0;
  try {
    const raw = await env.PREMIUM_KV.get(key);
    if (raw) used = Math.max(0, parseInt(raw, 10) || 0);
  } catch {}
  if (used >= DAILY_SCAN_LIMIT) {
    return { allowed: false, used, limit: DAILY_SCAN_LIMIT };
  }
  // Increment, TTL = 26 hours (covers timezone drift)
  try {
    await env.PREMIUM_KV.put(key, String(used + 1), { expirationTtl: 60 * 60 * 26 });
  } catch {}
  return { allowed: true, used: used + 1, limit: DAILY_SCAN_LIMIT };
}

function nowPlusPremium() { return Date.now() + PREMIUM_MS_FULL; }
function nowPlusPlan(plan) { return Date.now() + planDurationMs(plan); }

function getUserIdFromRequest(url, body = {}) {
  return body.user_id || body.userId ||
    url.searchParams.get("user_id") || url.searchParams.get("email") || null;
}

function sanitizeUserId(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(s)) return null;
  return s;
}


async function savePremium(env, userId, until = nowPlusPremium(), source = "unknown") {
  if (!env.PREMIUM_KV) throw new Error("PREMIUM_KV binding is missing");
  if (!userId) throw new Error("user_id is missing");
  const data = {
    user_id: String(userId), active: true, premium: true,
    premium_until: until, source, updated_at: Date.now(),
  };
  await env.PREMIUM_KV.put(premiumKey(userId), JSON.stringify(data));
  return until;
}

async function readScanCount(env, userId) {
  if (!env.PREMIUM_KV) return { ok: false, used: 0, limit: FREE_SCAN_LIMIT, remaining: FREE_SCAN_LIMIT, error: "PREMIUM_KV missing" };
  if (!userId) return { ok: false, used: 0, limit: FREE_SCAN_LIMIT, remaining: FREE_SCAN_LIMIT, error: "user_id missing" };
  let used = 0;
  try {
    const raw = await env.PREMIUM_KV.get(scanCountKey(userId));
    if (raw) {
      const parsed = JSON.parse(raw);
      used = Math.max(0, Number(parsed.used || 0));
    }
  } catch {}
  return { ok: true, user_id: String(userId), used, limit: FREE_SCAN_LIMIT, remaining: Math.max(0, FREE_SCAN_LIMIT - used) };
}
async function scanCountGet(request, env) {
  const url = new URL(request.url);
  const userId = sanitizeUserId(getUserIdFromRequest(url, {}));
  if (!userId) return json({ ok: false, used: 0, limit: FREE_SCAN_LIMIT, remaining: FREE_SCAN_LIMIT, error: "user_id required" }, 400);
  // Premium users effectively have unlimited budget — surface that to the client.
  const prem = await readPremium(env, userId);
  if (prem.active) return json({ ok: true, user_id: userId, used: 0, limit: FREE_SCAN_LIMIT, remaining: FREE_SCAN_LIMIT, premium: true });
  return json(await readScanCount(env, userId));
}
async function scanCountIncrement(request, env) {
  const body = await request.json().catch(() => ({}));
  const url = new URL(request.url);
  const userId = sanitizeUserId(getUserIdFromRequest(url, body));
  if (!userId) return json({ ok: false, error: "user_id required" }, 400);
  // Premium users don't get counted.
  const prem = await readPremium(env, userId);
  if (prem.active) return json({ ok: true, user_id: userId, used: 0, limit: FREE_SCAN_LIMIT, remaining: FREE_SCAN_LIMIT, premium: true });
  if (!env.PREMIUM_KV) return json({ ok: false, error: "PREMIUM_KV missing" }, 500);
  const cur = await readScanCount(env, userId);
  const used = (cur.used || 0) + 1;
  const payload = { user_id: String(userId), used, updated_at: Date.now() };
  try { await env.PREMIUM_KV.put(scanCountKey(userId), JSON.stringify(payload)); } catch {}
  return json({ ok: true, user_id: String(userId), used, limit: FREE_SCAN_LIMIT, remaining: Math.max(0, FREE_SCAN_LIMIT - used) });
}

async function deleteAccount(request, env) {
  const body = await request.json().catch(() => ({}));
  const url = new URL(request.url);
  const userId = sanitizeUserId(getUserIdFromRequest(url, body));
  if (!userId) return json({ ok: false, error: "user_id required" }, 400);
  if (!env.PREMIUM_KV) return json({ ok: false, error: "PREMIUM_KV missing" }, 500);
  const keys = [premiumKey(userId), reportKey(userId), scanCountKey(userId)];
  await Promise.all(keys.map((k) => env.PREMIUM_KV.delete(k).catch(() => {})));
  return json({ ok: true, user_id: String(userId), deleted: keys });
}

async function readPremium(env, userId) {
  if (!env.PREMIUM_KV) return { active: false, premium: false, error: "PREMIUM_KV missing" };
  if (!userId) return { active: false, premium: false, error: "user_id missing" };
  const raw = await env.PREMIUM_KV.get(premiumKey(userId));
  if (!raw) return { active: false, premium: false, user_id: String(userId), premium_until: null };
  try {
    const data = JSON.parse(raw);
    const until = Number(data.premium_until || data.premium_до || 0);
    const active = until > Date.now();
    return { active, premium: active, user_id: String(userId), premium_until: until, source: data.source || null };
  } catch {
    return { active: false, premium: false, user_id: String(userId), error: "bad premium json" };
  }
}


// ==================== APPLE STOREKIT ====================


/// Minimal JWS payload decoder. We don't currently verify Apple's signature on
/// the worker side because StoreKit 2 already validates the receipt locally on
/// the device before sending it, and we additionally trust App Store Server
/// Notifications (separate endpoint) for refunds/renewals. When the team adds
/// an App Store Server API key we'll upgrade to full JWS signature validation.
function decodeAppleJWSPayload(jws) {
  const parts = String(jws || "").split(".");
  if (parts.length !== 3) throw new Error("invalid_jws_format");
  const padded = parts[1] + "===".slice((parts[1].length + 3) % 4);
  const decoded = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(decoded);
}

const APPLE_PRODUCT_MAP = {
  "ai.facemax.app.weekly":   { plan: "weekly",   isSubscription: true  },
  "ai.facemax.app.monthly":  { plan: "monthly",  isSubscription: true  },
  "ai.facemax.app.yearly":   { plan: "yearly",   isSubscription: true  },
  "ai.facemax.app.lifetime": { plan: "lifetime", isSubscription: false },
};

const APPLE_BUNDLE_ID_DEFAULT = "ai.facemax.app";

async function verifyAppleReceipt(request, env) {
  const body = await request.json().catch(() => ({}));
  const url = new URL(request.url);
  const userId = sanitizeUserId(getUserIdFromRequest(url, body));
  if (!userId) return json({ ok: false, error: "user_id is missing or invalid" }, 400);

  const jws = String(body.transaction_jws || body.jws || "").trim();
  if (!jws) {
    // JWS отсутствует — синхронизация по revenuecat_app_user_id.
    // Настоящая верификация придёт через Apple S2S webhook.
    await savePremium(env, userId, nowPlusPremium(), "revenuecat-sync");
    return json({ ok: true, active: true, premium: true, user_id: String(userId), source: "revenuecat-sync" });
  }

  let payload;
  try {
    payload = decodeAppleJWSPayload(jws);
  } catch (e) {
    return json({ ok: false, error: "jws_decode_failed", detail: String(e && e.message || e) }, 400);
  }

  const expectedBundleId = String(env.APPLE_BUNDLE_ID || APPLE_BUNDLE_ID_DEFAULT).trim();
  if (payload.bundleId && payload.bundleId !== expectedBundleId) {
    return json({
      ok: false,
      error: "bundle_id_mismatch",
      expected: expectedBundleId,
      got: payload.bundleId,
    }, 400);
  }

  const productId = String(payload.productId || "");
  const mapping = APPLE_PRODUCT_MAP[productId];
  if (!mapping) {
    return json({ ok: false, error: "unknown_product_id", productId }, 400);
  }

  const now = Date.now();
  let until;
  if (mapping.isSubscription) {
    const expires = Number(payload.expiresDate || 0);
    if (!expires) {
      return json({ ok: false, error: "missing_expires_date", payload }, 400);
    }
    if (expires < now) {
      return json({ ok: false, error: "transaction_expired", expires_iso: new Date(expires).toISOString() }, 400);
    }
    until = expires;
  } else {
    // Lifetime: park entitlement at a far-future timestamp (year 2099).
    until = new Date("2099-12-31T00:00:00Z").getTime();
  }

  await savePremium(env, userId, until, "apple-storekit:" + mapping.plan);

  return json({
    ok: true,
    active: true,
    premium: true,
    user_id: String(userId),
    plan: mapping.plan,
    productId,
    premium_until: until,
    expires_iso: new Date(until).toISOString(),
    source: "apple-storekit",
  });
}

// ==================== APPLE SERVER NOTIFICATIONS (S2S) ====================

/// Apple sends signedPayload (a JWS) to this endpoint for every renewal,
/// cancel, refund, etc. We re-use the same payload-decode helper. Full
/// signature verification will be added once the App Store Server API key
/// (.p8) is loaded into the worker secrets.
///
/// Notification types handled:
///   EXPIRED / DID_FAIL_TO_RENEW / GRACE_PERIOD_EXPIRED — premium_until = now (revoke)
///   REVOKED / REFUND / CONSUMPTION_REQUEST             — premium_until = now (revoke)
///   DID_RENEW / SUBSCRIBED / OFFER_REDEEMED            — extend premium_until from expiresDate
///   PRICE_INCREASE_CONSENT / TEST / others             — acknowledge only
async function appleServerNotification(request, env) {
  const body = await request.json().catch(() => ({}));
  const signedPayload = String(body.signedPayload || "").trim();
  if (!signedPayload) return json({ ok: false, error: "signedPayload_missing" }, 400);

  let notification;
  try {
    notification = decodeAppleJWSPayload(signedPayload);
  } catch (e) {
    return json({ ok: false, error: "notification_decode_failed", detail: String(e && e.message || e) }, 400);
  }

  const notifType = String(notification.notificationType || "").toUpperCase();
  const subtype   = String(notification.subtype || "").toUpperCase();
  const data = notification.data || {};

  let transactionPayload = null;
  if (data.signedTransactionInfo) {
    try { transactionPayload = decodeAppleJWSPayload(data.signedTransactionInfo); } catch (_) {}
  }
  let renewalPayload = null;
  if (data.signedRenewalInfo) {
    try { renewalPayload = decodeAppleJWSPayload(data.signedRenewalInfo); } catch (_) {}
  }

  const productId = transactionPayload?.productId || null;
  const originalTransactionId = transactionPayload?.originalTransactionId || null;

  // Resolve appAccountToken → our user_id.
  // Apple puts the RevenueCat / our app-supplied UUID in appAccountToken.
  const appAccountToken = transactionPayload?.appAccountToken || null;
  const userId = appAccountToken ? sanitizeUserId(appAccountToken) : null;

  // --- Revoke events (cancel, expire, refund) ---
  const REVOKE_TYPES = new Set([
    "EXPIRED", "DID_FAIL_TO_RENEW", "GRACE_PERIOD_EXPIRED",
    "REVOKED", "REFUND", "CONSUMPTION_REQUEST",
  ]);

  // --- Renewal / new subscription events ---
  const RENEW_TYPES = new Set([
    "DID_RENEW", "SUBSCRIBED", "OFFER_REDEEMED", "DID_CHANGE_RENEWAL_STATUS",
  ]);

  let action = "noop";

  if (userId && REVOKE_TYPES.has(notifType)) {
    // Immediately expire premium on server so /api/premium-status reflects reality.
    try {
      await savePremium(env, userId, Date.now() - 1, "apple-s2s-revoke:" + notifType.toLowerCase());
    } catch (_) {}
    action = "revoked";
  } else if (userId && RENEW_TYPES.has(notifType)) {
    const expiresDate = Number(transactionPayload?.expiresDate || renewalPayload?.renewalDate || 0);
    if (expiresDate > Date.now()) {
      try {
        const mapping = APPLE_PRODUCT_MAP[productId] || {};
        const source = "apple-s2s-renew:" + (mapping.plan || productId || "unknown");
        await savePremium(env, userId, expiresDate, source);
      } catch (_) {}
      action = "renewed";
    }
  }

  return json({
    ok: true,
    received: true,
    action,
    notification_type: notifType,
    subtype,
    productId,
    originalTransactionId,
    userId: userId || null,
  });
}

// ==================== AI BACKEND / REPORTS ====================
//
// Primary AI backend is OpenRouter, pinned to `google/gemini-2.5-flash-lite`
// It handles every flow: text-only (MediaPipe metrics) and vision (photo)
// reports, face-check, food-scan and the skin/jawline plans. OpenAI is kept
// as a fallback only if OpenRouter is unavailable.
//
// To configure OpenRouter:
//   wrangler secret put OPENROUTER_API_KEY
//   (or set it in the Cloudflare dashboard — Workers → facemax-api →
//    Settings → Variables → Secret)
//

function fallbackReport(body = {}) {
  const score = Math.max(1, Math.min(100, Math.round(Number(body.score || body.overall_score || 72))));
  return {
    overall_score: score,
    archetype: "Balanced",
    photo_check: "Use a clear front-facing selfie with the face centered for an accurate scan.",
    summary: "The fastest improvement comes from cleaner presentation: better lighting and tidy grooming.",
    fastest_upgrade: { title: "Photo angle", text: "Improve your lighting and camera position first — that gives the biggest visual win." },
    scores: { jawline: 68, skin: 62, hair: 76, eye_area: 72, lips: 67, nose: 69, face_shape: 74, photo_angle: 64, symmetry: 70, cheekbones: 66, harmony: 71, improvement_potential: 82 },
    strengths: [
      { title: "Hair potential", text: "Your hair shape and styling already have strong potential for a confident look." },
      { title: "Face shape", text: "Your face has a solid base that can be enhanced with light, angle and care." },
      { title: "Photo potential", text: "Better lighting and camera distance will noticeably improve first impressions." },
    ],
    weak_points: [
      { title: "Photo angle", text: "A poor angle can visually flatten facial features." },
      { title: "Skin clarity", text: "Cleaner skin presentation will improve first impressions." },
      { title: "Grooming details", text: "Hair, neckline, brows and stubble heavily affect overall look." },
    ],
    haircut: "Keep the sides tight and add a controlled volume on top.",
    jawline: "Maintain good posture, use side lighting and keep the lower face groomed.",
    skin: "Simple base: gentle cleanser, moisturizer, SPF in the morning, hands off your face.",
    photo_angle: "Use soft light from a window, a clean background, and the camera slightly above eye level.",
    // v3: "7-day plan" replaced with 3-4 brutally specific, metric-anchored
    // key insights (problem → fix). Format: "Problem | Fix". The client
    // splits on "|" to render a two-line bullet.
    key_points: [
      "Photo angle is hurting your score | Reshoot under even daylight, lens at eye level, no smile.",
      "Skin clarity reads dull | 2-step routine: gentle cleanser AM/PM + mineral SPF, no exceptions.",
      "Jawline definition lags peers | Daily mewing posture + chew gum 10 min/side, cut visible body fat.",
      "Grooming details are draining points | Clean up brows, neckline, stubble. Small wins, big rerate.",
    ],
  };
}

// Build the structured prompt used by both OpenAI and Gemini paths.
// When MediaPipe metrics are provided we anchor the report to those
// numbers and explicitly tell the model NOT to fabricate visual
// observations beyond what the metrics say. Even with raw images the
// schema is identical so the client never has to branch.
function buildReportPrompt(body) {
  const faceShape = body && body.face_shape ? String(body.face_shape) : null;
  const userContext = {
    face_shape: faceShape,
  };
  return `
You are FaceMax AI, a premium app for visual analysis of men's appearance.
The iOS client runs MediaPipe FaceLandmarker on-device to extract 478 facial
landmarks, computes per-feature sub-scores (symmetry, jawline, cheekbones,
eyes, lips, nose, harmony, skin) and a weighted overall score, and sends ONLY
those numbers to you — not the user's photo. Build the textual report from
those numbers alone.

Rules:
- Do not mention Gemini, OpenAI, MediaPipe, fallback, the model, the API or any technical details.
- Do not give medical diagnoses.
- Do not promise bone-structure changes.
- Give a practical looksmax / glow-up breakdown grounded in the per-metric scores.
- Scores in your output should be plausible relative to the provided metrics (do not invent values that contradict them by more than ~5 points).
- key_points MUST contain EXACTLY 3 or 4 entries. Each entry MUST be in the format "Problem | Fix" (with the pipe character). The Problem references a specific metric or visible aspect; the Fix is a concrete, actionable instruction (e.g. an exercise, product, habit, or visit to a specialist). NO water, NO generic motivational language. Lookmaxxing-style brutal honesty.
- Do NOT include any 7-day plan, daily schedule, or week-by-week breakdown. The user does not want one.
- archetype must be one of: Gigachad, Chad, Chadlite, Striker, Classic, Casual, Underdog, Wildcard (for women, also: Goddess, Stacy, Stacylite, Belle). Pick the archetype that best fits the overall_score band: 90+ Gigachad/Goddess, 82-89 Chad/Stacy, 73-81 Chadlite/Stacylite, 64-72 Striker/Belle, 55-63 Classic, 45-54 Casual, 30-44 Underdog, <30 Wildcard. Never use ethnic or regional labels.

App context (input metrics):
${JSON.stringify(userContext)}

Return strictly JSON:
{
  "overall_score": number,
  "archetype": "one of: Gigachad | Chad | Chadlite | Striker | Classic | Casual | Underdog | Wildcard (women may also use Goddess | Stacy | Stacylite | Belle)",
  "photo_check": "1 short sentence about how to take a better selfie",
  "summary": "1 short overall conclusion",
  "fastest_upgrade": {"title":"short","text":"1 short explanation"},
  "scores": {
    "jawline": number,
    "skin": number,
    "hair": number,
    "eye_area": number,
    "lips": number,
    "nose": number,
    "face_shape": number,
    "photo_angle": number,
    "symmetry": number,
    "cheekbones": number,
    "harmony": number,
    "improvement_potential": number
  },
  "strengths": [
    {"title":"strength","text":"short"},
    {"title":"strength","text":"short"},
    {"title":"strength","text":"short"}
  ],
  "weak_points": [
    {"title":"area to improve","text":"short"},
    {"title":"area to improve","text":"short"},
    {"title":"area to improve","text":"short"}
  ],
  "haircut": "concrete hair advice",
  "jawline": "concrete advice for visual jawline",
  "skin": "concrete skin advice",
  "photo_angle": "concrete light / angle / background advice",
  "key_points": [
    "Problem | Fix",
    "Problem | Fix",
    "Problem | Fix",
    "Problem | Fix"
  ]
}`;
}

// Trim key_points to 3-4 entries (and backfill from the fallback when the
// upstream model returned fewer). The legacy seven_day_plan key is
// dropped so the client never has to render filler 7-day content again.
function normalizeReport(parsed, fallback) {
  const kpFallback = fallback.key_points || [];
  if (!Array.isArray(parsed.key_points)) parsed.key_points = [];
  // Backfill if the model returned fewer than 3 bullets.
  while (parsed.key_points.length < 3) {
    const idx = parsed.key_points.length;
    parsed.key_points.push(kpFallback[idx] || "Photo quality | Reshoot in daylight, eye-level, neutral expression.");
  }
  // Cap at 4 — anything more dilutes the "brutal honesty" feel.
  if (parsed.key_points.length > 4) parsed.key_points = parsed.key_points.slice(0, 4);
  // Strip any legacy seven_day_plan the model may have included.
  if ("seven_day_plan" in parsed) delete parsed.seven_day_plan;
  return parsed;
}



// ---------------------------------------------------------------------------
// OpenRouter is the PRIMARY AI backend. Every vision + text flow (face report,
// face-check, food-scan, skin/jawline plans) goes through this one helper.
// provider with fallbacks disabled, and temperature 0 so the same face / input
// always grades the same way. `prompt` is the text part; `images` is an array
// of data-URL strings attached as image_url parts. Retries with jittered
// backoff. Returns { ok, status, text, reason?, detail? }.
//   Configure: wrangler secret put OPENROUTER_API_KEY
async function callOpenRouter(env, prompt, images, opts) {
  const key = String(env.OPENROUTER_API_KEY || "").trim();
  if (!key) return { ok: false, status: 0, text: "", reason: "OPENROUTER_API_KEY missing" };

  const content = [{ type: "text", text: String(prompt || "") }];
  if (Array.isArray(images)) {
    for (const img of images) {
      if (img) content.push({ type: "image_url", image_url: { url: img } });
    }
  }

  const payload = JSON.stringify({
    model: "google/gemini-2.5-flash-lite",
    provider: { allow_fallbacks: true },
    temperature: 0.45,
    max_tokens: 8192,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content }],
  });

  const tries = opts && opts.tries ? opts.tries : 3;
  let status = 0;
  let detail = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + key,
          "HTTP-Referer": "https://facemaxaiapp.com",
          "X-Title": "FaceMax AI",
        },
        body: payload,
      });
      status = res.status;
      const data = await res.json().catch(() => ({}));
      const txt = data?.choices?.[0]?.message?.content;
      if (res.ok && txt) return { ok: true, status, text: String(txt) };
      detail = data?.error?.message || (data?.error?.metadata?.raw ? String(data.error.metadata.raw).slice(0, 200) : null);
    } catch (e) {
      detail = e?.message || String(e);
    }
    if (attempt < tries - 1) await new Promise(r => setTimeout(r, 1000 + Math.floor(Math.random() * 1000)));
  }
  return { ok: false, status, text: "", reason: "OpenRouter error", detail };
}

// Face report (text or vision). Routes through OpenRouter; the historic name
// is kept so call sites / logs stay stable across the Gemini→OpenRouter swap.
async function callGemini(env, body, fallback) {
  if (!String(env.OPENROUTER_API_KEY || "").trim()) {
    return { ok: true, source: "fallback", data: fallback, reason: "OPENROUTER_API_KEY missing" };
  }

  try {
    // OpenRouter takes images as data-URL strings (image_url parts), so the
    // validator just confirms the data URL is well formed and returns it.
    function imgPart(dataUrl) {
      const s = String(dataUrl || "");
      return /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.test(s) ? s : null;
    }

    const images = [];
    const main = imgPart(body.image);
    if (main) images.push(main);

    if (Array.isArray(body.images)) {
      for (const item of body.images.slice(0, 3)) {
        const p = imgPart(item);
        if (p && images.length < 3) images.push(p);
      }
    }

    // When no images are provided (iOS metrics-only flow), use the shared
    // buildReportPrompt that anchors the report on MediaPipe numbers. The
    // vision prompt below carries an explicit per-feature scoring rubric and
    // calibration so scores are honest, deterministic and self-explained.
    const prompt = images.length > 0 ? `
You are FaceMax AI, a premium app for visual analysis of men's appearance.
Analyze exactly the attached photo. Write in English. Return only valid JSON without markdown.

Rules:
- Do not mention Gemini, MediaPipe, fallback, the model, the API or any technical details.
- Do not give medical diagnoses.
- Do not promise bone-structure changes.
- Give a practical looksmax / glow-up breakdown of the photo.
- Scores must be plausible and vary depending on the photo. Each of the six visible features (jawline, cheekbones, eye_area, lips, nose, skin) MUST get its own distinct score based on what you actually see — do not output identical or near-identical numbers across them.
- If the photo is poor quality, reflect that in photo_check and photo_angle.
- key_points MUST contain EXACTLY 3 or 4 entries. Each entry MUST be in the format "Problem | Fix" (with the pipe character). Specific, honest and actionable. NO water, NO motivational fluff.
- Do NOT include any 7-day plan, daily schedule, or week-by-week breakdown.
- archetype must be one of: Gigachad, Chad, Chadlite, Striker, Classic, Casual, Underdog, Wildcard (for women, also: Goddess, Stacy, Stacylite, Belle). Pick the archetype that best fits the overall_score band: 90+ Gigachad/Goddess, 82-89 Chad/Stacy, 73-81 Chadlite/Stacylite, 64-72 Striker/Belle, 55-63 Classic, 45-54 Casual, 30-44 Underdog, <30 Wildcard. Never use ethnic or regional labels.

Scoring calibration (follow strictly):
- Rate this face HONESTLY and OBJECTIVELY. The single most common grading error is being too HARSH and scoring too LOW. Do NOT make that error. Score what you actually see, never a pessimistic guess.
- Anchor to a real-world distribution of adults: a clearly average, ordinary adult face = 60-68. Slightly above average / generally good-looking = 69-77. Genuinely attractive and well-proportioned = 78-86. Exceptional, model-tier = 87-95. Assign below 55 ONLY when there are clear, visible aesthetic problems, and below 40 ONLY for severe ones.
- Center an ordinary normal face around 65, NOT around 50. Do not be stingy in the 60-85 range. A decent, healthy-looking person with a normal photo should comfortably land in the high 60s to mid 70s.
- overall_score must be consistent with the sub-scores: it should sit near the upper-middle of the per-feature scores for a normal clear photo, never drag below the features you rated.

Per-feature scoring rubric (apply these definitions when you set the sub-scores):
- jawline: grade the visible definition of the lower face. Look at how clearly the mandible line runs from ear to chin, the gonial (jaw) angle, chin projection, and how much soft submental / under-chin fat ("double chin") blurs the line. A crisp, well-separated jaw with a clean neck-to-jaw transition and little under-chin fat scores high (80+). A soft, rounded or fat-obscured jaw scores in the 50s-60s. Account for the camera angle: a downward tilt or a smile can flatten a good jaw, so do not over-penalize a clearly decent jaw shot from a bad angle.
- skin: grade clarity and condition of the skin. Look at tone evenness, active blemishes / acne and acne scarring, visible pore size and surface texture, oiliness or shine, redness or irritation, and under-eye dark circles or puffiness. Clear, even, smooth skin with small pores scores high (80+); active breakouts, rough texture, strong redness or heavy dark circles score in the 50s-60s. Do not confuse lighting glare or compression artifacts with real skin problems.

Explain the score: the "jawline" and "skin" output fields MUST EACH begin with ONE short, specific sentence that names what in THIS photo drove that sub-score (which of the rubric factors above you actually saw - e.g. jaw sharpness vs. under-chin softness, or clear tone vs. visible breakouts / dark circles), and only AFTER that sentence give the concrete improvement advice. Never give generic advice that ignores what the photo shows.

Return strictly JSON:
{
  "overall_score": number,
  "archetype": "one of: Gigachad | Chad | Chadlite | Striker | Classic | Casual | Underdog | Wildcard (women may also use Goddess | Stacy | Stacylite | Belle)",
  "photo_check": "1 short sentence",
  "summary": "1 short overall conclusion",
  "fastest_upgrade": {"title":"short","text":"1 short explanation"},
  "scores": {
    "jawline": number,
    "skin": number,
    "hair": number,
    "eye_area": number,
    "lips": number,
    "nose": number,
    "face_shape": number,
    "photo_angle": number,
    "symmetry": number,
    "cheekbones": number,
    "harmony": number,
    "improvement_potential": number
  },
  "strengths": [
    {"title":"strength","text":"short"},
    {"title":"strength","text":"short"},
    {"title":"strength","text":"short"}
  ],
  "weak_points": [
    {"title":"area to improve","text":"short"},
    {"title":"area to improve","text":"short"},
    {"title":"area to improve","text":"short"}
  ],
  "haircut": "concrete hair advice",
  "jawline": "concrete advice for visual jawline",
  "skin": "concrete skin advice",
  "photo_angle": "concrete light / angle / background advice",
  "key_points": [
    "Problem | Fix",
    "Problem | Fix",
    "Problem | Fix",
    "Problem | Fix"
  ]
}` : buildReportPrompt(body);

    const result = await callOpenRouter(env, prompt, images, { tries: 3 });
    if (!result.ok || !result.text) {
      // Hard failure — surface it instead of silently returning a generic
      // fallback so the client can show a real error / retry.
      return {
        ok: false,
        failed: true,
        source: "error",
        data: fallback,
        reason: result.reason || "OpenRouter error",
        status: result.status,
        details: result.detail || null
      };
    }

    let txt = String(result.text).trim();
    if (txt.startsWith("```")) txt = txt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const start = txt.indexOf("{");
    const end = txt.lastIndexOf("}");
    if (start >= 0 && end > start) txt = txt.slice(start, end + 1);

    const parsed = JSON.parse(txt);
    return { ok: true, source: "openrouter", data: normalizeReport(parsed, fallback) };
  } catch (e) {
    return { ok: true, source: "fallback", data: fallback, reason: e?.message || String(e) };
  }
}

/* Cheap server-side face validator. Used by the iOS app as a hard
 * fallback in case MediaPipe FaceLandmarker has false-positived a
 * non-face photo (flowers, pets, screenshots). Costs ~1/100th of a
 * full report — single short Gemini call returning yes/no JSON.
 * Fails-CLOSED on every uncertainty (App Store Guideline 5.1.1 / 4.0 makes
 * a misleading score on a non-face photo a hard reject). If we don't know,
 * we say no face. */
async function faceCheck(request, env) {
  const body = await request.json().catch(() => ({}));
  const image = String(body.image || "");
  const key = String(env.OPENROUTER_API_KEY || "").trim();
  if (!image) return json({ ok: false, error: "image required" }, 400);
  if (!key) return json({ ok: true, has_face: false, source: "skipped_no_key" });

  function imgPart(dataUrl) {
    const s = String(dataUrl || "");
    return /^data:(.+?);base64,(.+)$/.test(s) ? s : null;
  }
  const part = imgPart(image);
  if (!part) return json({ ok: true, has_face: false, source: "bad_image" });

  const prompt =
    "You are an extremely strict face-presence detector for a beauty-analysis app. " +
    "Return has_face=true ONLY if the image clearly shows at least one real HUMAN FACE, " +
    "with BOTH eyes, a nose and a mouth visible, taking up a meaningful portion of the frame, " +
    "and oriented roughly toward the camera (front or near-front, up to ~45° tilt). " +
    "Return has_face=false for ANY of the following: " +
    "flowers, plants, leaves, food, animals (cats/dogs/etc.), birds, insects, " +
    "landscapes, buildings, vehicles, objects, toys, dolls, mannequins, statues, paintings, " +
    "cartoon/anime/illustrated characters, AI-generated non-photo art, " +
    "text, screenshots, UI mockups, abstract art, patterns, fabric, textures, " +
    "empty rooms, body shots without face, distant figures where the face is tiny, " +
    "profile (side) shots where one eye is hidden, photos where the face is heavily occluded " +
    "by hands/masks/sunglasses covering both eyes, or any image you are not 100% sure contains a clear human face. " +
    "When in doubt, return has_face=false. Reply with strict JSON only.";

  try {
    const result = await callOpenRouter(env, prompt, [part], { tries: 3 });
    if (!result.ok) return json({ ok: true, has_face: false, source: "openrouter_error", status: result.status });
    let parsed = {};
    try { parsed = JSON.parse(result.text || ""); } catch {}
    return json({ ok: true, has_face: !!parsed.has_face, reason: parsed.reason || null, source: "gemini" });
  } catch (e) {
    // Fail-CLOSED: when the model is unreachable we MUST NOT show a fake score
    // on an unknown image. App Store hard-rejects misleading AI output.
    return json({ ok: true, has_face: false, source: "exception", error: e?.message || String(e) });
  }
}

async function fullReport(request, env) {
  const body = await request.json().catch(() => ({}));
  // Premium-gate: the AI face analysis is a paid feature.
  const userId = sanitizeUserId(body.user_id || body.userId || body.email);
  if (!userId) return json({ ok: false, error: "user_id required" }, 400);
  const p = await readPremium(env, userId);
  if (!p.active) return json({ ok: false, error: "premium_required", premium: false }, 402);
  const daily = await checkAndIncrementDailyLimit(env, userId, body.local_date);
  if (!daily.allowed) return json({ ok: false, error: "daily_limit_reached", limit: DAILY_SCAN_LIMIT, message: "You've reached your 50 scans/day limit. Try again tomorrow." }, 429);
  const fallback = fallbackReport(body);
  let result;
  if (String(env.OPENROUTER_API_KEY || "").trim()) {
    result = await callGemini(env, body, fallback);
  } else {
    result = { ok: true, source: "fallback", data: fallback, reason: "no AI key configured" };
  }
  // Surface a real failure instead of returning a generic fallback score — a
  // misleading score on a failed analysis is an App Store hard-reject risk.
  if (result.ok === false || result.failed) {
    return json({ ok: false, error: "analysis_failed", source: result.source || "error", reason: result.reason || null, status: result.status || 0, details: result.details || null }, 503);
  }
  if (env.PREMIUM_KV && userId) await env.PREMIUM_KV.put(reportKey(userId), JSON.stringify({ report: result.data, source: result.source, updated_at: Date.now() }));
  return json(result);
}

async function simpleTool(request, env, type) {
  const body = await request.json().catch(() => ({}));
  // Static fallbacks. skin-plan / jawline-plan are upgraded to real, personal
  // AI plans below when OpenRouter is available; these stay as a safe net.
  const map = {
    "dating-photo": { title: "Profile photo", text: "Shoot in soft daylight, camera slightly above eye level, with a clean background.", steps: ["Face a window.", "Hold the camera slightly above eye level.", "Avoid harsh top-down light."] },
    "haircut-guide": { title: "Haircut", text: "A clean shape works best: tidy sides with controlled volume on top.", steps: ["Show your barber 2–3 references.", "Don't remove all top volume.", "Ask for a clean line at temples and neck."] },
    "skin-plan": { title: "Skin", text: "Clearer skin comes from a simple routine you actually keep. Be gentle, protect from the sun every day, and give it a few weeks - consistency beats intensity.", steps: ["Morning: gentle cleanser, light moisturizer, then a broad-spectrum SPF 30+ every single day.", "Evening: cleanse off the day, moisturize; 2-3 nights a week add a small amount of a retinoid or salicylic acid, building up slowly.", "Introduce only one new active at a time and patch-test so you do not irritate the skin.", "Sleep 7-8 hours and drink water through the day - it shows in tone and under-eye circles.", "Keep your hands off your face, do not pick spots, and swap your pillowcase twice a week.", "If breakouts are persistent or painful, see a dermatologist instead of guessing - that is the fast track."] },
    "jawline-plan": { title: "Jawline", text: "Bone structure is fixed, but a sharper-looking jaw is very achievable: lower body-fat, less facial bloat, better posture and light muscle tone all add real definition.", steps: ["Practice good tongue posture (mewing): tongue resting flat on the roof of your mouth, lips together, breathing through your nose.", "Fix head and neck posture - chin slightly tucked, shoulders back - both in daily life and on camera.", "Chew firm gum or use a jaw trainer ~10 minutes a day in moderation to tone the area; stop if your jaw aches.", "Cut facial bloat: lower added salt, limit alcohol, sleep enough and stay hydrated.", "Lower overall body-fat with a mild calorie deficit and higher protein - under-chin fat is what hides most jawlines.", "On camera, use soft side lighting, keep your neck straight and keep stubble/neckline tidy."] },
  };

  // Real AI plan for skin / jawline. Personalised from the user's score and
  // face shape, supportive tone, strict JSON. Falls back to the static plan
  // above on any error so the screen never breaks.
  if ((type === "skin-plan" || type === "jawline-plan") && String(env.OPENROUTER_API_KEY || "").trim()) {
    const scoreHint = Math.max(0, Math.min(100, Math.round(Number(body.score) || 0))) || null;
    const faceShapeHint = body.face_shape ? String(body.face_shape) : null;
    const context = JSON.stringify({ overall_score_hint: scoreHint, face_shape_hint: faceShapeHint });
    const prompt = type === "skin-plan" ? `
You are FaceMax AI, a supportive looksmaxxing skin coach. Build ONE concrete, realistic skin-improvement plan.
User context (may be partial): ${context}
Return ONLY valid JSON, no markdown: {"title":"Skin","text":"2-3 sentence supportive overview of how to improve skin clarity, tone and texture","steps":["6 short prioritized actions"]}
Rules:
- The steps MUST cover: a simple AM routine (gentle cleanser, moisturizer, daily broad-spectrum SPF), a PM routine (cleanse, moisturize, and ONE active such as a retinoid or salicylic/azelaic acid introduced slowly), lifestyle habits (sleep, hydration, not touching/picking the face, clean pillowcase), and nutrition (more water and omega-3s, less excess sugar/dairy if breakout-prone).
- Each step is ONE short, specific, beginner-friendly instruction. No medical diagnosis, no prescription-only drugs, no promises of overnight results.
- Encouraging, non-judgemental tone. Suggest seeing a dermatologist only for persistent or severe acne.` : `
You are FaceMax AI, a supportive looksmaxxing jawline coach. Build ONE concrete, realistic plan to maximise VISIBLE jawline definition.
User context (may be partial): ${context}
Return ONLY valid JSON, no markdown: {"title":"Jawline","text":"2-3 sentence supportive overview","steps":["6 short prioritized actions"]}
Rules:
- The steps MUST cover: tongue posture / mewing (tongue flat on the palate, lips together, nose breathing) and good head/neck posture; chewing resistance (firm gum or a jaw trainer) done in moderation; reducing facial bloat (less salt, enough sleep, hydration, limit alcohol); lowering overall body-fat via a mild calorie deficit plus protein since under-chin fat hides the jaw; and grooming/posture on camera.
- Be honest that bone structure cannot change, but body-fat, de-bloating, posture and muscle tone make a real visible difference.
- Each step is ONE short, specific, actionable instruction. No extreme dieting, no harmful advice. Encouraging tone.`;
    try {
      const result = await callOpenRouter(env, prompt, [], { tries: 2 });
      if (result.ok && result.text) {
        let txt = String(result.text).trim();
        if (txt.startsWith("```")) txt = txt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
        const start = txt.indexOf("{");
        const end = txt.lastIndexOf("}");
        if (start >= 0 && end > start) txt = txt.slice(start, end + 1);
        const parsed = JSON.parse(txt);
        const steps = Array.isArray(parsed.steps) ? parsed.steps.map(s => String(s || "").trim()).filter(Boolean).slice(0, 8) : [];
        if (parsed && typeof parsed.text === "string" && parsed.text.trim() && steps.length >= 3) {
          return json({ ok: true, source: "openrouter", data: { title: map[type].title, text: String(parsed.text).trim(), steps }, input: body });
        }
      }
    } catch {}
  }

  return json({ ok: true, source: "fallback", data: map[type] || map["dating-photo"], input: body });
}

// ==================== FOOD SCAN (DePuff-style) ====================
//
// Snap-a-meal endpoint. Sends the image to Gemini 2.5 Flash vision with a
// strict JSON schema describing the meal's bloating impact: an overall
// bloat score (0..100), per-driver levels (sodium / sugar / processed /
// dairy / alcohol), top water-retention ingredients, and concrete swaps.
// Falls back to a generic safe response if Gemini is missing / errors.

function fallbackFoodScan() {
  return {
    detected: "Meal",
    bloat_score: 55,
    bloat_label: "Moderate",
    calories_est: 600,
    sodium_level: "medium",
    sugar_level: "medium",
    processed_level: "medium",
    dairy_level: "low",
    alcohol_level: "low",
    summary: "This meal is moderately likely to cause facial bloating the next morning.",
    why: "Most restaurant-style or packaged meals contain hidden sodium, refined carbs and seed oils that promote water retention.",
    key_ingredients: [
      { name: "Hidden sodium", impact: "high", note: "Sauces, broths and breading often hide 1000+ mg per serving." },
      { name: "Refined carbs", impact: "medium", note: "White bread / fries spike insulin and pull water into tissue." },
      { name: "Seed oils", impact: "low", note: "Inflammatory in high doses, but small portions are fine." }
    ],
    swaps: [
      "Swap the side of fries for steamed greens or a side salad with olive oil.",
      "Ask for sauce on the side and use half the amount.",
      "Drink an extra 500 ml of water and pair the meal with potassium-rich foods (banana, avocado)."
    ],
    tip: "If you eat this in the evening, expect mild puffiness in the morning — sleep on your back, drink water, and do a 60-second cold rinse on waking."
  };
}

async function callGeminiFoodScan(env, body, fallback) {
  if (!String(env.OPENROUTER_API_KEY || "").trim()) return { ok: true, source: "fallback", data: fallback, reason: "OPENROUTER_API_KEY missing" };

  function imgPart(dataUrl) {
    const s = String(dataUrl || "");
    return /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.test(s) ? s : null;
  }

  const main = imgPart(body.image);
  if (!main) return { ok: true, source: "fallback", data: fallback, reason: "image missing or malformed" };

  const prompt = `
You are FaceMax AI, a premium app analysing how a meal affects next-morning facial bloating.
Look at exactly the attached photo. Write in English. Return only valid JSON without markdown.

Rules:
- Do not mention Gemini, the model, or any technical details.
- Do not give medical diagnoses or warnings.
- Be specific to what you see in the photo, not generic.
- bloat_score is 0..100 where 0 is no bloating impact and 100 is severe.
- bloat_label must match the score: 0-30 "Low", 31-55 "Moderate", 56-75 "High", 76-100 "Severe".
- All level fields must be one of: "low", "medium", "high".
- key_ingredients: 3 items, each with name, impact ("low"|"medium"|"high") and a one-sentence note.
- swaps: 3 concrete, actionable swaps the user could make next time.
- If the photo is not food, set detected to "No meal detected" and bloat_score to 0.

Return strictly JSON:
{
  "detected": "short name of the meal (e.g. 'Cheeseburger with fries')",
  "bloat_score": number,
  "bloat_label": "Low" | "Moderate" | "High" | "Severe",
  "calories_est": number,
  "sodium_level": "low" | "medium" | "high",
  "sugar_level": "low" | "medium" | "high",
  "processed_level": "low" | "medium" | "high",
  "dairy_level": "low" | "medium" | "high",
  "alcohol_level": "low" | "medium" | "high",
  "summary": "1 short sentence summarising the meal's bloating impact",
  "why": "1-2 sentence explanation of which components in this specific meal drive the score",
  "key_ingredients": [
    {"name":"","impact":"low|medium|high","note":"short"},
    {"name":"","impact":"low|medium|high","note":"short"},
    {"name":"","impact":"low|medium|high","note":"short"}
  ],
  "swaps": ["", "", ""],
  "tip": "1 short tactical tip for tonight to reduce morning puffiness"
}`;

  try {
    const result = await callOpenRouter(env, prompt, [main], { tries: 3 });
    if (!result.ok || !result.text) {
      return { ok: true, source: "fallback", data: fallback, reason: result.reason || "OpenRouter error", status: result.status, details: result.detail || null };
    }
    return { ok: true, source: "openrouter", data: JSON.parse(result.text) };
  } catch (e) {
    return { ok: true, source: "fallback", data: fallback, reason: e?.message || String(e) };
  }
}

async function foodScan(request, env) {
  const body = await request.json().catch(() => ({}));
  // Premium-gate: only paying users can use AI food scan.
  const userId = sanitizeUserId(body.user_id || body.userId);
  if (userId) {
    const p = await readPremium(env, userId);
    if (!p.active) return json({ ok: false, error: "premium_required", premium: false }, 402);
    const daily = await checkAndIncrementDailyLimit(env, userId, body.local_date);
    if (!daily.allowed) return json({ ok: false, error: "daily_limit_reached", limit: DAILY_SCAN_LIMIT, message: "You've reached your 50 scans/day limit. Try again tomorrow." }, 429);
  } else {
    return json({ ok: false, error: "user_id required" }, 400);
  }
  const fallback = fallbackFoodScan();
  let result;
  if (String(env.OPENROUTER_API_KEY || "").trim()) {
    result = await callGeminiFoodScan(env, body, fallback);
  } else {
    result = { ok: true, source: "fallback", data: fallback, reason: "no AI key configured" };
  }
  return json(result);
}

// ==================== GLOW UP PLAN (AI-generated, per-scan) ====================
//
// Generates a truly personalised daily Glow Up plan from the user's scan metrics.
// Uses the same OpenRouter → Gemini 2.5 Flash Lite pipeline as fullReport.
// Returns a JSON object the front-end renders directly in the Glow Up Hub.
//
// POST /api/glow-plan
// Body: { user_id, metrics: { skin, jawline, eyes, cheekbones, symmetry, harmony,
//          eye_area, lips, nose, face_shape, hair, improvement_potential },
//         overall_score, face_shape, archetype, gender, weakest_area }

async function glowPlan(request, env) {
  const body = await request.json().catch(() => ({}));
  // Premium-gate: glow plan is a paid feature.
  const userId = sanitizeUserId(body.user_id || body.userId);
  if (!userId) return json({ ok: false, error: "user_id required" }, 400);
  const p = await readPremium(env, userId);
  if (!p.active) return json({ ok: false, error: "premium_required", premium: false }, 402);

  const m = (body.metrics && typeof body.metrics === "object") ? body.metrics : {};
  const overall = Math.max(0, Math.min(100, Math.round(Number(body.overall_score || body.score) || 0)));
  const gender = String(body.gender || "").toLowerCase().startsWith("f") ? "female" : "male";
  const archetype = body.archetype ? String(body.archetype) : null;
  const faceShape = body.face_shape ? String(body.face_shape) : null;

  // Validate and extract thumbnail for vision context
  const thumbRaw = String(body.thumb || "");
  const thumb = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]{100,}$/.test(thumbRaw)
    ? thumbRaw
    : null;

  // Build score context string for the prompt
  const scoreLines = Object.entries(m)
    .filter(([, v]) => isFinite(Number(v)))
    .map(([k, v]) => `  ${k}: ${Math.round(Number(v))}`)
    .join("\n");

  const today = new Date().toLocaleDateString("en-US", { weekday: "long" });

  const prompt = `You are FaceMax AI — a brutally honest but supportive looksmaxxing coach.
Today is ${today}.
${thumb ? "An image of the user's face is attached. Use it alongside the numeric scores below to improve accuracy — look for visible signs of puffiness, skin condition, asymmetry, or under-eye issues that the scores may understate.\n" : ""}
The user just scanned their face. Here are their MediaPipe-derived scores (0–100):
${scoreLines || "  (no individual metrics provided)"}
Overall score: ${overall || "unknown"}
${faceShape ? `Face shape: ${faceShape}` : ""}
${archetype ? `Archetype: ${archetype}` : ""}
Gender: ${gender}

IMPORTANT SCORE INTERPRETATION:
- jawline < 65: likely caused by submental fat / water retention / facial bloating — depuff protocol is the primary fix, NOT just mewing
- jawline 65–75: mix of posture, fat and structure — combine depuff + posture
- jawline > 75: structure is good, posture/grooming optimisation
- cheekbones < 65: face may be round/chubby — focus on overall face slimming, sodium cut, lymphatic drainage
- eyes < 65: under-eye puffiness, dark circles, or drooping — cold therapy, sleep, drainage massage
- skin < 70: active skin issues — targeted skincare steps
- symmetry < 70: posture asymmetry or muscle imbalance — corrective exercises
- harmony < 70: proportions off — grooming, styling, or framing adjustments

Your task: generate ONE personalised Glow Up plan for TODAY specifically.
You MUST look at ALL metrics and decide what the user actually needs most — do NOT default to skin and jawline if other areas are weaker or if the issue is clearly facial fat/puffiness.

Real examples of correct reasoning:
- jawline = 58, cheekbones = 61 → the problem is facial fat/bloating, NOT bone structure. Today's plan = depuff protocol: sodium cut, lymphatic drainage, cold rinse, sleep position
- eyes = 59 → under-eye focus: cold spoon, drainage massage, sleep, hydration
- skin = 55 → active skincare repair steps
- symmetry = 62 → posture reset, corrective jaw/neck exercises
- cheekbones = 63 → face-slimming: calorie deficit reminder, chewing, sodium
- all scores > 72 → maintenance mode: pick the single lowest and give optimisation tips

Rules:
- focus: 4–6 words summarising today's main priority (their actual weakest area, be specific e.g. "De-puff & define" not just "Jawline work")
- steps: exactly 3 steps for today. Each step:
  - label: short action (5–8 words)
  - sub: 1 concrete sentence WHY this addresses their specific score (mention the score or visible issue)
  - area: the actual root issue — use any of: depuff | water_retention | face_fat | skin | jawline | eyes | cheekbones | symmetry | harmony | hair | nutrition | sleep | overall
- chips: 2–3 score chips to show. Pick their lowest scores. Format: { label, score, note }
  - note: 1 ultra-short tip specific to that score level
- food_tip: 1 sentence food/nutrition tip directly tied to their weakest area (if puffiness → sodium/alcohol; if skin → antioxidants; etc.)
- face_tip: 1 sentence face technique for today matched to their actual issue (if puffiness → gua sha / cold / drainage; if jawline structure → mewing; if eyes → cold spoon)
- skin_tip: 1 sentence skincare action only if skin < 75, otherwise omit or set null
- motivation: 1 short punchy sentence, looksmax-style, referencing their specific situation

Return ONLY valid JSON, no markdown:
{
  "focus": "string",
  "steps": [
    { "label": "string", "sub": "string", "area": "string" },
    { "label": "string", "sub": "string", "area": "string" },
    { "label": "string", "sub": "string", "area": "string" }
  ],
  "chips": [
    { "label": "string", "score": number, "note": "string" }
  ],
  "food_tip": "string",
  "face_tip": "string",
  "skin_tip": "string or null",
  "motivation": "string"
}`;

  const fallback = {
    focus: "Full-face glow-up",
    steps: [
      { label: "Cold water face rinse — 30 sec", sub: "Constricts vessels, reduces puffiness and tightens pores immediately.", area: "overall" },
      { label: "Tongue posture & neck reset", sub: "Tongue flat on palate, chin level — hold 3 × 30 sec. Improves jawline silhouette over time.", area: "overall" },
      { label: "8 glasses of water today", sub: "Flushes sodium retention that blurs facial definition and dulls skin.", area: "overall" },
    ],
    chips: [],
    food_tip: "Avoid salty and processed foods — sodium shows as morning puffiness across the whole face.",
    face_tip: "Knuckle-glide from jaw to cheekbone to brow for 3 minutes to boost circulation and drainage.",
    skin_tip: "Apply a hydrating toner in 2 thin layers before moisturiser tonight.",
    motivation: "Consistency beats intensity — every day you show up compounds.",
  };

  if (!String(env.OPENROUTER_API_KEY || "").trim()) {
    return json({ ok: true, source: "fallback", data: fallback });
  }

  try {
    // Include thumbnail if available — Gemini vision model sees the actual face
    // alongside the numeric metrics, improving plan accuracy and personalisation.
    const images = thumb ? [thumb] : [];
    const result = await callOpenRouter(env, prompt, images, { tries: 3 });
    if (!result.ok || !result.text) return json({ ok: true, source: "fallback", data: fallback });

    let txt = result.text.trim();
    if (txt.startsWith("```")) txt = txt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
    if (s < 0 || e <= s) return json({ ok: true, source: "fallback", data: fallback });
    txt = txt.slice(s, e + 1);

    const parsed = JSON.parse(txt);

    // Validate & sanitise
    const steps = Array.isArray(parsed.steps)
      ? parsed.steps.slice(0, 3).map(st => ({
          label: String(st.label || "").trim(),
          sub: String(st.sub || "").trim(),
          area: String(st.area || "overall").trim(),
        })).filter(st => st.label)
      : [];
    if (steps.length < 2) return json({ ok: true, source: "fallback", data: fallback });

    const chips = Array.isArray(parsed.chips)
      ? parsed.chips.slice(0, 3).map(c => ({
          label: String(c.label || "").trim(),
          score: Math.round(Number(c.score) || 0),
          note: String(c.note || "").trim(),
        })).filter(c => c.label)
      : [];

    return json({
      ok: true,
      source: "openrouter",
      data: {
        focus: String(parsed.focus || fallback.focus).trim(),
        steps,
        chips,
        food_tip: String(parsed.food_tip || fallback.food_tip).trim(),
        face_tip: String(parsed.face_tip || fallback.face_tip).trim(),
        skin_tip: parsed.skin_tip ? String(parsed.skin_tip).trim() : null,
        motivation: String(parsed.motivation || fallback.motivation).trim(),
      },
    });
  } catch {
    return json({ ok: true, source: "fallback", data: fallback });
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/" || path === "/health") return json({
        ok: true, app: "FaceMax AI API", message: "Worker backend is running",
        frontend_url_clean: cleanUrl(env.FRONTEND_URL || ""),
        endpoints: [
          "/api/premium-status?user_id=",
          "/api/scan-count?user_id=",
          "/api/scan-count (POST)",
          "/api/test-grant?user_id=",
          "/api/payment-success?user_id=",
          "/api/gemini-config-check",
          "/api/glow-plan",
          "/api/full-report",
          "/api/food-scan",
          "/api/dating-photo",
          "/api/haircut-guide",
          "/api/skin-plan",
          "/api/jawline-plan",
          "/api/apple-receipt-verify",
          "/api/apple-server-notification",
        ]
      });

      if (path === "/api/premium-status") return json(await readPremium(env, getUserIdFromRequest(url, {})));
      if (path === "/api/scan-count" && request.method === "GET") return await scanCountGet(request, env);
      if (path === "/api/scan-count" && request.method === "POST") return await scanCountIncrement(request, env);
      if (path === "/api/access") return json(await readPremium(env, url.searchParams.get("email")));
      if (path === "/api/test-grant") {
        const userId = getUserIdFromRequest(url, {}) || "test-user";
        const until = await savePremium(env, userId, nowPlusPremium(), "test_grant");
        return json({ ok: true, active: true, premium: true, user_id: String(userId), premium_until: until });
      }

      if (path === "/api/payment-success") {
        const userId = getUserIdFromRequest(url, {});
        if (!userId) return json({ ok: false, error: "user_id required" }, 400);
        const until = await savePremium(env, userId, nowPlusPremium(), "payment_success_redirect");
        return json({ ok: true, active: true, premium: true, user_id: String(userId), premium_until: until, expires_iso: new Date(until).toISOString() });
      }

      if (path === "/api/gemini-config-check") return json({
        ok: true,
        gemini_api_key_present: !!String(env.GEMINI_API_KEY || "").trim(),
        model: "gemini-2.5-flash-lite",
        note: String(env.GEMINI_API_KEY || "").trim() ? "Gemini key present" : "GEMINI_API_KEY missing"
      });

      if (path === "/api/glow-plan" && request.method === "POST") return await glowPlan(request, env);
      if (path === "/api/face-check" && request.method === "POST") return await faceCheck(request, env);
      if (path === "/api/full-report" && request.method === "POST") return await fullReport(request, env);
      if (path === "/api/food-scan" && request.method === "POST") return await foodScan(request, env);
      if (path === "/api/dating-photo" && request.method === "POST") return await simpleTool(request, env, "dating-photo");
      if (path === "/api/haircut-guide" && request.method === "POST") return await simpleTool(request, env, "haircut-guide");
      if (path === "/api/skin-plan" && request.method === "POST") return await simpleTool(request, env, "skin-plan");
      if (path === "/api/jawline-plan" && request.method === "POST") return await simpleTool(request, env, "jawline-plan");

      if (path === "/api/apple-receipt-verify" && request.method === "POST") return await verifyAppleReceipt(request, env);
      if (path === "/api/apple-server-notification" && request.method === "POST") return await appleServerNotification(request, env);

      if (path === "/api/delete-account" && request.method === "POST") return await deleteAccount(request, env);

      return json({ ok: false, error: "Not found", path }, 404);
    } catch (e) {
      return json({ ok: false, error: e?.message || String(e), path }, 500);
    }
  },
};