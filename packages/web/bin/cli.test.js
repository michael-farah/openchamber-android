import { describe, expect, it } from 'bun:test';

import { parseArgs, resolveTunnelProviders } from './cli.js';

describe('cli parseArgs tunnel flags', () => {
  it('maps legacy quick tunnel flag and emits deprecation warning', () => {
    const { options, warnings } = parseArgs(['--try-cf-tunnel']);

    expect(options.tryCfTunnel).toBe(true);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('--try-cf-tunnel');
    expect(warnings[0]).toContain('--tunnel-provider cloudflare --tunnel-mode quick');
  });

  it('parses canonical managed-local shorthand without path', () => {
    const { options } = parseArgs(['--tunnel']);

    expect(options.tunnelProvider).toBe('cloudflare');
    expect(options.tunnelMode).toBe('managed-local');
    expect(options.tunnelConfigPath).toBeNull();
  });

  it('parses managed-local shorthand with explicit config path', () => {
    const { options } = parseArgs(['--tunnel', '~/.cloudflared/config.yml']);

    expect(options.tunnelProvider).toBe('cloudflare');
    expect(options.tunnelMode).toBe('managed-local');
    expect(options.tunnelConfigPath).toBe('~/.cloudflared/config.yml');
  });

  it('gives precedence to canonical options when mixed with legacy flag', () => {
    const { options } = parseArgs([
      '--try-cf-tunnel',
      '--tunnel-provider', 'cloudflare',
      '--tunnel-mode', 'managed-local',
      '--tunnel-config',
    ]);

    expect(options.tryCfTunnel).toBe(true);
    expect(options.tunnelMode).toBe('managed-local');
    expect(options.tunnelConfigPath).toBeNull();
  });
});

describe('cli tunnel provider discovery', () => {
  it('uses provider capabilities from local api when available', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        providers: [{ provider: 'cloudflare', modes: [{ key: 'quick' }] }],
      }),
    });

    const result = await resolveTunnelProviders({ port: 4501 }, { readPorts: () => [], fetchImpl });

    expect(result.source).toBe('api:4501');
    expect(Array.isArray(result.providers)).toBe(true);
    expect(result.providers[0]?.provider).toBe('cloudflare');
  });

  it('falls back to built-in provider capabilities when api is unavailable', async () => {
    const fetchImpl = async () => {
      throw new Error('unreachable');
    };

    const result = await resolveTunnelProviders({ port: 4501 }, { readPorts: () => [], fetchImpl });

    expect(result.source).toBe('fallback');
    expect(Array.isArray(result.providers)).toBe(true);
    expect(result.providers[0]?.provider).toBe('cloudflare');
  });
});
