# Tunnel Settings UI Restructure - Execution Plan

## Context
The current `TunnelSettings.tsx` (1437 lines) is a monolithic component with scattered mode conditionals, no provider awareness, and no config file picker for managed-local mode. This plan restructures it into a clean, provider-agnostic, tab-based layout.

## Scope Lock
- Modify: `packages/ui/src/components/sections/openchamber/TunnelSettings.tsx` (full restructure)
- Modify: `packages/ui/src/lib/desktop.ts` (add `tunnelProvider`, `managedLocalTunnelConfigPath` to `DesktopSettings` type; add `pickFile()` helper)
- Modify: `packages/ui/src/lib/persistence.ts` (add `tunnelProvider`, `managedLocalTunnelConfigPath` sanitization)
- Do NOT modify backend (`packages/web/server/*`) — all needed APIs already exist

## Target Layout

```
┌─────────────────────────────────────────────────┐
│ Remote Tunnel                                    │
│ Provider: [Cloudflare ▾]  (dropdown)             │
│ "More providers coming soon" as disabled option  │
├─────────────────────────────────────────────────┤
│ [ Quick ] [ Managed Remote ] [ Managed Local ]   │  ← SortableTabsStrip active-pill, fit
├─────────────────────────────────────────────────┤
│                                                   │
│  <Mode-specific content panel>                    │
│  - Quick: best-effort warning + start button      │
│  - Managed Remote: presets, tokens, start button  │
│  - Managed Local: config file picker, fallback    │
│    info, start button                             │
│                                                   │
├─────────────────────────────────────────────────┤
│ TTL Settings (shared)                             │
├─────────────────────────────────────────────────┤
│ Active tunnel (when running): URL, QR, stop       │
├─────────────────────────────────────────────────┤
│ Session records                                   │
└─────────────────────────────────────────────────┘
```

## File Changes

### 1. `packages/ui/src/lib/desktop.ts`

#### Add fields to `DesktopSettings` type (after `tunnelMode` line ~97):
```typescript
  tunnelProvider?: string;
  tunnelMode?: 'quick' | 'managed-remote' | 'managed-local';
  tunnelBootstrapTtlMs?: number | null;
  tunnelSessionTtlMs?: number;
  managedLocalTunnelConfigPath?: string | null;  // NEW
  managedRemoteTunnelHostname?: string;
```

#### Add `requestFileAccess` function (after `requestDirectoryAccess` around line 288):
```typescript
export const requestFileAccess = async (
  options?: { filters?: Array<{ name: string; extensions: string[] }> }
): Promise<{ success: boolean; path?: string; error?: string }> => {
  if (isTauriShell() && isDesktopLocalOriginActive()) {
    try {
      const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
      const selected = await tauri?.dialog?.open?.({
        directory: false,
        multiple: false,
        title: 'Select File',
        ...(options?.filters ? { filters: options.filters } : {}),
      });
      if (!selected || typeof selected !== 'string') {
        return { success: false, error: 'File selection cancelled' };
      }
      return { success: true, path: selected };
    } catch (error) {
      console.warn('Failed to request file access (tauri)', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { success: false, error: 'Native file picker not available' };
};
```

### 2. `packages/ui/src/lib/persistence.ts`

#### Add sanitization for new fields (after tunnelSessionTtlMs block around line 525):
```typescript
  if (typeof candidate.tunnelProvider === 'string') {
    const provider = candidate.tunnelProvider.trim().toLowerCase();
    if (provider.length > 0) {
      result.tunnelProvider = provider;
    }
  }
  // ... existing tunnelMode block ...
  if (candidate.managedLocalTunnelConfigPath === null) {
    result.managedLocalTunnelConfigPath = null;
  } else if (typeof candidate.managedLocalTunnelConfigPath === 'string') {
    const trimmed = candidate.managedLocalTunnelConfigPath.trim();
    result.managedLocalTunnelConfigPath = trimmed.length > 0 ? trimmed : null;
  }
```

### 3. `packages/ui/src/components/sections/openchamber/TunnelSettings.tsx`

Full restructure. Key changes:

#### 3a. Provider Dropdown
- On mount, fetch `GET /api/openchamber/tunnel/providers` to get provider list
- Render a `Select` dropdown with provider options
- Include a disabled "More providers coming soon" item
- Store selected provider in state, persist via settings

#### 3b. Mode Tabs
- Import `SortableTabsStrip` from `@/components/ui/sortable-tabs-strip`
- Replace the three `ButtonSmall` mode chips with:
```tsx
<SortableTabsStrip
  items={[
    { id: 'quick', label: 'Quick' },
    { id: 'managed-remote', label: 'Managed Remote' },
    { id: 'managed-local', label: 'Managed Local' },
  ]}
  activeId={tunnelMode}
  onSelect={(id) => void handleModeChange(id as TunnelMode)}
  variant="active-pill"
  layoutMode="fit"
/>
```

#### 3c. Extract Three Panel Components (inline in same file or separate)
Each panel receives shared props interface:

```typescript
interface TunnelPanelProps {
  state: TunnelState;
  isSavingMode: boolean;
  onStart: () => void;
  primaryCtaClass: string;
}
```

**QuickTunnelPanel**: warning block + start button (lines 1039-1053 + start button from 1340-1349)

**ManagedRemoteTunnelPanel**: The entire presets management block (lines 1055-1262 + start button). Receives additional props: `presets`, `selectedPreset`, `onSelectPreset`, `onAddPreset`, `onRemovePreset`, etc.

**ManagedLocalTunnelPanel**: NEW panel with:
- Config file input + browse button
- Info block about default config fallback
- Start button
- Uses `requestFileAccess()` from desktop.ts for Tauri native picker
- Falls back to hidden `<input type="file">` for web

#### 3d. Fix NAMED Badge (line 885)
Replace:
```tsx
{isQuick ? 'QUICK' : 'NAMED'}
```
With:
```tsx
{record.mode === 'quick' ? 'QUICK' : record.mode === 'managed-remote' ? 'REMOTE' : 'LOCAL'}
```
And update the badge color to use a mode-aware mapping instead of just quick vs non-quick.

#### 3e. Managed Local Config File Picker
```tsx
// State
const [managedLocalConfigPath, setManagedLocalConfigPath] = React.useState<string | null>(null);
const fileInputRef = React.useRef<HTMLInputElement>(null);

// Handler
const handleBrowseConfigFile = React.useCallback(async () => {
  const result = await requestFileAccess({
    filters: [{ name: 'Config', extensions: ['yml', 'yaml', 'json'] }],
  });
  if (result.success && result.path) {
    setManagedLocalConfigPath(result.path);
    void saveTunnelSettings({ managedLocalTunnelConfigPath: result.path });
    return;
  }
  // Fallback to web file input
  fileInputRef.current?.click();
}, [saveTunnelSettings]);

// Render
<div className="space-y-1.5">
  <p className="typography-ui-label text-foreground">Configuration file</p>
  <div className="flex items-center gap-2">
    <Input
      value={managedLocalConfigPath || ''}
      onChange={(e) => {
        const path = e.target.value.trim() || null;
        setManagedLocalConfigPath(path);
      }}
      onBlur={() => void saveTunnelSettings({ managedLocalTunnelConfigPath: managedLocalConfigPath })}
      placeholder="Using default cloudflared config"
      className="h-7 flex-1"
    />
    <ButtonSmall variant="outline" size="xs" className="h-7 w-7 p-0" onClick={handleBrowseConfigFile}>
      <RiFolderLine className="h-4 w-4" />
    </ButtonSmall>
    {managedLocalConfigPath && (
      <ButtonSmall variant="ghost" size="xs" className="h-7 w-7 p-0" onClick={() => {
        setManagedLocalConfigPath(null);
        void saveTunnelSettings({ managedLocalTunnelConfigPath: null });
      }}>
        <RiCloseLine className="h-4 w-4" />
      </ButtonSmall>
    )}
  </div>
  <p className="typography-meta text-muted-foreground/70">
    {managedLocalConfigPath
      ? 'Custom config file will be used when starting the tunnel.'
      : 'When empty, cloudflared uses its default config (~/.cloudflared/config.yml).'}
  </p>
</div>
```

#### 3f. Pass configPath to start request
In `handleStart`, when `tunnelMode === 'managed-local'`:
```typescript
body: JSON.stringify({
  mode: 'managed-local',
  ...(managedLocalConfigPath ? { configPath: managedLocalConfigPath } : {}),
})
```

### 4. Server-side `packages/web/server/index.js`

#### Add `tunnelProvider` and `managedLocalTunnelConfigPath` to settings sanitization
In `sanitizeSettingsUpdate` (around line 2019-2043), add:
```javascript
if (typeof candidate.tunnelProvider === 'string') {
  result.tunnelProvider = candidate.tunnelProvider.trim().toLowerCase() || undefined;
}
// after tunnelMode block:
if (candidate.managedLocalTunnelConfigPath === null) {
  result.managedLocalTunnelConfigPath = null;
} else if (typeof candidate.managedLocalTunnelConfigPath === 'string') {
  const trimmed = candidate.managedLocalTunnelConfigPath.trim();
  result.managedLocalTunnelConfigPath = trimmed.length > 0 ? trimmed : null;
}
```

In the `/api/openchamber/tunnel/start` handler, read `managedLocalTunnelConfigPath` from settings as fallback when `configPath` is not in the request body.

## Validation
After all changes:
- `bun run type-check`
- `bun run lint`
- `bun run build`

## Done Criteria
- Provider dropdown visible with Cloudflare + "more coming" hint
- Mode selection uses `SortableTabsStrip` with clean per-mode panels
- Managed-local has working config file picker with default-config fallback info
- No "NAMED" badge anywhere
- No scattered mode conditionals -- each mode has its own panel
- Settings persist across app restarts
- Existing tunnel start/stop/status/QR functionality unchanged
