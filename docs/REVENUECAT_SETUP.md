# RevenueCat setup

This guide configures FaceMax AI's iOS subscriptions through RevenueCat,
so Apple In-App Purchase, entitlement state and webhook delivery to our
Cloudflare Worker are all managed in one place.

## 1. App Store Connect — products

Create three products in subscription group `facemax_premium`:

| Product ID                    | Type                | Duration  |
|-------------------------------|---------------------|-----------|
| `ai.facemax.app.weekly`       | Auto-renewable      | 7 days    |
| `ai.facemax.app.monthly`      | Auto-renewable      | 1 month   |
| `ai.facemax.app.lifetime`     | Non-consumable      | —         |

Tax category: `Digital services`. Cleared for sale in all territories.

Localize each product's display name + description. Keep the language
factual (e.g. "FaceMax Premium — monthly").

## 2. RevenueCat dashboard

1. Create a project named `facemax-ai`.
2. Add an iOS app with bundle ID `ai.facemax.app`.
3. Upload an App Store Connect API key (.p8) generated under
   "Users and Access → Keys" with role `App Manager`. RevenueCat needs
   this to read receipts.
4. Under "Products" sync from App Store Connect — the three IDs above
   should appear.
5. Create an entitlement called `premium` and attach **all three**
   products to it.
6. Create an offering called `default` with three packages:
   - `$rc_weekly` → `ai.facemax.app.weekly`
   - `$rc_monthly` → `ai.facemax.app.monthly`
   - `$rc_lifetime` → `ai.facemax.app.lifetime`

## 3. RevenueCat → Cloudflare webhook

RevenueCat → Project Settings → Integrations → Webhooks.

- **URL**: `https://facemax-api.voou96329.workers.dev/api/apple-server-notification`
- **Authorization header**: set to a long random string and store the
  same string as the Worker secret `REVENUECAT_WEBHOOK_AUTH`.

The Worker currently accepts Apple-shaped `signedPayload` requests
on this endpoint; a small adapter for RevenueCat-shaped event bodies
will be added in a follow-up PR.

## 4. iOS client integration

The `web/js/native-bridge.js` file already wires up
`@revenuecat/purchases-capacitor`. Before publishing:

1. Set `window.FACEMAX_REVENUECAT_API_KEY` to your **iOS public SDK key**
   (RevenueCat dashboard → API Keys → "App-specific" → iOS). The key
   starts with `appl_`.
   - Easiest: add a tiny `<script>window.FACEMAX_REVENUECAT_API_KEY = "appl_xxxx"</script>`
     just before the `<script src="js/native-bridge.js"></script>` tag.
   - Or read it from a `meta` tag and inject at build time.
2. Pass our internal `user_id` (`facemax_uid` from localStorage) as the
   RevenueCat `appUserID`. The native bridge already does this in
   `initRevenueCat(userId)`.

## 5. Server-side confirmation

When a purchase succeeds, the native bridge:

1. Reads `customerInfo.entitlements.active.premium`.
2. POSTs to `/api/apple-receipt-verify` so the Cloudflare KV (which the
   web also reads) reflects the new state immediately.
3. RevenueCat's webhook to `/api/apple-server-notification` keeps the KV
   in sync on renewals, refunds and cancellations.

## 6. Sandbox testing

- Create a Sandbox Tester in App Store Connect.
- On the iPhone, sign out of the App Store, install the build via
  TestFlight or Xcode, then trigger a purchase — iOS will prompt for the
  Sandbox tester credentials.
- Use `https://app.revenuecat.com/customers` to verify the test user
  shows an active `premium` entitlement.

## 7. Local development

The Worker is shared between web and iOS, so you can develop both with:

```bash
cd workers/api && npx wrangler dev --local
```

The frontend will then point to `http://localhost:8787` if you change
`API_BASE` in `web/index.html` (or via a `?api=` query param).
