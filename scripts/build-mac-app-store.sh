#!/bin/bash
# Builds the Mac App Store version of Project MD as a signed .pkg, ready to
# upload with Apple's Transporter app.
#
#   scripts/build-mac-app-store.sh 3
#
# The number is the build number. It must be higher than any build already
# uploaded for this version (App Store Connect rejects repeats).
#
# Needs, once (see "Mac App Store" in README.md):
#   - "Apple Distribution" and "Mac Installer Distribution" certificates in the keychain
#   - src-tauri/appstore/embedded.provisionprofile (Mac App Store profile for com.projectmd.board)
#
# The GitHub download is unaffected: it is still built by the Release workflow.
set -euo pipefail
cd "$(dirname "$0")/.."

BUILD="${1:-}"
if [[ ! "$BUILD" =~ ^[0-9]+$ ]]; then
  echo "Usage: $0 <build number>   e.g. $0 3" >&2
  exit 1
fi
if [ ! -f src-tauri/appstore/embedded.provisionprofile ]; then
  echo "Missing src-tauri/appstore/embedded.provisionprofile (download it from developer.apple.com)." >&2
  exit 1
fi
INSTALLER_ID=$(security find-identity -v | grep -oE '"(3rd Party Mac Developer Installer|Mac Installer Distribution)[^"]*"' | head -1 | tr -d '"' || true)
if [ -z "$INSTALLER_ID" ]; then
  echo "No \"Mac Installer Distribution\" certificate found in the keychain." >&2
  exit 1
fi

rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null

npx tauri build \
  --target universal-apple-darwin \
  --features app-store \
  --config src-tauri/tauri.appstore.conf.json \
  --config "{\"bundle\":{\"macOS\":{\"bundleVersion\":\"$BUILD\"}}}"

APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/Project MD.app"
VERSION=$(node -p 'require("./src-tauri/tauri.conf.json").version')
PKG="src-tauri/target/Project-MD-${VERSION}-${BUILD}-AppStore.pkg"

xcrun productbuild --sign "$INSTALLER_ID" --component "$APP" /Applications "$PKG"

echo
echo "Done: $PKG"
echo "Upload it with the Transporter app (free on the Mac App Store)."
