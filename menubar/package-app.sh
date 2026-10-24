#!/bin/bash
# 외부 배포용 유니버설 앱 번들(CC Menubar.app) 만들기.
#  - arm64·x86_64를 따로 컴파일하고 lipo로 합친다(Apple Silicon·Intel 공용).
#  - Info.plist(LSUIElement, 최소 macOS 13)로 번들을 조립하고 ad-hoc 서명(codesign -s -)만 한다.
#  - zip과 sha256을 .build/dist/에 만든다.
# 내부 설치용 build.sh(단일 arm64 바이너리)와 내부 설치 경로는 이 스크립트와 무관하게 그대로 쓴다.
# 테스트 러너(run-tests.sh)는 돌리지 않는다. Release 워크플로가 먼저 돌린다.
# 스냅샷 스모크 2종은 합친 바이너리로 돌린다(CC_MENUBAR_SKIP_SNAPSHOT=1이면 생략).
#
# 사용: bash menubar/package-app.sh [버전]
#       버전 우선순위: 인자 > MENUBAR_VERSION > 태그 menubar-v<버전>(GITHUB_REF_NAME 또는 git describe) > 0.0.0-dev
#       bash menubar/package-app.sh --info-plist-only <출력 경로> <버전>   (Info.plist만 만든다, 테스트용)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="CC Menubar"
APP_BUNDLE="CC Menubar.app"
EXECUTABLE="cc-menubar"
BUNDLE_ID="dev.teamclaude.cc-menubar"
MIN_MACOS="13.0"

write_info_plist() {
    local out="$1" version="$2"
    python3 - "$out" "$version" "$APP_NAME" "$EXECUTABLE" "$BUNDLE_ID" "$MIN_MACOS" <<'PY'
import plistlib, sys
out, version, name, executable, bundle_id, min_macos = sys.argv[1:7]
info = {
    "CFBundleDevelopmentRegion": "ko",
    "CFBundleDisplayName": name,
    "CFBundleExecutable": executable,
    "CFBundleIdentifier": bundle_id,
    "CFBundleInfoDictionaryVersion": "6.0",
    "CFBundleName": name,
    "CFBundlePackageType": "APPL",
    "CFBundleShortVersionString": version,
    "CFBundleVersion": version,
    "LSApplicationCategoryType": "public.app-category.developer-tools",
    "LSMinimumSystemVersion": min_macos,
    # 메뉴바 전용 앱: Dock 아이콘과 앱 메뉴를 띄우지 않는다.
    "LSUIElement": True,
    "NSHighResolutionCapable": True,
}
with open(out, "wb") as handle:
    plistlib.dump(info, handle)
PY
}

if [ "${1:-}" = "--info-plist-only" ]; then
    write_info_plist "${2:?출력 경로}" "${3:?버전}"
    exit 0
fi

resolve_version() {
    if [ -n "${1:-}" ]; then echo "$1"; return; fi
    if [ -n "${MENUBAR_VERSION:-}" ]; then echo "$MENUBAR_VERSION"; return; fi
    local tag="${GITHUB_REF_NAME:-}"
    if [ -z "$tag" ] && command -v git >/dev/null 2>&1; then
        tag="$(git -C "$SCRIPT_DIR" describe --tags --match 'menubar-v*' --abbrev=0 2>/dev/null || true)"
    fi
    case "$tag" in
        menubar-v*) echo "${tag#menubar-v}" ;;
        *) echo "0.0.0-dev" ;;
    esac
}

VERSION="$(resolve_version "${1:-}")"
# 버전은 파일 이름과 Info.plist에 들어간다. 영문·숫자·`.`·`+`·`-`만 받는다.
if ! [[ "$VERSION" =~ ^[0-9A-Za-z.+-]+$ ]]; then
    echo "✗ 버전 표기가 올바르지 않습니다: $VERSION" >&2
    exit 2
fi
BUILD_DIR="$SCRIPT_DIR/.build"
WORK="$BUILD_DIR/package"
APP="$BUILD_DIR/$APP_BUNDLE"
DIST="$BUILD_DIR/dist"
ZIP="$DIST/CC-Menubar-$VERSION-macos-universal.zip"
SOURCES=("$SCRIPT_DIR"/Sources/*.swift)

echo "▶ CC Menubar.app 패키징 (버전 $VERSION)"
rm -rf "${WORK:?}" "${APP:?}"
mkdir -p "$WORK" "$DIST"

for target in arm64-apple-macosx13.0 x86_64-apple-macosx13.0; do
    arch="${target%%-*}"
    echo "  컴파일: $target"
    swiftc \
        -j 1 \
        -num-threads 1 \
        -O \
        -framework Cocoa \
        -framework Foundation \
        -target "$target" \
        "${SOURCES[@]}" \
        -o "$WORK/$EXECUTABLE-$arch"
done

lipo -create "$WORK/$EXECUTABLE-arm64" "$WORK/$EXECUTABLE-x86_64" -output "$WORK/$EXECUTABLE"
ARCHS="$(lipo -archs "$WORK/$EXECUTABLE")"
echo "  아키텍처: $ARCHS"
case " $ARCHS " in
    *" arm64 "*) ;;
    *) echo "✗ arm64 슬라이스 없음" >&2; exit 1 ;;
esac
case " $ARCHS " in
    *" x86_64 "*) ;;
    *) echo "✗ x86_64 슬라이스 없음" >&2; exit 1 ;;
esac

if [ "${CC_MENUBAR_SKIP_SNAPSHOT:-0}" != "1" ]; then
    CC_MENUBAR_BINARY="$WORK/$EXECUTABLE" python3 "$SCRIPT_DIR/Tests/snapshot_test_teamclaude_table.py"
    CC_MENUBAR_BINARY="$WORK/$EXECUTABLE" python3 "$SCRIPT_DIR/Tests/snapshot_test_empty_home.py"
fi

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$WORK/$EXECUTABLE" "$APP/Contents/MacOS/$EXECUTABLE"
chmod 755 "$APP/Contents/MacOS/$EXECUTABLE"
write_info_plist "$APP/Contents/Info.plist" "$VERSION"
printf 'APPL????' > "$APP/Contents/PkgInfo"
plutil -lint "$APP/Contents/Info.plist" >/dev/null

# 애플 개발자 서명·공증은 하지 않는다(spec Non-goals). ad-hoc 서명만 해서 번들 무결성을 묶는다.
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --strict "$APP"

rm -f "$ZIP" "$ZIP.sha256"
(cd "$BUILD_DIR" && ditto -c -k --keepParent "$APP_BUNDLE" "$ZIP")
(cd "$DIST" && shasum -a 256 "$(basename "$ZIP")" > "$(basename "$ZIP").sha256")

echo ""
echo "✅ 패키징 완료"
echo "  앱: $APP"
echo "  zip: $ZIP"
echo "  sha256: $(cut -d' ' -f1 "$ZIP.sha256")"
