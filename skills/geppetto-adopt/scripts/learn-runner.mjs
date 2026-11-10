import { resolve, delimiter } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redact } from './signal.mjs';
export function learningCommand(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const paths = [resolve(directory, process.platform === 'win32' ? `${name}.exe` : name), resolve(directory, name === 'codex' ? 'node_modules/@openai/codex/bin/codex.js' : 'node_modules/@anthropic-ai/claude-code/cli.js')];
    for (const path of paths) if (existsSync(path)) return path.endsWith('.js') ? { executable: process.execPath, prefix: [path] } : { executable: path, prefix: [] };
  }
  return null; }
function learningReferences() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  if (resolve(root, 'geppetto-adopt/scripts/learn-runner.mjs') !== fileURLToPath(import.meta.url) || !existsSync(resolve(root, 'geppetto-learn/SKILL.md'))) throw new Error('Run learning from the installed Geppetto package so its procedures are available.');
  return root; }
export async function executeLearning({ cwd, prompt, host, output = 'ignore', maintenance = false, telemetryRoot = cwd, session }) {
  const command = learningCommand(host);
  if (!command) throw new Error(`Install ${host} CLI and sign in with your subscription account.`);
  const tools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', ...(maintenance ? ['MaintainEvidence'] : [])]; const server = { command: process.execPath, args: [fileURLToPath(new URL('./learner-tools.mjs', import.meta.url)), cwd, maintenance ? 'maintenance' : 'workspace-write', JSON.stringify(tools), learningReferences(), telemetryRoot, session ?? 'maintenance'] };
  const args = host === 'claude'
    ? ['-p', '--setting-sources', '', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { geppetto_files: server } }), '--tools', '', '--allowedTools', ...tools.map(tool => `mcp__geppetto_files__${tool}`)]
    : ['exec', '--ignore-user-config', '--sandbox', 'read-only', '--config', 'forced_login_method="chatgpt"', '--config', 'approval_policy="never"', ...['shell_tool', 'multi_agent', 'multi_agent_v2', 'apps', 'plugins', 'browser_use', 'computer_use', 'image_generation', 'memories', 'code_mode', 'code_mode_only', 'skill_mcp_dependency_install'].flatMap(feature => ['--config', `features.${feature}=false`]), '--config', 'web_search="disabled"', '--config', `mcp_servers={geppetto_files={command=${JSON.stringify(server.command)},args=${JSON.stringify(server.args)},default_tools_approval_mode="approve"}}`, '-'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:OPENAI_API_KEY|OPENAI_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_.*|OPENROUTER_API_KEY|T3_.*)$/i.test(key)));
  await new Promise((done, reject) => {
      const child = spawn(command.executable, [...command.prefix, ...args], { cwd, windowsHide: true, shell: false, stdio: ['pipe', output, output], env: { ...env, GEPPETTO_LEARNING_CHILD: '1' } });
      child.once('error', () => reject(new Error('Learning CLI could not start.')));
      child.once('close', code => code === 0 ? done() : reject(new Error(`Learning CLI failed (exit ${code ?? 'signal'}); signals remain available.`)));
      child.stdin.on('error', () => {}); child.stdin.end(redact(prompt));
    });
  return 0; }
