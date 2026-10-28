import { redact } from './signal.mjs';
export const learningResultSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['applied', 'no_change', 'blocked'] },
    reason: { type: 'string' }, owner: { type: 'string' },
  },
  required: ['decision', 'reason', 'owner'],
};
/** Validate completion independently of the host's successful process exit. */
export function learningResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== learningResultSchema.required.length
    || !learningResultSchema.properties.decision.enum.includes(value.decision)
    || ['reason', 'owner'].some(key => typeof value[key] !== 'string' || !value[key].trim())) {
    throw new Error('Learning requires a valid decision, reason and owner; signals remain pending.');
  }
  return { decision: value.decision, reason: redact(value.reason), owner: redact(value.owner) };
}
