import os from 'os';
import path from 'path';

export const TUNNEL_PROVIDER_CLOUDFLARE = 'cloudflare';

export const TUNNEL_MODE_QUICK = 'quick';
export const TUNNEL_MODE_MANAGED_REMOTE = 'managed-remote';
export const TUNNEL_MODE_MANAGED_LOCAL = 'managed-local';
export const TUNNEL_MODE_NAMED_LEGACY = 'named';

const SUPPORTED_TUNNEL_MODES = new Set([
  TUNNEL_MODE_QUICK,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_MODE_MANAGED_LOCAL,
]);

export class TunnelServiceError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'TunnelServiceError';
    this.code = code;
    this.details = details;
  }
}

export function normalizeTunnelProvider(value) {
  if (typeof value !== 'string') {
    return TUNNEL_PROVIDER_CLOUDFLARE;
  }
  const provider = value.trim().toLowerCase();
  return provider || TUNNEL_PROVIDER_CLOUDFLARE;
}

export function normalizeTunnelMode(value) {
  if (typeof value !== 'string') {
    return TUNNEL_MODE_QUICK;
  }
  const mode = value.trim().toLowerCase();
  if (mode === TUNNEL_MODE_NAMED_LEGACY || mode === TUNNEL_MODE_MANAGED_REMOTE) {
    return TUNNEL_MODE_MANAGED_REMOTE;
  }
  if (mode === TUNNEL_MODE_MANAGED_LOCAL) {
    return TUNNEL_MODE_MANAGED_LOCAL;
  }
  return TUNNEL_MODE_QUICK;
}

export function normalizeOptionalPath(value) {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === '~') {
    return os.homedir();
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

export function toLegacyTunnelMode(mode) {
  return mode === TUNNEL_MODE_QUICK ? TUNNEL_MODE_QUICK : TUNNEL_MODE_NAMED_LEGACY;
}

export function isSupportedTunnelMode(mode) {
  return SUPPORTED_TUNNEL_MODES.has(mode);
}

export function normalizeTunnelStartRequest(input = {}, defaults = {}) {
  const provider = normalizeTunnelProvider(input.provider ?? defaults.provider);
  const mode = normalizeTunnelMode(input.mode ?? defaults.mode);
  const configPathValue = Object.prototype.hasOwnProperty.call(input, 'configPath')
    ? input.configPath
    : defaults.configPath;
  const configPath = normalizeOptionalPath(configPathValue);

  const token = typeof (input.token ?? defaults.token) === 'string'
    ? (input.token ?? defaults.token).trim()
    : '';

  const hostname = typeof (input.hostname ?? defaults.hostname) === 'string'
    ? (input.hostname ?? defaults.hostname).trim().toLowerCase()
    : '';

  return {
    provider,
    mode,
    configPath,
    token,
    hostname,
  };
}

export function validateTunnelStartRequest(request, capabilities) {
  if (!request || typeof request !== 'object') {
    throw new TunnelServiceError('validation_error', 'Tunnel start request must be an object');
  }

  if (!request.provider) {
    throw new TunnelServiceError('validation_error', 'Tunnel provider is required');
  }

  if (!isSupportedTunnelMode(request.mode)) {
    throw new TunnelServiceError('mode_unsupported', `Unsupported tunnel mode: ${request.mode}`);
  }

  if (!capabilities || capabilities.provider !== request.provider) {
    throw new TunnelServiceError('provider_unsupported', `Unsupported tunnel provider: ${request.provider}`);
  }

  if (!Array.isArray(capabilities.modes) || !capabilities.modes.includes(request.mode)) {
    throw new TunnelServiceError('mode_unsupported', `Provider '${request.provider}' does not support mode '${request.mode}'`);
  }

  if (request.mode === TUNNEL_MODE_MANAGED_REMOTE) {
    if (!capabilities.supportsToken) {
      throw new TunnelServiceError('validation_error', `Provider '${request.provider}' does not support token-based tunnels`);
    }
    if (!capabilities.supportsHostname) {
      throw new TunnelServiceError('validation_error', `Provider '${request.provider}' does not support hostname-based tunnels`);
    }
    if (!request.token) {
      throw new TunnelServiceError('validation_error', 'Managed remote tunnel token is required');
    }
    if (!request.hostname) {
      throw new TunnelServiceError('validation_error', 'Managed remote tunnel hostname is required');
    }
  }

  if (request.mode === TUNNEL_MODE_MANAGED_LOCAL && request.configPath !== undefined && request.configPath !== null) {
    if (!capabilities.supportsConfigPath) {
      throw new TunnelServiceError('validation_error', `Provider '${request.provider}' does not support local config paths`);
    }
  }
}
