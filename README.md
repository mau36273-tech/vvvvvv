# FaceMax AI

AI-powered facial analysis and daily debloat / glow-up plan. Web frontend
([facemaxaiapp.com](https://facemaxaiapp.com)) and native iOS app share the
same Cloudflare Workers backend.

## Repository layout

```
.
├── web/                    Web frontend (static index.html + assets + js/)
├── workers/api/            Cloudflare Worker — REST API + AI proxy
├── ios/App/                Capacitor iOS Xcode project
├── capacitor.config.json   Capacitor config (appId, webDir, plugins)
├── scripts/                Small build / sync helpers
├── docs/                   App Store / RevenueCat / Apple setup notes
└── .github/workflows/      CI (iOS build, Worker deploy)
```

## Quick start

### 1. Web only (no native)

```bash
npx serve web   # or open web/index.html directly
```

The frontend talks to `https://facemax-api.voou96329.workers.dev` by default.

### 2. iOS (Capacitor)

Requires macOS with Xcode 16+, Ruby 3.2+ and CocoaPods.

```bash
npm install
npx cap sync ios
cd ios/App && pod install
open App.xcworkspace
```

Inside Xcode, select an iOS 16+ simulator and Run. The app loads the
contents of `web/` directly from the bundle.

### 3. Deploying the Worker

```bash
cd workers/api
npx wrangler deploy --minify
```

You'll need `CLOUDFLARE_API_TOKEN` exported (or set via `wrangler login`)
and the secrets configured per `wrangler.toml`.

## Architecture

- **Frontend** (`web/index.html`) — single-file SPA, vanilla JS, MediaPipe
  FaceLandmarker for on-device face landmark detection. The face score is
  derived entirely on-device from 478 landmarks + blendshapes (no photo
  upload). For the premium full report the app sends only the numeric
  MediaPipe feature vector (symmetry / jawline / cheekbones / eyes / lips
  / nose / harmony / skin and the detected face shape) to the Worker — the
  user's selfie never leaves the device for face-analysis flows.
- **Worker** (`workers/api/src/index.js`) — Cloudflare Worker exposing
  `/api/full-report`, `/api/food-scan`, `/api/dating-photo`,
  `/api/haircut-guide`, `/api/skin-plan`, `/api/jawline-plan`,
  `/api/premium-status`, plus payment webhooks (Lava, Apple S2S) and
  receipt verification (`/api/apple-receipt-verify`). The face report
  uses OpenAI ChatGPT (`gpt-4o-mini`) over text-only messages built from
  the MediaPipe metrics; food scan uses OpenAI vision with the food
  photo. Gemini is kept as a fallback for legacy web traffic. Stores
  premium entitlements in `PREMIUM_KV`.
- **Native bridge** (`web/js/native-bridge.js`) — exposes `window.facemax`
  with capability detection. On iOS it routes purchases through
  RevenueCat / StoreKit and forwards the transaction JWS to the Worker
  for verification.

## Subscriptions

- **iOS** — Apple In-App Purchase via [RevenueCat](https://www.revenuecat.com/).
  Products configured in App Store Connect:
  - `ai.facemax.app.weekly` — auto-renewable weekly
  - `ai.facemax.app.monthly` — auto-renewable monthly
  - `ai.facemax.app.lifetime` — non-consumable
- **Web** — [Lava.top](https://lava.top) (existing flow).

The Worker maps both to the same `PREMIUM_KV` entitlement, so users who
buy on iOS see their premium on the web (and vice versa) when signed in
with the same `user_id`.

## License

Proprietary. All rights reserved.
