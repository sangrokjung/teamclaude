import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]

class AccountSubscriptionTest(unittest.TestCase):
    def test_subscription_validation_and_identity(self):
        with tempfile.TemporaryDirectory(prefix='cc-subscription-tests-') as directory:
            executable = pathlib.Path(directory) / 'subscription-tests'
            result = subprocess.run(['/usr/bin/swiftc', '-j', '1', '-num-threads', '1',
                str(ROOT / 'menubar/Sources/AccountSubscription.swift'),
                str(ROOT / 'menubar/Sources/AccountSubscriptionButton.swift'),
                '-framework', 'Cocoa',
                str(ROOT / 'menubar/Tests/AccountSubscriptionTests.swift'),
                '-o', str(executable)], capture_output=True, text=True, timeout=600)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([str(executable)], capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('assertions passed', result.stdout)

    def test_full_menu_build_and_account_layout(self):
        with tempfile.TemporaryDirectory(prefix='cc-subscription-build-') as directory:
            executable = pathlib.Path(directory) / 'cc-menubar'
            sources = sorted((ROOT / 'menubar/Sources').glob('*.swift'))
            result = subprocess.run(['/usr/bin/swiftc', '-j', '1', '-num-threads', '1', '-framework', 'Cocoa', '-framework', 'Foundation',
                                     *map(str, sources), '-o', str(executable)],
                                    capture_output=True, text=True, timeout=600)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([str(executable), '--teamcodex-dashboard-selftest'],
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_actual_claude_rows_cancellation_layout(self):
        with tempfile.TemporaryDirectory(prefix='cc-cancellation-layout-') as directory:
            directory = pathlib.Path(directory)
            executable = directory / 'layout-tests'
            main_source = (ROOT / 'menubar/Sources/main.swift').read_text()
            entry_marker = '// MARK: - 진입점'
            self.assertEqual(main_source.count(entry_marker), 1)
            # Compile the actual production types; replace only the process entry point.
            declarations = directory / 'ProductionMenuTypes.swift'
            declarations.write_text(main_source.split(entry_marker)[0])
            sources = sorted(path for path in (ROOT / 'menubar/Sources').glob('*.swift') if path.name != 'main.swift')
            result = subprocess.run(['/usr/bin/swiftc', '-j', '1', '-num-threads', '1',
                '-framework', 'Cocoa', '-framework', 'Foundation', *map(str, sources), str(declarations),
                str(ROOT / 'menubar/Tests/AccountSubscriptionLayoutTests.swift'), '-o', str(executable)],
                capture_output=True, text=True, timeout=600)
            self.assertEqual(result.returncode, 0, result.stderr)
            screenshots = pathlib.Path(tempfile.mkdtemp(prefix='cc-subscription-gray-native-'))
            result = subprocess.run([str(executable), '--screenshot-dir', str(screenshots)], capture_output=True, text=True, timeout=30)
            print('Native screenshots:', screenshots)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('CANCELLATION-LAYOUT: actual Claude16 rows, six states, recovery buttons and scroll end passed', result.stdout)

if __name__ == '__main__':
    unittest.main(verbosity=2)
