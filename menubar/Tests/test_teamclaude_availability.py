from pathlib import Path
import json
import hashlib
import secrets
import os
import plistlib
import stat
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = Path('/private/tmp/teamclaude-fable-ui-evidence-20260909')


def private_output(path):
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError('QA output must be an owned private directory, not a symlink')
    return path


def interactive_result(output, nonce, executable_hash):
    lines = [line.removeprefix('INTERACTIVE-RESULT:') for line in output.splitlines()
             if line.startswith('INTERACTIVE-RESULT:')]
    if len(lines) != 1:
        raise ValueError('Exactly one child-process result is required')
    result = json.loads(lines[0])
    expected = {'nonce': nonce, 'executable_sha256': executable_hash,
                'invalid_date_blocked': True, 'saved': True,
                'ready_before': 4, 'ready_after': 3, 'last_row_visible': True}
    if result != expected or any(type(result[key]) is not bool for key in
                                 ['invalid_date_blocked', 'saved', 'last_row_visible']):
        raise ValueError('Interactive result does not match this execution')
    return result


class TeamClaudeAvailabilityTests(unittest.TestCase):
    interactive = False
    @classmethod
    def setUpClass(cls):
        private_output(OUTPUT)
        cls.run_dir = Path(tempfile.mkdtemp(prefix='run-', dir=OUTPUT))
        fd, temporary = tempfile.mkstemp(prefix='latest-', dir=OUTPUT)
        with os.fdopen(fd, 'w') as stream:
            json.dump({'directory': str(cls.run_dir)}, stream)
        os.replace(temporary, OUTPUT / 'latest-run.json')

    def test_private_output_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            target = base / 'target'
            target.mkdir(mode=0o700)
            link = base / 'link'
            link.symlink_to(target)
            with self.assertRaises(RuntimeError):
                private_output(link)
            target.chmod(0o777)
            with self.assertRaises(RuntimeError):
                private_output(target)
            target.chmod(0o700)
            first = Path(tempfile.mkdtemp(dir=target))
            second = Path(tempfile.mkdtemp(dir=target))
            self.assertNotEqual(first, second)
            self.assertEqual(stat.S_IMODE(first.stat().st_mode), 0o700)

    def test_full_optimized_binary(self):
        binary = self.run_dir / 'cc-menubar'
        sources = sorted((ROOT / 'menubar/Sources').glob('*.swift'))
        result = subprocess.run(['/usr/bin/swiftc', '-j', '1', '-num-threads', '1', '-O',
            '-framework', 'Cocoa', '-framework', 'Foundation', '-target', 'arm64-apple-macosx13.0',
            *map(str, sources), '-o', str(binary)], capture_output=True, text=True, timeout=240)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run([str(binary), '--teamcodex-dashboard-selftest'],
            capture_output=True, text=True, timeout=40)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        print('FABLE-FULL-BUILD: optimized production binary and dashboard selftest passed')

    def test_production_availability_and_layout(self):
        main = (ROOT / 'menubar/Sources/main.swift').read_text()
        declarations = self.run_dir / 'ProductionMenuTypes.swift'
        declarations.write_text(main.split('// MARK: - 진입점')[0])
        sources = sorted(path for path in (ROOT / 'menubar/Sources').glob('*.swift') if path.name != 'main.swift')
        bundle = self.run_dir / 'TeamClaude QA.app'
        executable = bundle / 'Contents/MacOS/fable-ui-tests'
        executable.parent.mkdir(parents=True)
        (bundle / 'Contents/Info.plist').write_bytes(plistlib.dumps({
            'CFBundleIdentifier': 'com.qjc.teamclaude-fable-ui-qa',
            'CFBundleName': 'TeamClaude QA', 'CFBundleExecutable': 'fable-ui-tests',
            'CFBundlePackageType': 'APPL', 'NSHighResolutionCapable': True}))
        result = subprocess.run(['/usr/bin/swiftc', '-j', '1', '-num-threads', '1',
            '-framework', 'Cocoa', '-framework', 'Foundation', *map(str, sources), str(declarations),
            str(ROOT / 'menubar/Tests/TeamClaudeAvailabilityTests.swift'), '-o', str(executable)],
            capture_output=True, text=True, timeout=240)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run([str(executable), '--screenshot', str(self.run_dir / 'fable-dashboard.png')],
            capture_output=True, text=True, timeout=40)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        print(result.stdout)
        (self.run_dir / 'test-result.txt').write_text(result.stdout)
        self.assertIn('FABLE-LAYOUT:', result.stdout)
        if self.interactive:
            nonce = secrets.token_hex(24)
            executable_hash = hashlib.sha256(executable.read_bytes()).hexdigest()
            (self.run_dir / 'interactive-ready.json').write_text(json.dumps({'app': str(bundle)}))
            # Keep the actual fixture as our child; its stdout pipe and exit status
            # are the result channel, never an operator-authored marker file.
            result = subprocess.run([str(executable), '--automated-modal', nonce],
                capture_output=True, text=True, timeout=40)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            verified = interactive_result(result.stdout, nonce, executable_hash)
            (self.run_dir / 'interactive-result.json').write_text(json.dumps(verified))
            print('AUTOMATED-MODAL-UI: child exit 0, matching nonce and executable digest, '
                  'invalid date blocked, modal save, count 4 to 3, last row visible passed')

    def test_manual_cua_matches_current_production_sources(self):
        plan = (ROOT / 'docs/plans/2026-09-09-teamclaude-availability.md').read_text()
        payload = plan.split('<!-- MANUAL-CUA-JSON -->\n```json\n', 1)[1].split('\n```', 1)[0]
        record = json.loads(payload)
        run = Path(record['run_directory'])
        self.assertEqual(run.parent, OUTPUT)
        private_output(run)
        for name, digest in record['production_sources'].items():
            self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest)
        self.assertEqual(hashlib.sha256((ROOT / 'menubar/Tests/TeamClaudeAvailabilityTests.swift').read_bytes()).hexdigest(),
                         record['fixture_source_sha256'])
        self.assertEqual(hashlib.sha256((run / 'cc-menubar').read_bytes()).hexdigest(),
                         record['production_executable_sha256'])
        digest = hashlib.sha256((run / 'TeamClaude QA.app/Contents/MacOS/fable-ui-tests').read_bytes()).hexdigest()
        process = json.loads((run / 'manual-result.json').read_text())
        self.assertEqual(process, record['process'])
        self.assertEqual(process['mode'], 'manual-cua')
        self.assertEqual(process['exit_status'], 0)
        interactive_result('INTERACTIVE-RESULT:' + json.dumps(process['result']),
                           process['result']['nonce'], digest)
        self.assertEqual(hashlib.sha256((run / 'fable-dashboard.png').read_bytes()).hexdigest(),
                         record['layout_screenshot_sha256'])
        print('MANUAL-CUA-LINK: prior actual CUA run, current production/fixture source hashes, '
              'exact deployed binary, captured child exit 0 and screenshot digest all match')

    def test_interactive_result_rejects_unbound_or_failed_results(self):
        valid = {'nonce': 'run-a', 'executable_sha256': 'digest-a',
                 'invalid_date_blocked': True, 'saved': True,
                 'ready_before': 4, 'ready_after': 3, 'last_row_visible': True}
        payload = 'INTERACTIVE-RESULT:' + json.dumps(valid)
        self.assertEqual(interactive_result(payload, 'run-a', 'digest-a'), valid)
        for output in ['passed', 'not passed', payload + '\n' + payload,
                       'INTERACTIVE-RESULT:' + json.dumps({**valid, 'saved': False}),
                       'INTERACTIVE-RESULT:' + json.dumps({**valid, 'nonce': 'old-run'}),
                       'INTERACTIVE-RESULT:' + json.dumps({**valid, 'executable_sha256': 'old-binary'}),
                       'INTERACTIVE-RESULT:' + json.dumps({**valid, 'last_row_visible': 1})]:
            with self.assertRaises(ValueError):
                interactive_result(output, 'run-a', 'digest-a')



class ProductionTeamClaudeAvailabilityTests(TeamClaudeAvailabilityTests):
    interactive = True


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromTestCase(TeamClaudeAvailabilityTests)


if __name__ == '__main__':
    unittest.main(verbosity=2)
