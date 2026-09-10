# Contributing to Elysium Harness

## Ground rules

1. **Minimal core, everything else is an extension.** If a feature can live in `@elysium/meta-layer`, `@elysium/extension-tools`, `@elysium/tui`, or a new package, it must not touch `@elysium/core`. Core additions require an architecture discussion first (open an issue with a concrete interface proposal).
2. **The frozen contract.** Public types in `packages/core/src/types/` are the stability guarantee for every extension. Breaking changes require a major version and a migration note.
3. **English only** — code, comments, docs, commit messages.
4. **TypeScript strict.** No `any` (lint-enforced), explicit error handling, `noUncheckedIndexedAccess` is on — handle the `undefined` case.
5. **No stubs.** PRs containing `TODO`/`FIXME`/`NotImplementedError` in shipped paths are rejected.

## Workflow

```bash
pnpm install
pnpm build        # must stay green
pnpm test         # must stay green (vitest, colocated under packages/*/test)
pnpm lint         # biome
```

- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`).
- One logical change per PR; include tests for behavior changes.
- For orchestration/quality-gate changes, add integration tests under `packages/core/test/integration/`.
- For anything touching telemetry or the meta-layer formats, update `docs/architecture.md` §5–6 in the same PR — those sections are normative.

## Design principles

- Per-turn snapshot semantics: configuration changes never mutate an in-flight provider request.
- Sessions are append-only; compaction projects context, it never rewrites history.
- Orchestration depth is capped at 2 by construction, not by convention.
- The meta-layer may propose config deltas and must measure deltas on held-out runs before promoting them; it never patches code.
- Security defaults: path containment, command deny-lists, secrets from the environment only.

## Benchmarks

Performance-affecting PRs should run the benchmark suite and include the comparison against `docs/baseline.md` (see `packages/benchmarks/README.md`). No arbitrary numeric targets — measurements only.
