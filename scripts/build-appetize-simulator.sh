#!/usr/bin/env bash
set -euo pipefail

# Builds an unsigned iOS Simulator .app and zips it in the format Appetize accepts.
# Run from the project root on a Mac with Xcode installed.

APP_NAME="App"
SCHEME="App"
WORKSPACE="ios/App/App.xcworkspace"
DERIVED_DATA="ios/App/build"
OUTPUT_ZIP="FaceMaxAI-Appetize-Simulator.app.zip"

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "ERROR: xcodebuild not found. Install Xcode and run this on macOS." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found. Install Node.js 20+." >&2
  exit 1
fi

npm ci
npx cap sync ios

cd ios/App

if command -v pod >/dev/null 2>&1; then
  pod install --repo-update
else
  echo "CocoaPods not found. Installing CocoaPods..."
  sudo gem install cocoapods -v 1.16.2 --no-document
  pod install --repo-update
fi

xcodebuild \
  -workspace App.xcworkspace \
  -scheme "$SCHEME" \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  build

APP_PATH="build/Build/Products/Debug-iphonesimulator/${APP_NAME}.app"
if [ ! -d "$APP_PATH" ]; then
  echo "ERROR: .app not found at $APP_PATH" >&2
  find build/Build/Products -name "*.app" -print || true
  exit 1
fi

rm -f "../../$OUTPUT_ZIP"
cd "$(dirname "$APP_PATH")"
ditto -c -k --keepParent "${APP_NAME}.app" "../../../../../$OUTPUT_ZIP"

echo "Done: $OUTPUT_ZIP"
echo "Upload this ZIP to Appetize. Do not upload the source project ZIP."
