# Changelog

## 0.3.0

- Run project CI from an immutable Geppetto package and migrate installed targets while preserving local edits and unrelated staged work. Fresh clones can update generated CI pins.
- Keep semantic requirements screening in its owning skill and remove automatic skill selection and memory classification.
- Record explicit turn decisions, combine their completion check with independent review, and learn from new transcript evidence. SessionStart supplies the recording command and schema before the first turn.
- Exclude private memory and redact secrets from learner evidence, close Stop safely on hook errors, and fingerprint large diffs through streamed Git output.
