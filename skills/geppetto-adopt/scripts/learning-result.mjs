import { readFileSync } from 'node:fs';
import { redact } from './signal.mjs';
export const learningResultSchema = JSON.parse(readFileSync(new URL('./learning-contracts.json', import.meta.url), 'utf8')).result;
/** Validate completion independently of the host's successful process exit. */
export function learningResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== learningResultSchema.required.length
    || !learningResultSchema.properties.decision.enum.includes(value.decision)
    || ['reason', 'owner'].some(key => typeof value[key] !== 'string' || !value[key].trim())) {
    throw new Error('Learning requires a valid decision, reason and owner; signals remain pending.');
  }
  return { decision: value.decision, reason: redact(value.reason), owner: redact(value.owner) }; }
