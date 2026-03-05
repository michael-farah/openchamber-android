# Tunnel Restructure Follow-up Plan (For Next Agent)

## Scope Lock

- Include: backend migration, terminology cleanup, provider-discovery usability outside Settings UI.
- Exclude: Settings UI/state redesign work.
- Do not modify:
  - `packages/ui/src/components/sections/openchamber/TunnelSettings.tsx`
  - `packages/ui/src/lib/desktop.ts`

## Implementation Plan (Single Pass)

1. Backend migration for legacy named data

- In `packages/web/server/index.js` (`readSettingsFromDiskMigrated` flow), add migration from legacy keys to canonical keys:
  - `namedTunnelHostname` -> `managedRemoteTunnelHostname`
  - `namedTunnelToken` -> `managedRemoteTunnelToken`
  - `namedTunnelPresets` -> `managedRemoteTunnelPresets`
  - `namedTunnelPresetTokens` -> `managedRemoteTunnelPresetTokens`
  - `namedTunnelSelectedPresetId` -> `managedRemoteTunnelSelectedPresetId`
- Add legacy file fallback migration:
  - If `cloudflare-managed-remote-tunnels.json` is missing and legacy `cloudflare-named-tunnels.json` exists, read/sanitize legacy content and write canonical file once.
- Keep migration idempotent and non-destructive.

2. Terminology debt cleanup (non-Settings)

- In `packages/web/server/index.js`, rename internal constants to remove `named` terminology, for example:
  - `CLOUDFLARE_NAMED_TUNNELS_VERSION` -> `CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION`.
- Keep runtime behavior unchanged.

3. Provider discovery usability without Settings changes

- Add a small CLI capability-discovery command in `packages/web/bin/cli.js` (for example `openchamber tunnel-providers`) that prints provider/mode descriptors.
- Preferred behavior:
  - Query local API when server is running.
  - Provide deterministic Cloudflare fallback output if API is unavailable.
- Add/extend tests in `packages/web/bin/cli.test.js` for command output shape.

4. Documentation cleanup

- Remove remaining user-facing legacy "Named" wording in docs:
  - `README.md` managed-remote section.
- Ensure `packages/web/README.md` remains canonical.
- Keep explicit note that `--try-cf-tunnel` is a deprecated alias to quick mode.

5. Tests and contract coverage

- Extend tests to cover migration/no-regression:
  - `packages/web/server/tunnel-api.test.js`: API-visible behavior remains canonical after migrations.
  - Add targeted migration coverage for legacy settings keys and legacy tunnel token file behavior.
  - Keep existing contract assertion: `mode=named` returns `422` with `code=mode_unsupported`.

6. Validation gate

- Run full checks:
  - `bun test`
  - `bun run type-check`
  - `bun run lint`
  - `bun run build`

## Done Criteria for This Pass

- Legacy `named*` persisted data migrates forward automatically.
- No new user-facing docs contain "Named tunnel" terminology.
- Provider capability discovery is usable outside Settings UI.
- Tunnel start/stop/status API contracts remain stable.
- Test/type/lint/build baseline is green.
