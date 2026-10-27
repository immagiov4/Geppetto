import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fixture, put, get, config } from './helpers.mjs';
import { main } from '../skills/geppetto-adopt/scripts/pr-event.mjs';
import { run } from '../skills/geppetto-adopt/scripts/common.mjs';

function setup(t, files, contents) {
  const cwd = fixture(t), calls = [], results = [];
  const cfg = config(); cfg.docs.root = './features/'; cfg.sections.featureDocs.push('Verification');
  put(cwd, '.geppetto/config.json', cfg);
  put(cwd, 'event.json', { number: 7, repository: { full_name: 'owner/project' }, pull_request: { body: '## Observability\nLogs', head: { sha: 'a'.repeat(40), repo: { full_name: 'fork/project' } } } });
  const request = async (path, options) => {
    calls.push({ path, options });
    if (path.includes('/pulls/7/files')) return path.endsWith('page=1') ? files : [];
    const filename = decodeURIComponent(path.split('/contents/')[1].split('?')[0]);
    assert.ok(filename in contents, `unexpected head read: ${path}`);
    assert.match(path, /ref=a{40}$/);
    return contents[filename];
  };
  const execute = (binary, args, options) => { const result = run(binary, args, options); results.push({ args, options, result }); return result; };
  return { cwd, calls, results, check: () => main(['--docs', '--event', resolve(cwd, 'event.json')], { cwd, request, execute }) };
}

for (const missing of ['Observability', 'Verification']) test(`CI fails on a changed feature document missing ${missing} using the docs gate`, async t => {
  const body = missing === 'Observability' ? '# Feature\n## Verification\nCLI test' : '# Feature\n## Observability\nLogs';
  const check = setup(t, [{ filename: 'features/new.md', status: 'added' }], { 'features/new.md': body });
  assert.equal(await check.check(), 1);
  assert.ok(check.results[0].result.stderr.includes(`Missing section: ${missing}`));
  assert.ok(check.results[0].args.includes('--docs'));
  assert.equal(existsSync(check.results[0].options.cwd), false, 'temporary head data is cleaned after failure');
});

test('first-adoption docs mode uses defaults and the API transport reads immutable Markdown as raw data', async t => {
  const check = setup(t, [], {}), calls = [];
  unlinkSync(resolve(check.cwd, '.geppetto/config.json'));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/pulls/7/files')) return new Response(JSON.stringify([{ filename: 'docs/new.md', status: 'added' }]));
    return new Response('# Feature\n## Observability\nLogs from the fixture');
  });
  assert.equal(await main(['--docs', '--event', resolve(check.cwd, 'event.json')], { cwd: check.cwd }), 0);
  assert.match(calls[0].url, /\/repos\/owner\/project\/pulls\/7\/files\?per_page=100&page=1$/);
  assert.match(calls[1].url, /\/repos\/fork\/project\/contents\/docs\/new.md\?ref=a{40}$/);
  assert.equal(calls[1].options.headers.Accept, 'application/vnd.github.raw+json');
  t.mock.method(globalThis, 'fetch', async () => new Response('denied', { status: 403 }));
  await assert.rejects(main(['--docs', '--event', resolve(check.cwd, 'event.json')], { cwd: check.cwd }), /HTTP 403/);
});

test('CI checks renamed and paginated head Markdown as inert data and skips removed and outside-root files', async t => {
  const files = [{ filename: 'features/renamed.md', status: 'renamed' }, { filename: 'features/deleted.md', status: 'removed' }, { filename: 'README.md', status: 'modified' }, { filename: 'features-elsewhere/a.md', status: 'added' }, { filename: 'features/tool.mjs', status: 'added' }];
  while (files.length < 100) files.push({ filename: `other/${files.length}.md`, status: 'modified' });
  const check = setup(t, files, { 'features/renamed.md': '# Feature\n## Observability\n$(touch owned) `process.exit(7)`\n## Verification\nCLI test' });
  const request = async (path, options) => {
    check.calls.push({ path, options });
    if (path.includes('/files?')) return path.endsWith('page=1') ? files : [{ filename: 'features/nested/next.md', status: 'modified' }];
    assert.match(path, /^\/repos\/fork\/project\/contents\/.+\?ref=a{40}$/);
    return '# Feature\n## Observability\n$(touch owned) `process.exit(7)`\n## Verification\nCLI test';
  };
  assert.equal(await main(['--docs', '--event', resolve(check.cwd, 'event.json')], { cwd: check.cwd, request, execute: (binary, args, options) => { const result = run(binary, args, options); check.results.push({ args, options, result }); return result; } }), 0);
  assert.equal(check.calls.filter(call => call.path.includes('/contents/')).length, 2);
  assert.equal(check.results[0].args.filter(arg => arg.endsWith('.md')).length, 2);
  assert.equal(existsSync(resolve(check.cwd, 'owned')), false);
  assert.equal(existsSync(check.results[0].options.cwd), false);
});

test('CI fails closed on API errors and unsafe changed paths', async t => {
  const check = setup(t, [{ filename: 'features/../escape.md', status: 'added' }], {});
  await assert.rejects(check.check(), /path/i);
  await assert.rejects(main(['--docs', '--event', resolve(check.cwd, 'event.json')], { cwd: check.cwd, request: async () => { throw new Error('API unavailable'); } }), /API unavailable/);
  const event = JSON.parse(get(check.cwd, 'event.json')); event.pull_request.changed_files = 3001;
  put(check.cwd, 'event.json', event);
  await assert.rejects(main(['--docs', '--event', resolve(check.cwd, 'event.json')], { cwd: check.cwd, request: async () => assert.fail('truncated lists must fail before fetching') }), /file list is truncated/);
});

test('a PR that changes the docs contract is checked against base and incoming config, read as data', async t => {
  const incoming = config(); incoming.docs.root = 'pages'; incoming.sections.featureDocs = ['Observability', 'Rollback'];
  const files = [{ filename: '.geppetto/config.json', status: 'modified' }, { filename: 'pages/new.md', status: 'added' }, { filename: 'features/old.md', status: 'modified' }];
  const check = setup(t, files, { '.geppetto/config.json': JSON.stringify(incoming), 'pages/new.md': '# New\n## Observability\nLogs\n## Verification\nCLI', 'features/old.md': '# Old\n## Observability\nLogs\n## Verification\nCLI\n## Rollback\nRevert' });
  assert.equal(await check.check(), 1);
  const stderr = check.results[0].result.stderr;
  assert.match(stderr, /pages\/new\.md:1: Missing section: Rollback/);
  assert.doesNotMatch(stderr, /features\/old\.md/);
  assert.equal(check.results[0].args.filter(arg => arg.endsWith('.md')).length, 2);
});
