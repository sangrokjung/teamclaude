"""codex_502_watchdog 변종 에러 수용 테스트 (2026-08-14 스톰 실측 셰이프).

피어 캠페인의 test_codex_502_watchdog.py와 분리된 추가 스위트 —
EXACT_ERRORS 변종 3종 + URL 줄바꿈(wrap) 대응만 검증한다.
"""
from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts/codex_502_watchdog.py"
SPEC = importlib.util.spec_from_file_location("codex_502_watchdog_v", MODULE_PATH)
assert SPEC and SPEC.loader
watchdog = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = watchdog
SPEC.loader.exec_module(watchdog)

STATUS = "  gpt-5.6-sol xhigh · ~/repo"

TUNNEL_502 = (
    "■ unexpected status 502 Bad Gateway: TeamCodex tunnel disconnected after "
    "request dispatch; request was not replayed., url: "
    "http://127.0.0.1:61719/codex/responses"
)
DRAIN_503 = (
    "■ unexpected status 503 Service Unavailable: Proxy is draining for a "
    "verified deployment, url: http://127.0.0.1:63195/codex/responses"
)
STREAM_PAREN = (
    "■ stream disconnected before completion: error sending request for url "
    "(http://127.0.0.1:54356/codex/responses)"
)
UNSUPPORTED_MODEL = (
    '■ {"detail":"The \'gpt-5.6-sol\' model is not supported when using Codex '
    'with a ChatGPT account."}'
)


def screen_of(*error_lines: str) -> str:
    body = "\n".join(error_lines)
    return f"• 이전 작업\n\n{body}\n\n› \n\n{STATUS}"


class VariantDetectionTests(unittest.TestCase):
    def test_tunnel_disconnected_502_single_line(self) -> None:
        match = watchdog.detect_waiting_502(screen_of(TUNNEL_502), "s1")
        self.assertIsNotNone(match)
        self.assertEqual(match.port, 61719)

    def test_drain_503_single_line(self) -> None:
        match = watchdog.detect_waiting_502(screen_of(DRAIN_503), "s1")
        self.assertIsNotNone(match)
        self.assertEqual(match.port, 63195)

    def test_stream_disconnected_paren_form(self) -> None:
        match = watchdog.detect_waiting_502(screen_of(STREAM_PAREN), "s1")
        self.assertIsNotNone(match)
        self.assertEqual(match.port, 54356)

    def test_wrapped_url_next_line(self) -> None:
        # 2026-08-14 실측: 좁은 pane에서 ", url:" 뒤에서 줄이 감긴다.
        line1 = (
            "■ unexpected status 502 Bad Gateway: TeamCodex tunnel disconnected "
            "after request dispatch; request was not replayed., url:"
        )
        line2 = "http://127.0.0.1:61719/codex/responses"
        match = watchdog.detect_waiting_502(screen_of(line1, line2), "s1")
        self.assertIsNotNone(match)
        self.assertEqual(match.port, 61719)

    def test_wrapped_mid_port_token(self) -> None:
        # 토큰 중간에서 감겨 포트 숫자가 분절돼도 이어붙여 복원한다.
        line1 = (
            "■ stream disconnected before completion: error sending request "
            "for url (http://127.0.0.1:6"
        )
        line2 = "1719/codex/responses)"
        match = watchdog.detect_waiting_502(screen_of(line1, line2), "s1")
        self.assertIsNotNone(match)
        self.assertEqual(match.port, 61719)

    def test_original_error_still_matches(self) -> None:
        original = (
            "■ unexpected status 502 Bad Gateway: Proxy worker failed after "
            "dispatch; request was not replayed, url: "
            "http://127.0.0.1:61475/codex/responses"
        )
        match = watchdog.detect_waiting_502(screen_of(original), "s1")
        self.assertIsNotNone(match)
        self.assertEqual(match.port, 61475)

    def test_exact_chatgpt_model_unsupported_json_matches(self) -> None:
        match = watchdog.detect_waiting_502(screen_of(UNSUPPORTED_MODEL), "s1")
        self.assertIsNotNone(match)
        self.assertIsNone(match.port)

    def test_quoted_chatgpt_model_unsupported_json_is_rejected(self) -> None:
        quoted = f"operator quoted: {UNSUPPORTED_MODEL}"
        self.assertIsNone(watchdog.detect_waiting_502(screen_of(quoted), "s1"))

    def test_unrelated_502_rejected(self) -> None:
        unrelated = (
            "■ unexpected status 502 Bad Gateway: upstream unavailable, "
            "url: http://127.0.0.1:61719/codex/responses"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen_of(unrelated), "s1"))

    def test_noise_between_error_and_prompt_rejected(self) -> None:
        # 포트 파싱에 소비되지 않은 비어있지 않은 줄이 있으면 종전대로 미매치.
        screen = f"• x\n\n{TUNNEL_502}\n어떤 진행 중 출력\n\n› \n\n{STATUS}"
        self.assertIsNone(watchdog.detect_waiting_502(screen, "s1"))

    def test_invalid_port_does_not_block_valid_match(self) -> None:
        # 리뷰 재현: 범위 밖 포트 URL이 앞서도 뒤의 유효 포트를 찾아야 한다.
        line1 = (
            "■ stream disconnected before completion: error sending request "
            "for url (http://127.0.0.1:1/codex/responses) retry url:"
        )
        line2 = "http://127.0.0.1:61719/codex/responses"
        match = watchdog.detect_waiting_502(screen_of(line1, line2), "s1")
        self.assertIsNotNone(match)
        self.assertEqual(match.port, 61719)

    def test_ambient_background_notice_allowed(self) -> None:
        # 실측(2026-08-14): background terminal 안내줄은 새 출력이 아니다.
        screen = (
            f"• x\n\n{TUNNEL_502}\n\n"
            "1 background terminal running · /ps to view · /stop to close\n\n"
            f"› \n\n{STATUS}"
        )
        match = watchdog.detect_waiting_502(screen, "s1")
        self.assertIsNotNone(match)
        self.assertEqual(match.port, 61719)

    def test_wrapped_url_without_port_rejected(self) -> None:
        line1 = (
            "■ unexpected status 503 Service Unavailable: Proxy is draining "
            "for a verified deployment, url:"
        )
        line2 = "http://127.0.0.1:80/codex/responses"
        self.assertIsNone(watchdog.detect_waiting_502(screen_of(line1, line2), "s1"))

    def test_log_failure_never_stops_the_watchdog(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            unwritable_target = Path(temp_dir)
            with mock.patch.object(watchdog, "LOG_PATH", unwritable_target):
                watchdog.log_event("scan-deferred", detail="fixture")

    def test_state_directory_failure_defers_without_scanning_or_submitting(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            invalid_state_dir = Path(temp_dir) / "not-a-directory"
            invalid_state_dir.write_text("fixture", encoding="utf-8")
            with (
                mock.patch.object(watchdog, "STATE_DIR", invalid_state_dir),
                mock.patch.object(watchdog, "LOCK_PATH", invalid_state_dir / "lock"),
                mock.patch.object(watchdog, "scan") as scan,
                mock.patch.object(watchdog, "log_event") as log_event,
                mock.patch.object(sys, "argv", ["codex_502_watchdog.py"]),
            ):
                self.assertEqual(watchdog.main(), 0)
            scan.assert_not_called()
            log_event.assert_called_once_with("scan-deferred", detail="FileExistsError")

if __name__ == "__main__":
    unittest.main()
