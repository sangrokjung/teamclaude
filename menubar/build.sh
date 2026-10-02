#!/bin/bash
# cc-menubar 빌드 스크립트
# swiftc로 메뉴바 앱 바이너리 컴파일

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/.build"
BINARY="$BUILD_DIR/cc-menubar"
SOURCES=("$SCRIPT_DIR"/Sources/*.swift)

echo "▶ cc-menubar 빌드 시작..."
echo "  소스: ${SOURCES[*]}"
echo "  출력: $BINARY"

mkdir -p "$BUILD_DIR"
if [ "${CC_MENUBAR_SKIP_TESTS:-0}" != "1" ]; then
    bash "$SCRIPT_DIR/run-tests.sh"
fi
if command -v git >/dev/null 2>&1; then
    DIRTY="$(git -C "$SCRIPT_DIR" status --porcelain -- Sources 2>/dev/null | wc -l | tr -d ' ')"
    if [ "${DIRTY:-0}" != "0" ]; then
        echo "⚠ 미커밋 소스 ${DIRTY}개 파일로 빌드합니다. 배포 전 커밋하세요."
    fi
fi

CANDIDATE="$(mktemp "$BUILD_DIR/cc-menubar.XXXXXX")"
trap 'rm -f "$CANDIDATE"' EXIT

swiftc \
    -j 1 \
    -num-threads 1 \
    -O \
    -framework Cocoa \
    -framework Foundation \
    -target arm64-apple-macosx13.0 \
    "${SOURCES[@]}" \
    -o "$CANDIDATE"

chmod +x "$CANDIDATE"
if [ "${CC_MENUBAR_SKIP_SNAPSHOT:-0}" != "1" ]; then
    # mv 전에 후보 바이너리로 스모크. 실패하면 set -e가 멈추고 trap이 후보를 지워 기존 바이너리가 남는다.
    CC_MENUBAR_BINARY="$CANDIDATE" python3 "$SCRIPT_DIR/Tests/snapshot_test_teamclaude_table.py"
fi
mv -f "$CANDIDATE" "$BINARY"

echo ""
echo "✅ 빌드 완료"
echo "  바이너리: $BINARY"
echo "  크기: $(du -sh "$BINARY" | cut -f1)"
echo ""
echo "실행 방법:"
echo "  $BINARY &"
echo ""
echo "LaunchAgent 등록 방법:"
echo "  launchctl load ~/Library/LaunchAgents/com.qjc.cc-menubar.plist"
