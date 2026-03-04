import { describe, expect, it } from 'bun:test';

import {
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
  normalizeTunnelMode,
  normalizeTunnelStartRequest,
  validateTunnelStartRequest,
} from './types.js';

describe('tunnel request types', () => {
  it('normalizes legacy named mode to managed-remote', () => {
    expect(normalizeTunnelMode('named')).toBe(TUNNEL_MODE_MANAGED_REMOTE);
  });

  it('normalizes tunnel start request defaults', () => {
    const request = normalizeTunnelStartRequest({});

    expect(request.provider).toBe(TUNNEL_PROVIDER_CLOUDFLARE);
    expect(request.mode).toBe(TUNNEL_MODE_QUICK);
    expect(request.token).toBe('');
    expect(request.hostname).toBe('');
  });

  it('requires token and hostname for managed-remote', () => {
    const capabilities = {
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      modes: [TUNNEL_MODE_QUICK, TUNNEL_MODE_MANAGED_REMOTE, TUNNEL_MODE_MANAGED_LOCAL],
      supportsConfigPath: true,
      supportsToken: true,
      supportsHostname: true,
    };

    expect(() => validateTunnelStartRequest({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      mode: TUNNEL_MODE_MANAGED_REMOTE,
      token: '',
      hostname: '',
      configPath: undefined,
    }, capabilities)).toThrow(TunnelServiceError);
  });
});
