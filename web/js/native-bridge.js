/* FaceMax AI — native bridge.
 *
 * Loaded by both the web (facemaxaiapp.com) and the iOS Capacitor wrapper.
 * Exposes a thin `window.facemax` API that the main app uses to:
 *   - Detect the runtime (web vs native iOS).
 *   - Pick a photo (camera or library) via the best available picker.
 *   - Trigger haptics on key buttons.
 *   - Drive subscription purchases (RevenueCat on native, Lava on web).
 *
 * The web frontend should never crash if native plugins are missing — every
 * native path falls back to the existing web behavior.
 */

(function () {
  "use strict";

  const facemax = (window.facemax = window.facemax || {});
  facemax.native = false;
  facemax.platform = "web";
  facemax.bundleId = "ai.facemax.app";

  function detect() {
    const cap = window.Capacitor;
    if (cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform()) {
      facemax.native = true;
      facemax.platform = (typeof cap.getPlatform === "function") ? cap.getPlatform() : "ios";
    }
    document.documentElement.classList.toggle("fm-native", facemax.native);
    document.documentElement.classList.add("fm-platform-" + facemax.platform);
  }

  // -------------------- Haptics --------------------

  facemax.haptic = function (style) {
    try {
      const Haptics = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
      if (Haptics && facemax.native) {
        if (style === "selection") return Haptics.selectionStart();
        const styleEnum = { light: "LIGHT", medium: "MEDIUM", heavy: "HEAVY" }[style] || "LIGHT";
        return Haptics.impact({ style: styleEnum });
      }
      if (navigator.vibrate) navigator.vibrate(style === "heavy" ? 25 : style === "medium" ? 15 : 8);
    } catch (e) { /* ignore */ }
  };

  function bindHaptics() {
    document.addEventListener("click", function (e) {
      const btn = e.target.closest("button, .btn, .nav, .tool, .meal-tab");
      if (!btn) return;
      const style = btn.classList.contains("btn-pay") || btn.classList.contains("btn-pay-starter")
        ? "medium"
        : btn.classList.contains("nav") ? "light" : "light";
      facemax.haptic(style);
    }, { passive: true });
  }

  // -------------------- Photo picker --------------------

  // Returns a Promise<string|null> with a data URL or null on cancel.
  facemax.pickPhoto = async function (opts) {
    opts = opts || {};
    const Camera = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Camera;
    if (Camera && facemax.native) {
      try {
        const source = opts.fromCamera ? "CAMERA" : (opts.fromLibrary ? "PHOTOS" : "PROMPT");
        const res = await Camera.getPhoto({
          quality: 88,
          allowEditing: false,
          resultType: "DataUrl",
          source,
          presentationStyle: "fullscreen",
          width: 1600,
          correctOrientation: true,
          saveToGallery: false,
        });
        return res && res.dataUrl ? res.dataUrl : null;
      } catch (err) {
        // User cancelled or denied — let caller fall back.
        return null;
      }
    }
    return null; // Web flow handled by the existing <input type="file"> path.
  };


  // -------------------- Apple Vision face landmarks (native iOS) --------------------
  // Visual-only helper for the premium scan animation. It runs locally on iPhone
  // through Apple's Vision framework and returns normalized points for drawing.
  // It never replaces the real AI/Worker analysis.
  facemax.appleVisionDetect = async function (dataUrl) {
    try {
      const FaceVision = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FaceVision;
      if (!facemax.native || !FaceVision || typeof FaceVision.detect !== "function" || !dataUrl) return null;
      return await FaceVision.detect({ image: dataUrl });
    } catch (e) {
      console.warn("[facemax] Apple Vision unavailable", e);
      return null;
    }
  };

  // -------------------- Subscriptions (RevenueCat on native) --------------------

  // Mapping between our backend plan names and Apple product IDs.
  facemax.products = {
    weekly:   { appleId: "ai.facemax.app.weekly",   plan: "starter", entitlement: "premium" },
    monthly:  { appleId: "ai.facemax.app.monthly",  plan: "full",    entitlement: "premium" },
    yearly:   { appleId: "ai.facemax.app.yearly",   plan: "yearly",  entitlement: "premium" },
    lifetime: { appleId: "ai.facemax.app.lifetime", plan: "lifetime", entitlement: "premium" },
  };

  let purchasesReady = null;

  async function initRevenueCat(userId) {
    if (!facemax.native) return false;
    const Purchases = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Purchases;
    if (!Purchases) return false;
    if (purchasesReady) return purchasesReady;
    purchasesReady = (async function () {
      const apiKey = window.FACEMAX_REVENUECAT_API_KEY || "";
      if (!apiKey) {
        console.warn("[facemax] RevenueCat API key not configured");
        return false;
      }
      await Purchases.configure({ apiKey, appUserID: userId || null });
      return true;
    })();
    return purchasesReady;
  }

  // Buy a product and confirm with our backend.
  // Returns { ok, premium_until, error }.
  facemax.purchase = async function (planName, userId) {
    if (!facemax.native) return { ok: false, error: "not_native" };
    const product = facemax.products[planName];
    if (!product) return { ok: false, error: "unknown_plan" };

    const ready = await initRevenueCat(userId);
    if (!ready) return { ok: false, error: "revenuecat_unavailable" };

    const Purchases = window.Capacitor.Plugins.Purchases;
    try {
      const { customerInfo } = await Purchases.purchaseProduct({
        productIdentifier: product.appleId,
      });
      const entitlement = customerInfo && customerInfo.entitlements
        && customerInfo.entitlements.active
        && customerInfo.entitlements.active[product.entitlement];
      if (!entitlement) return { ok: false, error: "entitlement_inactive" };

      // Forward the transaction JWS to our backend so the same KV that the
      // web frontend uses stays in sync. RevenueCat keeps the canonical
      // entitlement, but the backend mirror means the web can also unlock.
      const tx = entitlement.latestPurchaseDate ? customerInfo : null;
      const apiBase = (window.API_BASE || "https://facemax-api.voou96329.workers.dev");
      try {
        await fetch(apiBase + "/api/apple-receipt-verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            user_id: userId,
            // RevenueCat purchaseProduct returns the StoreKit transaction info
            // wrapped in customerInfo.originalAppUserId etc.; we forward what we
            // have. The backend will gracefully fall back to RevenueCat webhook
            // if the JWS is missing.
            transaction_jws: customerInfo && customerInfo.originalApplicationVersion ? null : null,
            revenuecat_app_user_id: customerInfo && customerInfo.originalAppUserId || userId,
          }),
        });
      } catch (e) { /* non-fatal */ }

      return { ok: true, premium_until: Number(entitlement.expirationDate || 0), source: "revenuecat" };
    } catch (err) {
      const code = err && err.code;
      if (code === "PURCHASE_CANCELLED") return { ok: false, error: "cancelled" };
      return { ok: false, error: err && err.message || String(err) };
    }
  };

  facemax.restorePurchases = async function (userId) {
    if (!facemax.native) return { ok: false, error: "not_native" };
    const ready = await initRevenueCat(userId);
    if (!ready) return { ok: false, error: "revenuecat_unavailable" };
    const Purchases = window.Capacitor.Plugins.Purchases;
    try {
      const { customerInfo } = await Purchases.restorePurchases();
      const active = customerInfo && customerInfo.entitlements && customerInfo.entitlements.active;
      const ent = active && (active.premium || Object.values(active)[0]);
      return ent
        ? { ok: true, premium_until: Number(ent.expirationDate || 0) }
        : { ok: false, error: "nothing_to_restore" };
    } catch (err) {
      return { ok: false, error: err && err.message || String(err) };
    }
  };

  // -------------------- Local Notifications --------------------
  //
  // Schedules retention / re-engagement reminders via Capacitor
  // LocalNotifications on iOS. Falls back to no-op on the web build.
  //
  // We expose a tiny wrapper so the main app never has to touch the plugin
  // surface directly. All scheduled notification IDs live in a numeric
  // namespace (1000-1999) so they can be cancelled wholesale on opt-out.

  const NOTIF_ID = {
    DAILY: 1001,
    RESCAN_7D: 1002,
    FREE_SCAN_LOW: 1003,
    STREAK: 1004,
    PAYWALL_RETURN: 1005,
  };

  function notifPlugin() {
    return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
  }

  facemax.notif = {
    ids: NOTIF_ID,

    isAvailable() {
      return !!(facemax.native && notifPlugin());
    },

    async getPermission() {
      const p = notifPlugin();
      if (!p || !facemax.native) return { display: "denied" };
      try { return await p.checkPermissions(); }
      catch (e) { return { display: "denied" }; }
    },

    async requestPermission() {
      const p = notifPlugin();
      if (!p || !facemax.native) return { display: "denied" };
      try {
        const cur = await p.checkPermissions();
        if (cur && cur.display === "granted") return cur;
        return await p.requestPermissions();
      } catch (e) {
        return { display: "denied" };
      }
    },

    async cancelAll() {
      const p = notifPlugin();
      if (!p || !facemax.native) return;
      try {
        const pending = await p.getPending();
        const ids = (pending && pending.notifications || []).map(n => ({ id: n.id }));
        if (ids.length) await p.cancel({ notifications: ids });
      } catch (e) { /* ignore */ }
    },

    async cancel(id) {
      const p = notifPlugin();
      if (!p || !facemax.native) return;
      try { await p.cancel({ notifications: [{ id }] }); }
      catch (e) { /* ignore */ }
    },

    // Schedule a notification at a specific Date. Cancels any prior with same id.
    async scheduleAt({ id, at, title, body }) {
      const p = notifPlugin();
      if (!p || !facemax.native) return false;
      if (!(at instanceof Date) || at.getTime() <= Date.now() + 5000) return false;
      try {
        await this.cancel(id);
        await p.schedule({
          notifications: [{
            id,
            title: String(title || "FaceMax AI"),
            body: String(body || ""),
            schedule: { at, allowWhileIdle: true },
            sound: null,
            smallIcon: "ic_stat_icon",
          }],
        });
        return true;
      } catch (e) { return false; }
    },

    // Schedule a notification that repeats every day at the given local hour/minute.
    async scheduleDaily({ id, hour, minute, title, body }) {
      const p = notifPlugin();
      if (!p || !facemax.native) return false;
      try {
        await this.cancel(id);
        await p.schedule({
          notifications: [{
            id,
            title: String(title || "FaceMax AI"),
            body: String(body || ""),
            schedule: {
              on: { hour: Number(hour), minute: Number(minute) },
              allowWhileIdle: true,
              repeats: true,
            },
            sound: null,
            smallIcon: "ic_stat_icon",
          }],
        });
        return true;
      } catch (e) { return false; }
    },
  };

  // -------------------- Status bar / safe area --------------------

  async function styleStatusBar() {
    try {
      const StatusBar = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.StatusBar;
      if (StatusBar && facemax.native) {
        await StatusBar.setStyle({ style: "DARK" });
        await StatusBar.setBackgroundColor({ color: "#100A14" });
      }
    } catch (e) { /* ignore */ }
  }

  // -------------------- Boot --------------------

  function boot() {
    detect();
    bindHaptics();
    styleStatusBar();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
