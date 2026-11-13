// herdr pane 시작 경로에서 워커 시작 검사(dotclaude `herdr_worker_guard.py`)가 기대는 래퍼 표식을 고정한다.
//
// 2026-11-13 실측(dotclaude plan 2026-11-13-herdr-full-cutover Task E.1 Step 0):
// - 본체 `~/.local/bin/claude` 앞 4KiB에 `teamclaude-transparent-wrapper:v1` 표식 줄이 있다.
// - 래퍼 경유로 뜬 Claude 프로세스 환경에 `TEAMCLAUDE_PROVIDER=anthropic`과
//   `TEAMCLAUDE_SESSION_SUPERVISED=1`이 있다(워커 4대 `claude --version` 프로세스 트리).
// 검사 쪽은 파일 앞 4KiB에서 표식 문자열을 찾고, 실행 중 프로세스는 환경
// `TEAMCLAUDE_SESSION_SUPERVISED=1`을 본다. 이 표식이 바뀌면 워커 시작이 모두 거부된다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_WRAPPER_SIGNATURE, renderClaudeWrapper } from '../src/claude-wrapper.js';

const MARKER = 'teamclaude-transparent-wrapper:v1';
const HEAD_BYTES = 4096;

function hasZsh() {
  return !spawnSync('zsh', ['-c', 'true']).error;
}

// 부른 인자와 표식 환경 두 개를 한 줄로 낸다(값은 정해진 상수뿐이라 그대로 비교한다).
function reporter(name) {
  return `#!/bin/sh
printf '%s|%s|%s|%s\\n' ${name} "\${TEAMCLAUDE_PROVIDER:-}" "\${TEAMCLAUDE_SESSION_SUPERVISED:-}" "$*"
`;
}

async function renderedFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-herdr-ancestry-'));
  const vendor = join(dir, 'vendor');
  const teamcodex = join(dir, 'teamcodex');
  await writeFile(vendor, reporter('vendor'));
  await writeFile(teamcodex, reporter('teamcodex'));
  await chmod(vendor, 0o755);
  await chmod(teamcodex, 0o755);
  const wrapper = join(dir, 'claude');
  await writeFile(wrapper, renderClaudeWrapper({ teamcodexBin: teamcodex, vendorShimPath: vendor }));
  await chmod(wrapper, 0o755);
  return { dir, wrapper };
}

function runWrapper(wrapper, args, extraEnv = {}) {
  // pane 셸처럼 TeamClaude 변수 없는 환경에서 시작한다.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...extraEnv };
  const result = spawnSync(wrapper, args, { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('rendered wrapper carries the transparent-wrapper marker as a comment line in the first 4 KiB', async () => {
  assert.equal(CLAUDE_WRAPPER_SIGNATURE, MARKER);
  const { dir, wrapper } = await renderedFixture();
  try {
    const head = (await readFile(wrapper)).subarray(0, HEAD_BYTES).toString('utf8');
    assert.ok(head.split('\n').includes(`# ${MARKER}`), 'marker comment line missing from the first 4 KiB');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a fresh pane shell start goes through `teamcodex run --` with TEAMCLAUDE_PROVIDER=anthropic', async t => {
  if (!hasZsh()) {
    t.skip('zsh is not installed');
    return;
  }
  const { dir, wrapper } = await renderedFixture();
  try {
    // herdr가 pane 프롬프트에 넣는 모양: `claude --model x`
    assert.equal(runWrapper(wrapper, ['--model', 'x']), 'teamcodex|anthropic||run -- --model x');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the supervised child keeps both runtime env markers on the Claude process', async t => {
  if (!hasZsh()) {
    t.skip('zsh is not installed');
    return;
  }
  const { dir, wrapper } = await renderedFixture();
  try {
    // `teamcodex run`이 준비한 자식 환경으로 래퍼에 다시 들어오면 Claude(vendor)가 두 표식을 그대로 가진다.
    const out = runWrapper(wrapper, ['--version'],
      { TEAMCLAUDE_PROVIDER: 'anthropic', TEAMCLAUDE_SESSION_SUPERVISED: '1' });
    assert.equal(out, 'vendor|anthropic|1|--version');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
