import { mkdir, mkdtemp, readFile, readdir, writeFile, link, unlink, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { atomicJson, jsonFile, rejectSymlinks, UsageError } from './common.mjs';
import { projectDataPath } from './project-records.mjs';
import { redact } from './signal.mjs';

const dayMs = 86_400_000;
export const weeklyWindowMs = 14 * dayMs;
const staleAfterMs = 8 * dayMs;
const reportName = /^\d{4}-\d{2}-\d{2}\.md$/;
const reportsFolder = 'weekly-metrics';
const proposalFields = ['evidence', 'procedure', 'decisionRule'];

export function isWeeklyReport(root, path) {
  if (basename(dirname(path)).toLowerCase() !== reportsFolder || !reportName.test(basename(path))) return false;
  const expected = projectDataPath(root, reportsFolder), actual = dirname(path);
  return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
}

export async function latestWeeklyReport(root) {
  const directory = projectDataPath(root, reportsFolder);
  await rejectSymlinks(directory);
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const name = entries.filter(entry => entry.isFile() && reportName.test(entry.name))
    .map(entry => entry.name).sort().at(-1);
  return name ? resolve(directory, name) : null;
}

export async function weeklyReportState(root, now) {
  try {
    const latest = await latestWeeklyReport(root);
    if (!latest) return { status: 'missing', latest: null };
    const created = Date.parse((await readFile(latest, 'utf8')).split('\n')[2]?.replace(/^Generated: /, ''));
    if (!Number.isFinite(created)) return { status: 'unavailable', latest };
    return { status: now - created > staleAfterMs ? 'stale' : 'current', latest };
  } catch (error) {
    return { status: error.code === 'ENOENT' ? 'missing' : 'unavailable', latest: null };
  }
}

export async function weeklyReportNotice(root, now) {
  const report = await weeklyReportState(root, now);
  return report.status === 'stale'
    ? 'Geppetto weekly metrics report is overdue. Read "' + report.latest + '" for the last successful report.' : '';
}

async function reportsDirectory(root) {
  const directory = projectDataPath(root, reportsFolder);
  await rejectSymlinks(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function newWeeklyDraft(root) {
  return resolve(await mkdtemp(resolve(await reportsDirectory(root), 'draft-')), 'experiments.json');
}

export async function writeWeeklyProposals(draft, proposals) {
  if (!Array.isArray(proposals) || proposals.length > 2 ||
      proposals.some(proposal => !proposal || Object.keys(proposal).length !== proposalFields.length ||
        !proposalFields.every(key => typeof proposal[key] === 'string' && proposal[key].trim()))) {
    throw new UsageError('Propose zero to two experiments with evidence, procedure and a fixed decision rule.');
  }
  await atomicJson(draft, proposals.map(proposal => Object.fromEntries(proposalFields
    .map(key => [key, redact(proposal[key].trim())]))));
}

export async function disposeWeeklyDraft(draft) {
  if (!draft) return;
  await unlink(draft).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await rmdir(dirname(draft));
}

const sum = values => values.reduce((total, value) => total + value, 0);
const title = text => String(text).replaceAll(/[\r\n]+/g, ' ').replaceAll('|', '\\|');
const shown = (value, unit = '') => Number.isFinite(value) ? '' + value + unit : 'unknown';

function renderReport(report, date, proposals) {
  const output = [
    '# Geppetto weekly metrics', '', 'Generated: ' + date,
    'Project: ' + title(report.project ?? 'unknown'), 'Observed window: ' + (report.since ?? 'unknown') + ' through ' + (report.asOf ?? 'unknown'), '',
    '## Time concentration and week-over-week trends', '',
    '| Operation | Wall time (14 days) | Resource time (14 days) | Latest seven days | Previous seven days |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  const keys = new Map(report.keys.map(row => [row.key, row]));
  for (const sink of report.topTimeSinks) {
    const key = keys.get(sink.key);
    const window = week => week ? shown(week.totalMs, ' ms') + ' (' + week.count + ' calls)' : 'unknown';
    output.push('| ' + title(sink.key) + ' | ' + shown(sink.wallMs, ' ms') + ' | ' + shown(sink.resourceMs, ' ms') +
      ' | ' + window(key?.lastWeek) + ' | ' + window(key?.previousWeek) + ' |');
  }
  if (!report.topTimeSinks.length) output.push('| No timed operations observed | unknown | unknown | unknown | unknown |');

  output.push('', '## Storage concentration', '');
  for (const row of report.sizes.toSorted((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1))) {
    output.push('- ' + title(row.path ?? row.status) + ': ' + shown(row.bytes, ' bytes') + ' (' + row.status +
      '), week-over-week change ' + shown(row.weekChangeBytes, ' bytes') + '.');
  }
  if (!report.sizes.length) output.push('No storage observations.');

  output.push('', '## Pull request cycle and size', '');
  if (!report.prCycle) output.push('Merged GitHub pull request coverage is unavailable.');
  else if (!report.mergedPrs.length) output.push('No merges observed in the sampled period.');
  if (report.prCycle) {
    const cutoff = Date.parse(report.asOf) - weeklyWindowMs / 2;
    const latest = report.mergedPrs.filter(row => Date.parse(row.ts) >= cutoff).length;
    const windows = Number.isFinite(cutoff) ? 'Observed merges: ' + latest + ' in the latest seven days, ' +
      (report.mergedPrs.length - latest) + ' in the previous seven days. ' : '';
    output.push(windows + 'Median cycle: ' + shown(report.prCycle.medianMs, ' ms') + '.');
  }
  for (const row of report.mergedPrs) {
    output.push('- #' + row.number + ' on ' + row.ts.slice(0, 10) + ': ' + shown(row.durationMs, ' ms') +
      ', ' + shown(row.changedFiles, ' files') + ', +' + shown(row.additions) + '/-' + shown(row.deletions) + '.');
  }

  const waits = report.decisionWaits.flatMap(row => Number.isFinite(row.durationMs) ? [row.durationMs] : []);
  const overhead = report.geppettoOverhead ?? {};
  output.push('', '## Geppetto overhead', '',
    '- Recorded decision wait: ' + shown(waits.length ? sum(waits) : null, ' ms') + ' over ' + waits.length + ' observed turns.',
    '- Injected context: ' + shown(overhead.injectedBytes, ' bytes') + ' in recorded hook events.',
    '- Model calls recorded by hooks: ' + shown(overhead.modelCalls) + '.',
    '- Hook process runtime: unknown.', '', '## Evidence coverage', '');
  for (const [name, coverage] of Object.entries(report.coverage)) {
    const span = coverage.first && coverage.last ? ' from ' + coverage.first + ' through ' + coverage.last : '';
    const limit = coverage.limit ? ' (up to ' + coverage.limit + ')' : '';
    output.push('- ' + title(name) + ': ' + coverage.status + ', ' + coverage.observed + ' observations' + span + limit + '.');
  }
  output.push('', '## Proposed experiments', '');
  if (!proposals.length) output.push('No experiments proposed.');
  for (const [index, proposal] of proposals.entries()) {
    output.push('### Experiment ' + (index + 1), '', '- Evidence: ' + title(proposal.evidence),
      '- Procedure: ' + title(proposal.procedure), '- Decision rule: ' + title(proposal.decisionRule), '');
  }
  return output.join('\n').trimEnd() + '\n';
}

export async function publishWeeklyReport(root, report, { draft, now = Date.now() } = {}) {
  if (report.status === 'unavailable') return null;
  const directory = await reportsDirectory(root);
  const date = new Date(now).toISOString();
  const destination = resolve(directory, date.slice(0, 10) + '.md');
  const temporary = resolve(directory, '.' + randomUUID() + '.tmp');
  const proposals = draft ? await jsonFile(draft, []) : [];
  try {
    await writeFile(temporary, redact(renderReport(report, date, proposals)), { flag: 'wx', mode: 0o600 });
    await link(temporary, destination).catch(error => { if (error.code !== 'EEXIST') throw error; });
    return destination;
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
