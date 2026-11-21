import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fixture, put, get, invoke, repo, git } from './helpers.mjs';
import { refreshMaintenanceLauncher } from '../skills/geppetto-adopt/scripts/maintenance.mjs';
import { reconcileMachine } from '../skills/geppetto-adopt/scripts/machine.mjs';

test('launcher records early failures and successful outcomes and skips absent projects', async t => {
 const home=fixture(t), project=fixture(t), missing=resolve(home,'absent');
 await refreshMaintenanceLauncher(home,{path:repo});
 put(home,'.geppetto/machine.json',{jobs:{'curate-skills':{status:'scheduled'}},projects:{[missing]:{codex:'absent-source'},[project]:{codex:repo}}});
 const launcher=resolve(home,'.geppetto/bin/maintenance-launcher.mjs');
 let result=invoke(launcher,['--run','curate-skills','--dry-run'],{home});
 assert.equal(result.status,0,result.stderr); assert.ok(JSON.parse(result.stdout).roots.includes(project));
 assert.match(get(home,'.geppetto/curate-skills.log'),/skipped.*absent/); assert.match(get(home,'.geppetto/curate-skills.log'),/success/);
 result=invoke(launcher,['--run','bogus'],{home}); assert.equal(result.status,1); assert.match(get(home,'.geppetto/unknown.log'),/failure.*Usage/);
});

test('registration from linked worktree records durable main checkout', async t => {
 const home=fixture(t), main=fixture(t), linked=resolve(fixture(t),'linked');
 assert.equal(git(main,['init']).status,0); git(main,['config','user.email','fixture@example.test']); git(main,['config','user.name','Fixture']);
 put(main,'app','fixture'); git(main,['add','.']); git(main,['commit','-m','fixture']); assert.equal(git(main,['worktree','add','-b','linked',linked]).status,0);
 await reconcileMachine(linked,'codex',{path:repo},{home,pluginHooks:true,memoryChoice:'none',scheduler:async()=>null});
 assert.deepEqual(Object.keys(JSON.parse(get(home,'.geppetto/machine.json')).projects),[main]);
});

test('source resolution errors are redacted before package imports', async t => {
  const home = fixture(t);
  await refreshMaintenanceLauncher(home, { path: resolve(home, 'github_pat_fixture123456789', '0.12.2') });
  const result = invoke(resolve(home, '.geppetto/bin/maintenance-launcher.mjs'), ['--run', 'curate-skills'], { home });
  assert.equal(result.status, 1);
  assert.match(get(home, '.geppetto/curate-skills.log'), /failure.*No installed Geppetto maintenance package.*\[REDACTED\]/);
});
