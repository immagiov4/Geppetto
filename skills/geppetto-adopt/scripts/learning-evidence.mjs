import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { redactValue } from './signal.mjs';

const pageCharacters = 24000;

/** Preserve selected session evidence for on-demand Read access, outside the writable project snapshot. */
export async function learningEvidence(directory, transcripts, config) {
  await mkdir(directory, { recursive: true });
  const pages = [], unavailable = []; let records = 0;
  for (const source of new Set(transcripts.filter(path => typeof path === 'string' && path.trim()).map(path => resolve(path)))) {
    let pending = '', page = '', first = null, last = null;
    const flush = async () => {
      if (!page) return;
      const path = resolve(directory, `part-${pages.length + 1}.txt`);
      await writeFile(path, page, { mode: 0o600 });
      pages.push({ path, source, first, last, characters: page.length }); page = ''; first = null;
    };
    try {
      for await (const chunk of createReadStream(source, { encoding: 'utf8' })) {
        pending += chunk; let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!line.trim()) continue;
          const record = JSON.parse(line), message = record.type === 'response_item' ? record.payload : record.message;
          if (!message || message.type === 'reasoning') continue;
          const text = JSON.stringify(redactValue({ timestamp: record.timestamp, role: message.role ?? record.type, ...message }), (key, value) =>
            ['image', 'input_image', 'image_url'].includes(value?.type) ? { type: value.type, content: 'Image omitted from text evidence.' } : value, 2) + '\n';
          records++;
          for (let start = 0; start < text.length;) {
            let boundary = Math.min(start + pageCharacters, text.length);
            if (boundary < text.length && /[\uD800-\uDBFF]/.test(text[boundary - 1])) boundary--;
            const piece = text.slice(start, boundary); start = boundary;
            if (page.length + piece.length > pageCharacters) await flush();
            first ??= record.timestamp ?? null; last = record.timestamp ?? null; page += piece;
          }
        }
      }
    } catch (error) { unavailable.push({ source, error: error.code ?? 'invalid-record' }); }
    await flush();
  }
  const configPath = resolve(directory, 'project-config.json');
  await writeFile(configPath, JSON.stringify(redactValue(config), null, 2), { mode: 0o600 });
  const index = { records, pages, unavailable, config: configPath };
  await writeFile(resolve(directory, 'index.json'), JSON.stringify(index, null, 2), { mode: 0o600 });
  return { directory, records, pages: pages.length, unavailable: unavailable.length };
}
