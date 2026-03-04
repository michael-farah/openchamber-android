import {
  checkCloudflaredAvailable,
  startCloudflareManagedLocalTunnel,
  startCloudflareNamedTunnel,
  startCloudflareQuickTunnel,
} from '../../cloudflare-tunnel.js';

import {
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
} from '../types.js';

export const cloudflareTunnelProviderCapabilities = {
  provider: TUNNEL_PROVIDER_CLOUDFLARE,
  modes: [
    TUNNEL_MODE_QUICK,
    TUNNEL_MODE_MANAGED_REMOTE,
    TUNNEL_MODE_MANAGED_LOCAL,
  ],
  supportsConfigPath: true,
  supportsToken: true,
  supportsHostname: true,
};

export function createCloudflareTunnelProvider() {
  return {
    id: TUNNEL_PROVIDER_CLOUDFLARE,
    capabilities: cloudflareTunnelProviderCapabilities,
    checkAvailability: async () => checkCloudflaredAvailable(),
    start: async (request, context = {}) => {
      if (request.mode === TUNNEL_MODE_MANAGED_REMOTE) {
        return startCloudflareNamedTunnel({
          token: request.token,
          hostname: request.hostname,
        });
      }

      if (request.mode === TUNNEL_MODE_MANAGED_LOCAL) {
        return startCloudflareManagedLocalTunnel({
          configPath: request.configPath,
          hostname: request.hostname,
        });
      }

      if (!context.originUrl) {
        throw new TunnelServiceError('validation_error', 'originUrl is required for quick tunnel mode');
      }

      return startCloudflareQuickTunnel({
        originUrl: context.originUrl,
        port: context.activePort,
      });
    },
    stop: (controller) => {
      controller?.stop?.();
    },
    resolvePublicUrl: (controller) => controller?.getPublicUrl?.() ?? null,
  };
}
