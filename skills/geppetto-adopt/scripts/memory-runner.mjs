import { mkdir, mkdtemp, chmod, copyFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { run } from './common.mjs';
import { codexDisabledFeatures, learningCommand, LearningContractError } from './learn-runner.mjs';
import { lockGraceMs } from './local-lock.mjs';

export class LearningAuthError extends Error {}
const cliTimeout = lockGraceMs / 3;
const maxOutputBytes = 512 * 1024;

/** Create a fresh profile from an allowlist. The origin profile is never run. */
export async function isolatedCodexHome(destination, source) {
  await mkdir(destination, { mode: 0o700 });
  const auth = resolve(destination, 'auth.json');
  try {
    await copyFile(resolve(source, 'auth.json'), auth);
    await chmod(auth, 0o600);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(resolve(destination, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
}

function codexResult(output) {
  let stdout, tokens, completed = false;
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') stdout = event.item.text;
    if (event.type === 'turn.completed') {
      completed = true;
      const { input_tokens: input, output_tokens: output } = event.usage ?? {};
      if (Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0) tokens = input + output;
    }
  }
  return { stdout: completed ? stdout : undefined, tokens };
}

export function codexMemoryRunner(home, temporary) {
  return async (_phase, stdin) => {
    const command = learningCommand('codex');
    if (!command) throw new LearningContractError('Install Codex CLI and sign in with your subscription account.');
    const runner = resolve(temporary, 'runner');
    await mkdir(runner, { recursive: true, mode: 0o700 });
    const isolated = await mkdtemp(resolve(runner, 'codex-'));
    try {
      const codex = resolve(isolated, 'profile'), cwd = resolve(isolated, 'input');
      await isolatedCodexHome(codex, process.env.CODEX_HOME || resolve(home, '.codex'));
      await mkdir(cwd);
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:CODEX_|T3_|GIT_|OPENAI_|ANTHROPIC_|OPENROUTER_)/i.test(name)));
      Object.assign(env, { CODEX_HOME: codex, HOME: isolated, USERPROFILE: isolated, GEPPETTO_LEARNING_CHILD: '1' });
      const args = ['exec', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'read-only', '--json',
        '--config', 'forced_login_method="chatgpt"', '--config', 'cli_auth_credentials_store="file"',
        '--config', 'approval_policy="never"', '--config', 'project_doc_max_bytes=0', '--config', 'web_search="disabled"',
        '--config', 'mcp_servers={}', ...codexDisabledFeatures.flatMap(feature => ['--config', 'features.' + feature + '=false']), '-'];
      const result = run(command.executable, [...command.prefix, ...args], { cwd, env, input: stdin, timeout: cliTimeout, maxBuffer: maxOutputBytes });
      if (result.status !== 0) {
        const auth = run(command.executable, [...command.prefix, 'login', 'status'], { cwd, env });
        if (auth.status === 1 && [auth.stdout, auth.stderr].some(value => value?.trim() === 'Not logged in')) {
          throw new LearningAuthError('Sign in to Codex with the configured subscription.');
        }
        throw new Error('Codex maintenance runner failed.');
      }
      return codexResult(result.stdout);
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  };
}
