# App Store submission checklist

Items to verify **before** every App Store Connect upload.

## 1. Apple Developer Program

- [ ] Active Apple Developer Program membership ($99 / year).
- [ ] Two-factor authentication enabled on the Apple ID.
- [ ] App ID `ai.facemax.app` registered with the Bundle ID.
- [ ] Push notifications **not** enabled (we don't use them yet — keeping
  the capability off avoids reviewer questions). Enable later if needed.
- [ ] Capabilities enabled: `In-App Purchase`, `Sign in with Apple`
  (planned), no others.

## 2. App Store Connect

- [ ] App record created with Bundle ID `ai.facemax.app`, primary
  language English, category **Health & Fitness** (secondary: Lifestyle).
- [ ] Subscription group `facemax_premium` with three products:
  - `ai.facemax.app.weekly` — auto-renewable, 7 days, e.g. $4.99
  - `ai.facemax.app.monthly` — auto-renewable, 1 month, e.g. $14.99
  - `ai.facemax.app.lifetime` — non-consumable, e.g. $69.99
- [ ] Localized subscription metadata + screenshots (Apple requires).
- [ ] Privacy nutrition labels filled in:
  - Data Used to Track You: **None**
  - Data Linked to You: Email (optional), Purchase History
  - Data Not Linked to You: Photos (transient, server-processed, deleted)
- [ ] Age rating: 4+ (no objectionable content).
- [ ] App Store Server API key (.p8) generated and stored as a Worker
  secret for `/api/apple-server-notification` signature verification.

## 3. Build settings

- [ ] Deployment target: iOS 16.0+ (Capacitor 7 floor).
- [ ] `LSRequiresIPhoneOS=true`, `UIRequiresFullScreen=true`.
- [ ] Portrait-only on iPhone (`UISupportedInterfaceOrientations`).
- [ ] Permissions strings present in `Info.plist`:
  - `NSCameraUsageDescription`
  - `NSPhotoLibraryUsageDescription`
  - `NSPhotoLibraryAddUsageDescription`
  - `NSMicrophoneUsageDescription` (required even if unused, because the
    camera plugin links AVFoundation)
- [ ] `ITSAppUsesNonExemptEncryption=false` (we only call HTTPS APIs).
- [ ] App Transport Security: no `NSAllowsArbitraryLoads=true`. We use
  per-domain exceptions for `workers.dev`, `facemaxaiapp.com`,
  `googleapis.com`, `gstatic.com`, `jsdelivr.net`.

## 4. UI / copy review (Guideline 4.2 — minimum functionality)

The app must clearly be more than a wrapped website. Verify:

- [ ] Tab bar at the bottom uses native iOS spacing + safe-area insets.
- [ ] Camera capture works without leaving the app (Capacitor camera).
- [ ] Haptic feedback on primary actions (Scan, Pay, Tab switch).
- [ ] Status bar / launch screen styled.
- [ ] Splash screen branded.
- [ ] Native back-gesture works (or the app provides an obvious back
  control everywhere).

## 5. Wording (Guidelines 1.1, 2.3, 5.0)

Avoid any phrasing that promises medical, weight loss or attractiveness
**outcomes**. Safe replacements:

| Avoid                              | Use instead                        |
|------------------------------------|------------------------------------|
| "Aesthetic potential"              | "Photo & grooming feedback"        |
| "Top 5% / Tier S"                  | "Strengths summary"                |
| "Looksmaxxing", "glow-up cure"     | "Self-care routine"                |
| "Make you hot / attractive"        | "Help you take better selfies"     |
| "Doctor-level analysis"            | "AI-powered photo feedback"        |
| Before/after weight claims         | None — keep claims qualitative     |

Always include a disclaimer near subscription paywalls:

> FaceMax AI provides cosmetic and lifestyle guidance only and is not a
> substitute for medical advice. Results vary.

## 6. Submission artefacts

- [ ] App icon: 1024×1024 PNG, no transparency, no rounded corners.
- [ ] Screenshots: at least 6.7" (1290×2796) and 5.5" (1242×2208).
- [ ] Promo text (170 chars).
- [ ] Description (4000 chars).
- [ ] Keywords (100 chars).
- [ ] Support URL: `https://facemaxaiapp.com/support`.
- [ ] Marketing URL: `https://facemaxaiapp.com`.
- [ ] Privacy Policy URL: `https://facemaxaiapp.com/privacy`.
- [ ] Demo account credentials for the reviewer (if any auth gates exist).

## 7. Pre-submission test pass

- [ ] Cold-launch on a real device: scan → result → upgrade → restore.
- [ ] Cold-launch with airplane mode → no crash, graceful empty state.
- [ ] Subscription purchase using a sandbox tester account.
- [ ] "Restore Purchases" button surfaces previously bought entitlement.
- [ ] Delete and reinstall → restore still works.
- [ ] Switch system language to Russian (existing copy is mostly EN) and
  verify nothing breaks layout.
