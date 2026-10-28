# Skill diet

Skills: skill-diet

[science4324/skill-diet](https://github.com/science4324/skill-diet) audits installed skills read-only: duplicates, skills with no detected use in Codex and Claude logs, and skills tied to paid services. It recommends keep, observe, remove or check subscription, and quarantines instead of deleting.

Status: suggested. If Codex keeps its sessions outside `~/.codex/sessions` (a custom `CODEX_HOME`), point it at the real folder, or Codex usage reads as unknown.

## Install

Copy the `skill-diet` folder to `~/.claude/skills/` (Claude Code) or `~/.codex/skills/` (Codex). Run `python skill-diet/scripts/skill_diet.py audit`.

## With geppetto-learn

The weekly skill curation uses its report to propose removing skills unused for over 30 days.
