import { describe, expect, it } from 'bun:test';

import { parseArgs } from './cli.js';

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
