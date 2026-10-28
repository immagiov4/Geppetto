# Skill diet

Skills: skill-diet

Evaluates leaner skill instructions against representative requests before retaining them.

Status: suggested. [Upstream source](https://github.com/nicobailon/skill-diet) provides the procedure; no local outcome comparison is claimed. This entry identifies the skill by nicobailon.

## Install

After an explicit yes, retrieve the upstream `skill-diet` skill and its supporting files, preserving its license. Claude Code: use `.claude/skills/skill-diet/` or `~/.claude/skills/skill-diet/`. Codex: use `.agents/skills/skill-diet/` or `~/.codex/skills/skill-diet/`. Check the source instructions and available evaluation runtime before running it. Keep the task's model, tier and delegation restrictions.

## With geppetto-learn

Apply the diet procedure when repeated evidence shows an instruction is too large or stale. Retain distinct valid cases and compare representative outcomes before keeping the edit.

## With geppetto-measure-it

Compare the current instructions, candidate and no-skill baseline on the same requests; report actual observed use and outcome coverage.
