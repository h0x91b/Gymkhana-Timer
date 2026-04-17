# Changelog entries

One file per task (worktree) documenting what changed in that session.

## Path

```
change-logs/YYYY/MM/DD/<type>-<short-slug>.md
```

`YYYY/MM/DD` is the date the entry was first created. If a task spans multiple days, keep the original date in the path and update the existing file — do not create a new one.

## Type prefixes

- `feature-` — new user-facing capability
- `fix-` — bug fix
- `refactor-` — non-behavioral code restructuring
- `docs-` — documentation-only changes
- `chore-` — tooling, config, scaffolding, housekeeping

## Slug

Short kebab-case description, unique enough that two parallel tasks can't collide (e.g., `feature-auto-calibrate-threshold`, `fix-cooldown-edge-case`).

## Content

Plain text, 1–3 sentences, one paragraph max. No frontmatter, no headers, no bullet lists — just prose describing what was done and why (if the why isn't obvious).

## Rules

- **One worktree = one changelog file.** A single task produces exactly one entry for the whole session, not one per commit. If the task evolves, append to or rewrite the existing file.
- **Same commit.** The changelog file goes in the same commit as the code change it describes.
- **English only.**
- If the change was prompted by an external bug report or feature request, credit the reporter on the last line: `Suggested by @username (h0x91b/Gymkhana-Timer#N)`.

## Example

`change-logs/2026/04/17/feature-roi-polygon-mode.md`

```
Added polygon ROI picker alongside the existing rectangle picker. Users can
now tap up to 8 points to describe a non-axis-aligned start/finish area,
which improves accuracy when the camera is offset from the line.
```
