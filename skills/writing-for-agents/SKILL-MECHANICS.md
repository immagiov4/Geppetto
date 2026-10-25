# Skill mechanics

This is the skill-specific branch of [`writing-for-agents`](SKILL.md). For the canonical Codex structure and validator, use the installed `$skill-creator` skill.

## Invocation

Codex skills always need a `name` and a discriminating `description` in the `SKILL.md` frontmatter.

Automatic discovery is the default. Use it when Codex should select the skill from the user's request or when another workflow naturally routes to it.

Use explicit-only invocation only when the user asked for that behavior or when preserving an existing skill's invocation policy. Put this in `agents/openai.yaml`:

```yaml
policy:
  allow_implicit_invocation: false
```

The skill remains available as `$skill-name`. Keep the description accurate because the user still sees it in skill discovery.

## Updating an existing collection

For an upstream update, compare the source catalogue with installed skills and incorporated sections, including new entries within the requested scope. Account for each relevant entry as adopted, already covered or incompatible, preserving local decisions. Before synchronizing existing copies, compare their contents and reconcile intentional differences; verify the resulting files in each authorized destination. Repository publication follows its own authorization.

## Splitting

Split a skill when a branch has its own trigger and enough instructions to justify a separate context load. Keep shared rules in one referenced file when several skills need them. Point to the file from each relevant `SKILL.md` and state when to read it.

## Router skills

A router skill names narrower skills and the requests each handles. Keep it short. Route with `$skill-name`, and do not duplicate the child skill's procedure in the router.
