import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixtureHome = mkdtempSync(join(tmpdir(), 'geppetto-test-home-'));
const removeHome = () => rmSync(fixtureHome, { recursive: true, force: true });
process.once('exit', removeHome);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { removeHome(); process.kill(process.pid, signal); });

Object.assign(process.env, {
  HOME: fixtureHome,
  USERPROFILE: fixtureHome,
  CODEX_HOME: join(fixtureHome, '.codex'),
  CLAUDE_CONFIG_DIR: join(fixtureHome, '.claude'),
  XDG_CONFIG_HOME: join(fixtureHome, '.config'),
});

for (const key of [
  'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'GITHUB_TOKEN', 'GH_TOKEN',
]) delete process.env[key];
