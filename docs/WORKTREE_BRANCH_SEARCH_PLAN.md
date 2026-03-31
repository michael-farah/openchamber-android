# Worktree Creation Branch Search Plan

## Context

This plan defines a minimal, production-grade implementation for branch search in the **New Worktree** dialog.

The target area is:

- `packages/ui/src/components/session/NewWorktreeDialog.tsx`

This document is intended for an agent that has no prior conversation context.

## Product Intent

Add search while choosing branches in the worktree creation flow, with clear, low-risk UX.

Confirmed behavior:

1. Search applies to **both** branch pickers:
   - Existing branch selector
   - Source branch selector (new branch mode)
2. Matching should use **fuzzy matching**
3. Matching branches should be shown at the **top**
4. Solution should be mature, minimal, and should not worsen architecture after recent refactoring

## Scope

### In Scope

- UI-level branch search/ranking in New Worktree dialog
- Desktop and mobile parity inside this dialog
- Reusable, isolated branch matching utility in `lib/worktrees`

### Out of Scope

- Backend/server API changes
- Git branch fetching/store protocol changes
- Worktree creation business logic (`createWorktree`, validation, upstream defaults)
- Broad refactors of unrelated branch selectors (unless explicitly requested)

## Design Principles

1. **Keep business logic untouched**
   - Only change branch selection UX and client-side list ordering.
2. **Isolate search logic**
   - Implement fuzzy branch ranking in a small utility module.
3. **Reuse existing UI patterns**
   - Prefer existing `DropdownMenu` + `Command` primitives used elsewhere.
4. **Desktop/mobile behavioral parity**
   - Same matching and ordering rules on both.
5. **Performance-safe defaults**
   - Use `useMemo`; avoid unnecessary recomputation and large object churn.

## Architecture Placement

### Why New Code Belongs in `lib/worktrees`

Branch ranking here is domain-adjacent (worktree branch selection), and should not be embedded as ad-hoc logic inside JSX blocks.

Recommended new utility:

- `packages/ui/src/lib/worktrees/branchSearch.ts`

Responsibilities:

- Normalize branch labels for search
- Fuzzy-match candidate branches
- Return grouped/ranked output suitable for UI rendering

This keeps `NewWorktreeDialog.tsx` focused on orchestration and rendering, preserving refactoring boundaries.

## Proposed UX Behavior

For each picker (Existing Branch and Source Branch):

1. User opens picker
2. User types query
3. List is split into groups:
   - `Matching branches` (top)
   - `Other local branches`
   - `Other remote branches`
4. If query is empty:
   - Show default groups only:
     - `Local branches`
     - `Remote branches`
5. Selection behavior remains unchanged:
   - Existing branch picker sets `selectedBranch` and auto-syncs worktree name
   - Source picker sets `sourceBranch`

## Matching Rules

Use fuzzy matching (existing precedent: `fuzzyMatch` from `packages/ui/src/lib/utils.ts`).

Recommended rule set:

1. Exact case-insensitive substring match is considered a match
2. Otherwise apply `fuzzyMatch` fallback
3. Preserve stable order within each group by original alphabetical list

## Implementation Plan

### Step 1: Add branch search utility

Create:

- `packages/ui/src/lib/worktrees/branchSearch.ts`

Suggested API:

```ts
export interface RankedBranchGroups {
  matching: string[];
  otherLocal: string[];
  otherRemote: string[];
}

export function rankBranchesForQuery(args: {
  localBranches: string[];
  remoteBranches: string[]; // already without `remotes/` prefix if following current dialog pattern
  query: string;
}): RankedBranchGroups
```

Notes:

- If `query.trim()` is empty:
  - `matching = []`
  - `otherLocal = localBranches`
  - `otherRemote = remoteBranches`
- If query exists:
  - Compute matched set against both local + remote labels
  - Place matches in `matching`
  - Non-matches split by source list into `otherLocal`/`otherRemote`
- Keep function pure and side-effect free

### Step 2: Wire into `NewWorktreeDialog` desktop existing-branch picker

Current desktop existing-branch UI uses `Select` with no search.

Replace with a searchable picker using existing primitives:

- `DropdownMenu`
- `Command`
- `CommandInput`
- `CommandList`
- `CommandGroup`
- `CommandItem`

Add local state:

- `existingBranchSearch: string`
- `existingBranchDropdownOpen: boolean`

Use `rankBranchesForQuery(...)` with `useMemo`.

Render groups per behavior section above.

### Step 3: Wire into `NewWorktreeDialog` desktop source-branch picker

Current desktop source picker also uses `Select` with no search.

Apply same searchable picker pattern with separate state:

- `sourceBranchSearch: string`
- `sourceBranchDropdownOpen: boolean`

Reuse same ranking utility.

### Step 4: Add search to mobile picker overlays

Current mobile overlays render full lists with no text input.

For both mobile overlays:

- Add `Input` at top (`placeholder="Search branches..."`)
- Track query state separately for each overlay
- Use same `rankBranchesForQuery` utility
- Render `Matching branches` first when query is non-empty

Keep existing tap/selection behavior unchanged.

### Step 5: Empty/loading states

Maintain existing loading behavior.

For empty results when query exists:

- Show `No branches found` / `No matching branches` message (pick one consistent string)

### Step 6: Clean up imports and dead code

If `Select*` imports are no longer used in `NewWorktreeDialog.tsx`, remove them.

## Data Flow Summary

1. Branch data source remains `useGitBranches(projectDirectory)` from `useGitStore`
2. `localBranches`/`remoteBranches` still derived once via `useMemo`
3. New query state feeds `rankBranchesForQuery`
4. Ranked arrays are rendered in desktop/mobile pickers
5. Selected value updates existing state fields exactly as before

No server contract changes.

## Performance Considerations

- Use `useMemo` around ranking inputs: `localBranches`, `remoteBranches`, `query`
- Keep ranking function linear over branch count; no nested heavy loops
- Do not mutate original arrays
- Reset query on dropdown close to avoid stale state and unnecessary re-renders

## Theming and UI Compliance

Follow existing theme tokens and shared components only.

- Use current UI primitives from `@/components/ui/*`
- No hardcoded colors
- No direct `sonner` usage (already compliant)

## Validation Checklist

Manual checks:

1. Open New Worktree dialog in desktop mode.
2. Existing Branch picker:
   - type query
   - verify matches appear at top under `Matching branches`
   - select local and remote branch
3. Source Branch picker:
   - same checks as above
4. Mobile mode:
   - repeat for both overlays with search input
5. Clear query:
   - verify default grouping returns
6. Ensure selected branch behavior and worktree name sync still work

Required repo checks before finalizing:

- `bun run type-check`
- `bun run lint`
- `bun run build`

## Risks and Mitigations

1. **Risk:** Regressing picker behavior (selection, close behavior)
   - **Mitigation:** Keep selection handlers unchanged; only change list rendering surface.
2. **Risk:** Inconsistent desktop/mobile behavior
   - **Mitigation:** Use one shared ranking utility for all picker variants.
3. **Risk:** Architectural drift from recent refactors
   - **Mitigation:** Put matching/ranking logic in `lib/worktrees`, keep dialog component lean.

## Acceptance Criteria

Feature is complete when:

1. Both branch selectors in New Worktree dialog support search.
2. Search uses fuzzy matching.
3. Matching branches appear first.
4. Works consistently in desktop and mobile variants.
5. No backend changes are introduced.
6. Type-check, lint, and build pass.

## Optional Follow-up (Separate Task)

If desired, reuse `rankBranchesForQuery` in other branch-picking components for consistency:

- `packages/ui/src/components/multirun/BranchSelector.tsx`
- other command-based branch selectors

This is optional and should not block the New Worktree dialog delivery.
