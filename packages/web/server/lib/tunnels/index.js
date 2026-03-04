import {
  TUNNEL_MODE_QUICK,
  TunnelServiceError,
  normalizeTunnelStartRequest,
  validateTunnelStartRequest,
} from './types.js';

export function createTunnelService({
  registry,
  getController,
  setController,
  getActivePort,
  onQuickTunnelWarning,
}) {
  if (!registry) {
    throw new Error('Tunnel service requires a provider registry');
  }

  const resolveActiveMode = () => {
    const controller = getController();
    if (!controller || typeof controller.mode !== 'string') {
      return null;
    }
    return controller.mode;
  };

  const stop = () => {
    const controller = getController();
    if (!controller) {
      return false;
    }

    const providerId = typeof controller.provider === 'string' ? controller.provider : '';
    const provider = providerId ? registry.get(providerId) : null;
    if (provider?.stop) {
      provider.stop(controller);
    } else {
      controller.stop?.();
    }
    setController(null);
    return true;
  };

  const checkAvailability = async (providerId) => {
    const provider = registry.get(providerId);
    if (!provider) {
      throw new TunnelServiceError('provider_unsupported', `Unsupported tunnel provider: ${providerId}`);
    }
    const result = await provider.checkAvailability();
    return result;
  };

  const start = async (rawRequest, options = {}) => {
    const request = normalizeTunnelStartRequest(rawRequest);
    const provider = registry.get(request.provider);

    if (!provider) {
      throw new TunnelServiceError('provider_unsupported', `Unsupported tunnel provider: ${request.provider}`);
    }

    validateTunnelStartRequest(request, provider.capabilities);

    let publicUrl = provider.resolvePublicUrl(getController());
    const activeMode = resolveActiveMode();

    if (publicUrl && activeMode !== request.mode) {
      stop();
      publicUrl = null;
    }

    if (!publicUrl) {
      const availability = await provider.checkAvailability();
      if (!availability?.available) {
        throw new TunnelServiceError('missing_dependency', 'cloudflared is not installed. Install it with: brew install cloudflared');
      }

      const activePort = Number.isFinite(getActivePort?.()) ? getActivePort() : null;
      const originUrl = activePort !== null ? `http://127.0.0.1:${activePort}` : undefined;

      const controller = await provider.start(request, {
        activePort,
        originUrl,
        ...options,
      });
      controller.provider = request.provider;
      setController(controller);

      publicUrl = provider.resolvePublicUrl(controller);
      if (!publicUrl) {
        stop();
        throw new TunnelServiceError('startup_failed', 'Tunnel started but no public URL was assigned');
      }

      if (request.mode === TUNNEL_MODE_QUICK) {
        onQuickTunnelWarning?.();
      }
    }

    return {
      publicUrl,
      request,
      activeMode: request.mode,
      provider: request.provider,
    };
  };

  const getPublicUrl = () => {
    const controller = getController();
    if (!controller) {
      return null;
    }
    const provider = registry.get(controller.provider);
    if (!provider) {
      return controller.getPublicUrl?.() ?? null;
    }
    return provider.resolvePublicUrl(controller);
  };

  return {
    start,
    stop,
    checkAvailability,
    getPublicUrl,
    resolveActiveMode,
  };
}
