#!/usr/bin/env python3
"""menubar/qa.sh 발행 쪽 회귀(검토 지적 2026-10-26).

- 요청이 이미 있으면 덮어쓰지 않는다(동시 실행 두 개가 서로의 요청을 지우지 않는다).
- 앱이 거부할 요청(같은 산출물 이름, 64KiB 초과)은 발행 전에 바로 실패한다.
"""
import importlib.machinery
import importlib.util
import os
import pathlib
import tempfile
import unittest

QA_SCRIPT = pathlib.Path(__file__).resolve().parent.parent / "qa.sh"


def load_qa(home):
    os.environ["HOME"] = home
    loader = importlib.machinery.SourceFileLoader("qa_cli_under_test", str(QA_SCRIPT))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class QACliTests(unittest.TestCase):
    def setUp(self):
        self.saved_home = os.environ.get("HOME")
        self.home = tempfile.mkdtemp(prefix="qa-cli-")
        self.qa = load_qa(self.home)
        self.qa.ensure_root()
        (self.qa.ROOT / "ENABLED").write_text("")
        os.chmod(self.qa.ROOT / "ENABLED", 0o600)

    def tearDown(self):
        if self.saved_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self.saved_home

    def test_pending_request_is_never_overwritten(self):
        self.qa.write_request({"id": "first", "steps": [{"open": True}]})
        before = self.qa.REQUEST.read_bytes()
        with self.assertRaises(SystemExit):
            self.qa.write_request({"id": "second", "steps": [{"close": True}]})
        self.assertEqual(self.qa.REQUEST.read_bytes(), before)
        self.assertTrue(before.startswith(b'{"id":"first"'))

    def test_duplicate_or_reserved_names_fail_before_publishing(self):
        for steps in ([{"capture": "x"}, {"capture": "x"}], [{"state": "x"}, {"state": "x"}], [{"state": "result"}]):
            with self.assertRaises(SystemExit):
                self.qa.write_request({"id": "dup", "steps": steps})
            self.assertFalse(os.path.lexists(self.qa.REQUEST))

    def test_default_scenario_passes_the_same_name_rules(self):
        # 기본 시나리오가 capture·state에 같은 이름을 써서 기본 실행이 거부됐다(2026-10-26 머지 후 실측).
        self.qa.encode_request({"id": "default", "steps": self.qa.default_steps()})

    def test_oversized_request_fails_before_publishing(self):
        steps = [{"capture": f"n{i}"} for i in range(4000)]
        with self.assertRaises(SystemExit):
            self.qa.write_request({"id": "big", "steps": steps})
        self.assertFalse(os.path.lexists(self.qa.REQUEST))


if __name__ == "__main__":
    unittest.main()
