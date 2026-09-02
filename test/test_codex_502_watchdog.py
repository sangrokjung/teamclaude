from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts/codex_502_watchdog.py"
SPEC = importlib.util.spec_from_file_location("codex_502_watchdog", MODULE_PATH)
assert SPEC and SPEC.loader
watchdog = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = watchdog
SPEC.loader.exec_module(watchdog)


ERROR = (
    "■ unexpected status 502 Bad Gateway: Proxy worker failed after dispatch; "
    "request was not replayed, url: http://127.0.0.1:61475/codex/responses"
)
DRAIN_ERROR = (
    "■ unexpected status 503 Service Unavailable: Proxy is draining for a "
    "verified deployment, url: http://127.0.0.1:61719/codex/responses"
)
GATEWAY_TIMEOUT_ERROR = (
    "■ unexpected status 504 Gateway Timeout: Upstream overloaded (HTTP 504). "
    "Request was not replayed., url: "
    "http://127.0.0.1:56098/codex/responses"
)
UPSTREAM_OVERLOADED_503_ERROR = (
    "■ unexpected status 503 Service Unavailable: Upstream overloaded (HTTP 503). "
    "Request was not replayed., url: "
    "http://127.0.0.1:53018/codex/responses"
)
UPSTREAM_CONNECTION_ERROR = (
    "■ unexpected status 502 Bad Gateway: Upstream connection failed after "
    "dispatch. Request was not replayed., url: "
    "http://127.0.0.1:61639/codex/responses"
)
STREAM_ERROR = (
    "■ stream disconnected before completion: error sending request for url "
    "(http://127.0.0.1:61720/codex/responses)"
)
CAPACITY_ERROR = "⚠ Selected model is at capacity. Please try a different model."
REQUEST_ID_ERROR = (
    "■ stream disconnected before completion: An error occurred while processing "
    "your request. You can retry your request, or contact us through our help "
    "center at help.openai.com if the error persists. Please include the request "
    "ID 68a59b0e-ca4f-49b5-911f-4b1e6351119b in your message."
)


class DetectWaiting502Tests(unittest.TestCase):
    def test_exact_request_id_stream_error_matches_without_proxy_url(self) -> None:
        screen = (
            f"• 이전 작업\n\n{REQUEST_ID_ERROR}\n\n› \n\n"
            "  gpt-5.6-sol xhigh · ~/repo"
        )
        match = watchdog.detect_waiting_502(screen, "session-request-id")
        self.assertIsNotNone(match)
        assert match is not None
        self.assertIsNone(match.port)

    def test_request_id_stream_error_wrapped_across_four_lines_matches(self) -> None:
        wrapped = (
            "■ stream disconnected before completion: An error occurred while processing your\n"
            "request. You can retry your request, or contact us through our help center at\n"
            "help.openai.com if the error persists. Please include the request ID\n"
            "68a59b0e-ca4f-49b5-911f-4b1e6351119b in your message."
        )
        screen = f"{wrapped}\n\n› Ask Codex to do anything\n\n  gpt-5.6-sol xhigh · ~/repo"
        match = watchdog.detect_waiting_502(screen, "session-request-id")
        self.assertIsNotNone(match)
        assert match is not None
        self.assertIsNone(match.port)

    def test_request_id_error_with_malformed_id_is_rejected(self) -> None:
        malformed = REQUEST_ID_ERROR.replace(
            "68a59b0e-ca4f-49b5-911f-4b1e6351119b", "not-a-request-id"
        )
        screen = f"{malformed}\n\n› \n\n  gpt-5.6-sol xhigh · ~/repo"
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-request-id"))

    def test_request_id_error_quoted_in_normal_output_is_rejected(self) -> None:
        quoted = f"• 진단 인용: {REQUEST_ID_ERROR.removeprefix('■ ')}"
        screen = f"{quoted}\n\n› \n\n  gpt-5.6-sol xhigh · ~/repo"
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-request-id"))
    def test_exact_error_at_prompt_matches(self) -> None:
        screen = f"• 이전 작업\n\n{ERROR}\n\n› \n\n  gpt-5.6-sol xhigh · ~/repo"
        match = watchdog.detect_waiting_502(screen, "session-1")
        self.assertIsNotNone(match)
        self.assertEqual(match.port, 61475)

    def test_exact_deployment_drain_503_at_prompt_matches(self) -> None:
        screen = f"• 이전 작업\n\n{DRAIN_ERROR}\n\n› \n\n  gpt-5.6-sol xhigh · ~/repo"
        match = watchdog.detect_waiting_502(screen, "session-1")
        self.assertIsNotNone(match)
        self.assertEqual(match.port, 61719)

    def test_exact_upstream_overloaded_504_at_prompt_matches(self) -> None:
        screen = (
            f"• 이전 작업\n\n{GATEWAY_TIMEOUT_ERROR}\n\n› \n\n"
            "  gpt-5.6-sol xhigh · ~/repo"
        )
        match = watchdog.detect_waiting_502(screen, "session-1")
        self.assertIsNotNone(match)
        self.assertEqual(match.port, 56098)

    def test_exact_upstream_overloaded_503_at_prompt_matches(self) -> None:
        screen = (
            f"• 이전 작업\n\n{UPSTREAM_OVERLOADED_503_ERROR}\n\n› \n\n"
            "  gpt-5.6-sol high · ~/qjc-agent-server/workspaces/sinsang-ax"
        )
        match = watchdog.detect_waiting_502(screen, "session-upstream-503")
        self.assertIsNotNone(match)
        assert match is not None
        self.assertEqual(match.port, 53018)

    def test_upstream_overloaded_503_accepts_dynamic_port_and_wrapped_url(self) -> None:
        error = UPSTREAM_OVERLOADED_503_ERROR.replace(":53018/", ":59999/")
        wrapped = error.replace(", url: http", ", url:\nhttp")
        screen = f"{wrapped}\n\n› Ask Codex to do anything\n\n  gpt-5.6-sol high · ~/repo"
        match = watchdog.detect_waiting_502(screen, "session-upstream-503-dynamic")
        self.assertIsNotNone(match)
        assert match is not None
        self.assertEqual(match.port, 59999)

    def test_generic_503_is_not_promoted_by_upstream_overloaded_allowlist(self) -> None:
        screen = (
            "■ unexpected status 503 Service Unavailable: Upstream overloaded, "
            "url: http://127.0.0.1:53018/codex/responses\n"
            "› \n  gpt-5.6-sol high · ~/repo"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-generic-503"))

    def test_upstream_overloaded_503_with_suffix_is_rejected(self) -> None:
        screen = (
            UPSTREAM_OVERLOADED_503_ERROR.replace(
                "Request was not replayed.", "Request was not replayed. please retry"
            )
            + "\n› \n  gpt-5.6-sol high · ~/repo"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-upstream-503-suffix"))

    def test_normal_output_quoting_upstream_overloaded_503_is_rejected(self) -> None:
        screen = (
            "• 진단 인용: "
            + UPSTREAM_OVERLOADED_503_ERROR.removeprefix("■ ")
            + "\n› \n  gpt-5.6-sol high · ~/repo"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-upstream-503-quoted"))

    def test_upstream_overloaded_503_with_user_draft_is_rejected(self) -> None:
        screen = (
            UPSTREAM_OVERLOADED_503_ERROR
            + "\n› 사용자가 작성 중인 초안\n  gpt-5.6-sol high · ~/repo"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-upstream-503-draft"))

    def test_exact_upstream_connection_failed_502_at_prompt_matches(self) -> None:
        screen = (
            f"• 이전 작업\n\n{UPSTREAM_CONNECTION_ERROR}\n\n› \n\n"
            "  gpt-5.6-sol xhigh · ~/repo"
        )
        match = watchdog.detect_waiting_502(screen, "session-1")
        self.assertIsNotNone(match)
        self.assertEqual(match.port, 61639)

    def test_upstream_connection_failed_502_accepts_current_dynamic_port(self) -> None:
        error = UPSTREAM_CONNECTION_ERROR.replace(":61639/", ":56008/")
        screen = f"• 이전 작업\n\n{error}\n\n› \n\n  gpt-5.6-sol xhigh · ~/repo"
        match = watchdog.detect_waiting_502(screen, "session-1")
        self.assertIsNotNone(match)
        self.assertEqual(match.port, 56008)

    def test_upstream_connection_error_55914_with_codex_default_placeholder_matches(self) -> None:
        error = UPSTREAM_CONNECTION_ERROR.replace(":61639/", ":55914/")
        screen = (
            f"{error}\n\n› Ask Codex to do anything\n\n"
            "  gpt-5.6-sol xhigh · ~/repo"
        )
        match = watchdog.detect_waiting_502(screen, "session-55914")
        self.assertIsNotNone(match)
        assert match is not None
        self.assertEqual(match.port, 55914)

    def test_upstream_connection_error_wrapped_at_word_boundary_matches(self) -> None:
        error = UPSTREAM_CONNECTION_ERROR.replace(
            "after dispatch. Request", "after dispatch.\nRequest"
        ).replace(":61639/", ":55914/")
        screen = (
            f"{error}\n\n› Ask Codex to do anything\n\n"
            "  gpt-5.6-sol default · ~/repo"
        )
        match = watchdog.detect_waiting_502(screen, "session-55914")
        self.assertIsNotNone(match)
        assert match is not None
        self.assertEqual(match.port, 55914)

    def test_exact_upstream_overloaded_504_with_wrapped_url_matches(self) -> None:
        wrapped = GATEWAY_TIMEOUT_ERROR.replace(", url: http", ", url:\nhttp")
        screen = f"{wrapped}\n\n› \n\n  gpt-5.6-sol xhigh · ~/repo"
        match = watchdog.detect_waiting_502(screen, "session-1")
        self.assertIsNotNone(match)
        self.assertEqual(match.port, 56098)

    def test_wrapped_error_fingerprint_includes_changed_proxy_port(self) -> None:
        first_error = GATEWAY_TIMEOUT_ERROR.replace(", url: http", ", url:\nhttp")
        second_error = first_error.replace(":56098/", ":56099/")
        first = watchdog.detect_waiting_502(
            f"{first_error}\n\n› \n  gpt-5.6-sol xhigh · ~/repo",
            "session-1",
        )
        second = watchdog.detect_waiting_502(
            f"{second_error}\n\n› \n  gpt-5.6-sol xhigh · ~/repo",
            "session-1",
        )
        self.assertIsNotNone(first)
        self.assertIsNotNone(second)
        self.assertNotEqual(first.fingerprint, second.fingerprint)

    def test_exact_model_capacity_at_prompt_matches_without_proxy_port(self) -> None:
        screen = (
            f"• 이전 작업\n\n{CAPACITY_ERROR}\n\n› \n\n"
            "  gpt-5.6-sol xhigh · ~/repo"
        )
        match = watchdog.detect_waiting_502(screen, "session-1")
        self.assertIsNotNone(match)
        self.assertIsNone(match.port)

    def test_similar_model_capacity_warning_does_not_match(self) -> None:
        screen = (
            "⚠ Selected model is temporarily at capacity. Please try a different model.\n"
            "› \n  gpt-5.6-sol xhigh · ~/repo"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-1"))

    def test_model_capacity_without_model_status_does_not_match(self) -> None:
        screen = f"{CAPACITY_ERROR}\n› \n  97% context left"
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-1"))

    def test_normal_output_quoting_model_capacity_does_not_match(self) -> None:
        screen = (
            f"• 진단 인용: {watchdog.CAPACITY_ERROR}\n"
            "› \n  gpt-5.6-sol xhigh · ~/repo"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-1"))

    def test_model_capacity_with_user_draft_does_not_match(self) -> None:
        screen = (
            f"{CAPACITY_ERROR}\n\n› 사용자가 작성 중인 초안\n\n"
            "  gpt-5.6-sol xhigh · ~/repo"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-1"))

    def test_model_capacity_fingerprint_changes_with_selected_model(self) -> None:
        first = watchdog.detect_waiting_502(
            f"{CAPACITY_ERROR}\n\n› \n  gpt-5.6-sol xhigh · ~/repo",
            "session-1",
        )
        second = watchdog.detect_waiting_502(
            f"{CAPACITY_ERROR}\n\n› \n  gpt-5.6-terra xhigh · ~/repo",
            "session-1",
        )
        self.assertIsNotNone(first)
        self.assertIsNotNone(second)
        self.assertNotEqual(first.fingerprint, second.fingerprint)

    def test_unrelated_504_does_not_match(self) -> None:
        screen = (
            "■ unexpected status 504 Gateway Timeout: maintenance, "
            "url: http://127.0.0.1:56098/codex/responses\n"
            "› \n  gpt-5.6-sol xhigh · ~/repo"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-1"))

    def test_unrelated_503_does_not_match(self) -> None:
        screen = (
            "■ unexpected status 503 Service Unavailable: maintenance, "
            "url: http://127.0.0.1:61719/codex/responses\n"
            "› \n  gpt-5.6-sol xhigh · ~/repo"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-1"))

    def test_exact_503_with_arbitrary_suffix_does_not_match(self) -> None:
        screen = (
            "■ unexpected status 503 Service Unavailable: Proxy is draining "
            "for a verified deployment but this is quoted text, "
            "url: http://127.0.0.1:61719/codex/responses\n"
            "› \n  gpt-5.6-sol xhigh · ~/repo"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-1"))

    def test_normal_output_quoting_exact_503_does_not_match(self) -> None:
        screen = (
            "• 진단 인용: unexpected status 503 Service Unavailable: Proxy is "
            "draining for a verified deployment, "
            "url: http://127.0.0.1:61719/codex/responses\n"
            "› \n  gpt-5.6-sol xhigh · ~/repo"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-1"))

    def test_exact_stream_disconnect_at_prompt_matches(self) -> None:
        screen = f"• 이전 작업\n\n{STREAM_ERROR}\n\n› \n\n  gpt-5.6-sol xhigh · ~/repo"
        match = watchdog.detect_waiting_502(screen, "session-1")
        self.assertIsNotNone(match)
        self.assertEqual(match.port, 61720)

    def test_stream_disconnect_with_arbitrary_suffix_does_not_match(self) -> None:
        screen = (
            "■ stream disconnected before completion: error sending request for url "
            "but this is quoted text (http://127.0.0.1:61720/codex/responses)\n"
            "› \n  gpt-5.6-sol xhigh · ~/repo"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-1"))

    def test_normal_output_quoting_stream_disconnect_does_not_match(self) -> None:
        screen = (
            "• 진단 인용: stream disconnected before completion: error sending "
            "request for url (http://127.0.0.1:61720/codex/responses)\n"
            "› \n  gpt-5.6-sol xhigh · ~/repo"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-1"))

    def test_stream_disconnect_two_and_three_line_wraps_match(self) -> None:
        wrapped = (
            "■ stream disconnected before completion: error sending request for url (\n"
            "http://127.0.0.1:617\n20/codex/responses)"
        )
        screen = f"{wrapped}\n\n› \n\n  gpt-5.6-sol xhigh · ~/repo"
        match = watchdog.detect_waiting_502(screen, "session-1")
        self.assertIsNotNone(match)
        self.assertEqual(match.port, 61720)

    def test_recovery_message_is_generic_for_all_transient_failures(self) -> None:
        self.assertTrue(watchdog.RECOVERY_MESSAGE.startswith("일시적 모델·프록시 오류로"))
        self.assertNotIn("502 프록시 오류", watchdog.RECOVERY_MESSAGE)
        self.assertNotIn("/model", watchdog.RECOVERY_MESSAGE)

    def test_builtin_placeholder_at_empty_prompt_matches(self) -> None:
        for placeholder in watchdog.CODEX_PLACEHOLDERS:
            with self.subTest(placeholder=placeholder):
                screen = (
                    f"{ERROR}\n\n› {placeholder}\n\n"
                    "  gpt-5.6-sol xhigh · ~/repo"
                )
                self.assertIsNotNone(
                    watchdog.detect_waiting_502(screen, "session-1")
                )

    def test_remote_tmux_footer_after_status_matches(self) -> None:
        screen = (
            f"{ERROR}\n\n› Run /review on my current changes\n\n"
            "  gpt-5.6-sol xhigh · ~/repo\n\n"
            "  Mac-Studio | qjc-codex-job 1:Python 08/13 18:22"
        )
        self.assertIsNotNone(
            watchdog.detect_waiting_502(screen, "session-1", "surface:289")
        )

    def test_arbitrary_line_after_status_does_not_match(self) -> None:
        screen = (
            f"{ERROR}\n\n› Run /review on my current changes\n\n"
            "  gpt-5.6-sol xhigh · ~/repo\n"
            "  user continuation"
        )
        self.assertIsNone(
            watchdog.detect_waiting_502(screen, "session-1", "surface:289")
        )

    def test_user_draft_after_error_does_not_match(self) -> None:
        screen = f"{ERROR}\n\n› 실제 사용자 초안\n\n  gpt-5.6-sol xhigh · ~/repo"
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-1"))

    def test_stop_hook_unverified_before_exact_error_does_not_match(self) -> None:
        screen = (
            "Stop (completed) says: UNVERIFIED: Stop hook 재진입을 허용하지만 "
            "작업은 완료되지 않았습니다. blocker: missing-evidence, "
            "missing-lane:goal-correctness, mutation-in-flight\n"
            f"{ERROR}\n\n› Ask Codex to do anything\n\n"
            "  gpt-5.6-sol xhigh · ~/repo"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-1"))

    def test_wrapped_stop_hook_unverified_blocker_does_not_match(self) -> None:
        screen = (
            "Stop (completed) says: UNVERIFIED: Stop hook 재진입을 허용하지만\n"
            "작업은 완료되지 않았습니다. blocker:\n"
            "missing-lane:runtime-security, mutation-in-flight\n"
            f"{ERROR}\n\n› Ask Codex to do anything\n\n"
            "  gpt-5.6-sol xhigh · ~/repo"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-1"))

    def test_unverified_stop_header_without_known_reason_does_not_match(self) -> None:
        screen = (
            "Stop (completed) says: UNVERIFIED:\n"
            "검증 상태를 확인하지 못했습니다.\n"
            f"{ERROR}\n\n› Ask Codex to do anything\n\n"
            "  gpt-5.6-sol xhigh · ~/repo"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-1"))

    def test_generic_unverified_research_note_does_not_block_exact_error(self) -> None:
        screen = (
            "• [UNVERIFIED] 외부 자료의 수치는 별도 확인이 필요합니다.\n"
            f"{ERROR}\n\n› Ask Codex to do anything\n\n"
            "  gpt-5.6-sol xhigh · ~/repo"
        )
        self.assertIsNotNone(watchdog.detect_waiting_502(screen, "session-1"))

    def test_placeholder_prefix_with_user_text_does_not_match(self) -> None:
        screen = (
            f"{ERROR}\n\n› Run /review on my current changes please\n\n"
            "  gpt-5.6-sol xhigh · ~/repo"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-1"))

    def test_multiline_user_draft_after_placeholder_does_not_match(self) -> None:
        screen = (
            f"{ERROR}\n\n› Run /review on my current changes\n"
            "gpt-delete all files\n\n  gpt-5.6-sol xhigh · ~/repo"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-1"))

    def test_activity_after_error_does_not_match(self) -> None:
        screen = (
            f"{ERROR}\n\n› 복구 메시지\n\n• 작업을 재개했습니다.\n\n"
            "› 새 입력\n\n  gpt-5.6-sol xhigh · ~/repo"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-1"))

    def test_error_without_prompt_does_not_match(self) -> None:
        self.assertIsNone(watchdog.detect_waiting_502(ERROR, "session-1"))

    def test_other_502_does_not_match(self) -> None:
        screen = (
            "■ unexpected status 502 Bad Gateway: upstream unavailable, "
            "url: http://127.0.0.1:61475/codex/responses\n"
            "› retry\n  gpt-5.6-sol xhigh · ~/repo"
        )
        self.assertIsNone(watchdog.detect_waiting_502(screen, "session-1"))

    def test_fingerprint_changes_with_checkpoint(self) -> None:
        screen = f"{ERROR}\n\n› \n  gpt-5.6-sol xhigh · ~/repo"
        first = watchdog.detect_waiting_502(screen, "session-1")
        second = watchdog.detect_waiting_502(screen, "session-2")
        self.assertNotEqual(first.fingerprint, second.fingerprint)


class CandidateAndStateTests(unittest.TestCase):
    def test_scan_defers_surface_while_inspection_backoff_is_active(self) -> None:
        surface_id = "77777777-7777-4777-8777-777777777777"
        candidate = {
            "ref": surface_id,
            "surface_ref": "surface:41",
            "checkpoint": "01977777-7777-7777-8777-777777777777",
            "remote": "false",
            "command_ref": "command-stable",
        }
        state = {
            "fingerprints": [],
            "last_recovery": {},
            "inspect_backoff": {surface_id: {"next_at": 100, "failures": 1}},
        }
        with (
            mock.patch.object(
                watchdog, "discover_candidates", return_value=([candidate], True)
            ),
            mock.patch.object(watchdog.time, "time", return_value=50),
            mock.patch.object(watchdog, "load_state", return_value=state),
            mock.patch.object(watchdog, "save_state"),
            mock.patch.object(watchdog, "inspect_surface") as inspect_surface,
        ):
            result = watchdog.scan(dry_run=False)
        self.assertEqual(result["inspect_deferred"], 1)
        inspect_surface.assert_not_called()

    def test_scan_opens_circuit_after_three_recent_recoveries(self) -> None:
        surface_id = "77777777-7777-4777-8777-777777777777"
        match = watchdog.Match(fingerprint="new-error", port=None)
        candidate = {
            "ref": surface_id,
            "surface_ref": "surface:41",
            "checkpoint": "01977777-7777-7777-8777-777777777777",
            "remote": "false",
            "command_ref": "command-stable",
        }
        state = {
            "fingerprints": [],
            "last_recovery": {},
            "recovery_history": {surface_id: [0, 120, 420]},
        }
        with (
            mock.patch.object(
                watchdog, "discover_candidates", return_value=([candidate], True)
            ),
            mock.patch.object(
                watchdog,
                "inspect_surface",
                return_value=(surface_id, match, None, "false"),
            ),
            mock.patch.object(watchdog.time, "time", return_value=421),
            mock.patch.object(watchdog, "load_state", return_value=state),
            mock.patch.object(watchdog, "save_state"),
            mock.patch.object(watchdog, "submit_recovery") as submit_recovery,
        ):
            result = watchdog.scan(dry_run=False)
        self.assertEqual(result["circuit_open"], 1)
        submit_recovery.assert_not_called()

    def test_recovery_gate_uses_bounded_backoff_and_circuit_breaker(self) -> None:
        state = {"recovery_history": {}}
        self.assertEqual(watchdog.recovery_gate(state, "surface-1", 0), (True, "ready"))
        watchdog.record_recovery_attempt(state, "surface-1", 0)
        self.assertEqual(watchdog.recovery_gate(state, "surface-1", 1), (False, "backoff"))
        self.assertEqual(
            watchdog.recovery_gate(state, "surface-1", 120), (True, "ready")
        )
        watchdog.record_recovery_attempt(state, "surface-1", 120)
        self.assertEqual(
            watchdog.recovery_gate(state, "surface-1", 420), (True, "ready")
        )
        watchdog.record_recovery_attempt(state, "surface-1", 420)
        self.assertEqual(
            watchdog.recovery_gate(state, "surface-1", 421), (False, "circuit-open")
        )
        self.assertEqual(
            watchdog.recovery_gate(state, "surface-1", 2221), (True, "ready")
        )

    def test_inspection_gate_backoff_grows_and_resets(self) -> None:
        state = {"inspect_backoff": {}}
        self.assertTrue(watchdog.inspection_allowed(state, "surface-1", 0))
        watchdog.record_inspection_result(state, "surface-1", 0, "screen-internal-error")
        self.assertFalse(watchdog.inspection_allowed(state, "surface-1", 1))
        self.assertTrue(watchdog.inspection_allowed(state, "surface-1", 60))
        watchdog.record_inspection_result(state, "surface-1", 60, "screen-internal-error")
        self.assertFalse(watchdog.inspection_allowed(state, "surface-1", 119))
        self.assertTrue(watchdog.inspection_allowed(state, "surface-1", 180))
        watchdog.record_inspection_result(state, "surface-1", 180, None)
        self.assertTrue(watchdog.inspection_allowed(state, "surface-1", 181))

    def test_health_snapshot_reports_critical_contention_without_mutation(self) -> None:
        snapshot = watchdog.health_snapshot(
            loadavg=(64.0, 60.0, 70.0),
            cpu_count=16,
            disk_free_bytes=15 * 1024**3,
            database_sizes={"logs_2.sqlite": 16 * 1024**3},
        )
        self.assertEqual(snapshot["status"], "critical")
        self.assertGreater(snapshot["load_ratio_1m"], 3)
        self.assertIn("reduce_concurrency", snapshot["recommendations"])
    def test_internal_screen_error_fails_closed(self) -> None:
        surface_id = "77777777-7777-4777-8777-777777777777"
        checkpoint = "01977777-7777-7777-8777-777777777777"
        candidate = {
            "ref": surface_id,
            "surface_ref": "surface:41",
            "checkpoint": checkpoint,
            "remote": "false",
        }
        with mock.patch.object(
            watchdog,
            "run_cmux",
            side_effect=RuntimeError("cmux read-screen: internal_error"),
        ):
            inspected = watchdog.inspect_surface(candidate)

        self.assertEqual(
            inspected,
            (surface_id, None, "screen-internal-error", "false"),
        )

    def test_discovery_keeps_stable_identity_and_current_surface_ref(self) -> None:
        surface_id = "77777777-7777-4777-8777-777777777777"
        checkpoint = "01977777-7777-7777-8777-777777777777"
        tree_output = json.dumps(
            {
                "windows": [
                    {
                        "workspaces": [
                            {
                                "panes": [
                                    {
                                        "surfaces": [
                                            {
                                                "id": surface_id,
                                                "ref": "surface:41",
                                                "type": "terminal",
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        )

        def run_cmux(*args: str, **_kwargs: object) -> str:
            if args == ("--json", "--id-format", "both", "tree", "--all"):
                return tree_output
            if args[-1] == surface_id:
                return json.dumps(
                    {
                        "resume_binding": {
                            "kind": "codex",
                            "checkpoint_id": checkpoint,
                            "command": f"codex resume {checkpoint}",
                        }
                    }
                )
            raise AssertionError(args)

        with mock.patch.object(watchdog, "run_cmux", side_effect=run_cmux):
            candidates, complete = watchdog.discover_candidates([])

        self.assertTrue(complete)
        self.assertEqual(
            candidates,
            [
                {
                    "ref": surface_id,
                    "surface_ref": "surface:41",
                    "checkpoint": checkpoint,
                    "remote": "false",
                    "command_ref": watchdog.binding_command_ref(
                        ["codex", "resume", checkpoint]
                    ),
                }
            ],
        )

    def test_inspection_reads_current_ref_but_returns_stable_identity(self) -> None:
        surface_id = "77777777-7777-4777-8777-777777777777"
        candidate = {
            "ref": surface_id,
            "surface_ref": "surface:41",
            "checkpoint": "01977777-7777-7777-8777-777777777777",
            "remote": "false",
            "command_ref": "command-stable",
        }
        screen = f"{ERROR}\n\n› \n\n  gpt-5.6-sol xhigh · ~/repo"
        with mock.patch.object(watchdog, "run_cmux", return_value=screen) as run_cmux:
            inspected = watchdog.inspect_surface(candidate)

        self.assertEqual(inspected[0], surface_id)
        self.assertIsNotNone(inspected[1])
        self.assertIsNone(inspected[2])
        run_cmux.assert_called_once_with(
            "read-screen", "--surface", "surface:41", "--lines", "80", timeout=8
        )

    def test_inspection_without_current_ref_fails_closed(self) -> None:
        surface_id = "77777777-7777-4777-8777-777777777777"
        candidate = {
            "ref": surface_id,
            "checkpoint": "01977777-7777-7777-8777-777777777777",
            "remote": "false",
        }
        screen = f"{ERROR}\n\n› \n\n  gpt-5.6-sol xhigh · ~/repo"
        with mock.patch.object(watchdog, "run_cmux", return_value=screen) as run_cmux:
            inspected = watchdog.inspect_surface(candidate)

        self.assertEqual(
            inspected,
            (surface_id, None, "surface-ref-missing", "false"),
        )
        run_cmux.assert_not_called()

    def test_scan_submits_to_current_ref_once_after_three_ref_checks(self) -> None:
        surface_id = "77777777-7777-4777-8777-777777777777"
        match = watchdog.Match(fingerprint="fingerprint", port=61475)
        candidate = {
            "ref": surface_id,
            "surface_ref": "surface:41",
            "checkpoint": "01977777-7777-7777-8777-777777777777",
            "remote": "false",
            "command_ref": "command-stable",
        }
        binding = {key: value for key, value in candidate.items() if key != "surface_ref"}
        state = {"fingerprints": [], "last_recovery": {}}
        with (
            mock.patch.object(
                watchdog, "discover_candidates", return_value=([candidate], True)
            ),
            mock.patch.object(
                watchdog,
                "inspect_surface",
                return_value=(surface_id, match, None, "false"),
            ),
            mock.patch.object(
                watchdog, "lookup_resume_candidate", return_value=(binding, False)
            ),
            mock.patch.object(
                watchdog,
                "lookup_surface_ref",
                create=True,
                side_effect=[
                    ("surface:41", False),
                    ("surface:41", False),
                    ("surface:41", False),
                ],
            ) as lookup_surface_ref,
            mock.patch.object(watchdog, "load_state", return_value=state),
            mock.patch.object(watchdog, "save_state"),
            mock.patch.object(watchdog, "proxy_healthy", return_value=True),
            mock.patch.object(watchdog, "log_event"),
            mock.patch.object(
                watchdog, "submit_recovery", return_value=(True, "submitted")
            ) as submit_recovery,
        ):
            result = watchdog.scan(dry_run=False)

        self.assertEqual(result["submitted"], 1)
        self.assertEqual(lookup_surface_ref.call_count, 3)
        submit_recovery.assert_called_once_with("surface:41")

    def test_model_capacity_submits_without_proxy_health_probe(self) -> None:
        match = watchdog.Match(fingerprint="capacity-fingerprint", port=None)
        candidate = {
            "ref": "surface:41",
            "checkpoint": "session-41",
            "remote": "false",
            "command_ref": "command-stable",
        }
        state = {"fingerprints": [], "last_recovery": {}}
        with (
            mock.patch.object(
                watchdog, "discover_candidates", return_value=([candidate], True)
            ),
            mock.patch.object(
                watchdog,
                "inspect_surface",
                return_value=("surface:41", match, None, "false"),
            ),
            mock.patch.object(
                watchdog,
                "lookup_resume_candidate",
                return_value=(candidate, False),
            ),
            mock.patch.object(watchdog, "load_state", return_value=state),
            mock.patch.object(watchdog, "save_state"),
            mock.patch.object(watchdog, "proxy_healthy") as proxy_healthy,
            mock.patch.object(watchdog, "log_event"),
            mock.patch.object(
                watchdog, "submit_recovery", return_value=(True, "submitted")
            ) as submit_recovery,
        ):
            result = watchdog.scan(dry_run=False)

        self.assertEqual(result["submitted"], 1)
        proxy_healthy.assert_not_called()
        submit_recovery.assert_called_once_with("surface:41")

    def test_surface_ref_change_after_final_screen_is_stale(self) -> None:
        surface_id = "77777777-7777-4777-8777-777777777777"
        match = watchdog.Match(fingerprint="fingerprint", port=61475)
        candidate = {
            "ref": surface_id,
            "surface_ref": "surface:41",
            "checkpoint": "01977777-7777-7777-8777-777777777777",
            "remote": "false",
            "command_ref": "command-stable",
        }
        binding = {key: value for key, value in candidate.items() if key != "surface_ref"}
        state = {"fingerprints": [], "last_recovery": {}}
        with (
            mock.patch.object(
                watchdog, "discover_candidates", return_value=([candidate], True)
            ),
            mock.patch.object(
                watchdog,
                "inspect_surface",
                return_value=(surface_id, match, None, "false"),
            ),
            mock.patch.object(
                watchdog, "lookup_resume_candidate", return_value=(binding, False)
            ),
            mock.patch.object(
                watchdog,
                "lookup_surface_ref",
                create=True,
                side_effect=[
                    ("surface:41", False),
                    ("surface:41", False),
                    ("surface:42", False),
                ],
            ) as lookup_surface_ref,
            mock.patch.object(watchdog, "load_state", return_value=state),
            mock.patch.object(watchdog, "save_state"),
            mock.patch.object(watchdog, "proxy_healthy", return_value=True),
            mock.patch.object(watchdog, "log_event"),
            mock.patch.object(
                watchdog, "submit_recovery", return_value=(True, "submitted")
            ) as submit_recovery,
        ):
            result = watchdog.scan(dry_run=False)

        self.assertEqual(result["stale"], 1)
        self.assertEqual(state["fingerprints"], [])
        self.assertEqual(lookup_surface_ref.call_count, 3)
        submit_recovery.assert_not_called()

    def test_ambiguous_surface_tree_never_submits(self) -> None:
        surface_id = "77777777-7777-4777-8777-777777777777"
        match = watchdog.Match(fingerprint="fingerprint", port=61475)
        candidate = {
            "ref": surface_id,
            "surface_ref": "surface:41",
            "checkpoint": "01977777-7777-7777-8777-777777777777",
            "remote": "false",
            "command_ref": "command-stable",
        }
        conflicting_tree = json.dumps(
            {
                "windows": [
                    {
                        "workspaces": [
                            {
                                "panes": [
                                    {
                                        "surfaces": [
                                            {
                                                "id": surface_id,
                                                "ref": "surface:41",
                                                "type": "terminal",
                                            },
                                            {
                                                "id": surface_id,
                                                "ref": "surface:42",
                                                "type": "terminal",
                                            },
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        )
        state = {"fingerprints": [], "last_recovery": {}}
        with (
            mock.patch.object(
                watchdog, "discover_candidates", return_value=([candidate], True)
            ),
            mock.patch.object(
                watchdog,
                "inspect_surface",
                return_value=(surface_id, match, None, "false"),
            ),
            mock.patch.object(watchdog, "run_cmux", return_value=conflicting_tree),
            mock.patch.object(watchdog, "load_state", return_value=state),
            mock.patch.object(watchdog, "save_state"),
            mock.patch.object(watchdog, "proxy_healthy", return_value=True),
            mock.patch.object(watchdog, "log_event"),
            mock.patch.object(
                watchdog, "submit_recovery", return_value=(True, "submitted")
            ) as submit_recovery,
        ):
            result = watchdog.scan(dry_run=False)

        self.assertEqual(result["stale"], 1)
        self.assertEqual(state["fingerprints"], [])
        submit_recovery.assert_not_called()

    def test_local_resume_binding_requires_uuid_v7_checkpoint(self) -> None:
        surface = "11111111-1111-4111-8111-111111111111"
        valid = "01911111-1111-7111-8111-111111111111"
        for checkpoint in (
            None,
            "",
            "not-a-uuid",
            "01911111-1111-1111-8111-111111111111",
            "01911111-1111-4111-8111-111111111111",
            "01911111-1111-8111-8111-111111111111",
        ):
            with self.subTest(checkpoint=checkpoint):
                payload = {
                    "resume_binding": {
                        "kind": "codex",
                        "checkpoint_id": checkpoint,
                        "command": f"codex resume {checkpoint or ''}",
                    }
                }
                self.assertIsNone(watchdog.resume_candidate(surface, payload))
        self.assertEqual(
            watchdog.resume_candidate(
                surface,
                {
                    "resume_binding": {
                        "kind": "codex",
                        "checkpoint_id": valid,
                        "command": f"codex resume {valid}",
                    }
                },
            ),
            {
                "ref": surface,
                "checkpoint": valid,
                "remote": "false",
                "command_ref": watchdog.binding_command_ref(
                    ["codex", "resume", valid]
                ),
            },
        )

    def test_local_resume_binding_requires_command_checkpoint_identity(self) -> None:
        surface = "11111111-1111-4111-8111-111111111111"
        checkpoint = "01911111-1111-7111-8111-111111111111"
        other = "01922222-2222-7222-8222-222222222222"
        for command in (
            None,
            "",
            "codex resume",
            f"codex resume {other}",
            f"sh -c 'codex resume {checkpoint}'",
            f"echo codex resume {checkpoint}",
            f"codex resume {checkpoint} && echo wrong",
            f"codex resume {checkpoint} arbitrary-suffix",
            ["echo", "codex", "resume", checkpoint],
            ["bash", "-c", "codex", "resume", checkpoint],
            ["codex", "resume", checkpoint, "&&", "echo", "wrong"],
            ["codex", "resume", checkpoint, "arbitrary-suffix"],
        ):
            with self.subTest(command=command):
                self.assertIsNone(
                    watchdog.resume_candidate(
                        surface,
                        {
                            "resume_binding": {
                                "kind": "codex",
                                "checkpoint_id": checkpoint,
                                "command": command,
                            }
                        },
                    )
                )

    def test_local_resume_binding_accepts_exact_cmux_command_shape(self) -> None:
        surface = "11111111-1111-4111-8111-111111111111"
        checkpoint = "01911111-1111-7111-8111-111111111111"
        cwd = "/Users/test/project"
        command = (
            f"cd -- '{cwd}' 2>/dev/null || [ ! -d '{cwd}' ] && "
            f"'/opt/bin/codex' 'resume' '{checkpoint}' "
            "'-c' 'check_for_update_on_startup=false' '--yolo'"
        )
        self.assertEqual(
            watchdog.resume_candidate(
                surface,
                {
                    "resume_binding": {
                        "kind": "codex",
                        "checkpoint_id": checkpoint,
                        "command": command,
                    }
                },
            ),
            {
                "ref": surface,
                "checkpoint": checkpoint,
                "remote": "false",
                "command_ref": watchdog.binding_command_ref(
                    [
                        "cd",
                        "--",
                        cwd,
                        "2>/dev/null",
                        "||",
                        "[",
                        "!",
                        "-d",
                        cwd,
                        "]",
                        "&&",
                        "/opt/bin/codex",
                        "resume",
                        checkpoint,
                        "-c",
                        "check_for_update_on_startup=false",
                        "--yolo",
                    ]
                ),
            },
        )
        self.assertIsNone(
            watchdog.resume_candidate(
                surface,
                {
                    "resume_binding": {
                        "kind": "codex",
                        "checkpoint_id": checkpoint,
                        "command": command + " 'arbitrary-suffix'",
                    }
                },
            )
        )
        for invalid in (
            command.removesuffix(" '--yolo'"),
            command.replace("'-c'", "'--yolo' '-c'", 1),
        ):
            with self.subTest(invalid=invalid):
                self.assertIsNone(
                    watchdog.resume_candidate(
                        surface,
                        {
                            "resume_binding": {
                                "kind": "codex",
                                "checkpoint_id": checkpoint,
                                "command": invalid,
                            }
                        },
                    )
                )

    def test_remote_binding_requires_checkpoint_in_command(self) -> None:
        surface = "22222222-2222-4222-8222-222222222222"
        for checkpoint, command in (
            (None, "qjc-agent attach"),
            ("", "qjc-agent attach"),
            ("qjc-codex-42", "qjc-agent attach qjc-codex-other"),
            (
                "qjc-codex-42",
                "qjc-agent attach qjc-codex-other --note qjc-codex-42",
            ),
        ):
            with self.subTest(checkpoint=checkpoint, command=command):
                self.assertIsNone(
                    watchdog.resume_candidate(
                        surface,
                        {
                            "resume_binding": {
                                "kind": "tmux",
                                "checkpoint_id": checkpoint,
                                "command": command,
                            }
                        },
                    )
                )

    def test_remote_codex_launcher_bindings_are_exact_candidates(self) -> None:
        surface = "22222222-2222-4222-8222-222222222222"
        checkpoint = "qjc-codex-42"
        valid_commands = (
            "qjc-agent codex",
            ["/Users/test/bin/qjc-agent", "codex"],
            "qjc-worker agent codex",
            ["/Users/test/bin/qjc-worker", "agent", "codex"],
        )
        for command in valid_commands:
            with self.subTest(command=command):
                command_tokens = command if isinstance(command, list) else command.split()
                candidate = watchdog.resume_candidate(
                    surface,
                    {
                        "resume_binding": {
                            "kind": "tmux",
                            "checkpoint_id": checkpoint,
                            "command": command,
                        }
                    },
                )
                self.assertEqual(
                    candidate,
                    {
                        "ref": surface,
                        "checkpoint": checkpoint,
                        "remote": "true",
                        "command_ref": watchdog.binding_command_ref(command_tokens),
                    },
                )

        for command in (
            "qjc-agent codex --unsafe",
            "qjc-worker agent codex --unsafe",
            "other-agent codex",
        ):
            with self.subTest(command=command):
                self.assertIsNone(
                    watchdog.resume_candidate(
                        surface,
                        {
                            "resume_binding": {
                                "kind": "tmux",
                                "checkpoint_id": checkpoint,
                                "command": command,
                            }
                        },
                    )
                )
        for command in (
            "qjc-agent attach qjc-codex-42",
            ["/Users/test/bin/qjc-agent", "attach", "qjc-codex-42"],
        ):
            with self.subTest(command=command):
                command_tokens = command if isinstance(command, list) else command.split()
                self.assertEqual(
                    watchdog.resume_candidate(
                        surface,
                        {
                            "resume_binding": {
                                "kind": "tmux",
                                "checkpoint_id": "qjc-codex-42",
                                "command": command,
                            }
                        },
                    ),
                    {
                        "ref": surface,
                        "checkpoint": "qjc-codex-42",
                        "remote": "true",
                        "command_ref": watchdog.binding_command_ref(
                            command_tokens
                        ),
                    },
                )

    def test_only_terminal_codex_bindings_are_candidates(self) -> None:
        payload = {
            "surfaces": [
                {
                    "ref": "surface:1",
                    "type": "terminal",
                    "resume_binding": {
                        "kind": "codex",
                        "checkpoint_id": "01911111-1111-7111-8111-111111111111",
                    },
                },
                {
                    "ref": "surface:2",
                    "type": "terminal",
                    "resume_binding": {"kind": "claude"},
                },
                {"ref": "surface:3", "type": "browser"},
            ]
        }
        self.assertEqual(
            watchdog.codex_surfaces(payload),
            [
                {
                    "ref": "surface:1",
                    "checkpoint": "01911111-1111-7111-8111-111111111111",
                }
            ],
        )

    def test_live_process_ttys_join_global_surface_tree(self) -> None:
        process_output = "\n".join(
            [
                "ttys012 /Users/test/. /opt/bin/codex resume abc",
                "ttys003 codex codex --yolo",
                "ttys012 /Users/test/. /opt/bin/codex resume abc",
                "ttys004 node node server.js",
                "ttys047 bash bash /Users/test/bin/qjc-agent codex",
                "ttys056 ssh ssh host /opt/qjc-worker agent codex project",
            ]
        )
        tree_output = "\n".join(
            [
                '│ ├── surface surface:12 [terminal] "A" tty=ttys012',
                '│ ├── surface surface:3 [terminal] "B" tty=ttys003',
                '│ └── surface surface:4 [terminal] "C" tty=ttys004',
                '│ ├── surface surface:47 [terminal] "D" tty=ttys047',
                '│ └── surface surface:56 [terminal] "E" tty=ttys056',
            ]
        )
        self.assertEqual(
            watchdog.process_codex_ttys(process_output),
            ({"ttys003", "ttys012"}, {"ttys047", "ttys056"}),
        )
        self.assertEqual(
            watchdog.surface_tty_map(tree_output),
            {
                "ttys012": "surface:12",
                "ttys003": "surface:3",
                "ttys004": "surface:4",
                "ttys047": "surface:47",
                "ttys056": "surface:56",
            },
        )

    def test_resume_bindings_discover_local_and_remote_without_ps(self) -> None:
        local_id = "11111111-1111-4111-8111-111111111111"
        remote_id = "22222222-2222-4222-8222-222222222222"
        tree_output = json.dumps(
            {
                "windows": [
                    {
                        "workspaces": [
                            {
                                "panes": [
                                    {
                                        "surfaces": [
                                            {"id": local_id, "type": "terminal"},
                                            {"id": remote_id, "type": "terminal"},
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        )
        bindings = {
            local_id: {
                "kind": "codex",
                "checkpoint_id": "01911111-1111-7111-8111-111111111111",
                "command": "codex resume 01911111-1111-7111-8111-111111111111",
            },
            remote_id: {
                "kind": "tmux",
                "checkpoint_id": "qjc-codex-42",
                "command": "qjc-agent attach qjc-codex-42",
            },
        }

        def run_cmux(*args: str, **_kwargs: object) -> str:
            if args == ("--json", "--id-format", "both", "tree", "--all"):
                return tree_output
            if args[:5] == ("--json", "surface", "resume", "get", "--surface"):
                return json.dumps({"resume_binding": bindings[args[5]]})
            raise AssertionError(args)

        with (
            mock.patch.object(watchdog, "run_cmux", side_effect=run_cmux),
            mock.patch.object(
                watchdog.subprocess,
                "run",
                side_effect=AssertionError("global ps must not run"),
            ),
        ):
            candidates, complete = watchdog.discover_candidates([])

        self.assertTrue(complete)
        self.assertEqual(
            candidates,
            [
                {
                    "ref": local_id,
                    "checkpoint": "01911111-1111-7111-8111-111111111111",
                    "remote": "false",
                    "command_ref": watchdog.binding_command_ref(
                        [
                            "codex",
                            "resume",
                            "01911111-1111-7111-8111-111111111111",
                        ]
                    ),
                },
                {
                    "ref": remote_id,
                    "checkpoint": "qjc-codex-42",
                    "remote": "true",
                    "command_ref": watchdog.binding_command_ref(
                        ["qjc-agent", "attach", "qjc-codex-42"]
                    ),
                },
            ],
        )

    def test_binding_lookup_timeout_skips_only_affected_surface(self) -> None:
        stale_id = "33333333-3333-4333-8333-333333333333"
        healthy_id = "44444444-4444-4444-8444-444444444444"
        tree_output = json.dumps(
            {
                "windows": [
                    {
                        "workspaces": [
                            {
                                "panes": [
                                    {
                                        "surfaces": [
                                            {"id": stale_id, "type": "terminal"},
                                            {"id": healthy_id, "type": "terminal"},
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        )

        def run_cmux(*args: str, **_kwargs: object) -> str:
            if args == ("--json", "--id-format", "both", "tree", "--all"):
                return tree_output
            if args[-1] == stale_id:
                raise subprocess.TimeoutExpired(args, 2)
            if args[-1] == healthy_id:
                return json.dumps(
                    {
                        "resume_binding": {
                            "kind": "codex",
                            "checkpoint_id": "01944444-4444-7444-8444-444444444444",
                            "command": (
                                "codex resume "
                                "01944444-4444-7444-8444-444444444444"
                            ),
                        }
                    }
                )
            raise AssertionError(args)

        with mock.patch.object(watchdog, "run_cmux", side_effect=run_cmux):
            candidates, complete = watchdog.discover_candidates([])

        self.assertFalse(complete)
        self.assertEqual(
            candidates,
            [
                {
                    "ref": healthy_id,
                    "checkpoint": "01944444-4444-7444-8444-444444444444",
                    "remote": "false",
                    "command_ref": watchdog.binding_command_ref(
                        [
                            "codex",
                            "resume",
                            "01944444-4444-7444-8444-444444444444",
                        ]
                    ),
                }
            ],
        )

    def test_tree_timeout_revalidates_stable_cached_surface(self) -> None:
        surface_id = "55555555-5555-4555-8555-555555555555"
        cached = [
            {
                "ref": surface_id,
                "checkpoint": "01955555-5555-7555-8555-555555555555",
                "remote": "false",
            }
        ]

        def run_cmux(*args: str, **_kwargs: object) -> str:
            if args == ("--json", "--id-format", "both", "tree", "--all"):
                raise subprocess.TimeoutExpired(args, 12)
            if args[-1] == surface_id:
                return json.dumps(
                    {
                        "resume_binding": {
                            "kind": "codex",
                            "checkpoint_id": "01966666-6666-7666-8666-666666666666",
                            "command": (
                                "codex resume "
                                "01966666-6666-7666-8666-666666666666"
                            ),
                        }
                    }
                )
            raise AssertionError(args)

        with mock.patch.object(watchdog, "run_cmux", side_effect=run_cmux):
            candidates, complete = watchdog.discover_candidates(cached)

        self.assertFalse(complete)
        self.assertEqual(
            candidates,
            [
                {
                    "ref": surface_id,
                    "checkpoint": "01966666-6666-7666-8666-666666666666",
                    "remote": "false",
                    "command_ref": watchdog.binding_command_ref(
                        [
                            "codex",
                            "resume",
                            "01966666-6666-7666-8666-666666666666",
                        ]
                    ),
                }
            ],
        )

    def test_tree_without_stable_ids_revalidates_cached_surface(self) -> None:
        surface_id = "66666666-6666-4666-8666-666666666666"
        tree_output = json.dumps(
            {
                "windows": [
                    {
                        "workspaces": [
                            {
                                "panes": [
                                    {
                                        "surfaces": [
                                            {"ref": "surface:46", "type": "terminal"}
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        )
        cached = [
            {
                "ref": surface_id,
                "checkpoint": "01955555-5555-7555-8555-555555555555",
                "remote": "false",
            }
        ]

        def run_cmux(*args: str, **_kwargs: object) -> str:
            if args == ("--json", "--id-format", "both", "tree", "--all"):
                return tree_output
            if args[-1] == surface_id:
                return json.dumps(
                    {
                        "resume_binding": {
                            "kind": "codex",
                            "checkpoint_id": "01966666-6666-7666-8666-666666666666",
                            "command": (
                                "codex resume "
                                "01966666-6666-7666-8666-666666666666"
                            ),
                        }
                    }
                )
            raise AssertionError(args)

        with mock.patch.object(watchdog, "run_cmux", side_effect=run_cmux):
            candidates, complete = watchdog.discover_candidates(cached)

        self.assertFalse(complete)
        self.assertEqual(candidates[0]["ref"], surface_id)
        self.assertEqual(
            candidates[0]["checkpoint"],
            "01966666-6666-7666-8666-666666666666",
        )

    def test_unknown_topology_never_consumes_recovery_attempt(self) -> None:
        match = watchdog.Match(fingerprint="fingerprint", port=61475)
        candidate = {
            "ref": "surface:41",
            "checkpoint": "session-41",
            "remote": "unknown",
        }
        state = {"fingerprints": [], "last_recovery": {}}
        with (
            mock.patch.object(
                watchdog, "discover_candidates", return_value=([candidate], True)
            ),
            mock.patch.object(
                watchdog,
                "inspect_surface",
                return_value=("surface:41", match, None, "unknown"),
            ),
            mock.patch.object(watchdog, "load_state", return_value=state),
            mock.patch.object(watchdog, "save_state"),
            mock.patch.object(watchdog, "proxy_healthy", return_value=True),
            mock.patch.object(watchdog, "submit_recovery") as submit_recovery,
            mock.patch.object(watchdog, "log_event") as log_event,
        ):
            result = watchdog.scan(dry_run=False)

        self.assertEqual(result["topology_unknown"], 1)
        self.assertEqual(state["fingerprints"], [])
        self.assertEqual(state["last_recovery"], {})
        submit_recovery.assert_not_called()
        log_event.assert_called_once_with("topology-unknown", "surface:41")

    def test_binding_change_before_send_is_stale(self) -> None:
        match = watchdog.Match(fingerprint="fingerprint", port=61475)
        candidate = {
            "ref": "surface:41",
            "checkpoint": "session-41",
            "remote": "false",
            "command_ref": "command-original",
        }
        cases = {
            "shell": (None, False),
            "lookup-error": (None, True),
            "checkpoint-changed": (
                {**candidate, "checkpoint": "session-42"},
                False,
            ),
            "remote-changed": ({**candidate, "remote": "true"}, False),
            "command-changed": (
                {**candidate, "command_ref": "command-changed"},
                False,
            ),
        }
        for name, lookup_result in cases.items():
            with self.subTest(name=name):
                state = {"fingerprints": [], "last_recovery": {}}
                with (
                    mock.patch.object(
                        watchdog,
                        "discover_candidates",
                        return_value=([candidate], True),
                    ),
                    mock.patch.object(
                        watchdog,
                        "inspect_surface",
                        return_value=("surface:41", match, None, "false"),
                    ),
                    mock.patch.object(
                        watchdog,
                        "lookup_resume_candidate",
                        return_value=lookup_result,
                    ) as lookup_resume_candidate,
                    mock.patch.object(watchdog, "load_state", return_value=state),
                    mock.patch.object(watchdog, "save_state"),
                    mock.patch.object(watchdog, "proxy_healthy", return_value=True),
                    mock.patch.object(watchdog, "log_event"),
                    mock.patch.object(
                        watchdog,
                        "submit_recovery",
                        return_value=(True, "submitted"),
                    ) as submit_recovery,
                ):
                    result = watchdog.scan(dry_run=False)

                self.assertEqual(result["stale"], 1)
                self.assertEqual(state["fingerprints"], [])
                self.assertEqual(state["last_recovery"], {})
                lookup_resume_candidate.assert_called_once_with("surface:41")
                submit_recovery.assert_not_called()

    def test_binding_change_after_final_screen_is_stale(self) -> None:
        match = watchdog.Match(fingerprint="fingerprint", port=61475)
        candidate = {
            "ref": "surface:41",
            "checkpoint": "session-41",
            "remote": "false",
            "command_ref": "command-original",
        }
        changed = {**candidate, "command_ref": "command-changed"}
        state = {"fingerprints": [], "last_recovery": {}}
        with (
            mock.patch.object(
                watchdog, "discover_candidates", return_value=([candidate], True)
            ),
            mock.patch.object(
                watchdog,
                "inspect_surface",
                return_value=("surface:41", match, None, "false"),
            ),
            mock.patch.object(
                watchdog,
                "lookup_resume_candidate",
                side_effect=[(candidate, False), (changed, False)],
            ) as lookup_resume_candidate,
            mock.patch.object(watchdog, "load_state", return_value=state),
            mock.patch.object(watchdog, "save_state"),
            mock.patch.object(watchdog, "proxy_healthy", return_value=True),
            mock.patch.object(watchdog, "log_event"),
            mock.patch.object(
                watchdog, "submit_recovery", return_value=(True, "submitted")
            ) as submit_recovery,
        ):
            result = watchdog.scan(dry_run=False)

        self.assertEqual(result["stale"], 1)
        self.assertEqual(result["submitted"], 0)
        self.assertEqual(state["fingerprints"], [])
        self.assertEqual(state["last_recovery"], {})
        self.assertEqual(lookup_resume_candidate.call_count, 2)
        submit_recovery.assert_not_called()

    def test_user_draft_started_after_final_binding_check_is_stale(self) -> None:
        match = watchdog.Match(fingerprint="fingerprint", port=61475)
        candidate = {
            "ref": "surface:41",
            "checkpoint": "session-41",
            "remote": "false",
            "command_ref": "command-stable",
        }
        state = {"fingerprints": [], "last_recovery": {}}
        with (
            mock.patch.object(
                watchdog, "discover_candidates", return_value=([candidate], True)
            ),
            mock.patch.object(
                watchdog,
                "inspect_surface",
                side_effect=[
                    ("surface:41", match, None, "false"),
                    ("surface:41", match, None, "false"),
                    ("surface:41", match, None, "false"),
                    ("surface:41", None, None, "false"),
                ],
            ) as inspect_surface,
            mock.patch.object(
                watchdog,
                "lookup_resume_candidate",
                return_value=(candidate, False),
            ),
            mock.patch.object(watchdog, "load_state", return_value=state),
            mock.patch.object(watchdog, "save_state") as save_state,
            mock.patch.object(watchdog, "proxy_healthy", return_value=True),
            mock.patch.object(watchdog, "log_event"),
            mock.patch.object(
                watchdog, "submit_recovery", return_value=(True, "submitted")
            ) as submit_recovery,
        ):
            result = watchdog.scan(dry_run=False)

        self.assertEqual(result["stale"], 1)
        self.assertEqual(result["submitted"], 0)
        self.assertEqual(state["fingerprints"], [])
        self.assertEqual(state["last_recovery"], {})
        self.assertEqual(inspect_surface.call_count, 4)
        self.assertGreaterEqual(save_state.call_count, 2)
        submit_recovery.assert_not_called()

    def test_user_draft_started_during_binding_check_is_stale(self) -> None:
        match = watchdog.Match(fingerprint="fingerprint", port=61475)
        candidate = {
            "ref": "surface:41",
            "checkpoint": "session-41",
            "remote": "false",
        }
        state = {"fingerprints": [], "last_recovery": {}}
        with (
            mock.patch.object(
                watchdog, "discover_candidates", return_value=([candidate], True)
            ),
            mock.patch.object(
                watchdog,
                "inspect_surface",
                side_effect=[
                    ("surface:41", match, None, "false"),
                    ("surface:41", match, None, "false"),
                    ("surface:41", None, None, "false"),
                ],
            ),
            mock.patch.object(
                watchdog,
                "lookup_resume_candidate",
                return_value=(candidate, False),
            ),
            mock.patch.object(watchdog, "load_state", return_value=state),
            mock.patch.object(watchdog, "save_state"),
            mock.patch.object(watchdog, "proxy_healthy", return_value=True),
            mock.patch.object(watchdog, "log_event"),
            mock.patch.object(
                watchdog, "submit_recovery", return_value=(True, "submitted")
            ) as submit_recovery,
        ):
            result = watchdog.scan(dry_run=False)

        self.assertEqual(result["stale"], 1)
        self.assertEqual(state["fingerprints"], [])
        self.assertEqual(state["last_recovery"], {})
        submit_recovery.assert_not_called()

    def test_unchanged_binding_and_screen_submit_once(self) -> None:
        match = watchdog.Match(fingerprint="fingerprint", port=61475)
        candidate = {
            "ref": "surface:41",
            "checkpoint": "session-41",
            "remote": "false",
            "command_ref": "command-stable",
        }
        state = {"fingerprints": [], "last_recovery": {}}
        with (
            mock.patch.object(
                watchdog, "discover_candidates", return_value=([candidate], True)
            ),
            mock.patch.object(
                watchdog,
                "inspect_surface",
                return_value=("surface:41", match, None, "false"),
            ) as inspect_surface,
            mock.patch.object(
                watchdog,
                "lookup_resume_candidate",
                return_value=(candidate, False),
            ),
            mock.patch.object(watchdog, "load_state", return_value=state),
            mock.patch.object(watchdog, "save_state"),
            mock.patch.object(watchdog, "proxy_healthy", return_value=True),
            mock.patch.object(watchdog, "log_event"),
            mock.patch.object(
                watchdog, "submit_recovery", return_value=(True, "submitted")
            ) as submit_recovery,
        ):
            result = watchdog.scan(dry_run=False)

        self.assertEqual(result["submitted"], 1)
        self.assertEqual(result["stale"], 0)
        self.assertEqual(inspect_surface.call_count, 4)
        submit_recovery.assert_called_once_with("surface:41")

    def test_proxy_status_requires_accounts_array(self) -> None:
        self.assertTrue(watchdog.valid_proxy_status(b'{"accounts":[]}'))
        self.assertFalse(watchdog.valid_proxy_status(b'{"ok":true}'))

    def test_submit_recovery_targets_exact_surface_once(self) -> None:
        with mock.patch.object(watchdog, "run_cmux", return_value="OK") as run_cmux:
            self.assertEqual(watchdog.submit_recovery("surface:9"), (True, "submitted"))
        self.assertEqual(
            run_cmux.call_args_list,
            [
                mock.call(
                    "send",
                    "--surface",
                    "surface:9",
                    # cmux Enter = 리터럴 "\n" 이스케이프 (실개행은 미제출 — 2026-08-14 실증)
                    watchdog.RECOVERY_MESSAGE + "\\n",
                ),
            ],
        )

    def test_failed_submit_does_not_report_success(self) -> None:
        with mock.patch.object(watchdog, "run_cmux", side_effect=RuntimeError("failed")):
            ok, result = watchdog.submit_recovery("surface:9")
        self.assertFalse(ok)
        self.assertEqual(result, "send-RuntimeError")

    def test_fingerprint_and_cooldown_prevent_duplicate(self) -> None:
        match = watchdog.Match(fingerprint="fingerprint", port=61475)
        state = {"fingerprints": ["surface:1:fingerprint"], "last_recovery": {}}
        self.assertTrue(watchdog.is_duplicate(state, "surface:1", match, time.time()))

        self.assertFalse(watchdog.is_duplicate(state, "surface:2", match, time.time()))

        fresh = {"fingerprints": [], "last_recovery": {"surface:1": {"at": time.time()}}}
        other = watchdog.Match(fingerprint="other", port=61475)
        self.assertTrue(watchdog.is_duplicate(fresh, "surface:1", other, time.time()))

        capacity = watchdog.Match(fingerprint="capacity", port=None)
        capacity_state = {
            "fingerprints": ["surface:1:capacity"],
            "last_recovery": {},
        }
        self.assertTrue(
            watchdog.is_duplicate(capacity_state, "surface:1", capacity, time.time())
        )

    def test_attempt_is_persisted_before_recovery_send(self) -> None:
        match = watchdog.Match(fingerprint="fingerprint", port=61475)
        state = {"fingerprints": [], "last_recovery": {}}
        events: list[str] = []

        def save_state(_state: object) -> None:
            events.append("save")

        def submit_recovery(_surface: str) -> tuple[bool, str]:
            events.append("send")
            return False, "send-TimeoutExpired"

        with (
            mock.patch.object(watchdog, "save_state", side_effect=save_state),
            mock.patch.object(
                watchdog, "submit_recovery", side_effect=submit_recovery
            ),
        ):
            ok, result = watchdog.attempt_recovery(
                state, "surface:1", match, 1.0
            )

        self.assertFalse(ok)
        self.assertEqual(result, "send-TimeoutExpired")
        self.assertEqual(events, ["save", "send", "save"])
        self.assertTrue(watchdog.is_duplicate(state, "surface:1", match, 2.0))
        self.assertEqual(
            state["last_recovery"]["surface:1"]["result"],
            "send-TimeoutExpired",
        )
        self.assertEqual(state["recovery_history"]["surface:1"], [1.0])

    def test_successful_attempt_records_recovery_history(self) -> None:
        match = watchdog.Match(fingerprint="fingerprint", port=None)
        state = {"fingerprints": [], "last_recovery": {}}
        with (
            mock.patch.object(watchdog, "save_state"),
            mock.patch.object(
                watchdog, "submit_recovery", return_value=(True, "submitted")
            ),
        ):
            ok, result = watchdog.attempt_recovery(
                state, "surface:1", match, 123.0
            )
        self.assertTrue(ok)
        self.assertEqual(result, "submitted")
        self.assertEqual(state["recovery_history"]["surface:1"], [123.0])

    def test_health_cli_prints_read_only_snapshot(self) -> None:
        with (
            mock.patch.object(sys, "argv", ["codex_502_watchdog.py", "--health"]),
            mock.patch.object(
                watchdog,
                "health_snapshot",
                return_value={"status": "ok", "recommendations": []},
            ),
            mock.patch("builtins.print") as output,
        ):
            self.assertEqual(watchdog.main(), 0)
        output.assert_called_once_with(
            '{"recommendations": [], "status": "ok"}'
        )

    def test_resume_command_cli_validates_checkpoint(self) -> None:
        checkpoint = "01977777-7777-7777-8777-777777777777"
        with (
            mock.patch.object(
                sys,
                "argv",
                ["codex_502_watchdog.py", "--resume-command", checkpoint],
            ),
            mock.patch("builtins.print") as output,
        ):
            self.assertEqual(watchdog.main(), 0)
        output.assert_called_once_with(f"codex resume {checkpoint}")

        with mock.patch.object(
            sys,
            "argv",
            ["codex_502_watchdog.py", "--resume-command", "$(unsafe)"],
        ):
            self.assertEqual(watchdog.main(), 2)

    def test_transient_scan_timeout_defers_without_failing_launchd_tick(self) -> None:
        with (
            mock.patch.object(watchdog, "scan", side_effect=subprocess.TimeoutExpired("cmux", 12)),
            mock.patch.object(watchdog, "log_event") as log_event,
            mock.patch.object(sys, "argv", ["codex_502_watchdog.py"]),
            mock.patch.object(watchdog, "STATE_DIR") as state_dir,
            mock.patch.object(watchdog, "LOCK_PATH") as lock_path,
            mock.patch.object(watchdog.fcntl, "flock"),
        ):
            state_dir.mkdir.return_value = None
            lock = mock.MagicMock()
            lock_path.open.return_value.__enter__.return_value = lock
            self.assertEqual(watchdog.main(), 0)

        log_event.assert_called_once_with("scan-deferred", detail="TimeoutExpired")


if __name__ == "__main__":
    unittest.main()
