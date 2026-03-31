# Reusable Fuzzy Search Helper Rollout Plan

## Goal

Introduce a reusable fuzzy-search helper in shared UI library code, then adopt it in the worktree branch search flow without widening risk.

This is a refactor-for-reuse task, not a behavior rewrite.

## Why This Change

- Current fuzzy search logic is spread across multiple places.
- `fuzzyMatch` currently lives in `utils.ts` and is called ad-hoc.
- Worktree branch search now needs to be architecturally reusable across the app.

## Scope

### In Scope

1. Add a dedicated shared fuzzy-search helper module.
2. Keep backward compatibility for existing `fuzzyMatch(...)` call sites.
3. Migrate worktree branch ranking to the new helper abstraction.

### Out of Scope

- Bulk migration of every fuzzy-search call site in one pass.
- UI redesign.
- Backend/API changes.

## Proposed Architecture

Create a separate file:

- `packages/ui/src/lib/search/fuzzySearch.ts`

Export a small, typed API:

```ts
export interface FuzzySearchOptions {
  threshold?: number;
  distance?: number;
  ignoreLocation?: boolean;
  preferSubstring?: boolean;
}

export function matchesFuzzyQuery(
  target: string,
  query: string,
  options?: FuzzySearchOptions
): boolean;

export function filterByFuzzyQuery<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
  options?: FuzzySearchOptions
): T[];

export function partitionByFuzzyQuery<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
  options?: FuzzySearchOptions
): { matching: T[]; other: T[] };
```

Design notes:

- `matchesFuzzyQuery` keeps current behavior precedence:
  1) fast case-insensitive substring match
  2) Fuse-based fuzzy fallback
- Keep defaults aligned with existing behavior (`threshold: 0.4`, `distance: 100`, `ignoreLocation: true`).
- Keep functions pure and side-effect free.

## Compatibility Strategy

Keep `fuzzyMatch` in `packages/ui/src/lib/utils.ts`, but implement it as a compatibility wrapper that calls `matchesFuzzyQuery`.

This gives:

- no immediate breakage across the app
- a clear forward path for gradual migration

## Worktree Adoption

Refactor:

- `packages/ui/src/lib/worktrees/branchSearch.ts`

to use the new helper API for partitioning local/remote branches by query.

Behavior must remain unchanged:

- Empty query -> no matches group
- Non-empty query -> matching group first
- "No matching branches" state remains in UI
- Existing selection side effects in `NewWorktreeDialog.tsx` remain unchanged

## Risks and Mitigation

1. **Risk:** subtle fuzzy behavior drift
   - **Mitigation:** preserve substring-first rule + existing Fuse defaults.
2. **Risk:** accidental broad refactor
   - **Mitigation:** keep migration limited to worktree path + compatibility wrapper.
3. **Risk:** render performance regressions
   - **Mitigation:** keep matching logic linear and memoized at call sites.

## Validation

Required checks:

- `bun run type-check`
- `bun run lint`
- `bun run build`

Manual checks (worktree dialog):

1. Existing Branch picker (desktop/mobile): query, select local/remote, clear query.
2. Source Branch picker (desktop/mobile): same checks.
3. Verify "No matching branches" appears when expected.

## Acceptance Criteria

1. New shared helper exists at `packages/ui/src/lib/search/fuzzySearch.ts`.
2. `utils.fuzzyMatch` remains available and works via compatibility wrapper.
3. `branchSearch.ts` uses shared helper and preserves current behavior.
4. Project passes type-check, lint, and build.
