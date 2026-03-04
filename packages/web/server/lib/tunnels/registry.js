export function createTunnelProviderRegistry(initialProviders = []) {
  const providers = new Map();

  const register = (provider) => {
    if (!provider || typeof provider.id !== 'string' || provider.id.trim().length === 0) {
      throw new Error('Tunnel provider must define a non-empty id');
    }
    providers.set(provider.id.trim().toLowerCase(), provider);
    return provider;
  };

  const get = (providerId) => {
    if (typeof providerId !== 'string' || providerId.trim().length === 0) {
      return null;
    }
    return providers.get(providerId.trim().toLowerCase()) ?? null;
  };

  const list = () => Array.from(providers.values());

  const listCapabilities = () => list().map((provider) => ({ ...provider.capabilities }));

  for (const provider of initialProviders) {
    register(provider);
  }

  return {
    register,
    get,
    list,
    listCapabilities,
  };
}
