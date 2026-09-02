import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function killSpawnGroup(result) {
  if (!Number.isInteger(result.pid)) return;
  try {
    process.kill(-result.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

test("model recovery gate includes the Python watchdog regressions", () => {
  const env = { ...process.env };
  delete env.TEAMCLAUDE_SESSION_SUPERVISED;
  const result = spawnSync(
    "python3",
    [
      "-m", "unittest", "discover", "-s", "test",
      "-p", "test_codex_502_watchdog*.py", "-v",
    ],
    { cwd: root, detached: true, encoding: "utf8", env, timeout: 300_000 },
  );
  killSpawnGroup(result);

  assert.equal(
    result.status,
    0,
    `Python watchdog regressions failed:\n${result.stdout}\n${result.stderr}`,
  );
  assert.match(result.stderr, /Ran 102 tests/);
  assert.match(result.stderr, /OK/);
  console.log("Python watchdog regression suite: 102/102 PASS");
});

test("model recovery gate executes the pinned full recovery verifier", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.TEAMCLAUDE_SESSION_SUPERVISED;
  const result = spawnSync(
    "python3",
    [
      "test/test_model_recovery_gate.py",
      "ModelRecoveryGateTest.test_node_model_recovery_regressions",
      "ModelRecoveryGateTest.test_watchdog_source_matches_operating_copy",
      "ModelRecoveryGateTest.test_account_manager_evidence_matches_source",
      "-v",
    ],
    { cwd: root, detached: true, encoding: "utf8", env, timeout: 300_000 },
  );
  killSpawnGroup(result);

  assert.equal(
    result.status,
    0,
    `Pinned source evidence failed:\n${result.stdout}\n${result.stderr}`,
  );
  assert.match(result.stderr, /Ran 3 tests/);
  assert.match(result.stderr, /OK/);
  console.log("Python pinned full recovery verifier: 3/3 PASS");
});

test("model recovery gate executes the proxy compatibility contracts", () => {
  const env = {
    ...process.env,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.TEAMCLAUDE_SESSION_SUPERVISED;
  const result = spawnSync(
    process.execPath,
    [
      "--test", "--test-reporter=tap", "--test-concurrency=1",
      "test/account-manager.test.js",
      "test/server-codex-model-compatibility.test.js",
      "test/server-proxy-connection.test.js",
    ],
    { cwd: root, detached: true, encoding: "utf8", env, timeout: 300_000 },
  );
  killSpawnGroup(result);

  assert.equal(
    result.status,
    0,
    `Proxy compatibility contracts failed:\n${result.stdout}\n${result.stderr}`,
  );
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /# fail 0/);
  assert.match(output, /# skipped 0/);
  console.log("Proxy compatibility contracts: PASS");
});

test("model recovery gate includes the remaining Node recovery contracts", async () => {
  const env = {
    ...process.env,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.TEAMCLAUDE_SESSION_SUPERVISED;

  const recovery = spawnSync(
    process.execPath,
    [
      "--test", "--test-reporter=tap", "--test-concurrency=1",
      "--test-name-pattern=codex resume launches an explicit session through TeamCodex|default config bounds Claude connection recovery to fifteen minutes|real proxy and run reopen an ambiguous session without issuing a second POST",
      "test/codex-resume.test.js",
      "test/config.test.js",
      "test/run-recovery.test.js",
    ],
    { cwd: root, detached: true, encoding: "utf8", env, timeout: 300_000 },
  );
  killSpawnGroup(recovery);
  assert.equal(
    recovery.status,
    0,
    `Node recovery contracts failed:\n${recovery.stdout}\n${recovery.stderr}`,
  );
  const recoveryOutput = `${recovery.stdout}\n${recovery.stderr}`;
  assert.match(recoveryOutput, /# pass 3/);
  assert.match(recoveryOutput, /# fail 0/);

  const noReplay = spawnSync(
    process.execPath,
    [
      "--test", "--test-reporter=tap", "--test-concurrency=1",
      "--test-name-pattern=stalled unsafe retry returns 502 so a 429 retry cannot duplicate its side effect|expired continuity deadline returns saved 429 without another unsafe upstream attempt",
      "test/server-429.test.js",
    ],
    { cwd: root, detached: true, encoding: "utf8", env, timeout: 300_000 },
  );
  killSpawnGroup(noReplay);
  assert.equal(
    noReplay.status,
    0,
    `Node no-replay contracts failed:\n${noReplay.stdout}\n${noReplay.stderr}`,
  );
  const noReplayOutput = `${noReplay.stdout}\n${noReplay.stderr}`;
  assert.match(noReplayOutput, /# pass 2/);
  assert.match(noReplayOutput, /# fail 0/);

  const supervisor = spawnSync(
    process.execPath,
    [
      "--test", "--test-reporter=tap", "--test-concurrency=1",
      "--test-name-pattern=deployment drain requires proxy authentication and keeps lifecycle identity private|proxy worker crash keeps the listener reachable and replacement serves the next request",
      "test/server-supervisor.test.js",
    ],
    { cwd: root, detached: true, encoding: "utf8", env, timeout: 300_000 },
  );
  killSpawnGroup(supervisor);
  assert.equal(
    supervisor.status,
    0,
    `Supervisor no-replay contract failed:\n${supervisor.stdout}\n${supervisor.stderr}`,
  );
  const supervisorOutput = `${supervisor.stdout}\n${supervisor.stderr}`;
  assert.match(supervisorOutput, /# pass 2/);
  assert.match(supervisorOutput, /# fail 0/);
  await delay(2_000);
  console.log("Node recovery, deployment-auth, and supervisor no-replay contracts: PASS");
});
