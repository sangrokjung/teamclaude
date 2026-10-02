#!/usr/bin/env bash
# known-red 분류 함수. run-tests.sh가 source한다.
#
#   classify_known_red LOGFILE [METHOD...]
#
# unittest 출력(LOGFILE)에서 실패한 테스트 메서드 이름(FAIL:/ERROR: 줄)을 뽑아, 인자로 받은 허용 목록과 대조한다.
#   stdout: "known-red"              — 실패 전부가 허용 목록 안
#           "unlisted: m1 m2"        — 허용 목록 밖 실패가 있음(게이트를 막아야 한다)
#           "no-failures-parsed"     — 실패했는데 FAIL/ERROR 줄이 없음(크래시·컴파일 실패 등, 게이트를 막아야 한다)
# 파일 단위 항목(메서드 없음)은 이 함수를 거치지 않고 예전처럼 known-red로 넘긴다.
classify_known_red() {
  local log="$1"; shift
  local failing
  failing="$(grep -oE '^(FAIL|ERROR): [A-Za-z0-9_]+' "$log" 2>/dev/null | awk '{print $2}' | sort -u)"
  if [ -z "$failing" ]; then
    echo "no-failures-parsed"; return 0
  fi
  local unlisted="" f m listed
  for f in $failing; do
    listed=0
    for m in "$@"; do [ "$f" = "$m" ] && listed=1; done
    [ "$listed" = 0 ] && unlisted="$unlisted $f"
  done
  if [ -n "$unlisted" ]; then
    echo "unlisted:$unlisted"
  else
    echo "known-red"
  fi
}
