# ChatGPT iOS/Appetize layout fixes

Applied to this archive to make the Capacitor iOS build less broken in Appetize/iOS WebView.

## Changed

1. `capacitor.config.json`
   - `ios.contentInset`: `always` -> `never`
   - `ios.scrollEnabled`: `false` -> `true`

   Reason: the previous build disabled the native WKWebView scroll view and then tried to make `body` the scroll container. That commonly breaks height, safe-area handling, bottom navigation and keyboard behavior in iOS simulators/Appetize.

2. `web/index.html`
   - Removed the native-only `html.fm-native { height:100%; overflow:hidden }` pattern.
   - Replaced it with native scrolling using `min-height` and `overflow-y:auto`.
   - Changed `.app` sizing from `width:min(100%,460px); min-height:100svh` to `width:100%; max-width:460px; min-height:100dvh` with an `svh` fallback.
   - Stabilized the bottom tab bar offset with `calc(8px + env(safe-area-inset-bottom,0px))`.

3. `ios/App/App/public/`
   - Added/synced the `web/` bundle into the iOS project.

   Reason: the Xcode project references `App/public`, but the uploaded archive did not include it. Opening or uploading the iOS project without running `npx cap sync ios` could therefore produce an empty/broken WebView.

4. `ios/App/App/capacitor.config.json`
   - Added/synced the Capacitor config into the iOS app bundle.

## Recommended next commands on macOS

```bash
npm install
npm run build:web
npx cap sync ios
cd ios/App
pod install
open App.xcworkspace
```

Build from `App.xcworkspace`, not `App.xcodeproj`.

## Still not fixed here

- RevenueCat key is still empty in `web/index.html`.
- Several URLs still point to preview/dev domains.
- The app is still one large single-file SPA, not a clean native Swift rewrite.
- Appetize may still differ from a real iPhone/TestFlight build, but these fixes remove the most obvious WebView/layout conflicts.
