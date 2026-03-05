import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TEST_DATA_DIR = path.join(os.tmpdir(), `openchamber-tunnel-api-${process.pid}-${Date.now()}`);
const previousOpenchamberDataDir = process.env.OPENCHAMBER_DATA_DIR;
process.env.OPENCHAMBER_DATA_DIR = TEST_DATA_DIR;
await fs.promises.mkdir(TEST_DATA_DIR, { recursive: true });

const { startWebUiServer } = await import('./index.js');

const runCloudflareIntegration = process.env.OPENCHAMBER_RUN_CF_INTEGRATION === '1';
const integrationIt = runCloudflareIntegration ? it : it.skip;

let activeServer = null;

const writeSettingsFile = async (payload) => {
  await fs.promises.mkdir(TEST_DATA_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(TEST_DATA_DIR, 'settings.json'), JSON.stringify(payload, null, 2), 'utf8');
};

const writeLegacyNamedTunnelFile = async (payload) => {
  await fs.promises.mkdir(TEST_DATA_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(TEST_DATA_DIR, 'cloudflare-named-tunnels.json'), JSON.stringify(payload, null, 2), 'utf8');
};

const removeManagedRemoteTunnelFile = async () => {
  try {
    await fs.promises.unlink(path.join(TEST_DATA_DIR, 'cloudflare-managed-remote-tunnels.json'));
  } catch {
  }
};

const cleanupTestDataFiles = async () => {
  const files = [
    'settings.json',
    'cloudflare-managed-remote-tunnels.json',
    'cloudflare-named-tunnels.json',
  ];
  await Promise.all(files.map(async (fileName) => {
    try {
      await fs.promises.unlink(path.join(TEST_DATA_DIR, fileName));
    } catch {
    }
  }));
};

afterEach(async () => {
  if (activeServer) {
    await activeServer.stop({ exitProcess: false });
    activeServer = null;
  }
  await cleanupTestDataFiles();
});

afterAll(async () => {
  if (typeof previousOpenchamberDataDir === 'string') {
    process.env.OPENCHAMBER_DATA_DIR = previousOpenchamberDataDir;
  } else {
    delete process.env.OPENCHAMBER_DATA_DIR;
  }
  await fs.promises.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('tunnel api contract', () => {
  it('returns normalized mode and provider on status', async () => {
    process.env.OPENCODE_SKIP_START = 'true';
    process.env.OPENCODE_HOST = 'http://127.0.0.1:9';

    activeServer = await startWebUiServer({
      port: 0,
      attachSignals: false,
      exitOnShutdown: false,
    });

    const port = activeServer.getPort();
    const response = await fetch(`http://127.0.0.1:${port}/api/openchamber/tunnel/status`);
    const body = await response.json();

    expect(response.ok).toBe(true);
    expect(body.provider).toBe('cloudflare');
    expect(typeof body.mode).toBe('string');
    expect(body.mode === 'quick' || body.mode === 'managed-remote' || body.mode === 'managed-local').toBe(true);
  });

  it('returns provider capability descriptors', async () => {
    process.env.OPENCODE_SKIP_START = 'true';
    process.env.OPENCODE_HOST = 'http://127.0.0.1:9';

    activeServer = await startWebUiServer({
      port: 0,
      attachSignals: false,
      exitOnShutdown: false,
    });

    const port = activeServer.getPort();
    const response = await fetch(`http://127.0.0.1:${port}/api/openchamber/tunnel/providers`);
    const body = await response.json();

    expect(response.ok).toBe(true);
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers[0]?.provider).toBe('cloudflare');
    expect(Array.isArray(body.providers[0]?.modes)).toBe(true);
  });

  it('migrates legacy named tunnel settings keys to canonical managed-remote keys', async () => {
    process.env.OPENCODE_SKIP_START = 'true';
    process.env.OPENCODE_HOST = 'http://127.0.0.1:9';
    await writeSettingsFile({
      namedTunnelHostname: 'legacy.example.com',
      namedTunnelToken: 'legacy-token',
      namedTunnelPresets: [{ id: 'legacy-id', name: 'Legacy Preset', hostname: 'legacy.example.com' }],
      namedTunnelPresetTokens: { 'legacy-id': 'legacy-token' },
      namedTunnelSelectedPresetId: 'legacy-id',
    });

    activeServer = await startWebUiServer({
      port: 0,
      attachSignals: false,
      exitOnShutdown: false,
    });

    const port = activeServer.getPort();
    const response = await fetch(`http://127.0.0.1:${port}/api/config/settings`);
    const body = await response.json();

    expect(response.ok).toBe(true);
    expect(body.managedRemoteTunnelHostname).toBe('legacy.example.com');
    expect(body.hasManagedRemoteTunnelToken).toBe(true);
    expect(Array.isArray(body.managedRemoteTunnelPresets)).toBe(true);
    expect(body.managedRemoteTunnelPresets[0]?.id).toBe('legacy-id');
    expect(body.managedRemoteTunnelSelectedPresetId).toBe('legacy-id');
    expect(body.namedTunnelHostname).toBeUndefined();

    const migratedSettingsRaw = await fs.promises.readFile(path.join(TEST_DATA_DIR, 'settings.json'), 'utf8');
    const migratedSettings = JSON.parse(migratedSettingsRaw);
    expect(migratedSettings.namedTunnelHostname).toBeUndefined();
    expect(migratedSettings.managedRemoteTunnelHostname).toBe('legacy.example.com');
  });

  it('migrates legacy named tunnel token file when managed-remote file is missing', async () => {
    process.env.OPENCODE_SKIP_START = 'true';
    process.env.OPENCODE_HOST = 'http://127.0.0.1:9';
    await removeManagedRemoteTunnelFile();
    await writeLegacyNamedTunnelFile({
      version: 1,
      tunnels: [
        {
          id: 'legacy-config-id',
          name: 'Legacy Config',
          hostname: 'legacy-config.example.com',
          token: 'legacy-config-token',
          updatedAt: Date.now(),
        },
      ],
    });

    activeServer = await startWebUiServer({
      port: 0,
      attachSignals: false,
      exitOnShutdown: false,
    });

    const port = activeServer.getPort();
    const response = await fetch(`http://127.0.0.1:${port}/api/openchamber/tunnel/status`);
    const body = await response.json();

    expect(response.ok).toBe(true);
    expect(Array.isArray(body.managedRemoteTunnelTokenPresetIds)).toBe(true);
    expect(body.managedRemoteTunnelTokenPresetIds).toContain('legacy-config-id');

    const migratedConfigRaw = await fs.promises.readFile(path.join(TEST_DATA_DIR, 'cloudflare-managed-remote-tunnels.json'), 'utf8');
    const migratedConfig = JSON.parse(migratedConfigRaw);
    expect(Array.isArray(migratedConfig.tunnels)).toBe(true);
    expect(migratedConfig.tunnels[0]?.id).toBe('legacy-config-id');
  });

  it('returns structured validation for unsupported provider', async () => {
    process.env.OPENCODE_SKIP_START = 'true';
    process.env.OPENCODE_HOST = 'http://127.0.0.1:9';

    activeServer = await startWebUiServer({
      port: 0,
      attachSignals: false,
      exitOnShutdown: false,
    });

    const port = activeServer.getPort();
    const response = await fetch(`http://127.0.0.1:${port}/api/openchamber/tunnel/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'unknown-provider', mode: 'quick' }),
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('provider_unsupported');
  });

  it('returns structured validation for unsupported mode', async () => {
    process.env.OPENCODE_SKIP_START = 'true';
    process.env.OPENCODE_HOST = 'http://127.0.0.1:9';

    activeServer = await startWebUiServer({
      port: 0,
      attachSignals: false,
      exitOnShutdown: false,
    });

    const port = activeServer.getPort();
    const response = await fetch(`http://127.0.0.1:${port}/api/openchamber/tunnel/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'cloudflare', mode: 'future-mode' }),
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('mode_unsupported');
  });

  it('rejects removed mode value named', async () => {
    process.env.OPENCODE_SKIP_START = 'true';
    process.env.OPENCODE_HOST = 'http://127.0.0.1:9';

    activeServer = await startWebUiServer({
      port: 0,
      attachSignals: false,
      exitOnShutdown: false,
    });

    const port = activeServer.getPort();
    const response = await fetch(`http://127.0.0.1:${port}/api/openchamber/tunnel/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'cloudflare', mode: 'named' }),
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('mode_unsupported');
  });

  it('supports stop endpoint contract', async () => {
    process.env.OPENCODE_SKIP_START = 'true';
    process.env.OPENCODE_HOST = 'http://127.0.0.1:9';

    activeServer = await startWebUiServer({
      port: 0,
      attachSignals: false,
      exitOnShutdown: false,
    });

    const port = activeServer.getPort();
    const response = await fetch(`http://127.0.0.1:${port}/api/openchamber/tunnel/stop`, {
      method: 'POST',
    });
    const body = await response.json();

    expect(response.ok).toBe(true);
    expect(body.ok).toBe(true);
    expect(typeof body.revokedBootstrapCount).toBe('number');
    expect(typeof body.invalidatedSessionCount).toBe('number');
  });

  integrationIt('runs managed-remote tunnel integration when explicitly enabled', async () => {
    process.env.OPENCODE_SKIP_START = 'true';
    process.env.OPENCODE_HOST = 'http://127.0.0.1:9';

    activeServer = await startWebUiServer({
      port: 0,
      attachSignals: false,
      exitOnShutdown: false,
    });

    const port = activeServer.getPort();
    const response = await fetch(`http://127.0.0.1:${port}/api/openchamber/tunnel/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'managed-remote' }),
    });
    const body = await response.json();

    expect(response.ok).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('managed-remote');
  });
});
