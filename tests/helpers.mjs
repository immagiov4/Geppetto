import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const scripts = resolve(repo, 'skills/geppetto-adopt/scripts');
export function fixture(t) {
  const dir = mkdtempSync(resolve(tmpdir(), 'geppetto-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
export function put(dir, path, text) { mkdirSync(dirname(resolve(dir, path)), { recursive: true }); writeFileSync(resolve(dir, path), typeof text === 'string' ? text : JSON.stringify(text)); }
export const get = (dir, path) => readFileSync(resolve(dir, path), 'utf8');
export function invoke(script, args = [], { cwd = repo, home = cwd, input = '', env = {}, memoryChoice } = {}) {
  // Installation fixtures use a fake native scheduler, never the host's real jobs.
  const temporary = basename(script) === 'install.mjs' && !args.includes('--scheduler-jobs') ? mkdtempSync(resolve(tmpdir(), 'geppetto-scheduler-')) : null;
  try {
    if (basename(script) === 'install.mjs' && !args.includes('--memory')) {
      if (memoryChoice === undefined) {
        const configured = [home, cwd].some(root => {
          try { const memory = JSON.parse(get(root, '.geppetto/config.json')).memory; return memory?.choice || memory?.repo || memory?.localPath; }
          catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
        });
        if (!configured) memoryChoice = 'none';
      }
      if (memoryChoice) args = [...args, '--memory', memoryChoice];
    }
    if (temporary) {
      const jobs = Object.fromEntries(['curate-skills', 'maintain-memory'].map(name => [name, { scheduler: 'fixture', id: name, cadence: 'weekly', nextRun: '2026-11-02T09:00:00', disable: `fixture disable ${name}` }]));
      put(temporary, 'jobs.json', jobs); args = [...args, '--scheduler-jobs', resolve(temporary, 'jobs.json')];
    }
    return spawnSync(process.execPath, [resolve(scripts, script), ...args], { cwd, input, encoding: 'utf8', windowsHide: true, env: { ...process.env, HOME: home, USERPROFILE: home, ...env } });
  } finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
}
export function parallel(script, args, { cwd, home = cwd }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve(scripts, script), ...args], { cwd, windowsHide: true, env: { ...process.env, HOME: home, USERPROFILE: home } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject); child.on('close', status => resolveResult({ status, stdout, stderr }));
  });
}
export function git(dir, args) { return spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true }); }
export const config = () => ({ version: 1, docs: { root: 'docs', style: 'project', referenceRepo: null }, sections: { pr: ['Observability'], featureDocs: ['Observability'], optional: ['Verification'] }, review: { engine: 'code-review' }, unitCoverage: 'behaviour', packs: [], pillars: {}, hooks: {} });
