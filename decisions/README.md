# Decision records

Short architectural decision records (ADRs). Document **why** a non-obvious choice was made so future agents and humans don't have to reverse-engineer the reasoning.

## When to create one

- You relied on undocumented or reverse-engineered browser behavior
- You picked a non-obvious approach over a simpler-looking alternative for a concrete reason
- You implemented a workaround for a limitation in a browser API
- The decision involves trade-offs or known risks worth preserving

Small, self-evident changes do not need a decision record.

## Path

```
decisions/NNN-short-slug.md
```

Sequential numbering (`001`, `002`, …). Check the directory for the next free number. Slug is kebab-case and descriptive.

## Required sections

1. **Context** — what problem was being solved
2. **Investigation** (optional) — what was tried, what was found
3. **Decision** — what was done and where in the code (file + function)
4. **Risks** — what could break, what assumptions were made
5. **Alternatives considered** — what was rejected and why

## Rules

- Each section 2–4 sentences. A good decision record fits on one screen.
- Link to file paths and function names so readers can jump to the implementation.
- Include the decision file in the same commit as the code change it describes.
- English only.
