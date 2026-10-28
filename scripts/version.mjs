import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
export const manifests = ['package.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.codex-plugin/plugin.json', '.agents/plugins/marketplace.json'];
const versionOf = (doc, file) => file.includes('marketplace.json') ? doc.plugins.find(p => p.name === 'geppetto').version : doc.version;
export function versions(revision) {
  return manifests.map(file => [file, versionOf(JSON.parse(revision !== undefined ? execFileSync('git', ['show', `${revision}:${file}`], { encoding: 'utf8', windowsHide: true }) : readFileSync(file, 'utf8')), file)]);
}
export function bump(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected version x.y.z');
  for (const file of manifests) {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    if (file.includes('marketplace.json')) doc.plugins.find(p => p.name === 'geppetto').version = version;
    else doc.version = version;
    writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  }
}
