# Tunnel Settings Validation and Error UX Plan

## Why this follow-up

Managed Local tunnel config currently allows arbitrary typed paths and can surface raw YAML parser internals to users. We want strict file-type guidance and actionable, non-technical failures.

## Scope

- UI validation in `packages/ui/src/components/sections/openchamber/TunnelSettings.tsx`
- Backend error wording in `packages/web/server/lib/cloudflare-tunnel.js`
- Test updates in `packages/web/server/lib/cloudflare-tunnel.test.js`

## Required behavior

1. Managed Local config accepts only `.yml`, `.yaml`, `.json` paths from typed input and start action.
2. If typed path extension is invalid, show a clear inline error and block start.
3. Backend does not return raw YAML parse details to UI users.
4. Backend returns concise, actionable messages for missing/unreadable/invalid config.

## Implementation details

### UI (`TunnelSettings.tsx`)

- Add extension helpers:
  - `ALLOWED_MANAGED_LOCAL_CONFIG_EXTENSIONS`
  - `hasAllowedManagedLocalConfigExtension(path)`
- Add state: `managedLocalConfigError`.
- Validate in:
  - `handleManagedLocalConfigInputBlur`
  - `handleStart` when `tunnelMode === 'managed-local'`
- Validation message:
  - `Config file must use .yml, .yaml, or .json extension.`

### Backend (`cloudflare-tunnel.js`)

- Replace technical parse message with friendly message:
  - from: `Managed local tunnel config is invalid YAML: ... (parser details)`
  - to: `Managed local tunnel config is invalid. Use a valid cloudflared YAML/JSON config file.`
- Keep path-specific errors actionable but not overly technical:
  - not found, not file, unreadable.

### Tests (`cloudflare-tunnel.test.js`)

- Update assertions to match new error message shape for invalid YAML.
- Keep coverage for config-not-found behavior.

## Validation

- `bun test`
- `bun run type-check`
- `bun run lint`
- `bun run build`

## Done criteria

- Invalid typed extensions are blocked before start.
- Users no longer see parser internals for config failures.
- Error copy is actionable and understandable.
- Full validation passes.
