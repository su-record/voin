#!/bin/zsh
# voin.app을 빌드한다. 서버 코드·Node.js·모델을 모두 앱 안에 넣어 다른 맥에서도 설치 없이 돈다.
#   build-app.sh                       → /Applications(또는 ~/Applications)에 설치
#   build-app.sh --dist                → 팀원 배포용 DMG도 dist/에 만든다
#   build-app.sh --dist --with-model   → 받아쓰기 모델(751MB)까지 넣은 DMG (인터넷 없이 쓰는 팀원용)
# 기본은 받아쓰기 모델을 넣지 않는다. 앱이 처음 실행될 때 Hugging Face에서 받는다.
# 대상: Apple Silicon 맥, macOS 14.4 이상
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
APP_SRC="$PROJECT_DIR/native/app"
BUILD="$APP_SRC/build"
APP="$BUILD/voin.app"
RES="$APP/Contents/Resources"
VERSION="$(node -p "require('$PROJECT_DIR/package.json').version")" # 버전은 package.json 한 곳에서만 바꾼다

DIST=false; WITH_MODEL=false
for arg in "$@"; do
  case "$arg" in
    --dist) DIST=true ;;
    --with-model) WITH_MODEL=true ;;
    *) echo "알 수 없는 옵션: $arg"; exit 1 ;;
  esac
done

if $WITH_MODEL; then
  # 받아쓰기 모델: Hugging Face 캐시(Handy가 받아 둔 것) 또는 MODEL_PATH
  MODEL="${MODEL_PATH:-$(ls "$HOME"/.cache/huggingface/hub/models--handy-computer--nemotron-3.5-asr-streaming-0.6b-gguf/snapshots/*/*.gguf 2>/dev/null | head -1)}"
  [ -f "$MODEL" ] || { echo "받아쓰기 모델(.gguf)을 찾지 못했습니다. MODEL_PATH로 지정하세요."; exit 1; }
fi
[ -f "$PROJECT_DIR/models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx" ] || { echo "models/에 화자 분리 모델이 없습니다."; exit 1; }

rm -rf "$BUILD" && mkdir -p "$APP/Contents/MacOS" "$RES/app/native" "$RES/app/models" "$RES/bin"

echo "1/5 네이티브 코드 컴파일"
swiftc -O -target arm64-apple-macos14.4 "$PROJECT_DIR/native/syscap.swift" -o "$RES/app/native/syscap" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PROJECT_DIR/native/Info.plist" 2>/dev/null
swiftc -O -target arm64-apple-macos14.4 "$APP_SRC/MeetingNotesApp.swift" -o "$APP/Contents/MacOS/MeetingNotes"

echo "2/5 서버 코드와 라이브러리 복사"
cp "$PROJECT_DIR/server.mjs" "$PROJECT_DIR/package.json" "$RES/app/"
cp -R "$PROJECT_DIR/lib" "$PROJECT_DIR/public" "$PROJECT_DIR/node_modules" "$RES/app/"
lipo -thin arm64 "$(command -v node)" -output "$RES/bin/node"

echo "3/5 모델 복사"
if $WITH_MODEL; then cp "$MODEL" "$RES/app/models/"; fi
cp -R "$PROJECT_DIR/models/sherpa-onnx-pyannote-segmentation-3-0" "$PROJECT_DIR/models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx" "$RES/app/models/"

echo "4/5 아이콘과 Info.plist"
swift "$APP_SRC/make-icon.swift" "$BUILD/icon.png"
ICONSET="$BUILD/AppIcon.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$BUILD/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$BUILD/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RES/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>local.meeting-notes.app</string>
  <key>CFBundleName</key><string>voin</string>
  <key>CFBundleDisplayName</key><string>voin</string>
  <key>CFBundleExecutable</key><string>MeetingNotes</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.4</string>
  <key>LSArchitecturePriority</key><array><string>arm64</string></array>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>말한 내용을 받아쓰기 위해 마이크를 사용합니다.</string>
  <key>NSAudioCaptureUsageDescription</key><string>화상회의 상대방 목소리를 받아쓰기 위해 시스템 오디오를 녹음합니다.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

echo "5/5 서명(ad-hoc)"
# 앱 안의 실행 코드(dylib, .node, node, syscap)를 모두 서명한 뒤 앱 전체를 서명한다
find "$RES" -type f \( -name "*.dylib" -o -name "*.node" -o -name "*.so" \) -exec codesign --force --sign - {} \; 2>/dev/null
codesign --force --sign - "$RES/bin/node" "$RES/app/native/syscap"
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"

DEST=/Applications
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
rm -rf "$DEST/voin.app" "$DEST/Recap.app" "$DEST/회의록.app" # 예전 이름(Recap·회의록)으로 설치된 앱도 지운다
cp -R "$APP" "$DEST/"
echo "설치 완료: $DEST/voin.app ($(du -sh "$APP" | cut -f1))"

if $DIST; then
  # 팀원 배포용 DMG: 앱 + 응용 프로그램 폴더 바로가기(끌어다 놓아 설치) + 설치 안내 + 테스트 음성
  DIST_DIR="$PROJECT_DIR/dist"
  STAGE="$BUILD/dmg"
  SUFFIX=""; if $WITH_MODEL; then SUFFIX="-모델포함"; fi
  DMG="$DIST_DIR/voin-$VERSION$SUFFIX.dmg"
  mkdir -p "$DIST_DIR" "$STAGE"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/응용 프로그램"
  cp "$PROJECT_DIR/docs/팀원-설치-안내.md" "$STAGE/설치 안내.md"
  cp "$PROJECT_DIR/samples/4명-테스트.wav" "$STAGE/테스트용 음성 (4명).wav"
  rm -f "$DMG"
  hdiutil create -volname "voin $VERSION" -srcfolder "$STAGE" -fs APFS -format ULFO "$DMG" >/dev/null
  codesign --force --sign - "$DMG"
  echo "배포 파일: $DMG ($(du -sh "$DMG" | cut -f1))"
fi
