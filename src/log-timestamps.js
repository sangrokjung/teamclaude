// launchd captures stdout/stderr to plain files with no timestamps, so an
// incident leaves hundreds of "[TeamClaude] Proxy worker stopped" lines that
// cannot be placed in time. Prefix ISO time when not attached to a terminal.
// A TTY keeps raw lines: the TUI mirrors console output into its log pane.
export function installTimestampedConsole({
  console: target = console,
  isTTY = Boolean(process.stdout.isTTY),
  now = () => new Date(),
} = {}) {
  if (isTTY) return () => {};
  const originalLog = target.log;
  const originalError = target.error;
  target.log = (...args) => originalLog.call(target, now().toISOString(), ...args);
  target.error = (...args) => originalError.call(target, now().toISOString(), ...args);
  return () => {
    target.log = originalLog;
    target.error = originalError;
  };
}
