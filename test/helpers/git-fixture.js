import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const FAKE_GITHUB_URL = 'https://github.com/example-org/example-repo.git';

// Hermetic git: never read the developer's global/system config (signing,
// hooks, identity) and never walk above the temp root.
export function isolatedGitEnv(root) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: root,
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function git(cwd, env, ...args) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

// A real repository whose origin LOOKS like GitHub but is rewritten to a
// local bare repository via url.<bare>.insteadOf, so pushes stay on disk.
export async function makeRepo(root) {
  await mkdir(root, { recursive: true });
  const env = isolatedGitEnv(root);
  const bare = join(root, 'origin.git');
  const repo = join(root, 'project');
  await mkdir(repo, { recursive: true });
  git(root, env, 'init', '--quiet', '--bare', bare);
  git(repo, env, 'init', '--quiet', '-b', 'main');
  git(repo, env, 'config', 'user.name', 'Test User');
  git(repo, env, 'config', 'user.email', 'test@example.invalid');
  git(repo, env, 'config', 'commit.gpgsign', 'false');
  git(repo, env, 'remote', 'add', 'origin', FAKE_GITHUB_URL);
  git(repo, env, 'config', `url.${bare}.insteadOf`, FAKE_GITHUB_URL);
  await writeFile(join(repo, 'tracked.txt'), 'original\n');
  await writeFile(join(repo, 'removed.txt'), 'will be deleted\n');
  await writeFile(join(repo, '.gitignore'), 'ignored.log\n');
  git(repo, env, 'add', '-A');
  git(repo, env, 'commit', '--quiet', '-m', 'initial');
  git(repo, env, 'push', '--quiet', 'origin', 'main');
  return { repo, bare, env };
}

