import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repository = 'yAnn1ck-B/arcane-fold';

export function githubEnvironment() {
  const env = { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' };
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return env;
  const credentials = spawnSync('git', ['credential', 'fill'], {
    cwd: root,
    env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    input: `protocol=https\nhost=github.com\npath=${repository}.git\n\n`,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (credentials.status !== 0) throw new Error('GitHub authentication is unavailable. Authenticate Git/GitHub CLI first.');
  const fields = Object.fromEntries(credentials.stdout.trim().split(/\r?\n/).map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  if (!fields.password) throw new Error('GitHub authentication did not return a usable credential.');
  env.GH_TOKEN = fields.password;
  return env;
}

export function githubExecutable() {
  const portable = path.join(root, '.tools', 'gh', 'bin', process.platform === 'win32' ? 'gh.exe' : 'gh');
  return existsSync(portable) ? portable : 'gh';
}

export function runGithub(args, { input, capture = true } = {}) {
  const result = spawnSync(githubExecutable(), args, {
    cwd: root, env: githubEnvironment(), input, encoding: 'utf8', windowsHide: true,
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit'],
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw new Error(`GitHub CLI could not start: ${result.error.code ?? 'unknown error'}`);
  if (result.status !== 0) throw new Error(`GitHub CLI failed (${result.status}): ${result.stderr?.trim() || 'see command output'}`);
  return capture ? result.stdout.trim() : '';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (!args.length) throw new Error('Pass GitHub CLI arguments. Authentication is read in memory and never printed.');
    if (args[0] === 'exec') {
      const [command, ...rest] = args.slice(1);
      if (!command) throw new Error('Pass an executable after exec.');
      const result = spawnSync(command, rest, { cwd: root, env: githubEnvironment(), stdio: 'inherit', windowsHide: true });
      if (result.error) throw new Error(`Command could not start: ${result.error.code}`);
      process.exitCode = result.status ?? 1;
    } else {
      runGithub(args, { capture: false });
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
