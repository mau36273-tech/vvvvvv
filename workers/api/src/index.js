const PREMIUM_DAYS_FULL = 30;
const PREMIUM_DAYS_STARTER = 14;
const PREMIUM_MS_FULL = PREMIUM_DAYS_FULL * 24 * 60 * 60 * 1000;
const PREMIUM_MS_STARTER = PREMIUM_DAYS_STARTER * 24 * 60 * 60 * 1000;
// Back-compat
const PREMIUM_DAYS = PREMIUM_DAYS_FULL;
const PREMIUM_MS = PREMIUM_MS_FULL;
const DEFAULT_LAVA_OFFER_ID_FULL = "29aeda8f-cb0c-4f9c-b07e-979c51979946";
const DEFAULT_LAVA_OFFER_ID_STARTER = "c6a64b17-4c24-4d2b-bed4-2b02a5bc4969";
const DEFAULT_LAVA_OFFER_ID = DEFAULT_LAVA_OFFER_ID_FULL;
const DEFAULT_LAVA_CURRENCY = "USD";
const LAVA_EMAIL_DOMAIN = "facemaxaiapp.com";

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
function lavaInvoiceKey(invoiceId) { return "lava_invoice:" + String(invoiceId); }
function lavaUserKey(email) { return "lava_user:" + String(email || "").toLowerCase(); }
function scanCountKey(userId) { return "scancount:" + String(userId); }

const FREE_SCAN_LIMIT = 3;
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

function buildLavaEmail(userId) {
  const id = sanitizeUserId(userId);
  if (!id) return null;
  return id + "@" + LAVA_EMAIL_DOMAIN;
}

function parseUserIdFromLavaEmail(email) {
  const s = String(email || "").trim().toLowerCase();
  const m = s.match(/^([a-z0-9._-]{1,64})@/i);
  return m ? m[1] : null;
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

// ==================== LAVA TOP ====================

function getLavaOfferId(env) {
  return String(env.LAVA_OFFER_ID || DEFAULT_LAVA_OFFER_ID_FULL).trim();
}
function getLavaOfferIdFor(env, plan) {
  if (normalizePlan(plan) === "starter") {
    return String(env.LAVA_OFFER_ID_STARTER || DEFAULT_LAVA_OFFER_ID_STARTER).trim();
  }
  return String(env.LAVA_OFFER_ID || DEFAULT_LAVA_OFFER_ID_FULL).trim();
}
function getLavaCurrency(env) {
  const c = String(env.LAVA_CURRENCY || DEFAULT_LAVA_CURRENCY).trim().toUpperCase();
  return ["USD", "EUR", "RUB"].includes(c) ? c : DEFAULT_LAVA_CURRENCY;
}
function getLavaApiKey(env) {
  return String(env.LAVA_API_KEY || "").trim();
}
function getLavaWebhookSecret(env) {
  return String(env.LAVA_WEBHOOK_SECRET || "").trim();
}

async function createLavaInvoice(request, env) {
  const body = await request.json().catch(() => ({}));
  const url = new URL(request.url);
  const userId = sanitizeUserId(getUserIdFromRequest(url, body));
  if (!userId) return json({ ok: false, error: "user_id is missing or invalid" }, 400);

  const plan = normalizePlan(body.plan || url.searchParams.get("plan"));
  const apiKey = getLavaApiKey(env);
  if (!apiKey) return json({ ok: false, error: "LAVA_API_KEY is missing" }, 500);

  const email = buildLavaEmail(userId);
  const offerId = getLavaOfferIdFor(env, plan);
  const payload = {
    email,
    offerId,
    currency: getLavaCurrency(env),
    buyerLanguage: "EN",
  };

  const res = await fetch("https://gate.lava.top/api/v2/invoice", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json({ ok: false, error: "Lava create invoice failed", status: res.status, details: data }, 502);
  }

  const paymentUrl = data.paymentUrl || data.payment_url || null;
  const duration_ms = planDurationMs(plan);
  // Store latest pending plan keyed by email so the webhook (which only sees
  // the buyer email + contractId) can grant the correct subscription length.
  if (env.PREMIUM_KV) {
    await env.PREMIUM_KV.put(
      lavaUserKey(email),
      JSON.stringify({
        user_id: String(userId), email, plan, duration_ms,
        offer_id: offerId, invoice_id: data.id || null,
        created_at: Date.now(),
      }),
      { expirationTtl: 60 * 60 * 24 * 7 }
    );
  }
  if (env.PREMIUM_KV && data.id) {
    await env.PREMIUM_KV.put(
      lavaInvoiceKey(data.id),
      JSON.stringify({
        invoice_id: data.id, user_id: String(userId), email, plan, offer_id: offerId,
        status: data.status, amount: data.receipt?.amount, currency: data.receipt?.currency,
        created_at: Date.now(),
      }),
      { expirationTtl: 60 * 60 * 24 * 7 }
    );
  }

  return json({
    ok: true,
    invoice_id: data.id || null,
    status: data.status || null,
    url: paymentUrl,
    payment_url: paymentUrl,
    user_id: userId,
    email,
    plan,
    duration_days: Math.round(duration_ms / (24 * 60 * 60 * 1000)),
  });
}

async function lavaWebhook(request, env) {
  const expected = getLavaWebhookSecret(env);
  // Lava webhook auth: supports both
  //   1) "API key of your service" -> X-Api-Key: <secret>   (or Authorization: <secret>)
  //   2) "Basic"                   -> Authorization: Basic base64("lava:<secret>")
  let authorized = false;
  if (expected) {
    const xApiKey = request.headers.get("x-api-key") || "";
    const authHeader = request.headers.get("authorization") || "";
    if (xApiKey === expected) {
      authorized = true;
    } else if (authHeader === expected) {
      authorized = true;
    } else if (authHeader.toLowerCase().startsWith("basic ")) {
      try {
        const decoded = atob(authHeader.slice(6).trim());
        const idx = decoded.indexOf(":");
        const pass = idx >= 0 ? decoded.slice(idx + 1) : decoded;
        if (pass === expected) authorized = true;
      } catch (_) {}
    } else if (authHeader.toLowerCase().startsWith("bearer ")) {
      if (authHeader.slice(7).trim() === expected) authorized = true;
    }
  } else {
    authorized = true;
  }
  if (!authorized) {
    return json({ ok: false, error: "Invalid webhook signature" }, 401);
  }

  const data = await request.json().catch(() => ({}));
  const eventType = String(data.eventType || data.event || "").trim();
  const status = String(data.status || "").toLowerCase();
  const email = data.buyer?.email || data.email || null;
  const userId = parseUserIdFromLavaEmail(email);

  const isSuccess = eventType === "payment.success" ||
    eventType === "subscription.recurring.payment.success" ||
    status === "completed" || status === "subscription-active";

  // Resolve plan/duration from the most recent pending invoice for this email
  let plan = "full";
  let durationMs = PREMIUM_MS_FULL;
  if (env.PREMIUM_KV && email) {
    const raw = await env.PREMIUM_KV.get(lavaUserKey(email));
    if (raw) {
      try {
        const meta = JSON.parse(raw);
        plan = normalizePlan(meta.plan);
        durationMs = Number(meta.duration_ms) || planDurationMs(plan);
      } catch {}
    }
  }

  let premiumUntil = null;
  if (isSuccess && userId) {
    premiumUntil = await savePremium(env, userId, Date.now() + durationMs,
      "lava_webhook:" + (eventType || status || "success") + ":" + plan);
  }

  if (env.PREMIUM_KV && data.contractId) {
    await env.PREMIUM_KV.put(
      lavaInvoiceKey(data.contractId),
      JSON.stringify({
        contract_id: data.contractId, user_id: userId, email, plan,
        event_type: eventType, status, amount: data.amount, currency: data.currency,
        timestamp: data.timestamp || null, premium_until: premiumUntil,
        received_at: Date.now(),
      }),
      { expirationTtl: 60 * 60 * 24 * 30 }
    );
  }

  return json({
    ok: true,
    received: true,
    event_type: eventType || null,
    user_id: userId || null,
    email: email || null,
    plan,
    activated: isSuccess && !!userId,
    premium_until: premiumUntil,
  });
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
  "ai.facemax.app.lifetime": { plan: "lifetime", isSubscription: false },
};

const APPLE_BUNDLE_ID_DEFAULT = "ai.facemax.app";

async function verifyAppleReceipt(request, env) {
  const body = await request.json().catch(() => ({}));
  const url = new URL(request.url);
  const userId = sanitizeUserId(getUserIdFromRequest(url, body));
  if (!userId) return json({ ok: false, error: "user_id is missing or invalid" }, 400);

  const jws = String(body.transaction_jws || body.jws || "").trim();
  if (!jws) return json({ ok: false, error: "transaction_jws is missing" }, 400);

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

  const data = notification.data || {};
  let transactionPayload = null;
  if (data.signedTransactionInfo) {
    try { transactionPayload = decodeAppleJWSPayload(data.signedTransactionInfo); } catch (_) {}
  }

  return json({
    ok: true,
    received: true,
    notification_type: notification.notificationType || null,
    subtype: notification.subtype || null,
    productId: transactionPayload?.productId || null,
    // We intentionally do not flip premium off here yet — refunds/cancellations
    // are handled lazily via /api/premium-status which always returns active
    // only when premium_until > now.
  });
}

// ==================== AI BACKEND / REPORTS ====================
//
// Primary AI backend is OpenRouter, pinned to `google/gemini-2.5-flash-lite`
// via the google-vertex/eu provider at temperature 0 (see callOpenRouter).
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
  const metrics = body && typeof body.metrics === "object" && body.metrics ? body.metrics : null;
  const score = Math.max(1, Math.min(100, Math.round(Number(body?.score) || 0))) || null;
  const faceShape = body && body.face_shape ? String(body.face_shape) : null;
  const userContext = {
    score_hint: score,
    face_shape: faceShape,
    mediapipe_metrics: metrics,
    strongest_feature_hint: body?.strongest_feature,
    main_upgrade_area_hint: body?.main_upgrade_area,
  };
  const jawlineHint = metrics && Number.isFinite(Number(metrics.jawline)) ? Math.round(Number(metrics.jawline)) : null;
  const skinHint = metrics && Number.isFinite(Number(metrics.skin)) ? Math.round(Number(metrics.skin)) : null;
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
- Be deterministic: the same input metrics MUST always produce the same scores. Do not add randomness or motivational rounding. Re-read the input numbers calmly and grade the same evidence the same way every time.
- key_points MUST contain EXACTLY 3 or 4 entries. Each entry MUST be in the format "Problem | Fix" (with the pipe character). The Problem references a specific metric or visible aspect; the Fix is a concrete, actionable instruction (e.g. an exercise, product, habit, or visit to a specialist). NO water, NO generic motivational language. Lookmaxxing-style brutal honesty.
- Do NOT include any 7-day plan, daily schedule, or week-by-week breakdown. The user does not want one.
- archetype must be one of: Gigachad, Chad, Chadlite, Striker, Classic, Casual, Underdog, Wildcard (for women, also: Goddess, Stacy, Stacylite, Belle). Pick the archetype that best fits the overall_score band: 90+ Gigachad/Goddess, 82-89 Chad/Stacy, 73-81 Chadlite/Stacylite, 64-72 Striker/Belle, 55-63 Classic, 45-54 Casual, 30-44 Underdog, <30 Wildcard. Never use ethnic or regional labels.

Scoring calibration (follow strictly):
- Center an ordinary normal adult face around 65, NOT around 50. Average = 60-68, slightly above average = 69-77, attractive = 78-86, exceptional = 87-95.
- overall_score must sit near the upper-middle of the per-feature scores for a normal clear photo, never drag below the features you rated.
- Anchor the jawline sub-score within ±5 of the input metric (${jawlineHint ?? "unknown"}). Anchor the skin sub-score within ±5 of the input metric (${skinHint ?? "unknown"}). Do not contradict the on-device measurements by more than that.

Per-feature scoring rubric (jawline + skin — use these definitions when you set the sub-scores AND when you write the explanation):
- jawline: judge the visible definition of the lower face — mandible sharpness, gonial (jaw) angle, chin projection, submental / under-chin softness. Crisp, well-separated jaw with little under-chin fat scores 80+. Soft, rounded or fat-obscured jaw scores in the 50s-60s. Use the input jawline metric as your anchor and only deviate ≤5 points based on context (face_shape, symmetry).
- skin: judge clarity and condition — tone evenness, blemishes / acne / scarring, pore size and surface texture, oiliness, redness, under-eye darkness / puffiness. Clear, even, smooth skin scores 80+; active breakouts, rough texture or heavy dark circles score in the 50s-60s. The client cannot send pixels, so reason from the skin input metric (${skinHint ?? "unknown"}) and treat it as the visible-skin proxy.

Explain the score: the "jawline" and "skin" output fields MUST EACH begin with ONE short, specific sentence anchored to the actual sub-score you just assigned (mention the score bucket — e.g. "At {score}/100 your jaw reads soft from this angle..." or "At {score}/100 the skin signal looks uneven...") and only AFTER that sentence give the concrete improvement advice. The sentence MUST NOT be generic — it must mention what drove the number (jaw sharpness vs. under-chin softness, clear tone vs. visible breakouts / dark circles, etc.).

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
// Also validates that the skin/jawline reasoning strings are non-empty so
// the client never renders an empty "why this score" caption.
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

  // Ensure jawline/skin reasoning is non-trivial AND score-anchored. The
  // text-only model sometimes returns a 1-3 word stub ("clean jaw.") which
  // breaks the "why this score" caption on the report screen, and even when
  // it returns a full sentence it often drops the "At {score}/100..." lead
  // we asked for in the prompt. We backfill in BOTH cases so the user
  // always sees a sentence tied to the actual sub-score before the advice.
  const subScores = parsed.scores || {};
  const ensureReason = (key) => {
    const raw = String(parsed[key] == null ? "" : parsed[key]).trim();
    const sub = Number(subScores[key]);
    const bucket = Number.isFinite(sub)
      ? (sub >= 80 ? "strong" : sub >= 65 ? "decent" : sub >= 50 ? "average" : "soft")
      : "average";
    const lead = Number.isFinite(sub)
      ? `At ${Math.round(sub)}/100 your ${key === "jawline" ? "jaw definition" : "skin signal"} reads ${bucket}.`
      : `Your ${key} reads ${bucket} from the provided metrics.`;
    // Re-anchor the lead whenever the model failed to include it. Cheap
    // detector: the FIRST ~12 characters must look like "At NN/100" or
    // "At NN /100". If not, prepend our own lead and treat the model's
    // text as the advice that follows.
    const hasLead = /^\s*at\s+\d{1,3}\s*\/\s*100/i.test(raw);
    if (raw.length >= 24 && hasLead) return;
    const advice = raw || (fallback[key] || "");
    parsed[key] = (lead + " " + advice).trim();
  };
  ensureReason("jawline");
  ensureReason("skin");
  return parsed;
}

// Fallback: OpenAI ChatGPT text-only. Used when Gemini is unavailable.
// Input is the MediaPipe-derived feature vector, no photo.
async function callOpenAI(env, body, fallback) {
  const key = String(env.OPENAI_API_KEY || "").trim();
  if (!key) {
    return { ok: true, source: "fallback", data: fallback, reason: "OPENAI_API_KEY missing" };
  }
  const prompt = buildReportPrompt(body);
  const model = String(env.OPENAI_REPORT_MODEL || "gpt-4o-mini").trim() || "gpt-4o-mini";
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key,
      },
      body: JSON.stringify({
        model,
        temperature: 0.45,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are FaceMax AI. Reply with strict JSON only." },
          { role: "user", content: prompt },
        ],
      }),
    });
    const data = await res.json().catch(() => ({}));
    const txt = data?.choices?.[0]?.message?.content;
    if (!res.ok || !txt) {
      return {
        ok: true,
        source: "fallback",
        data: fallback,
        reason: "OpenAI API error",
        status: res.status,
        details: data?.error?.message || null,
      };
    }
    let parsed;
    try { parsed = JSON.parse(txt); } catch {
      return { ok: true, source: "fallback", data: fallback, reason: "OpenAI returned non-JSON" };
    }
    return { ok: true, source: "openai", data: normalizeReport(parsed, fallback) };
  } catch (e) {
    return { ok: true, source: "fallback", data: fallback, reason: e?.message || String(e) };
  }
}

// ---------------------------------------------------------------------------
// OpenRouter is the PRIMARY AI backend. Every vision + text flow (face report,
// face-check, food-scan, skin/jawline plans) goes through this one helper.
// The model is pinned to google/gemini-2.5-flash-lite via the google-vertex/eu
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
    provider: { only: ["google-vertex/eu"], allow_fallbacks: false },
    temperature: 0,
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
- Be deterministic: the same face must always receive the same score. Derive overall_score and every sub-score ONLY from what you actually see in this image; you are given no prior score and must not anchor to any default or middling value. Read the face calmly and grade the same visible evidence the same way every time.

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
  const fallback = fallbackReport(body);
  // Prefer OpenRouter for both text-only (MediaPipe metrics) and vision (photo)
  // report flows. Fall back to OpenAI only if OpenRouter is unavailable.
  let result;
  const hasOpenRouter = !!String(env.OPENROUTER_API_KEY || "").trim();
  const hasOpenAI = !!String(env.OPENAI_API_KEY || "").trim();
  if (hasOpenRouter) {
    result = await callGemini(env, body, fallback);
    // Vision can hiccup on the pinned Vertex/EU provider (rate limit / transient
    // error) and dead-ends the client with a "try again" modal. Before giving
    // up, retry the SAME model+provider WITHOUT the image, anchored on the
    // MediaPipe metrics the client already sent, so the user still gets a real
    // AI report. Provider/model stay pinned — we only drop the photo.
    const hadImage = !!(body && (body.image || (Array.isArray(body.images) && body.images.length)));
    if ((result.failed || result.source === "fallback") && hadImage) {
      const metricsBody = { ...body, image: null, images: [] };
      const retry = await callGemini(env, metricsBody, fallback);
      if (retry.ok && !retry.failed && retry.source !== "fallback") result = retry;
    }
    if ((result.failed || result.source === "fallback") && hasOpenAI) {
      result = await callOpenAI(env, body, fallback);
    }
  } else if (hasOpenAI) {
    result = await callOpenAI(env, body, fallback);
  } else {
    result = { ok: true, source: "fallback", data: fallback, reason: "no AI key configured" };
  }
  // Surface a real failure instead of returning a generic fallback score — a
  // misleading score on a failed analysis is an App Store hard-reject risk.
  if (result.ok === false || result.failed) {
    return json({ ok: false, error: "analysis_failed", source: result.source || "error", reason: result.reason || null, status: result.status || 0 }, 503);
  }
  const userId = body.user_id || body.userId || body.email || null;
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
  //
  // v4 (Umax-parity): the AI returns a STRUCTURED plan with named categories
  // (AM / PM / Weekly / Lifestyle for skin; Posture / Active / De-bloat /
  // Camera for jawline), plus a realistic timeline and a short "when to see
  // a pro" note. For backwards compatibility with the existing client we
  // also flatten the category steps into the legacy `steps[]` array so an
  // un-upgraded UI still renders the plan.
  if ((type === "skin-plan" || type === "jawline-plan") && String(env.OPENROUTER_API_KEY || "").trim()) {
    const scoreHint = Math.max(0, Math.min(100, Math.round(Number(body.score) || 0))) || null;
    const faceShapeHint = body.face_shape ? String(body.face_shape) : null;
    const context = JSON.stringify({ overall_score_hint: scoreHint, face_shape_hint: faceShapeHint });
    const prompt = type === "skin-plan" ? `
You are FaceMax AI, a supportive looksmaxxing skin coach. Build ONE concrete, realistic skin-improvement plan.
User context (may be partial): ${context}
Return ONLY valid JSON, no markdown:
{
  "title": "Skin",
  "text": "2-3 sentence supportive overview of how to improve skin clarity, tone and texture, tailored to the score hint when present",
  "expected_timeline": "realistic visible-change timeframe, e.g. 'Most people see clearer tone in 3-6 weeks; deeper texture changes take 8-12 weeks of consistency.'",
  "categories": [
    {"label":"Morning routine","steps":["2-3 specific AM actions"]},
    {"label":"Evening routine","steps":["2-3 specific PM actions"]},
    {"label":"Weekly add-ons","steps":["1-2 weekly habits"]},
    {"label":"Lifestyle & nutrition","steps":["2-3 daily lifestyle habits"]}
  ],
  "red_flags": "1 short sentence on when to stop guessing and see a dermatologist"
}
Rules:
- Morning routine MUST cover: gentle cleanser, hydrating serum or light moisturizer, and broad-spectrum SPF 30+ every single day (including indoors). Mention specific, beginner-friendly ingredient hints (e.g. "niacinamide 5%", "hyaluronic acid", "mineral SPF") so the steps feel concrete.
- Evening routine MUST cover: cleanse off the day (oil + foam if heavy sunscreen / makeup), moisturize, and ONE active such as a low-strength retinoid OR salicylic / azelaic acid introduced slowly (2-3x per week, then build).
- Weekly add-ons SHOULD include: a clay or hydration mask 1x/week depending on skin type, and a gentle exfoliation cap (do not stack actives same night).
- Lifestyle & nutrition MUST cover: 7-8h sleep, hydration through the day, hands-off-the-face, clean pillowcase 1-2x/week, more omega-3s and water, less excess sugar / dairy if acne-prone.
- Each step is ONE short, specific, beginner-friendly instruction (≆30-90 chars). No medical diagnosis, no prescription-only drugs, no promises of overnight results.
- expected_timeline must be realistic and honest — NEVER promise "clear skin in days".
- red_flags MUST mention painful / cystic acne or scarring as the trigger to see a dermatologist.
- Encouraging, non-judgemental tone. The user has a sub-score around ${scoreHint ?? "unknown"}/100; if it is low, lead with the gentlest steps first; if it is already high (≥80), focus on maintenance and refinement.` : `
You are FaceMax AI, a supportive looksmaxxing jawline coach. Build ONE concrete, realistic plan to maximise VISIBLE jawline definition.
User context (may be partial): ${context}
Return ONLY valid JSON, no markdown:
{
  "title": "Jawline",
  "text": "2-3 sentence supportive overview that is honest about bone structure (fixed) vs. visible definition (very achievable via body-fat, posture, de-bloat and light muscle tone)",
  "expected_timeline": "realistic visible-change timeframe, e.g. 'Posture and de-bloat changes can be visible in 1-2 weeks; meaningful jaw definition gains usually come with 6-12 weeks of lower body-fat plus consistent training.'",
  "categories": [
    {"label":"Posture & mewing","steps":["2-3 specific posture / tongue-position habits"]},
    {"label":"Active training","steps":["2-3 specific jaw / neck exercises with reps or duration"]},
    {"label":"De-bloat & body-fat","steps":["2-3 nutrition / lifestyle habits to reduce facial bloat and lower body-fat"]},
    {"label":"Camera & grooming","steps":["1-2 ways to make the jaw look sharper in photos"]}
  ],
  "realistic_caveat": "1 short sentence that frankly acknowledges bone structure cannot change, but visible definition can"
}
Rules:
- Posture & mewing MUST cover: tongue posture (tongue flat on the roof of the mouth, lips closed, breathing through the nose), chin slightly tucked, shoulders back, and avoiding the head-forward / neck-down phone slouch.
- Active training MUST include: specific exercises with reps or duration (e.g. "Chin tucks: 3 sets of 10, hold 5s each", "Neck extension stretch: hold 8s, 3x per side", "Firm gum or jaw trainer: 10 min per side, alternate days"). Warn to stop if the jaw aches.
- De-bloat & body-fat MUST cover: lowering added salt, limiting alcohol, sleeping 7-8h, hydrating through the day, AND lowering overall body-fat with a mild calorie deficit + higher protein so under-chin fat stops hiding the jaw.
- Camera & grooming SHOULD cover: side / 3⁄4 lighting, chin slightly forward (not down), keeping stubble and neckline tidy.
- Each step is ONE short, specific, actionable instruction (≆30-90 chars). No extreme dieting (do not suggest crash deficits or fasting beyond 16h), no harmful advice.
- expected_timeline must be realistic and honest.
- The user has a sub-score around ${scoreHint ?? "unknown"}/100; if it is below 60, the lowest-hanging fruit is usually de-bloat + posture (lead with those); if it is already high, focus on refinement and camera.
- Encouraging tone.`;
    // Outer retry: callOpenRouter only retries on HTTP failure, not on JSON
    // parse failure. The skin-plan prompt is long enough that the model
    // occasionally drops a stray field (e.g. omits "categories") or returns
    // markdown instead of pure JSON, which throws here and silently falls
    // back to the static plan. Retry the full parse+validate up to 3 times
    // so a single bad response from Gemini doesn't degrade the iOS UI.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await callOpenRouter(env, prompt, [], { tries: 2 });
        if (!result.ok || !result.text) continue;
        let txt = String(result.text).trim();
        if (txt.startsWith("```")) txt = txt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
        const start = txt.indexOf("{");
        const end = txt.lastIndexOf("}");
        if (start >= 0 && end > start) txt = txt.slice(start, end + 1);
        const parsed = JSON.parse(txt);

        // Normalize categories[].steps[]: each step trimmed, non-empty, capped.
        const categories = Array.isArray(parsed.categories)
          ? parsed.categories
              .map(c => ({
                label: String((c && c.label) || "").trim(),
                steps: Array.isArray(c && c.steps)
                  ? c.steps.map(s => String(s || "").trim()).filter(Boolean).slice(0, 4)
                  : []
              }))
              .filter(c => c.label && c.steps.length)
              .slice(0, 5)
          : [];

        // Legacy flat steps: prefer model's flat array if provided, else
        // flatten categories so an un-upgraded client still works.
        let flatSteps = Array.isArray(parsed.steps)
          ? parsed.steps.map(s => String(s || "").trim()).filter(Boolean).slice(0, 10)
          : [];
        if (!flatSteps.length && categories.length) {
          flatSteps = categories.flatMap(c => c.steps.map(s => `${c.label}: ${s}`)).slice(0, 12);
        }

        const text = parsed && typeof parsed.text === "string" ? parsed.text.trim() : "";
        const timeline = parsed && typeof parsed.expected_timeline === "string" ? parsed.expected_timeline.trim() : "";
        const tail = type === "skin-plan"
          ? (parsed && typeof parsed.red_flags === "string" ? parsed.red_flags.trim() : "")
          : (parsed && typeof parsed.realistic_caveat === "string" ? parsed.realistic_caveat.trim() : "");

        // Require the FULL structured payload: overview + ≥3 categories +
        // timeline + tail. A response missing categories is the failure
        // mode we just fixed — retry instead of returning a degraded plan.
        const totalSteps = categories.reduce((n, c) => n + c.steps.length, 0);
        const structured = text && categories.length >= 3 && totalSteps >= 4 && timeline && tail;
        if (structured) {
          return json({
            ok: true,
            source: "openrouter",
            data: {
              title: map[type].title,
              text,
              expected_timeline: timeline,
              [type === "skin-plan" ? "red_flags" : "realistic_caveat"]: tail,
              categories,
              steps: flatSteps
            },
            input: body
          });
        }
        // Loosened fallback: on the final attempt, if we at least have an
        // overview + 3 flat steps, return that as openrouter (better than
        // static) — still flagged as openrouter so the client renders it.
        if (attempt === 2 && text && (totalSteps >= 3 || flatSteps.length >= 3)) {
          return json({
            ok: true,
            source: "openrouter",
            data: {
              title: map[type].title,
              text,
              expected_timeline: timeline || null,
              [type === "skin-plan" ? "red_flags" : "realistic_caveat"]: tail || null,
              categories,
              steps: flatSteps
            },
            input: body
          });
        }
      } catch {
        // JSON parse error or unexpected shape — fall through to next attempt.
      }
    }
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

async function callOpenAIFoodScan(env, body, fallback) {
  const key = String(env.OPENAI_API_KEY || "").trim();
  if (!key) return { ok: true, source: "fallback", data: fallback, reason: "OPENAI_API_KEY missing" };

  // OpenAI Chat Completions vision payload — pass the meal photo as a
  // data URL via image_url parts. Same prompt schema as the Gemini path
  // so the client never has to branch on `source`.
  const image = String(body.image || "");
  if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(image)) {
    return { ok: true, source: "fallback", data: fallback, reason: "image missing or malformed" };
  }

  const prompt = `
You are FaceMax AI, a premium app analysing how a meal affects next-morning facial bloating.
Look at the attached photo. Write in English. Return only valid JSON without markdown.

Rules:
- Do not mention OpenAI, the model, or any technical details.
- Do not give medical diagnoses or warnings.
- Be specific to what you see in the photo, not generic.
- bloat_score is 0..100 where 0 is no bloating impact and 100 is severe.
- bloat_label must match the score: 0-30 "Low", 31-55 "Moderate", 56-75 "High", 76-100 "Severe".
- All level fields must be one of: "low", "medium", "high".
- key_ingredients: 3 items, each with name, impact ("low"|"medium"|"high") and a one-sentence note.
- swaps: 3 concrete, actionable swaps the user could make next time.
- If the photo is not food, set detected to "No meal detected" and bloat_score to 0.

Return strictly JSON with the schema:
{ "detected","bloat_score","bloat_label","calories_est","sodium_level","sugar_level","processed_level",
  "dairy_level","alcohol_level","summary","why",
  "key_ingredients":[{"name","impact","note"},{"name","impact","note"},{"name","impact","note"}],
  "swaps":["","",""],"tip":"" }`;

  const model = String(env.OPENAI_VISION_MODEL || "gpt-4o-mini").trim() || "gpt-4o-mini";
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify({
        model,
        temperature: 0.35,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are FaceMax AI. Reply with strict JSON only." },
          { role: "user", content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: image } },
          ] },
        ],
      }),
    });
    const data = await res.json().catch(() => ({}));
    const txt = data?.choices?.[0]?.message?.content;
    if (!res.ok || !txt) {
      return { ok: true, source: "fallback", data: fallback, reason: "OpenAI API error", status: res.status, details: data?.error?.message || null };
    }
    let parsed;
    try { parsed = JSON.parse(txt); } catch {
      return { ok: true, source: "fallback", data: fallback, reason: "OpenAI returned non-JSON" };
    }
    return { ok: true, source: "openai", data: parsed };
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
  } else {
    return json({ ok: false, error: "user_id required" }, 400);
  }
  const fallback = fallbackFoodScan();
  // Prefer OpenRouter for vision (food scan always has an image). Fall back to
  // OpenAI if OpenRouter is unavailable.
  let result;
  const hasOpenRouter = !!String(env.OPENROUTER_API_KEY || "").trim();
  const hasOpenAI = !!String(env.OPENAI_API_KEY || "").trim();
  if (hasOpenRouter) {
    result = await callGeminiFoodScan(env, body, fallback);
    if (result.source === "fallback" && hasOpenAI) {
      result = await callOpenAIFoodScan(env, body, fallback);
    }
  } else if (hasOpenAI) {
    result = await callOpenAIFoodScan(env, body, fallback);
  } else {
    result = { ok: true, source: "fallback", data: fallback, reason: "no AI key configured" };
  }
  return json(result);
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
          "/api/lava-config-check",
          "/api/create-lava-invoice",
          "/api/lava-webhook",
          "/api/gemini-config-check",
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
        model: "gemini-2.5-flash",
        note: String(env.GEMINI_API_KEY || "").trim() ? "Gemini key present" : "GEMINI_API_KEY missing"
      });

      if (path === "/api/openai-config-check") return json({
        ok: true,
        openai_api_key_present: !!String(env.OPENAI_API_KEY || "").trim(),
        model: String(env.OPENAI_REPORT_MODEL || "gpt-4o-mini"),
        note: String(env.OPENAI_API_KEY || "").trim() ? "OpenAI key present" : "OPENAI_API_KEY missing (set via wrangler secret put OPENAI_API_KEY)"
      });

      if (path === "/api/lava-config-check") return json({
        ok: true,
        lava_api_key_present: !!getLavaApiKey(env),
        lava_webhook_secret_present: !!getLavaWebhookSecret(env),
        offer_id_full: getLavaOfferIdFor(env, "full"),
        offer_id_starter: getLavaOfferIdFor(env, "starter"),
        offer_id: getLavaOfferId(env),
        currency: getLavaCurrency(env),
        email_domain: LAVA_EMAIL_DOMAIN,
        plans: {
          full: { days: PREMIUM_DAYS_FULL, offer_id: getLavaOfferIdFor(env, "full") },
          starter: { days: PREMIUM_DAYS_STARTER, offer_id: getLavaOfferIdFor(env, "starter") },
        },
      });
      if (path === "/api/create-lava-invoice" && request.method === "POST") return await createLavaInvoice(request, env);
      if (path === "/api/lava-webhook" && request.method === "POST") return await lavaWebhook(request, env);

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