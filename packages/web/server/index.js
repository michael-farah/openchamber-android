import express from 'express';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import { fileURLToPath } from 'url';
import os from 'os';
import crypto from 'crypto';
import { createUiAuth } from './lib/opencode/ui-auth.js';
import { createTunnelAuth } from './lib/opencode/tunnel-auth.js';
import {
  printTunnelWarning,
} from './lib/cloudflare-tunnel.js';
import { createTunnelService } from './lib/tunnels/index.js';
import { createTunnelProviderRegistry } from './lib/tunnels/registry.js';
import { createCloudflareTunnelProvider } from './lib/tunnels/providers/cloudflare.js';
import {
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
  isSupportedTunnelMode,
  normalizeOptionalPath,
  normalizeTunnelStartRequest,
  normalizeTunnelMode,
  normalizeTunnelProvider,
} from './lib/tunnels/types.js';
import { prepareNotificationLastMessage } from './lib/notifications/index.js';
import { registerTtsRoutes } from './lib/tts/routes.js';
import { registerQuotaRoutes } from './lib/quota/routes.js';
import { registerGitHubRoutes } from './lib/github/routes.js';
import { registerGitRoutes } from './lib/git/routes.js';
import { createTerminalRuntime } from './lib/terminal/runtime.js';
import { registerFsRoutes } from './lib/fs/routes.js';
import { createFsSearchRuntime } from './lib/fs/search.js';
import { registerOpenCodeRoutes } from './lib/opencode/routes.js';
import webPush from 'web-push';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PORT = 3000;
const DESKTOP_NOTIFY_PREFIX = '[OpenChamberDesktopNotify] ';
const uiNotificationClients = new Set();
const HEALTH_CHECK_INTERVAL = 15000;
const SHUTDOWN_TIMEOUT = 10000;
const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const MODELS_METADATA_CACHE_TTL = 5 * 60 * 1000;
const CLIENT_RELOAD_DELAY_MS = 800;
const OPEN_CODE_READY_GRACE_MS = 12000;
const LONG_REQUEST_TIMEOUT_MS = 4 * 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_DEFAULT_MS = 30 * 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_MIN_MS = 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_MAX_MS = 24 * 60 * 60 * 1000;
const TUNNEL_SESSION_TTL_DEFAULT_MS = 8 * 60 * 60 * 1000;
const TUNNEL_SESSION_TTL_MIN_MS = 5 * 60 * 1000;
const TUNNEL_SESSION_TTL_MAX_MS = 24 * 60 * 60 * 1000;
const OPENCHAMBER_VERSION = (() => {
  try {
    const packagePath = path.resolve(__dirname, '..', 'package.json');
    const raw = fs.readFileSync(packagePath, 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
  }
  return 'unknown';
})();
const fsPromises = fs.promises;

// Lock to prevent race conditions in persistSettings
let persistSettingsLock = Promise.resolve();

const normalizeDirectoryPath = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed === '~') {
    return os.homedir();
  }

  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }

  return trimmed;
};

const normalizePathForPersistence = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = normalizeDirectoryPath(value);
  if (typeof normalized !== 'string') {
    return normalized;
  }

  const trimmed = normalized.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (process.platform !== 'win32') {
    return trimmed;
  }

  return trimmed.replace(/\//g, '\\');
};

const areStringArraysEqual = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
};

const normalizeSettingsPaths = (input) => {
  const settings = input && typeof input === 'object' ? input : {};
  let next = settings;
  let changed = false;

  const ensureNext = () => {
    if (next === settings) {
      next = { ...settings };
    }
  };

  const normalizePathField = (key) => {
    if (typeof settings[key] !== 'string' || settings[key].length === 0) {
      return;
    }
    const normalized = normalizePathForPersistence(settings[key]);
    if (normalized !== settings[key]) {
      ensureNext();
      next[key] = normalized;
      changed = true;
    }
  };

  const normalizePathArrayField = (key) => {
    if (!Array.isArray(settings[key])) {
      return;
    }

    const normalized = normalizeStringArray(
      settings[key]
        .map((entry) => (typeof entry === 'string' ? normalizePathForPersistence(entry) : entry))
        .filter((entry) => typeof entry === 'string' && entry.length > 0)
    );

    if (!areStringArraysEqual(normalized, settings[key])) {
      ensureNext();
      next[key] = normalized;
      changed = true;
    }
  };

  normalizePathField('lastDirectory');
  normalizePathField('homeDirectory');
  normalizePathArrayField('approvedDirectories');
  normalizePathArrayField('pinnedDirectories');

  if (Array.isArray(settings.projects)) {
    const normalizedProjects = sanitizeProjects(settings.projects) || [];
    if (JSON.stringify(normalizedProjects) !== JSON.stringify(settings.projects)) {
      ensureNext();
      next.projects = normalizedProjects;
      changed = true;
    }
  }

  return { settings: next, changed };
};

const OPENCHAMBER_USER_CONFIG_ROOT = path.join(os.homedir(), '.config', 'openchamber');
const OPENCHAMBER_USER_THEMES_DIR = path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'themes');

const MAX_THEME_JSON_BYTES = 512 * 1024;

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const clampNumber = (value, min, max) => Math.max(min, Math.min(max, value));

const normalizeTunnelBootstrapTtlMs = (value) => {
  if (value === null) {
    return null;
  }
  if (!Number.isFinite(value)) {
    return TUNNEL_BOOTSTRAP_TTL_DEFAULT_MS;
  }
  return clampNumber(Math.round(value), TUNNEL_BOOTSTRAP_TTL_MIN_MS, TUNNEL_BOOTSTRAP_TTL_MAX_MS);
};

const normalizeTunnelSessionTtlMs = (value) => {
  if (!Number.isFinite(value)) {
    return TUNNEL_SESSION_TTL_DEFAULT_MS;
  }
  return clampNumber(Math.round(value), TUNNEL_SESSION_TTL_MIN_MS, TUNNEL_SESSION_TTL_MAX_MS);
};

const normalizeManagedRemoteTunnelHostname = (value) => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = (() => {
    try {
      if (trimmed.includes('://')) {
        return new URL(trimmed);
      }
      return new URL(`https://${trimmed}`);
    } catch {
      return null;
    }
  })();

  const hostname = parsed?.hostname?.trim().toLowerCase() || '';
  if (!hostname) {
    return undefined;
  }
  return hostname;
};

const normalizeManagedRemoteTunnelPresets = (value) => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result = [];
  const seenIds = new Set();
  const seenHostnames = new Set();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const hostname = normalizeManagedRemoteTunnelHostname(candidate.hostname);
    if (!id || !name || !hostname) continue;
    if (seenIds.has(id) || seenHostnames.has(hostname)) continue;
    seenIds.add(id);
    seenHostnames.add(hostname);
    result.push({ id, name, hostname });
  }

  return result;
};

const normalizeManagedRemoteTunnelPresetTokens = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const result = {};
  for (const [rawId, rawToken] of Object.entries(value)) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    const token = typeof rawToken === 'string' ? rawToken.trim() : '';
    if (!id || !token) {
      continue;
    }
    result[id] = token;
  }

  return Object.keys(result).length > 0 ? result : undefined;
};

const isValidThemeColor = (value) => isNonEmptyString(value);

const normalizeThemeJson = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : null;
  const colors = raw.colors && typeof raw.colors === 'object' ? raw.colors : null;
  if (!metadata || !colors) {
    return null;
  }

  const id = metadata.id;
  const name = metadata.name;
  const variant = metadata.variant;
  if (!isNonEmptyString(id) || !isNonEmptyString(name) || (variant !== 'light' && variant !== 'dark')) {
    return null;
  }

  const primary = colors.primary;
  const surface = colors.surface;
  const interactive = colors.interactive;
  const status = colors.status;
  const syntax = colors.syntax;
  const syntaxBase = syntax && typeof syntax === 'object' ? syntax.base : null;
  const syntaxHighlights = syntax && typeof syntax === 'object' ? syntax.highlights : null;

  if (!primary || !surface || !interactive || !status || !syntaxBase || !syntaxHighlights) {
    return null;
  }

  // Minimal fields required by CSSVariableGenerator and diff/syntax rendering.
  const required = [
    primary.base,
    primary.foreground,
    surface.background,
    surface.foreground,
    surface.muted,
    surface.mutedForeground,
    surface.elevated,
    surface.elevatedForeground,
    surface.subtle,
    interactive.border,
    interactive.selection,
    interactive.selectionForeground,
    interactive.focusRing,
    interactive.hover,
    status.error,
    status.errorForeground,
    status.errorBackground,
    status.errorBorder,
    status.warning,
    status.warningForeground,
    status.warningBackground,
    status.warningBorder,
    status.success,
    status.successForeground,
    status.successBackground,
    status.successBorder,
    status.info,
    status.infoForeground,
    status.infoBackground,
    status.infoBorder,
    syntaxBase.background,
    syntaxBase.foreground,
    syntaxBase.keyword,
    syntaxBase.string,
    syntaxBase.number,
    syntaxBase.function,
    syntaxBase.variable,
    syntaxBase.type,
    syntaxBase.comment,
    syntaxBase.operator,
    syntaxHighlights.diffAdded,
    syntaxHighlights.diffRemoved,
    syntaxHighlights.lineNumber,
  ];

  if (!required.every(isValidThemeColor)) {
    return null;
  }

  const tags = Array.isArray(metadata.tags)
    ? metadata.tags.filter((tag) => typeof tag === 'string' && tag.trim().length > 0)
    : [];

  return {
    ...raw,
    metadata: {
      ...metadata,
      id: id.trim(),
      name: name.trim(),
      description: typeof metadata.description === 'string' ? metadata.description : '',
      version: typeof metadata.version === 'string' && metadata.version.trim().length > 0 ? metadata.version : '1.0.0',
      variant,
      tags,
    },
  };
};

const readCustomThemesFromDisk = async () => {
  try {
    const entries = await fsPromises.readdir(OPENCHAMBER_USER_THEMES_DIR, { withFileTypes: true });
    const themes = [];
    const seen = new Set();

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.json')) continue;

      const filePath = path.join(OPENCHAMBER_USER_THEMES_DIR, entry.name);
      try {
        const stat = await fsPromises.stat(filePath);
        if (!stat.isFile()) continue;
        if (stat.size > MAX_THEME_JSON_BYTES) {
          console.warn(`[themes] Skip ${entry.name}: too large (${stat.size} bytes)`);
          continue;
        }

        const rawText = await fsPromises.readFile(filePath, 'utf8');
        const parsed = JSON.parse(rawText);
        const normalized = normalizeThemeJson(parsed);
        if (!normalized) {
          console.warn(`[themes] Skip ${entry.name}: invalid theme JSON`);
          continue;
        }

        const id = normalized.metadata.id;
        if (seen.has(id)) {
          console.warn(`[themes] Skip ${entry.name}: duplicate theme id "${id}"`);
          continue;
        }

        seen.add(id);
        themes.push(normalized);
      } catch (error) {
        console.warn(`[themes] Failed to read ${entry.name}:`, error);
      }
    }

    return themes;
  } catch (error) {
    // Missing dir is fine.
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return [];
    }
    console.warn('[themes] Failed to list custom themes dir:', error);
    return [];
  }
};

const createTimeoutSignal = (timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
};

/** Humanize a project label: replace dashes/underscores with spaces, title-case each word. Mirrors the UI's formatProjectLabel. */
const formatProjectLabel = (label) => {
  if (!label || typeof label !== 'string') return '';
  return label
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

const resolveNotificationTemplate = (template, variables) => {
  if (!template || typeof template !== 'string') return '';
  return template.replace(/\{(\w+)\}/g, (_match, key) => {
    const value = variables[key];
    if (value === undefined || value === null) return '';
    return String(value);
  });
};

const shouldApplyResolvedTemplateMessage = (template, resolved, variables) => {
  if (!resolved) {
    return false;
  }

  if (typeof template !== 'string') {
    return true;
  }

  if (template.includes('{last_message}')) {
    return typeof variables?.last_message === 'string' && variables.last_message.trim().length > 0;
  }

  return true;
};

const ZEN_DEFAULT_MODEL = 'gpt-5-nano';

/**
 * Validated fallback zen model determined at startup by checking available free
 * models from the zen API. When `null`, startup validation hasn't run yet (or
 * failed), so `resolveZenModel` falls back to `ZEN_DEFAULT_MODEL`.
 */
let validatedZenFallback = null;

/** Cached free zen models response and timestamp (shared by startup + endpoint). */
let cachedZenModels = null;
let cachedZenModelsTimestamp = 0;
const ZEN_MODELS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch free models from the zen API with caching. Returns an array of
 * `{ id, owned_by }` objects (may be empty on failure). Results are cached
 * for `ZEN_MODELS_CACHE_TTL` ms.
 */
const fetchFreeZenModels = async () => {
  const now = Date.now();
  if (cachedZenModels && now - cachedZenModelsTimestamp < ZEN_MODELS_CACHE_TTL) {
    return cachedZenModels.models;
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), 8000) : null;
  try {
    const response = await fetch('https://opencode.ai/zen/v1/models', {
      signal: controller?.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`zen/v1/models responded with status ${response.status}`);
    }
    const data = await response.json();
    const allModels = Array.isArray(data?.data) ? data.data : [];
    const freeModels = allModels
      .filter((m) => typeof m?.id === 'string' && m.id.endsWith('-free'))
      .map((m) => ({ id: m.id, owned_by: m.owned_by }));

    cachedZenModels = { models: freeModels };
    cachedZenModelsTimestamp = Date.now();
    return freeModels;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

/**
 * Resolve the zen model to use. Checks the provided override first,
 * then falls back to the stored zenModel setting, then to the validated
 * startup fallback, then to the hardcoded default.
 */
const resolveZenModel = async (override) => {
  if (typeof override === 'string' && override.trim().length > 0) {
    return override.trim();
  }
  try {
    const settings = await readSettingsFromDisk();
    if (typeof settings?.zenModel === 'string' && settings.zenModel.trim().length > 0) {
      return settings.zenModel.trim();
    }
  } catch {
    // ignore
  }
  return validatedZenFallback || ZEN_DEFAULT_MODEL;
};

const validateZenModelAtStartup = async () => {
  try {
    const freeModels = await fetchFreeZenModels();
    const freeModelIds = freeModels.map((m) => m.id);

    if (freeModelIds.length > 0) {
      validatedZenFallback = freeModelIds[0];

      const settings = await readSettingsFromDisk();
      const storedModel = typeof settings?.zenModel === 'string' ? settings.zenModel.trim() : '';

      if (!storedModel || !freeModelIds.includes(storedModel)) {
        const fallback = freeModelIds[0];
        console.log(
          storedModel
            ? `[zen] Stored model "${storedModel}" not found in free models, falling back to "${fallback}"`
            : `[zen] No model configured, setting default to "${fallback}"`
        );
        await persistSettings({ zenModel: fallback });
      } else {
        console.log(`[zen] Stored model "${storedModel}" verified as available`);
      }
    } else {
      console.warn('[zen] No free models returned from API, skipping validation');
    }
  } catch (error) {
    console.warn('[zen] Startup model validation failed (non-blocking):', error?.message || error);
  }
};


const summarizeText = async (text, targetLength, zenModel) => {
  if (!text || typeof text !== 'string' || text.trim().length === 0) return text;

  try {
    const prompt = `Summarize the following text in approximately ${targetLength} characters. Be concise and capture the key point. Output ONLY the summary text, nothing else.\n\nText:\n${text}`;

    const completionTimeout = createTimeoutSignal(15000);
    let response;
    try {
      response = await fetch('https://opencode.ai/zen/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: zenModel || ZEN_DEFAULT_MODEL,
          input: [{ role: 'user', content: prompt }],
          max_output_tokens: 1000,
          stream: false,
          reasoning: { effort: 'low' },
        }),
        signal: completionTimeout.signal,
      });
    } finally {
      completionTimeout.cleanup();
    }

    if (!response.ok) return text;

    const data = await response.json();
    const summary = data?.output?.find((item) => item?.type === 'message')
      ?.content?.find((item) => item?.type === 'output_text')?.text?.trim();

    return summary || text;
  } catch {
    return text;
  }
};

const NOTIFICATION_BODY_MAX_CHARS = 1000;

/**
 * Extract text from parts array (used when parts are available inline or fetched from API).
 */
const extractTextFromParts = (parts, maxLength = NOTIFICATION_BODY_MAX_CHARS) => {
  if (!Array.isArray(parts) || parts.length === 0) return '';

  const textParts = parts
    .filter((p) => p && (p.type === 'text' || typeof p.text === 'string' || typeof p.content === 'string'))
    .map((p) => p.text || p.content || '')
    .filter(Boolean);

  let text = textParts.length > 0 ? textParts.join('\n').trim() : '';

  // Truncate to prevent oversized notification payloads
  if (maxLength > 0 && text.length > maxLength) {
    text = text.slice(0, maxLength);
  }

  return text;
};

/**
 * Try to extract message text from the payload itself (fast path).
 * Note: message.updated events from the OpenCode SSE stream typically do NOT include
 * parts inline — parts are sent via separate message.part.updated events. This function
 * is a fast path for the rare case where parts are included.
 */
const extractLastMessageText = (payload, maxLength = NOTIFICATION_BODY_MAX_CHARS) => {
  const info = payload?.properties?.info;
  if (!info) return '';

  // Try inline parts on info or on properties
  const parts = info.parts || payload?.properties?.parts;
  const text = extractTextFromParts(parts, maxLength);
  if (text) return text;

  // Fallback: try content array (legacy)
  const content = info.content;
  if (Array.isArray(content)) {
    const textContent = content
      .filter((c) => c && (c.type === 'text' || typeof c.text === 'string'))
      .map((c) => c.text || '')
      .filter(Boolean);
    if (textContent.length > 0) {
      let result = textContent.join('\n').trim();
      if (maxLength > 0 && result.length > maxLength) {
        result = result.slice(0, maxLength);
      }
      return result;
    }
  }

  return '';
};

/**
 * Fetch the last assistant message text from the OpenCode API.
 * This is needed because message.updated events don't include parts;
 * we must fetch them separately via the session messages endpoint.
 */
const fetchLastAssistantMessageText = async (sessionId, messageId, maxLength = NOTIFICATION_BODY_MAX_CHARS) => {
  if (!sessionId) return '';

  try {
    // Fetch last few messages to find the one that triggered the notification
    const url = buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}/message`, '');
    const response = await fetch(`${url}?limit=5`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) return '';

    const messages = await response.json().catch(() => null);
    if (!Array.isArray(messages)) return '';

    // Find the specific message by ID, or fall back to the last assistant message
    let target = null;
    if (messageId) {
      target = messages.find((m) => m?.info?.id === messageId && m?.info?.role === 'assistant');
    }
    if (!target) {
      // Find the last assistant message with finish === 'stop'
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.info?.role === 'assistant' && m?.info?.finish === 'stop') {
          target = m;
          break;
        }
      }
    }

    if (!target || !Array.isArray(target.parts)) return '';

    return extractTextFromParts(target.parts, maxLength);
  } catch {
    return '';
  }
};

/**
 * In-memory cache of session titles populated from SSE session.updated / session.created events.
 * This is the preferred source for session titles since it is populated passively and doesn't
 * require a separate API call.
 */
const sessionTitleCache = new Map();

const cacheSessionTitle = (sessionId, title) => {
  if (typeof sessionId === 'string' && sessionId.length > 0 &&
      typeof title === 'string' && title.length > 0) {
    sessionTitleCache.set(sessionId, title);
  }
};

const getCachedSessionTitle = (sessionId) => {
  return sessionTitleCache.get(sessionId) ?? null;
};

/**
 * Extract and cache session title from session.updated / session.created SSE events.
 * Called by the global event watcher to passively maintain the title cache.
 */
const maybeCacheSessionInfoFromEvent = (payload) => {
  if (!payload || typeof payload !== 'object') return;
  const type = payload.type;
  if (type !== 'session.updated' && type !== 'session.created') return;
  const info = payload.properties?.info;
  if (!info || typeof info !== 'object') return;
  const sessionId = info.id;
  const title = info.title;
  cacheSessionTitle(sessionId, title);
  // Also cache parentID from session events to ensure subtask detection works correctly
  const parentID = info.parentID;
  if (sessionId && parentID !== undefined) {
    setCachedSessionParentId(sessionId, parentID);
  }
};

/**
 * Fetch session metadata (title, directory) from the OpenCode API.
 * Cached for 60s per session to avoid repeated API calls.
 */
const sessionInfoCache = new Map();
const SESSION_INFO_CACHE_TTL_MS = 60 * 1000;

const fetchSessionInfo = async (sessionId) => {
  if (!sessionId) return null;

  const cached = sessionInfoCache.get(sessionId);
  if (cached && Date.now() - cached.at < SESSION_INFO_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const url = buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}`, '');
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      console.warn(`[Notification] fetchSessionInfo: ${response.status} for session ${sessionId}`);
      return null;
    }
    const data = await response.json().catch(() => null);
    if (data && typeof data === 'object') {
      sessionInfoCache.set(sessionId, { data, at: Date.now() });
      return data;
    }
    return null;
  } catch (err) {
    console.warn(`[Notification] fetchSessionInfo failed for ${sessionId}:`, err?.message || err);
    return null;
  }
};

const buildTemplateVariables = async (payload, sessionId) => {
  const info = payload?.properties?.info || {};

  // Session title — try inline payload, then SSE cache, then API fetch
  let sessionTitle = payload?.properties?.sessionTitle ||
    payload?.properties?.session?.title ||
    (typeof info.sessionTitle === 'string' ? info.sessionTitle : '') ||
    '';

  // Try the SSE-populated session title cache (filled from session.updated / session.created events)
  if (!sessionTitle && sessionId) {
    const cached = getCachedSessionTitle(sessionId);
    if (cached) {
      sessionTitle = cached;
    }
  }

  // Last resort: fetch session info from the API
  let sessionInfo = null;
  if (!sessionTitle && sessionId) {
    sessionInfo = await fetchSessionInfo(sessionId);
    if (sessionInfo && typeof sessionInfo.title === 'string') {
      sessionTitle = sessionInfo.title;
      // Populate the SSE cache so future notifications don't need an API call
      cacheSessionTitle(sessionId, sessionTitle);
    }
  }

  // Agent name from mode or agent field (v2 has both mode and agent)
  const agentName = (() => {
    const mode = typeof info.agent === 'string' && info.agent.trim().length > 0
      ? info.agent.trim()
      : (typeof info.mode === 'string' ? info.mode.trim() : '');
    if (!mode) return 'Agent';
    return mode.split(/[-_\s]+/).filter(Boolean)
      .map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(' ');
  })();

  // Model name — v2 has modelID directly on info, v1 user messages nest it under info.model.modelID
  const modelName = (() => {
    const raw = typeof info.modelID === 'string' ? info.modelID.trim()
      : (typeof info.model?.modelID === 'string' ? info.model.modelID.trim() : '');
    if (!raw) return 'Assistant';
    return raw.split(/[-_]+/).filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  })();

  // Project name, branch, worktree — derived from multiple sources with fallbacks
  let projectName = '';
  let branch = '';
  let worktreeDir = '';

  // 1. Primary source: the message payload's path (always accurate for the session)
  const infoPath = info.path;
  if (typeof infoPath?.root === 'string' && infoPath.root.length > 0) {
    worktreeDir = infoPath.root;
  } else if (typeof infoPath?.cwd === 'string' && infoPath.cwd.length > 0) {
    worktreeDir = infoPath.cwd;
  }

  // 2. Look up the user-facing project label from stored settings
  try {
    const settings = await readSettingsFromDisk();
    const projects = Array.isArray(settings.projects) ? settings.projects : [];

    if (worktreeDir) {
      // Match the session directory against stored projects to find the label
      const normalizedDir = worktreeDir.replace(/\/+$/, '');
      const matchedProject = projects.find((p) => {
        if (!p || typeof p.path !== 'string') return false;
        return p.path.replace(/\/+$/, '') === normalizedDir;
      });
      if (matchedProject && typeof matchedProject.label === 'string' && matchedProject.label.trim().length > 0) {
        projectName = matchedProject.label.trim();
      } else {
        // No label stored — derive from directory name
        projectName = normalizedDir.split('/').filter(Boolean).pop() || '';
      }
    } else {
      // No directory from payload — fall back to active project
      const activeId = typeof settings.activeProjectId === 'string' ? settings.activeProjectId : '';
      const activeProject = activeId ? projects.find((p) => p && p.id === activeId) : projects[0];
      if (activeProject) {
        projectName = typeof activeProject.label === 'string' && activeProject.label.trim().length > 0
          ? activeProject.label.trim()
          : typeof activeProject.path === 'string'
            ? activeProject.path.split('/').pop() || ''
            : '';
        worktreeDir = typeof activeProject.path === 'string' ? activeProject.path : '';
      }
    }
  } catch {
    // Settings read failed — derive from directory if available
    if (worktreeDir && !projectName) {
      projectName = worktreeDir.split('/').filter(Boolean).pop() || '';
    }
  }

  // 3. Get branch from git
  if (worktreeDir) {
    try {
      const { simpleGit } = await import('simple-git');
      const git = simpleGit({
        baseDir: worktreeDir,
        spawnOptions: { windowsHide: true },
        binary: resolveGitBinaryForSpawn(),
      });
      branch = await Promise.race([
        git.revparse(['--abbrev-ref', 'HEAD']),
        new Promise((_, reject) => setTimeout(() => reject(new Error('git timeout')), 3000)),
      ]).catch(() => '');
    } catch {
      // ignore — git may not be available
    }
  }

  return {
    project_name: formatProjectLabel(projectName),
    worktree: worktreeDir,
    branch: typeof branch === 'string' ? branch.trim() : '',
    session_name: sessionTitle,
    agent_name: agentName,
    model_name: modelName,
    last_message: '', // Populated by caller
    session_id: sessionId || '',
  };
};

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');
const SETTINGS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'settings.json');
const PUSH_SUBSCRIPTIONS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'push-subscriptions.json');
const CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'cloudflare-managed-remote-tunnels.json');
const CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'cloudflare-named-tunnels.json');
const CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION = 1;
const PROJECT_ICONS_DIR_PATH = path.join(OPENCHAMBER_DATA_DIR, 'project-icons');
const PROJECT_ICON_MIME_TO_EXTENSION = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
};
const PROJECT_ICON_EXTENSION_TO_MIME = Object.fromEntries(
  Object.entries(PROJECT_ICON_MIME_TO_EXTENSION).map(([mime, ext]) => [ext, mime])
);
const PROJECT_ICON_SUPPORTED_MIMES = new Set(Object.keys(PROJECT_ICON_MIME_TO_EXTENSION));
const PROJECT_ICON_MAX_BYTES = 5 * 1024 * 1024;
const PROJECT_ICON_THEME_COLORS = {
  light: '#111111',
  dark: '#f5f5f5',
};
const PROJECT_ICON_HEX_COLOR_PATTERN = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{4}|[\da-fA-F]{6}|[\da-fA-F]{8})$/;

const normalizeProjectIconMime = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'image/jpg') {
    return 'image/jpeg';
  }
  if (PROJECT_ICON_SUPPORTED_MIMES.has(normalized)) {
    return normalized;
  }
  return null;
};

const projectIconBaseName = (projectId) => {
  const hash = crypto.createHash('sha1').update(projectId).digest('hex');
  return `project-${hash}`;
};

const projectIconPathForMime = (projectId, mime) => {
  const normalizedMime = normalizeProjectIconMime(mime);
  if (!normalizedMime) {
    return null;
  }
  const ext = PROJECT_ICON_MIME_TO_EXTENSION[normalizedMime];
  return path.join(PROJECT_ICONS_DIR_PATH, `${projectIconBaseName(projectId)}.${ext}`);
};

const projectIconPathCandidates = (projectId) => {
  const base = projectIconBaseName(projectId);
  return Object.values(PROJECT_ICON_MIME_TO_EXTENSION).map((ext) => path.join(PROJECT_ICONS_DIR_PATH, `${base}.${ext}`));
};

const removeProjectIconFiles = async (projectId, keepPath) => {
  const candidates = projectIconPathCandidates(projectId);
  await Promise.all(candidates.map(async (candidatePath) => {
    if (keepPath && candidatePath === keepPath) {
      return;
    }
    try {
      await fsPromises.unlink(candidatePath);
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }));
};

const parseProjectIconDataUrl = (value) => {
  if (typeof value !== 'string') {
    return { ok: false, error: 'dataUrl is required' };
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    return { ok: false, error: 'Invalid dataUrl format' };
  }

  const mime = normalizeProjectIconMime(match[1]);
  if (!mime || !['image/png', 'image/jpeg', 'image/svg+xml'].includes(mime)) {
    return { ok: false, error: 'Icon must be PNG, JPEG, or SVG' };
  }

  try {
    const base64 = match[2].replace(/\s+/g, '');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length === 0) {
      return { ok: false, error: 'Icon content is empty' };
    }
    if (bytes.length > PROJECT_ICON_MAX_BYTES) {
      return { ok: false, error: 'Icon exceeds size limit (5 MB)' };
    }
    return { ok: true, mime, bytes };
  } catch {
    return { ok: false, error: 'Failed to decode icon data' };
  }
};

const normalizeProjectIconThemeVariant = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'light' || normalized === 'dark') {
    return normalized;
  }
  return null;
};

const normalizeProjectIconColor = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (!PROJECT_ICON_HEX_COLOR_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
};

const applyProjectIconSvgTheme = (svgMarkup, themeVariant, iconColor) => {
  if (typeof svgMarkup !== 'string') {
    return svgMarkup;
  }

  const color = iconColor || PROJECT_ICON_THEME_COLORS[themeVariant];
  if (!color) {
    return svgMarkup;
  }

  const svgTagIndex = svgMarkup.search(/<svg\b/i);
  if (svgTagIndex === -1) {
    return svgMarkup;
  }

  const svgOpenTagEndIndex = svgMarkup.indexOf('>', svgTagIndex);
  if (svgOpenTagEndIndex === -1) {
    return svgMarkup;
  }

  const overrideStyle = `<style data-openchamber-theme-icon="1">:root{color:${color}!important;}</style>`;
  return `${svgMarkup.slice(0, svgOpenTagEndIndex + 1)}${overrideStyle}${svgMarkup.slice(svgOpenTagEndIndex + 1)}`;
};

const findProjectById = (settings, projectId) => {
  const projects = sanitizeProjects(settings?.projects) || [];
  const index = projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    return { projects, index: -1, project: null };
  }
  return { projects, index, project: projects[index] };
};

const readSettingsFromDisk = async () => {
  try {
    const raw = await fsPromises.readFile(SETTINGS_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
    return {};
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return {};
    }
    console.warn('Failed to read settings file:', error);
    return {};
  }
};

const writeSettingsToDisk = async (settings) => {
  try {
    await fsPromises.mkdir(path.dirname(SETTINGS_FILE_PATH), { recursive: true });
    await fsPromises.writeFile(SETTINGS_FILE_PATH, JSON.stringify(settings, null, 2), 'utf8');
  } catch (error) {
    console.warn('Failed to write settings file:', error);
    throw error;
  }
};

const PUSH_SUBSCRIPTIONS_VERSION = 1;
let persistPushSubscriptionsLock = Promise.resolve();
let persistManagedRemoteTunnelConfigLock = Promise.resolve();

const readPushSubscriptionsFromDisk = async () => {
  try {
    const raw = await fsPromises.readFile(PUSH_SUBSCRIPTIONS_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
    }
    if (typeof parsed.version !== 'number' || parsed.version !== PUSH_SUBSCRIPTIONS_VERSION) {
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
    }

    const subscriptionsBySession =
      parsed.subscriptionsBySession && typeof parsed.subscriptionsBySession === 'object'
        ? parsed.subscriptionsBySession
        : {};

    return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
    }
    console.warn('Failed to read push subscriptions file:', error);
    return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
  }
};

const writePushSubscriptionsToDisk = async (data) => {
  await fsPromises.mkdir(path.dirname(PUSH_SUBSCRIPTIONS_FILE_PATH), { recursive: true });
  await fsPromises.writeFile(PUSH_SUBSCRIPTIONS_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
};

const persistPushSubscriptionUpdate = async (mutate) => {
  persistPushSubscriptionsLock = persistPushSubscriptionsLock.then(async () => {
    await fsPromises.mkdir(path.dirname(PUSH_SUBSCRIPTIONS_FILE_PATH), { recursive: true });
    const current = await readPushSubscriptionsFromDisk();
    const next = mutate({
      version: PUSH_SUBSCRIPTIONS_VERSION,
      subscriptionsBySession: current.subscriptionsBySession || {},
    });
    await writePushSubscriptionsToDisk(next);
    return next;
  });

  return persistPushSubscriptionsLock;
};

const sanitizeManagedRemoteTunnelConfigEntries = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  const result = [];
  const seenIds = new Set();
  const seenHostnames = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const hostname = normalizeManagedRemoteTunnelHostname(entry.hostname);
    const token = typeof entry.token === 'string' ? entry.token.trim() : '';
    const updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now();

    if (!id || !name || !hostname || !token) {
      continue;
    }
    if (seenIds.has(id) || seenHostnames.has(hostname)) {
      continue;
    }

    seenIds.add(id);
    seenHostnames.add(hostname);
    result.push({ id, name, hostname, token, updatedAt });
  }

  return result;
};

const migrateManagedRemoteTunnelConfigFromLegacyFile = async () => {
  try {
    const legacyRaw = await fsPromises.readFile(CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH, 'utf8');
    const parsed = JSON.parse(legacyRaw);
    const tunnels = sanitizeManagedRemoteTunnelConfigEntries(parsed?.tunnels);
    const migrated = {
      version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
      tunnels,
    };
    await writeManagedRemoteTunnelConfigToDisk(migrated);
    return migrated;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
    }
    console.warn('Failed to migrate legacy named tunnel config file:', error);
    return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
  }
};

const readManagedRemoteTunnelConfigFromDisk = async () => {
  try {
    const raw = await fsPromises.readFile(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
    }

    const version = parsed.version === CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION
      ? CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION
      : CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION;

    return {
      version,
      tunnels: sanitizeManagedRemoteTunnelConfigEntries(parsed.tunnels),
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return migrateManagedRemoteTunnelConfigFromLegacyFile();
    }
    console.warn('Failed to read managed remote tunnel config file:', error);
    return { version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION, tunnels: [] };
  }
};

const writeManagedRemoteTunnelConfigToDisk = async (data) => {
  await fsPromises.mkdir(path.dirname(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH), { recursive: true });
  await fsPromises.writeFile(CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
};

const updateManagedRemoteTunnelConfig = async (mutate) => {
  persistManagedRemoteTunnelConfigLock = persistManagedRemoteTunnelConfigLock.then(async () => {
    const current = await readManagedRemoteTunnelConfigFromDisk();
    const next = mutate({
      version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
      tunnels: sanitizeManagedRemoteTunnelConfigEntries(current.tunnels),
    });

    await writeManagedRemoteTunnelConfigToDisk({
      version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
      tunnels: sanitizeManagedRemoteTunnelConfigEntries(next?.tunnels),
    });
  });

  return persistManagedRemoteTunnelConfigLock;
};

const syncManagedRemoteTunnelConfigWithPresets = async (presets) => {
  const sanitizedPresets = normalizeManagedRemoteTunnelPresets(presets) || [];

  await updateManagedRemoteTunnelConfig((current) => {
    const byId = new Map(current.tunnels.map((entry) => [entry.id, entry]));
    const byHostname = new Map(current.tunnels.map((entry) => [entry.hostname, entry]));

    const nextTunnels = [];
    for (const preset of sanitizedPresets) {
      const existing = byId.get(preset.id) || byHostname.get(preset.hostname) || null;
      if (!existing) {
        continue;
      }

      nextTunnels.push({
        ...existing,
        id: preset.id,
        name: preset.name,
        hostname: preset.hostname,
      });
    }

    return {
      version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
      tunnels: nextTunnels,
    };
  });
};

const upsertManagedRemoteTunnelToken = async ({ id, name, hostname, token }) => {
  if (typeof id !== 'string' || typeof name !== 'string' || typeof hostname !== 'string' || typeof token !== 'string') {
    return;
  }
  const normalizedId = id.trim();
  const normalizedName = name.trim();
  const normalizedHostname = normalizeManagedRemoteTunnelHostname(hostname);
  const normalizedToken = token.trim();
  if (!normalizedId || !normalizedName || !normalizedHostname || !normalizedToken) {
    return;
  }

  await updateManagedRemoteTunnelConfig((current) => {
    const withoutConflicts = current.tunnels.filter((entry) => entry.id !== normalizedId && entry.hostname !== normalizedHostname);
    withoutConflicts.push({
      id: normalizedId,
      name: normalizedName,
      hostname: normalizedHostname,
      token: normalizedToken,
      updatedAt: Date.now(),
    });

    return {
      version: CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
      tunnels: withoutConflicts,
    };
  });
};

const resolveManagedRemoteTunnelToken = async ({ presetId, hostname }) => {
  const normalizedPresetId = typeof presetId === 'string' ? presetId.trim() : '';
  const normalizedHostname = normalizeManagedRemoteTunnelHostname(hostname);
  const config = await readManagedRemoteTunnelConfigFromDisk();

  if (normalizedPresetId) {
    const byId = config.tunnels.find((entry) => entry.id === normalizedPresetId);
    if (byId?.token) {
      return byId.token;
    }
  }

  if (normalizedHostname) {
    const byHostname = config.tunnels.find((entry) => entry.hostname === normalizedHostname);
    if (byHostname?.token) {
      return byHostname.token;
    }
  }

  return '';
};

const resolveDirectoryCandidate = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = normalizeDirectoryPath(trimmed);
  return path.resolve(normalized);
};

const validateDirectoryPath = async (candidate) => {
  const resolved = resolveDirectoryCandidate(candidate);
  if (!resolved) {
    return { ok: false, error: 'Directory parameter is required' };
  }
  try {
    const stats = await fsPromises.stat(resolved);
    if (!stats.isDirectory()) {
      return { ok: false, error: 'Specified path is not a directory' };
    }
    return { ok: true, directory: resolved };
  } catch (error) {
    const err = error;
    if (err && typeof err === 'object' && err.code === 'ENOENT') {
      return { ok: false, error: 'Directory not found' };
    }
    if (err && typeof err === 'object' && err.code === 'EACCES') {
      return { ok: false, error: 'Access to directory denied' };
    }
    return { ok: false, error: 'Failed to validate directory' };
  }
};

const resolveProjectDirectory = async (req) => {
  const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
  const queryDirectory = Array.isArray(req.query?.directory)
    ? req.query.directory[0]
    : req.query?.directory;
  const requested = headerDirectory || queryDirectory || null;

  if (requested) {
    const validated = await validateDirectoryPath(requested);
    if (!validated.ok) {
      return { directory: null, error: validated.error };
    }
    return { directory: validated.directory, error: null };
  }

  const settings = await readSettingsFromDiskMigrated();
  const projects = sanitizeProjects(settings.projects) || [];
  if (projects.length === 0) {
    return { directory: null, error: 'Directory parameter or active project is required' };
  }

  const activeId = typeof settings.activeProjectId === 'string' ? settings.activeProjectId : '';
  const active = projects.find((project) => project.id === activeId) || projects[0];
  if (!active || !active.path) {
    return { directory: null, error: 'Directory parameter or active project is required' };
  }

  const validated = await validateDirectoryPath(active.path);
  if (!validated.ok) {
    return { directory: null, error: validated.error };
  }

  return { directory: validated.directory, error: null };
};

const isUnsafeSkillRelativePath = (value) => {
  if (typeof value !== 'string' || value.length === 0) {
    return true;
  }

  const normalized = value.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalized)) {
    return true;
  }

  return normalized.split('/').some((segment) => segment === '..');
};

const resolveOptionalProjectDirectory = async (req) => {
  const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
  const queryDirectory = Array.isArray(req.query?.directory)
    ? req.query.directory[0]
    : req.query?.directory;
  const requested = headerDirectory || queryDirectory || null;

  if (!requested) {
    return { directory: null, error: null };
  }

  const validated = await validateDirectoryPath(requested);
  if (!validated.ok) {
    return { directory: null, error: validated.error };
  }

  return { directory: validated.directory, error: null };
};

const sanitizeTypographySizesPartial = (input) => {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const candidate = input;
  const result = {};
  let populated = false;

  const assign = (key) => {
    if (typeof candidate[key] === 'string' && candidate[key].length > 0) {
      result[key] = candidate[key];
      populated = true;
    }
  };

  assign('markdown');
  assign('code');
  assign('uiHeader');
  assign('uiLabel');
  assign('meta');
  assign('micro');

  return populated ? result : undefined;
};

const normalizeStringArray = (input) => {
  if (!Array.isArray(input)) {
    return [];
  }
  return Array.from(
    new Set(
      input.filter((entry) => typeof entry === 'string' && entry.length > 0)
    )
  );
};

const sanitizeModelRefs = (input, limit) => {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const result = [];
  const seen = new Set();

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const providerID = typeof entry.providerID === 'string' ? entry.providerID.trim() : '';
    const modelID = typeof entry.modelID === 'string' ? entry.modelID.trim() : '';
    if (!providerID || !modelID) continue;
    const key = `${providerID}/${modelID}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ providerID, modelID });
    if (result.length >= limit) break;
  }

  return result;
};

const sanitizeSkillCatalogs = (input) => {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const result = [];
  const seen = new Set();

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;

    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    const source = typeof entry.source === 'string' ? entry.source.trim() : '';
    const subpath = typeof entry.subpath === 'string' ? entry.subpath.trim() : '';
    const gitIdentityId = typeof entry.gitIdentityId === 'string' ? entry.gitIdentityId.trim() : '';

    if (!id || !label || !source) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    result.push({
      id,
      label,
      source,
      ...(subpath ? { subpath } : {}),
      ...(gitIdentityId ? { gitIdentityId } : {}),
    });
  }

  return result;
};

const sanitizeProjects = (input) => {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const hexColorPattern = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/;
  const normalizeIconBackground = (value) => {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return hexColorPattern.test(trimmed) ? trimmed.toLowerCase() : null;
  };

  const result = [];
  const seenIds = new Set();
  const seenPaths = new Set();

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;

    const candidate = entry;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const rawPath = typeof candidate.path === 'string' ? candidate.path.trim() : '';
    const resolvedPath = rawPath ? path.resolve(normalizeDirectoryPath(rawPath)) : '';
    const normalizedPath = resolvedPath ? normalizePathForPersistence(resolvedPath) : '';
    const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
    const icon = typeof candidate.icon === 'string' ? candidate.icon.trim() : '';
    const iconImage = candidate.iconImage && typeof candidate.iconImage === 'object'
      ? candidate.iconImage
      : null;
    const iconBackground = normalizeIconBackground(candidate.iconBackground);
    const color = typeof candidate.color === 'string' ? candidate.color.trim() : '';
    const addedAt = Number.isFinite(candidate.addedAt) ? Number(candidate.addedAt) : null;
    const lastOpenedAt = Number.isFinite(candidate.lastOpenedAt)
      ? Number(candidate.lastOpenedAt)
      : null;

    if (!id || !normalizedPath) continue;
    if (seenIds.has(id)) continue;
    if (seenPaths.has(normalizedPath)) continue;

    seenIds.add(id);
    seenPaths.add(normalizedPath);

    const project = {
      id,
      path: normalizedPath,
      ...(label ? { label } : {}),
      ...(icon ? { icon } : {}),
      ...(iconBackground ? { iconBackground } : {}),
      ...(color ? { color } : {}),
      ...(Number.isFinite(addedAt) && addedAt >= 0 ? { addedAt } : {}),
      ...(Number.isFinite(lastOpenedAt) && lastOpenedAt >= 0 ? { lastOpenedAt } : {}),
    };

    if (candidate.iconImage === null) {
      project.iconImage = null;
    } else if (iconImage) {
      const mime = typeof iconImage.mime === 'string' ? iconImage.mime.trim() : '';
      const updatedAt = typeof iconImage.updatedAt === 'number' && Number.isFinite(iconImage.updatedAt)
        ? Math.max(0, Math.round(iconImage.updatedAt))
        : 0;
      const source = iconImage.source === 'custom' || iconImage.source === 'auto'
        ? iconImage.source
        : null;
      if (mime && updatedAt > 0 && source) {
        project.iconImage = { mime, updatedAt, source };
      }
    }

    if (candidate.iconBackground === null) {
      project.iconBackground = null;
    }

    if (typeof candidate.sidebarCollapsed === 'boolean') {
      project.sidebarCollapsed = candidate.sidebarCollapsed;
    }

    result.push(project);
  }

  return result;
};

const DEFAULT_PWA_APP_NAME = 'OpenChamber - AI Coding Assistant';
const PWA_APP_NAME_MAX_LENGTH = 64;

const normalizePwaAppName = (value, fallback = '') => {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return fallback;
  }
  return normalized.slice(0, PWA_APP_NAME_MAX_LENGTH);
};

const sanitizeSettingsUpdate = (payload) => {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  const candidate = payload;
  const result = {};

  if (typeof candidate.themeId === 'string' && candidate.themeId.length > 0) {
    result.themeId = candidate.themeId;
  }
  if (typeof candidate.themeVariant === 'string' && (candidate.themeVariant === 'light' || candidate.themeVariant === 'dark')) {
    result.themeVariant = candidate.themeVariant;
  }
  if (typeof candidate.useSystemTheme === 'boolean') {
    result.useSystemTheme = candidate.useSystemTheme;
  }
  if (typeof candidate.lightThemeId === 'string' && candidate.lightThemeId.length > 0) {
    result.lightThemeId = candidate.lightThemeId;
  }
  if (typeof candidate.darkThemeId === 'string' && candidate.darkThemeId.length > 0) {
    result.darkThemeId = candidate.darkThemeId;
  }
  if (typeof candidate.splashBgLight === 'string' && candidate.splashBgLight.trim().length > 0) {
    result.splashBgLight = candidate.splashBgLight.trim();
  }
  if (typeof candidate.splashFgLight === 'string' && candidate.splashFgLight.trim().length > 0) {
    result.splashFgLight = candidate.splashFgLight.trim();
  }
  if (typeof candidate.splashBgDark === 'string' && candidate.splashBgDark.trim().length > 0) {
    result.splashBgDark = candidate.splashBgDark.trim();
  }
  if (typeof candidate.splashFgDark === 'string' && candidate.splashFgDark.trim().length > 0) {
    result.splashFgDark = candidate.splashFgDark.trim();
  }
  if (typeof candidate.lastDirectory === 'string' && candidate.lastDirectory.length > 0) {
    const normalized = normalizePathForPersistence(candidate.lastDirectory);
    if (typeof normalized === 'string' && normalized.length > 0) {
      result.lastDirectory = normalized;
    }
  }
  if (typeof candidate.homeDirectory === 'string' && candidate.homeDirectory.length > 0) {
    const normalized = normalizePathForPersistence(candidate.homeDirectory);
    if (typeof normalized === 'string' && normalized.length > 0) {
      result.homeDirectory = normalized;
    }
  }

  // Absolute path to the opencode CLI binary (optional override).
  // Accept empty-string to clear (we persist an empty string sentinel so the running
  // process can reliably drop a previously applied OPENCODE_BINARY override).
  if (typeof candidate.opencodeBinary === 'string') {
    const normalized = normalizeDirectoryPath(candidate.opencodeBinary).trim();
    result.opencodeBinary = normalized;
  }
  if (Array.isArray(candidate.projects)) {
    const projects = sanitizeProjects(candidate.projects);
    if (projects) {
      result.projects = projects;
    }
  }
  if (typeof candidate.activeProjectId === 'string' && candidate.activeProjectId.length > 0) {
    result.activeProjectId = candidate.activeProjectId;
  }

  if (Array.isArray(candidate.approvedDirectories)) {
    result.approvedDirectories = normalizeStringArray(
      candidate.approvedDirectories
        .map((entry) => (typeof entry === 'string' ? normalizePathForPersistence(entry) : entry))
        .filter((entry) => typeof entry === 'string' && entry.length > 0)
    );
  }
  if (Array.isArray(candidate.securityScopedBookmarks)) {
    result.securityScopedBookmarks = normalizeStringArray(candidate.securityScopedBookmarks);
  }
  if (Array.isArray(candidate.pinnedDirectories)) {
    result.pinnedDirectories = normalizeStringArray(
      candidate.pinnedDirectories
        .map((entry) => (typeof entry === 'string' ? normalizePathForPersistence(entry) : entry))
        .filter((entry) => typeof entry === 'string' && entry.length > 0)
    );
  }


  if (typeof candidate.uiFont === 'string' && candidate.uiFont.length > 0) {
    result.uiFont = candidate.uiFont;
  }
  if (typeof candidate.monoFont === 'string' && candidate.monoFont.length > 0) {
    result.monoFont = candidate.monoFont;
  }
  if (typeof candidate.markdownDisplayMode === 'string' && candidate.markdownDisplayMode.length > 0) {
    result.markdownDisplayMode = candidate.markdownDisplayMode;
  }
  if (typeof candidate.githubClientId === 'string') {
    const trimmed = candidate.githubClientId.trim();
    if (trimmed.length > 0) {
      result.githubClientId = trimmed;
    }
  }
  if (typeof candidate.githubScopes === 'string') {
    const trimmed = candidate.githubScopes.trim();
    if (trimmed.length > 0) {
      result.githubScopes = trimmed;
    }
  }
  if (typeof candidate.showReasoningTraces === 'boolean') {
    result.showReasoningTraces = candidate.showReasoningTraces;
  }
  if (typeof candidate.showTextJustificationActivity === 'boolean') {
    result.showTextJustificationActivity = candidate.showTextJustificationActivity;
  }
  if (typeof candidate.showDeletionDialog === 'boolean') {
    result.showDeletionDialog = candidate.showDeletionDialog;
  }
  if (typeof candidate.nativeNotificationsEnabled === 'boolean') {
    result.nativeNotificationsEnabled = candidate.nativeNotificationsEnabled;
  }
  if (typeof candidate.notificationMode === 'string') {
    const mode = candidate.notificationMode.trim();
    if (mode === 'always' || mode === 'hidden-only') {
      result.notificationMode = mode;
    }
  }
  if (typeof candidate.notifyOnSubtasks === 'boolean') {
    result.notifyOnSubtasks = candidate.notifyOnSubtasks;
  }
  if (typeof candidate.notifyOnCompletion === 'boolean') {
    result.notifyOnCompletion = candidate.notifyOnCompletion;
  }
  if (typeof candidate.notifyOnError === 'boolean') {
    result.notifyOnError = candidate.notifyOnError;
  }
  if (typeof candidate.notifyOnQuestion === 'boolean') {
    result.notifyOnQuestion = candidate.notifyOnQuestion;
  }
  if (candidate.notificationTemplates && typeof candidate.notificationTemplates === 'object') {
    result.notificationTemplates = candidate.notificationTemplates;
  }
  if (typeof candidate.summarizeLastMessage === 'boolean') {
    result.summarizeLastMessage = candidate.summarizeLastMessage;
  }
  if (typeof candidate.summaryThreshold === 'number' && Number.isFinite(candidate.summaryThreshold)) {
    result.summaryThreshold = Math.max(0, Math.round(candidate.summaryThreshold));
  }
  if (typeof candidate.summaryLength === 'number' && Number.isFinite(candidate.summaryLength)) {
    result.summaryLength = Math.max(10, Math.round(candidate.summaryLength));
  }
  if (typeof candidate.maxLastMessageLength === 'number' && Number.isFinite(candidate.maxLastMessageLength)) {
    result.maxLastMessageLength = Math.max(10, Math.round(candidate.maxLastMessageLength));
  }
  if (typeof candidate.usageAutoRefresh === 'boolean') {
    result.usageAutoRefresh = candidate.usageAutoRefresh;
  }
  if (typeof candidate.usageRefreshIntervalMs === 'number' && Number.isFinite(candidate.usageRefreshIntervalMs)) {
    result.usageRefreshIntervalMs = Math.max(30000, Math.min(300000, Math.round(candidate.usageRefreshIntervalMs)));
  }
  if (candidate.usageDisplayMode === 'usage' || candidate.usageDisplayMode === 'remaining') {
    result.usageDisplayMode = candidate.usageDisplayMode;
  }
  if (Array.isArray(candidate.usageDropdownProviders)) {
    result.usageDropdownProviders = normalizeStringArray(candidate.usageDropdownProviders);
  }
  if (typeof candidate.autoDeleteEnabled === 'boolean') {
    result.autoDeleteEnabled = candidate.autoDeleteEnabled;
  }
  if (typeof candidate.autoDeleteAfterDays === 'number' && Number.isFinite(candidate.autoDeleteAfterDays)) {
    const normalizedDays = Math.max(1, Math.min(365, Math.round(candidate.autoDeleteAfterDays)));
    result.autoDeleteAfterDays = normalizedDays;
  }
  if (candidate.tunnelBootstrapTtlMs === null) {
    result.tunnelBootstrapTtlMs = null;
  } else if (typeof candidate.tunnelBootstrapTtlMs === 'number' && Number.isFinite(candidate.tunnelBootstrapTtlMs)) {
    result.tunnelBootstrapTtlMs = normalizeTunnelBootstrapTtlMs(candidate.tunnelBootstrapTtlMs);
  }
  if (typeof candidate.tunnelSessionTtlMs === 'number' && Number.isFinite(candidate.tunnelSessionTtlMs)) {
    result.tunnelSessionTtlMs = normalizeTunnelSessionTtlMs(candidate.tunnelSessionTtlMs);
  }
  if (typeof candidate.tunnelProvider === 'string') {
    const provider = normalizeTunnelProvider(candidate.tunnelProvider);
    if (provider) {
      result.tunnelProvider = provider;
    }
  }
  if (typeof candidate.tunnelMode === 'string') {
    result.tunnelMode = normalizeTunnelMode(candidate.tunnelMode);
  }
  if (candidate.managedLocalTunnelConfigPath === null) {
    result.managedLocalTunnelConfigPath = null;
  } else if (typeof candidate.managedLocalTunnelConfigPath === 'string') {
    const trimmed = candidate.managedLocalTunnelConfigPath.trim();
    result.managedLocalTunnelConfigPath = trimmed.length > 0 ? normalizeOptionalPath(trimmed) : null;
  }
  if (typeof candidate.managedRemoteTunnelHostname === 'string') {
    const hostname = normalizeManagedRemoteTunnelHostname(candidate.managedRemoteTunnelHostname);
    result.managedRemoteTunnelHostname = hostname;
  }
  if (candidate.managedRemoteTunnelToken === null) {
    result.managedRemoteTunnelToken = null;
  } else if (typeof candidate.managedRemoteTunnelToken === 'string') {
    result.managedRemoteTunnelToken = candidate.managedRemoteTunnelToken.trim();
  }
  const managedRemoteTunnelPresets = normalizeManagedRemoteTunnelPresets(candidate.managedRemoteTunnelPresets);
  if (managedRemoteTunnelPresets) {
    result.managedRemoteTunnelPresets = managedRemoteTunnelPresets;
  }
  const managedRemoteTunnelPresetTokens = normalizeManagedRemoteTunnelPresetTokens(candidate.managedRemoteTunnelPresetTokens);
  if (managedRemoteTunnelPresetTokens) {
    result.managedRemoteTunnelPresetTokens = managedRemoteTunnelPresetTokens;
  }
  if (typeof candidate.managedRemoteTunnelSelectedPresetId === 'string') {
    const id = candidate.managedRemoteTunnelSelectedPresetId.trim();
    result.managedRemoteTunnelSelectedPresetId = id || undefined;
  }

  const typography = sanitizeTypographySizesPartial(candidate.typographySizes);
  if (typography) {
    result.typographySizes = typography;
  }

  if (typeof candidate.defaultModel === 'string') {
    const trimmed = candidate.defaultModel.trim();
    result.defaultModel = trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof candidate.defaultVariant === 'string') {
    const trimmed = candidate.defaultVariant.trim();
    result.defaultVariant = trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof candidate.defaultAgent === 'string') {
    const trimmed = candidate.defaultAgent.trim();
    result.defaultAgent = trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof candidate.defaultGitIdentityId === 'string') {
    const trimmed = candidate.defaultGitIdentityId.trim();
    result.defaultGitIdentityId = trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof candidate.queueModeEnabled === 'boolean') {
    result.queueModeEnabled = candidate.queueModeEnabled;
  }
  if (typeof candidate.autoCreateWorktree === 'boolean') {
    result.autoCreateWorktree = candidate.autoCreateWorktree;
  }
  if (typeof candidate.gitmojiEnabled === 'boolean') {
    result.gitmojiEnabled = candidate.gitmojiEnabled;
  }
  if (typeof candidate.zenModel === 'string') {
    const trimmed = candidate.zenModel.trim();
    result.zenModel = trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof candidate.gitProviderId === 'string') {
    const trimmed = candidate.gitProviderId.trim();
    result.gitProviderId = trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof candidate.gitModelId === 'string') {
    const trimmed = candidate.gitModelId.trim();
    result.gitModelId = trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof candidate.pwaAppName === 'string') {
    result.pwaAppName = normalizePwaAppName(candidate.pwaAppName, undefined);
  }
  if (typeof candidate.toolCallExpansion === 'string') {
    const mode = candidate.toolCallExpansion.trim();
    if (mode === 'collapsed' || mode === 'activity' || mode === 'detailed' || mode === 'changes') {
      result.toolCallExpansion = mode;
    }
  }
  if (typeof candidate.inputSpellcheckEnabled === 'boolean') {
    result.inputSpellcheckEnabled = candidate.inputSpellcheckEnabled;
  }
  if (typeof candidate.showToolFileIcons === 'boolean') {
    result.showToolFileIcons = candidate.showToolFileIcons;
  }
  if (typeof candidate.showExpandedBashTools === 'boolean') {
    result.showExpandedBashTools = candidate.showExpandedBashTools;
  }
  if (typeof candidate.showExpandedEditTools === 'boolean') {
    result.showExpandedEditTools = candidate.showExpandedEditTools;
  }
  if (typeof candidate.chatRenderMode === 'string') {
    const mode = candidate.chatRenderMode.trim();
    if (mode === 'sorted' || mode === 'live') {
      result.chatRenderMode = mode;
    }
  }
  if (typeof candidate.activityRenderMode === 'string') {
    const mode = candidate.activityRenderMode.trim();
    if (mode === 'collapsed' || mode === 'summary') {
      result.activityRenderMode = mode;
    }
  }
  if (typeof candidate.mermaidRenderingMode === 'string') {
    const mode = candidate.mermaidRenderingMode.trim();
    if (mode === 'svg' || mode === 'ascii') {
      result.mermaidRenderingMode = mode;
    }
  }
  if (typeof candidate.userMessageRenderingMode === 'string') {
    const mode = candidate.userMessageRenderingMode.trim();
    if (mode === 'markdown' || mode === 'plain') {
      result.userMessageRenderingMode = mode;
    }
  }
  if (typeof candidate.stickyUserHeader === 'boolean') {
    result.stickyUserHeader = candidate.stickyUserHeader;
  }
  if (typeof candidate.fontSize === 'number' && Number.isFinite(candidate.fontSize)) {
    result.fontSize = Math.max(50, Math.min(200, Math.round(candidate.fontSize)));
  }
  if (typeof candidate.terminalFontSize === 'number' && Number.isFinite(candidate.terminalFontSize)) {
    result.terminalFontSize = Math.max(9, Math.min(52, Math.round(candidate.terminalFontSize)));
  }
  if (typeof candidate.padding === 'number' && Number.isFinite(candidate.padding)) {
    result.padding = Math.max(50, Math.min(200, Math.round(candidate.padding)));
  }
  if (typeof candidate.cornerRadius === 'number' && Number.isFinite(candidate.cornerRadius)) {
    result.cornerRadius = Math.max(0, Math.min(32, Math.round(candidate.cornerRadius)));
  }
  if (typeof candidate.inputBarOffset === 'number' && Number.isFinite(candidate.inputBarOffset)) {
    result.inputBarOffset = Math.max(0, Math.min(100, Math.round(candidate.inputBarOffset)));
  }

  const favoriteModels = sanitizeModelRefs(candidate.favoriteModels, 64);
  if (favoriteModels) {
    result.favoriteModels = favoriteModels;
  }

  const recentModels = sanitizeModelRefs(candidate.recentModels, 16);
  if (recentModels) {
    result.recentModels = recentModels;
  }
  if (typeof candidate.diffLayoutPreference === 'string') {
    const mode = candidate.diffLayoutPreference.trim();
    if (mode === 'dynamic' || mode === 'inline' || mode === 'side-by-side') {
      result.diffLayoutPreference = mode;
    }
  }
  if (typeof candidate.diffViewMode === 'string') {
    const mode = candidate.diffViewMode.trim();
    if (mode === 'single' || mode === 'stacked') {
      result.diffViewMode = mode;
    }
  }
  if (typeof candidate.directoryShowHidden === 'boolean') {
    result.directoryShowHidden = candidate.directoryShowHidden;
  }
  if (typeof candidate.filesViewShowGitignored === 'boolean') {
    result.filesViewShowGitignored = candidate.filesViewShowGitignored;
  }
  if (typeof candidate.openInAppId === 'string') {
    const trimmed = candidate.openInAppId.trim();
    if (trimmed.length > 0) {
      result.openInAppId = trimmed;
    }
  }

  // Message limit — single setting for fetch / trim / Load More chunk
  if (typeof candidate.messageLimit === 'number' && Number.isFinite(candidate.messageLimit)) {
    result.messageLimit = Math.max(10, Math.min(500, Math.round(candidate.messageLimit)));
  }

  const skillCatalogs = sanitizeSkillCatalogs(candidate.skillCatalogs);
  if (skillCatalogs) {
    result.skillCatalogs = skillCatalogs;
  }

  // Usage model selections - which models appear in dropdown
  if (candidate.usageSelectedModels && typeof candidate.usageSelectedModels === 'object') {
    const sanitized = {};
    for (const [providerId, models] of Object.entries(candidate.usageSelectedModels)) {
      if (typeof providerId === 'string' && Array.isArray(models)) {
        const validModels = models.filter((m) => typeof m === 'string' && m.length > 0);
        if (validModels.length > 0) {
          sanitized[providerId] = validModels;
        }
      }
    }
    if (Object.keys(sanitized).length > 0) {
      result.usageSelectedModels = sanitized;
    }
  }

  // Usage page collapsed families - for "Other Models" section
  if (candidate.usageCollapsedFamilies && typeof candidate.usageCollapsedFamilies === 'object') {
    const sanitized = {};
    for (const [providerId, families] of Object.entries(candidate.usageCollapsedFamilies)) {
      if (typeof providerId === 'string' && Array.isArray(families)) {
        const validFamilies = families.filter((f) => typeof f === 'string' && f.length > 0);
        if (validFamilies.length > 0) {
          sanitized[providerId] = validFamilies;
        }
      }
    }
    if (Object.keys(sanitized).length > 0) {
      result.usageCollapsedFamilies = sanitized;
    }
  }

  // Header dropdown expanded families (inverted - stores EXPANDED, default all collapsed)
  if (candidate.usageExpandedFamilies && typeof candidate.usageExpandedFamilies === 'object') {
    const sanitized = {};
    for (const [providerId, families] of Object.entries(candidate.usageExpandedFamilies)) {
      if (typeof providerId === 'string' && Array.isArray(families)) {
        const validFamilies = families.filter((f) => typeof f === 'string' && f.length > 0);
        if (validFamilies.length > 0) {
          sanitized[providerId] = validFamilies;
        }
      }
    }
    if (Object.keys(sanitized).length > 0) {
      result.usageExpandedFamilies = sanitized;
    }
  }

  // Custom model groups configuration
  if (candidate.usageModelGroups && typeof candidate.usageModelGroups === 'object') {
    const sanitized = {};
    for (const [providerId, config] of Object.entries(candidate.usageModelGroups)) {
      if (typeof providerId !== 'string') continue;

      const providerConfig = {};

      // customGroups: array of {id, label, models, order}
      if (Array.isArray(config.customGroups)) {
        const validGroups = config.customGroups
          .filter((g) => g && typeof g.id === 'string' && typeof g.label === 'string')
          .map((g) => ({
            id: g.id.slice(0, 64),
            label: g.label.slice(0, 128),
            models: Array.isArray(g.models)
              ? g.models.filter((m) => typeof m === 'string').slice(0, 500)
              : [],
            order: typeof g.order === 'number' ? g.order : 0,
          }));
        if (validGroups.length > 0) {
          providerConfig.customGroups = validGroups;
        }
      }

      // modelAssignments: Record<modelName, groupId>
      if (config.modelAssignments && typeof config.modelAssignments === 'object') {
        const assignments = {};
        for (const [model, groupId] of Object.entries(config.modelAssignments)) {
          if (typeof model === 'string' && typeof groupId === 'string') {
            assignments[model] = groupId;
          }
        }
        if (Object.keys(assignments).length > 0) {
          providerConfig.modelAssignments = assignments;
        }
      }

      // renamedGroups: Record<groupId, label>
      if (config.renamedGroups && typeof config.renamedGroups === 'object') {
        const renamed = {};
        for (const [groupId, label] of Object.entries(config.renamedGroups)) {
          if (typeof groupId === 'string' && typeof label === 'string') {
            renamed[groupId] = label.slice(0, 128);
          }
        }
        if (Object.keys(renamed).length > 0) {
          providerConfig.renamedGroups = renamed;
        }
      }

      if (Object.keys(providerConfig).length > 0) {
        sanitized[providerId] = providerConfig;
      }
    }
    if (Object.keys(sanitized).length > 0) {
      result.usageModelGroups = sanitized;
    }
  }

  // Usage reporting opt-out (default: true/enabled)
  if (typeof candidate.reportUsage === 'boolean') {
    result.reportUsage = candidate.reportUsage;
  }

  return result;
};

const mergePersistedSettings = (current, changes) => {
  const baseApproved = Array.isArray(changes.approvedDirectories)
    ? changes.approvedDirectories
    : Array.isArray(current.approvedDirectories)
      ? current.approvedDirectories
      : [];

  const additionalApproved = [];
  if (typeof changes.lastDirectory === 'string' && changes.lastDirectory.length > 0) {
    additionalApproved.push(changes.lastDirectory);
  }
  if (typeof changes.homeDirectory === 'string' && changes.homeDirectory.length > 0) {
    additionalApproved.push(changes.homeDirectory);
  }
  const projectEntries = Array.isArray(changes.projects)
    ? changes.projects
    : Array.isArray(current.projects)
      ? current.projects
      : [];
  projectEntries.forEach((project) => {
    if (project && typeof project.path === 'string' && project.path.length > 0) {
      additionalApproved.push(project.path);
    }
  });
  const approvedSource = [...baseApproved, ...additionalApproved];

  const baseBookmarks = Array.isArray(changes.securityScopedBookmarks)
    ? changes.securityScopedBookmarks
    : Array.isArray(current.securityScopedBookmarks)
      ? current.securityScopedBookmarks
      : [];

  const nextTypographySizes = changes.typographySizes
    ? {
        ...(current.typographySizes || {}),
        ...changes.typographySizes
      }
    : current.typographySizes;

  const next = {
    ...current,
    ...changes,
    approvedDirectories: Array.from(
      new Set(
        approvedSource.filter((entry) => typeof entry === 'string' && entry.length > 0)
      )
    ),
    securityScopedBookmarks: Array.from(
      new Set(
        baseBookmarks.filter((entry) => typeof entry === 'string' && entry.length > 0)
      )
    ),
    typographySizes: nextTypographySizes
  };

  return next;
};

const formatSettingsResponse = (settings) => {
  const sanitized = sanitizeSettingsUpdate(settings);
  delete sanitized.managedRemoteTunnelToken;
  const approved = normalizeStringArray(settings.approvedDirectories);
  const bookmarks = normalizeStringArray(settings.securityScopedBookmarks);
  const hasManagedRemoteTunnelToken = typeof settings?.managedRemoteTunnelToken === 'string' && settings.managedRemoteTunnelToken.trim().length > 0;
  const pwaAppName = normalizePwaAppName(settings?.pwaAppName, '');

  return {
    ...sanitized,
    hasManagedRemoteTunnelToken,
    ...(pwaAppName ? { pwaAppName } : {}),
    approvedDirectories: approved,
    securityScopedBookmarks: bookmarks,
    pinnedDirectories: normalizeStringArray(settings.pinnedDirectories),
    typographySizes: sanitizeTypographySizesPartial(settings.typographySizes),
    showReasoningTraces:
      typeof settings.showReasoningTraces === 'boolean'
        ? settings.showReasoningTraces
        : typeof sanitized.showReasoningTraces === 'boolean'
          ? sanitized.showReasoningTraces
          : false
  };
};

const validateProjectEntries = async (projects) => {
  console.log(`[validateProjectEntries] Starting validation for ${projects.length} projects`);

  if (!Array.isArray(projects)) {
    console.warn(`[validateProjectEntries] Input is not an array, returning empty`);
    return [];
  }

  const validations = projects.map(async (project) => {
    if (!project || typeof project.path !== 'string' || project.path.length === 0) {
      console.error(`[validateProjectEntries] Invalid project entry: missing or empty path`, project);
      return null;
    }
    try {
      const stats = await fsPromises.stat(project.path);
      if (!stats.isDirectory()) {
        console.error(`[validateProjectEntries] Project path is not a directory: ${project.path}`);
        return null;
      }
      return project;
    } catch (error) {
      const err = error;
      console.error(`[validateProjectEntries] Failed to validate project "${project.path}": ${err.code || err.message || err}`);
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        console.log(`[validateProjectEntries] Removing project with ENOENT: ${project.path}`);
        return null;
      }
      console.log(`[validateProjectEntries] Keeping project despite non-ENOENT error: ${project.path}`);
      return project;
    }
  });

  const results = (await Promise.all(validations)).filter((p) => p !== null);

  console.log(`[validateProjectEntries] Validation complete: ${results.length}/${projects.length} projects valid`);
  return results;
};

const migrateSettingsFromLegacyLastDirectory = async (current) => {
  const settings = current && typeof current === 'object' ? current : {};
  const now = Date.now();

  const sanitizedProjects = sanitizeProjects(settings.projects) || [];
  let nextProjects = sanitizedProjects;
  let nextActiveProjectId =
    typeof settings.activeProjectId === 'string' ? settings.activeProjectId : undefined;

  let changed = false;

  if (nextProjects.length === 0) {
    const legacy = typeof settings.lastDirectory === 'string' ? settings.lastDirectory.trim() : '';
    const candidate = legacy ? resolveDirectoryCandidate(legacy) : null;

    if (candidate) {
      try {
        const stats = await fsPromises.stat(candidate);
        if (stats.isDirectory()) {
          const id = crypto.randomUUID();
          nextProjects = [
            {
              id,
              path: candidate,
              addedAt: now,
              lastOpenedAt: now,
            },
          ];
          nextActiveProjectId = id;
          changed = true;
        }
      } catch {
        // ignore invalid lastDirectory
      }
    }
  }

  if (nextProjects.length > 0) {
    const active = nextProjects.find((project) => project.id === nextActiveProjectId) || null;
    if (!active) {
      nextActiveProjectId = nextProjects[0].id;
      changed = true;
    }
  } else if (nextActiveProjectId) {
    nextActiveProjectId = undefined;
    changed = true;
  }

  if (!changed) {
    return { settings, changed: false };
  }

  const merged = mergePersistedSettings(settings, {
    ...settings,
    projects: nextProjects,
    ...(nextActiveProjectId ? { activeProjectId: nextActiveProjectId } : { activeProjectId: undefined }),
  });

  return { settings: merged, changed: true };
};

const migrateSettingsFromLegacyThemePreferences = async (current) => {
  const settings = current && typeof current === 'object' ? current : {};

  const themeId = typeof settings.themeId === 'string' ? settings.themeId.trim() : '';
  const themeVariant = typeof settings.themeVariant === 'string' ? settings.themeVariant.trim() : '';

  const hasLight = typeof settings.lightThemeId === 'string' && settings.lightThemeId.trim().length > 0;
  const hasDark = typeof settings.darkThemeId === 'string' && settings.darkThemeId.trim().length > 0;

  if (hasLight && hasDark) {
    return { settings, changed: false };
  }

  const defaultLight = 'flexoki-light';
  const defaultDark = 'flexoki-dark';

  let nextLightThemeId = hasLight ? settings.lightThemeId : undefined;
  let nextDarkThemeId = hasDark ? settings.darkThemeId : undefined;

  if (!hasLight) {
    if (themeId && themeVariant === 'light') {
      nextLightThemeId = themeId;
    } else {
      nextLightThemeId = defaultLight;
    }
  }

  if (!hasDark) {
    if (themeId && themeVariant === 'dark') {
      nextDarkThemeId = themeId;
    } else {
      nextDarkThemeId = defaultDark;
    }
  }

  const merged = mergePersistedSettings(settings, {
    ...settings,
    ...(nextLightThemeId ? { lightThemeId: nextLightThemeId } : {}),
    ...(nextDarkThemeId ? { darkThemeId: nextDarkThemeId } : {}),
  });

  return { settings: merged, changed: true };
};

const migrateSettingsFromLegacyCollapsedProjects = async (current) => {
  const settings = current && typeof current === 'object' ? current : {};
  const collapsed = Array.isArray(settings.collapsedProjects)
    ? normalizeStringArray(settings.collapsedProjects)
    : [];

  if (collapsed.length === 0 || !Array.isArray(settings.projects)) {
    if (collapsed.length === 0) {
      return { settings, changed: false };
    }
    // Nothing to apply to; drop legacy key.
    const next = { ...settings };
    delete next.collapsedProjects;
    return { settings: next, changed: true };
  }

  const set = new Set(collapsed);
  const projects = sanitizeProjects(settings.projects) || [];
  let changed = false;

  const nextProjects = projects.map((project) => {
    const shouldCollapse = set.has(project.id);
    if (project.sidebarCollapsed !== shouldCollapse) {
      changed = true;
      return { ...project, sidebarCollapsed: shouldCollapse };
    }
    return project;
  });

  if (!changed) {
    // Still drop legacy key if present.
    if (Object.prototype.hasOwnProperty.call(settings, 'collapsedProjects')) {
      const next = { ...settings };
      delete next.collapsedProjects;
      return { settings: next, changed: true };
    }
    return { settings, changed: false };
  }

  const next = { ...settings, projects: nextProjects };
  delete next.collapsedProjects;
  return { settings: next, changed: true };
};

const DEFAULT_NOTIFICATION_TEMPLATES = {
  completion: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
  error: { title: 'Tool error', message: '{last_message}' },
  question: { title: 'Input needed', message: '{last_message}' },
  subtask: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
};

const ensureNotificationTemplateShape = (templates) => {
  const input = templates && typeof templates === 'object' ? templates : {};
  let changed = false;
  const next = {};

  for (const event of Object.keys(DEFAULT_NOTIFICATION_TEMPLATES)) {
    const currentEntry = input[event];
    const base = DEFAULT_NOTIFICATION_TEMPLATES[event];
    const currentTitle = typeof currentEntry?.title === 'string' ? currentEntry.title : base.title;
    const currentMessage = typeof currentEntry?.message === 'string' ? currentEntry.message : base.message;
    if (!currentEntry || typeof currentEntry.title !== 'string' || typeof currentEntry.message !== 'string') {
      changed = true;
    }
    next[event] = { title: currentTitle, message: currentMessage };
  }

  return { templates: next, changed };
};

const migrateSettingsNotificationDefaults = async (current) => {
  const settings = current && typeof current === 'object' ? current : {};
  let changed = false;
  const next = { ...settings };

  if (typeof settings.notifyOnSubtasks !== 'boolean') {
    next.notifyOnSubtasks = true;
    changed = true;
  }
  if (typeof settings.notifyOnCompletion !== 'boolean') {
    next.notifyOnCompletion = true;
    changed = true;
  }
  if (typeof settings.notifyOnError !== 'boolean') {
    next.notifyOnError = true;
    changed = true;
  }
  if (typeof settings.notifyOnQuestion !== 'boolean') {
    next.notifyOnQuestion = true;
    changed = true;
  }

  const { templates, changed: templatesChanged } = ensureNotificationTemplateShape(settings.notificationTemplates);
  if (templatesChanged || !settings.notificationTemplates || typeof settings.notificationTemplates !== 'object') {
    next.notificationTemplates = templates;
    changed = true;
  }

  return { settings: changed ? next : settings, changed };
};

const migrateSettingsFromLegacyNamedTunnelKeys = async (current) => {
  const settings = current && typeof current === 'object' ? current : {};
  const next = { ...settings };
  let changed = false;

  if (!Object.prototype.hasOwnProperty.call(next, 'managedRemoteTunnelHostname')
    && Object.prototype.hasOwnProperty.call(next, 'namedTunnelHostname')) {
    next.managedRemoteTunnelHostname = normalizeManagedRemoteTunnelHostname(next.namedTunnelHostname);
    changed = true;
  }

  if (!Object.prototype.hasOwnProperty.call(next, 'managedRemoteTunnelToken')
    && Object.prototype.hasOwnProperty.call(next, 'namedTunnelToken')) {
    if (next.namedTunnelToken === null) {
      next.managedRemoteTunnelToken = null;
    } else if (typeof next.namedTunnelToken === 'string') {
      next.managedRemoteTunnelToken = next.namedTunnelToken.trim();
    }
    changed = true;
  }

  if (!Object.prototype.hasOwnProperty.call(next, 'managedRemoteTunnelPresets')
    && Object.prototype.hasOwnProperty.call(next, 'namedTunnelPresets')) {
    next.managedRemoteTunnelPresets = normalizeManagedRemoteTunnelPresets(next.namedTunnelPresets);
    changed = true;
  }

  if (!Object.prototype.hasOwnProperty.call(next, 'managedRemoteTunnelPresetTokens')
    && Object.prototype.hasOwnProperty.call(next, 'namedTunnelPresetTokens')) {
    next.managedRemoteTunnelPresetTokens = normalizeManagedRemoteTunnelPresetTokens(next.namedTunnelPresetTokens);
    changed = true;
  }

  if (!Object.prototype.hasOwnProperty.call(next, 'managedRemoteTunnelSelectedPresetId')
    && Object.prototype.hasOwnProperty.call(next, 'namedTunnelSelectedPresetId')) {
    const selectedPresetId = typeof next.namedTunnelSelectedPresetId === 'string'
      ? next.namedTunnelSelectedPresetId.trim()
      : '';
    if (selectedPresetId) {
      next.managedRemoteTunnelSelectedPresetId = selectedPresetId;
    }
    changed = true;
  }

  const legacyKeys = [
    'namedTunnelHostname',
    'namedTunnelToken',
    'namedTunnelPresets',
    'namedTunnelPresetTokens',
    'namedTunnelSelectedPresetId',
  ];
  for (const key of legacyKeys) {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      delete next[key];
      changed = true;
    }
  }

  return { settings: changed ? next : settings, changed };
};

const readSettingsFromDiskMigrated = async () => {
  const current = await readSettingsFromDisk();
  const migration1 = await migrateSettingsFromLegacyLastDirectory(current);
  const migration2 = await migrateSettingsFromLegacyThemePreferences(migration1.settings);
  const migration3 = await migrateSettingsFromLegacyCollapsedProjects(migration2.settings);
  const migration4 = await migrateSettingsNotificationDefaults(migration3.settings);
  const migration5 = await migrateSettingsFromLegacyNamedTunnelKeys(migration4.settings);
  const migration6 = normalizeSettingsPaths(migration5.settings);
  if (migration1.changed || migration2.changed || migration3.changed || migration4.changed || migration5.changed || migration6.changed) {
    await writeSettingsToDisk(migration6.settings);
  }
  return migration6.settings;
};

const getOrCreateVapidKeys = async () => {
  const settings = await readSettingsFromDiskMigrated();
  const existing = settings?.vapidKeys;
  if (existing && typeof existing.publicKey === 'string' && typeof existing.privateKey === 'string') {
    return { publicKey: existing.publicKey, privateKey: existing.privateKey };
  }

  const generated = webPush.generateVAPIDKeys();
  const next = {
    ...settings,
    vapidKeys: {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
    },
  };

  await writeSettingsToDisk(next);
  return { publicKey: generated.publicKey, privateKey: generated.privateKey };
};

const getUiSessionTokenFromRequest = (req) => {
  const cookieHeader = req?.headers?.cookie;
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return null;
  }
  const segments = cookieHeader.split(';');
  for (const segment of segments) {
    const [rawName, ...rest] = segment.split('=');
    const name = rawName?.trim();
    if (!name) continue;
    if (name !== 'oc_ui_session') continue;
    const value = rest.join('=').trim();
    try {
      return decodeURIComponent(value || '');
    } catch {
      return value || null;
    }
  }
  return null;
};

const TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW = 128;
const TERMINAL_INPUT_WS_REBIND_WINDOW_MS = 60 * 1000;
const TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS = 15 * 1000;

const rejectWebSocketUpgrade = (socket, statusCode, reason) => {
  if (!socket || socket.destroyed) {
    return;
  }

  const message = typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : 'Bad Request';
  const body = Buffer.from(message, 'utf8');
  const statusText = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    500: 'Internal Server Error',
  }[statusCode] || 'Bad Request';

  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${body.length}\r\n\r\n`
    );
    socket.write(body);
  } catch {
  }

  try {
    socket.destroy();
  } catch {
  }
};


const getRequestOriginCandidates = async (req) => {
  const origins = new Set();
  const forwardedProto = typeof req.headers['x-forwarded-proto'] === 'string'
    ? req.headers['x-forwarded-proto'].split(',')[0].trim().toLowerCase()
    : '';
  const protocol = forwardedProto || (req.socket?.encrypted ? 'https' : 'http');

  const forwardedHost = typeof req.headers['x-forwarded-host'] === 'string'
    ? req.headers['x-forwarded-host'].split(',')[0].trim()
    : '';
  const host = forwardedHost || (typeof req.headers.host === 'string' ? req.headers.host.trim() : '');

  if (host) {
    origins.add(`${protocol}://${host}`);
    const [hostname, port] = host.split(':');
    const normalizedHost = typeof hostname === 'string' ? hostname.toLowerCase() : '';
    const portSuffix = typeof port === 'string' && port.length > 0 ? `:${port}` : '';
    if (normalizedHost === 'localhost') {
      origins.add(`${protocol}://127.0.0.1${portSuffix}`);
      origins.add(`${protocol}://[::1]${portSuffix}`);
    } else if (normalizedHost === '127.0.0.1' || normalizedHost === '[::1]') {
      origins.add(`${protocol}://localhost${portSuffix}`);
    }
  }

  try {
    const settings = await readSettingsFromDiskMigrated();
    if (typeof settings?.publicOrigin === 'string' && settings.publicOrigin.trim().length > 0) {
      origins.add(new URL(settings.publicOrigin.trim()).origin);
    }
  } catch {
  }

  return origins;
};

const isRequestOriginAllowed = async (req) => {
  const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  if (!originHeader) {
    return false;
  }

  let normalizedOrigin = '';
  try {
    normalizedOrigin = new URL(originHeader).origin;
  } catch {
    return false;
  }

  const allowedOrigins = await getRequestOriginCandidates(req);
  return allowedOrigins.has(normalizedOrigin);
};

const normalizePushSubscriptions = (record) => {
  if (!Array.isArray(record)) return [];
  return record
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const endpoint = entry.endpoint;
      const p256dh = entry.p256dh;
      const auth = entry.auth;
      if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
        return null;
      }
      return {
        endpoint,
        p256dh,
        auth,
        createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : null,
      };
    })
    .filter(Boolean);
};

const getPushSubscriptionsForUiSession = async (uiSessionToken) => {
  if (!uiSessionToken) return [];
  const store = await readPushSubscriptionsFromDisk();
  const record = store.subscriptionsBySession?.[uiSessionToken];
  return normalizePushSubscriptions(record);
};

const addOrUpdatePushSubscription = async (uiSessionToken, subscription, userAgent) => {
  if (!uiSessionToken) {
    return;
  }

  await ensurePushInitialized();

  const now = Date.now();

  await persistPushSubscriptionUpdate((current) => {
    const subsBySession = { ...(current.subscriptionsBySession || {}) };
    const existing = Array.isArray(subsBySession[uiSessionToken]) ? subsBySession[uiSessionToken] : [];

    const filtered = existing.filter((entry) => entry && typeof entry.endpoint === 'string' && entry.endpoint !== subscription.endpoint);

    filtered.unshift({
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
      createdAt: now,
      lastSeenAt: now,
      userAgent: typeof userAgent === 'string' && userAgent.length > 0 ? userAgent : undefined,
    });

    subsBySession[uiSessionToken] = filtered.slice(0, 10);

    return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
  });
};

const removePushSubscription = async (uiSessionToken, endpoint) => {
  if (!uiSessionToken || !endpoint) return;

  await ensurePushInitialized();

  await persistPushSubscriptionUpdate((current) => {
    const subsBySession = { ...(current.subscriptionsBySession || {}) };
    const existing = Array.isArray(subsBySession[uiSessionToken]) ? subsBySession[uiSessionToken] : [];
    const filtered = existing.filter((entry) => entry && typeof entry.endpoint === 'string' && entry.endpoint !== endpoint);
    if (filtered.length === 0) {
      delete subsBySession[uiSessionToken];
    } else {
      subsBySession[uiSessionToken] = filtered;
    }
    return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
  });
};

const removePushSubscriptionFromAllSessions = async (endpoint) => {
  if (!endpoint) return;

  await ensurePushInitialized();

  await persistPushSubscriptionUpdate((current) => {
    const subsBySession = { ...(current.subscriptionsBySession || {}) };
    for (const [token, entries] of Object.entries(subsBySession)) {
      if (!Array.isArray(entries)) continue;
      const filtered = entries.filter((entry) => entry && typeof entry.endpoint === 'string' && entry.endpoint !== endpoint);
      if (filtered.length === 0) {
        delete subsBySession[token];
      } else {
        subsBySession[token] = filtered;
      }
    }
    return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
  });
};

const buildSessionDeepLinkUrl = (sessionId) => {
  if (!sessionId || typeof sessionId !== 'string') {
    return '/';
  }
  return `/?session=${encodeURIComponent(sessionId)}`;
};

const sendPushToSubscription = async (sub, payload) => {
  await ensurePushInitialized();
  const body = JSON.stringify(payload);

  const pushSubscription = {
    endpoint: sub.endpoint,
    keys: {
      p256dh: sub.p256dh,
      auth: sub.auth,
    }
  };

  try {
    await webPush.sendNotification(pushSubscription, body);
  } catch (error) {
    const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : null;
    if (statusCode === 410 || statusCode === 404) {
      await removePushSubscriptionFromAllSessions(sub.endpoint);
      return;
    }
    console.warn('[Push] Failed to send notification:', error);
  }
};

const sendPushToAllUiSessions = async (payload, options = {}) => {
  const requireNoSse = options.requireNoSse === true;
  const store = await readPushSubscriptionsFromDisk();
  const sessions = store.subscriptionsBySession || {};
  const subscriptionsByEndpoint = new Map();

  for (const [token, record] of Object.entries(sessions)) {
    const subscriptions = normalizePushSubscriptions(record);
    if (subscriptions.length === 0) continue;

    for (const sub of subscriptions) {
      if (!subscriptionsByEndpoint.has(sub.endpoint)) {
        subscriptionsByEndpoint.set(sub.endpoint, sub);
      }
    }
  }

  await Promise.all(Array.from(subscriptionsByEndpoint.entries()).map(async ([endpoint, sub]) => {
    if (requireNoSse && isAnyUiVisible()) {
      return;
    }
    await sendPushToSubscription(sub, payload);
  }));
};

let pushInitialized = false;



const uiVisibilityByToken = new Map();
let globalVisibilityState = false;

const updateUiVisibility = (token, visible) => {
  if (!token) return;
  const now = Date.now();
  const nextVisible = Boolean(visible);
  uiVisibilityByToken.set(token, { visible: nextVisible, updatedAt: now });
  globalVisibilityState = nextVisible;

};

const isAnyUiVisible = () => globalVisibilityState === true;

const isUiVisible = (token) => uiVisibilityByToken.get(token)?.visible === true;

// Session activity tracking (mirrors desktop session_activity.rs)
const sessionActivityPhases = new Map(); // sessionId -> { phase: 'idle'|'busy'|'cooldown', updatedAt: number }
const sessionActivityCooldowns = new Map(); // sessionId -> timeoutId
const SESSION_COOLDOWN_DURATION_MS = 2000;

// Complete session status tracking - source of truth for web clients
// This maintains the authoritative state, clients only cache it
const sessionStates = new Map(); // sessionId -> {
//   status: 'idle'|'busy'|'retry',
//   lastUpdateAt: number,
//   lastEventId: string,
//   metadata: { attempt?: number, message?: string, next?: number }
// }
const SESSION_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_STATE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const updateSessionState = (sessionId, status, eventId, metadata = {}) => {
  if (!sessionId || typeof sessionId !== 'string') return;

  const now = Date.now();
  const existing = sessionStates.get(sessionId);
  const existingAttentionState = sessionAttentionStates.get(sessionId);

  // Only update if this is a newer event (simple ordering protection)
  if (existing && existing.lastUpdateAt > now - 5000 && status === existing.status) {
    // Same status within 5 seconds, skip to reduce noise
    return;
  }

  sessionStates.set(sessionId, {
    status,
    lastUpdateAt: now,
    lastEventId: eventId || `server-${now}`,
    metadata: { ...existing?.metadata, ...metadata }
  });

  // Update attention tracking state (must be called before broadcasting)
  updateSessionAttentionStatus(sessionId, status, eventId);
  const attentionState = sessionAttentionStates.get(sessionId);

  // Broadcast status change to connected web clients via SSE
  // This enables real-time updates without polling
  // Include needsAttention in the same event to ensure atomic updates
  const attentionChanged = !!attentionState && existingAttentionState?.needsAttention !== attentionState.needsAttention;
  if (uiNotificationClients.size > 0 && (!existing || existing.status !== status || attentionChanged)) {
    const state = sessionStates.get(sessionId);
    for (const res of uiNotificationClients) {
      try {
        writeSseEvent(res, {
          type: 'openchamber:session-status',
          properties: {
            sessionId,
            status: state.status,
            timestamp: state.lastUpdateAt,
            metadata: state.metadata,
            needsAttention: attentionState?.needsAttention ?? false
          }
        });
      } catch {
        // Client disconnected, will be cleaned up by close handler
      }
    }
  }

  // Also update activity phases for backward compatibility
  const phase = status === 'busy' || status === 'retry' ? 'busy' : 'idle';
  setSessionActivityPhase(sessionId, phase);
};

const getSessionStateSnapshot = () => {
  const result = {};
  const now = Date.now();

  for (const [sessionId, data] of sessionStates) {
    // Skip very old states (session likely gone)
    if (now - data.lastUpdateAt > SESSION_STATE_MAX_AGE_MS) continue;

    result[sessionId] = {
      status: data.status,
      lastUpdateAt: data.lastUpdateAt,
      metadata: data.metadata
    };
  }

  return result;
};

const getSessionState = (sessionId) => {
  if (!sessionId) return null;
  return sessionStates.get(sessionId) || null;
};

// Session attention tracking - authoritative source for unread/needs-attention state
// Tracks which sessions need user attention based on activity and view state
const sessionAttentionStates = new Map(); // sessionId -> {
//   needsAttention: boolean,
//   lastUserMessageAt: number | null,
//   lastStatusChangeAt: number,
//   viewedByClients: Set<clientId>,
//   status: 'idle' | 'busy' | 'retry'
// }
const SESSION_ATTENTION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

const getOrCreateAttentionState = (sessionId) => {
  if (!sessionId || typeof sessionId !== 'string') return null;

  let state = sessionAttentionStates.get(sessionId);
  if (!state) {
    state = {
      needsAttention: false,
      lastUserMessageAt: null,
      lastStatusChangeAt: Date.now(),
      viewedByClients: new Set(),
      status: 'idle'
    };
    sessionAttentionStates.set(sessionId, state);
  }
  return state;
};

const updateSessionAttentionStatus = (sessionId, status, eventId) => {
  const state = getOrCreateAttentionState(sessionId);
  if (!state) return;

  const prevStatus = state.status;
  state.status = status;
  state.lastStatusChangeAt = Date.now();

  // Check if we need to mark as needsAttention
  // Condition: transitioning from busy/retry to idle + user sent message + not currently viewed
  // Note: The actual broadcast with needsAttention is done in updateSessionState
  // to ensure both status and attention are sent in a single event
  if ((prevStatus === 'busy' || prevStatus === 'retry') && status === 'idle') {
    if (state.lastUserMessageAt && state.viewedByClients.size === 0) {
      state.needsAttention = true;
    }
  }
};

const markSessionViewed = (sessionId, clientId) => {
  const state = getOrCreateAttentionState(sessionId);
  if (!state) return;

  const wasNeedsAttention = state.needsAttention;
  state.viewedByClients.add(clientId);

  // Clear needsAttention when viewed
  if (wasNeedsAttention) {
    state.needsAttention = false;

    // Broadcast attention cleared event
    if (uiNotificationClients.size > 0) {
      for (const res of uiNotificationClients) {
        try {
          writeSseEvent(res, {
            type: 'openchamber:session-status',
            properties: {
              sessionId,
              status: state.status,
              timestamp: Date.now(),
              metadata: {},
              needsAttention: false
            }
          });
        } catch {
          // Client disconnected
        }
      }
    }
  }
};

const markSessionUnviewed = (sessionId, clientId) => {
  const state = sessionAttentionStates.get(sessionId);
  if (!state) return;

  state.viewedByClients.delete(clientId);
};

const markUserMessageSent = (sessionId) => {
  const state = getOrCreateAttentionState(sessionId);
  if (!state) return;

  state.lastUserMessageAt = Date.now();
};

const getSessionAttentionSnapshot = () => {
  const result = {};
  const now = Date.now();

  for (const [sessionId, state] of sessionAttentionStates) {
    // Skip very old states
    if (now - state.lastStatusChangeAt > SESSION_ATTENTION_MAX_AGE_MS) continue;

    result[sessionId] = {
      needsAttention: state.needsAttention,
      lastUserMessageAt: state.lastUserMessageAt,
      lastStatusChangeAt: state.lastStatusChangeAt,
      status: state.status,
      isViewed: state.viewedByClients.size > 0
    };
  }

  return result;
};

const getSessionAttentionState = (sessionId) => {
  if (!sessionId) return null;
  const state = sessionAttentionStates.get(sessionId);
  if (!state) return null;

  return {
    needsAttention: state.needsAttention,
    lastUserMessageAt: state.lastUserMessageAt,
    lastStatusChangeAt: state.lastStatusChangeAt,
    status: state.status,
    isViewed: state.viewedByClients.size > 0
  };
};

const cleanupOldSessionStates = () => {
  const now = Date.now();
  let cleaned = 0;

  for (const [sessionId, data] of sessionStates) {
    if (now - data.lastUpdateAt > SESSION_STATE_MAX_AGE_MS) {
      sessionStates.delete(sessionId);
      cleaned++;
    }
  }

  // Also cleanup attention states
  for (const [sessionId, state] of sessionAttentionStates) {
    if (now - state.lastStatusChangeAt > SESSION_ATTENTION_MAX_AGE_MS) {
      sessionAttentionStates.delete(sessionId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.info(`[SessionState] Cleaned up ${cleaned} old session states`);
  }
};

// Start periodic cleanup
setInterval(cleanupOldSessionStates, SESSION_STATE_CLEANUP_INTERVAL_MS);

const setSessionActivityPhase = (sessionId, phase) => {
  if (!sessionId || typeof sessionId !== 'string') return false;

  const current = sessionActivityPhases.get(sessionId);
  if (current?.phase === phase) return false; // No change

  // Match desktop semantics: only enter cooldown from busy.
  if (phase === 'cooldown' && current?.phase !== 'busy') {
    return false;
  }

  // Cancel existing cooldown timer only on phase change.
  const existingTimer = sessionActivityCooldowns.get(sessionId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    sessionActivityCooldowns.delete(sessionId);
  }

  sessionActivityPhases.set(sessionId, { phase, updatedAt: Date.now() });

  // Schedule transition from cooldown to idle
  if (phase === 'cooldown') {
    const timer = setTimeout(() => {
      const now = sessionActivityPhases.get(sessionId);
      if (now?.phase === 'cooldown') {
        sessionActivityPhases.set(sessionId, { phase: 'idle', updatedAt: Date.now() });
      }
      sessionActivityCooldowns.delete(sessionId);
    }, SESSION_COOLDOWN_DURATION_MS);
    sessionActivityCooldowns.set(sessionId, timer);
  }

  return true;
};

const getSessionActivitySnapshot = () => {
  const result = {};
  for (const [sessionId, data] of sessionActivityPhases) {
    result[sessionId] = { type: data.phase };
  }
  return result;
};

const resetAllSessionActivityToIdle = () => {
  // Cancel all cooldown timers
  for (const timer of sessionActivityCooldowns.values()) {
    clearTimeout(timer);
  }
  sessionActivityCooldowns.clear();
  
  // Reset all phases to idle
  const now = Date.now();
  for (const [sessionId] of sessionActivityPhases) {
    sessionActivityPhases.set(sessionId, { phase: 'idle', updatedAt: now });
  }
};

const resolveVapidSubject = async () => {
  const configured = process.env.OPENCHAMBER_VAPID_SUBJECT;
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured.trim();
  }

  const originEnv = process.env.OPENCHAMBER_PUBLIC_ORIGIN;
  if (typeof originEnv === 'string' && originEnv.trim().length > 0) {
    const trimmed = originEnv.trim();
    // Convert http://localhost to mailto for VAPID compatibility
    if (trimmed.startsWith('http://localhost')) {
      return 'mailto:openchamber@localhost';
    }
    return trimmed;
  }

  try {
    const settings = await readSettingsFromDiskMigrated();
    const stored = settings?.publicOrigin;
    if (typeof stored === 'string' && stored.trim().length > 0) {
      const trimmed = stored.trim();
      // Convert http://localhost to mailto for VAPID compatibility
      if (trimmed.startsWith('http://localhost')) {
        return 'mailto:openchamber@localhost';
      }
      return trimmed;
    }
  } catch {
    // ignore
  }

  return 'mailto:openchamber@localhost';
};

const ensurePushInitialized = async () => {
  if (pushInitialized) return;
  const keys = await getOrCreateVapidKeys();
  const subject = await resolveVapidSubject();

  if (subject === 'mailto:openchamber@localhost') {
    console.warn('[Push] No public origin configured for VAPID; set OPENCHAMBER_VAPID_SUBJECT or enable push once from a real origin.');
  }

  webPush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  pushInitialized = true;
};

const persistSettings = async (changes) => {
  // Serialize concurrent calls using lock
  persistSettingsLock = persistSettingsLock.then(async () => {
    console.log(`[persistSettings] Called with changes:`, JSON.stringify(changes, null, 2));
    const current = await readSettingsFromDisk();
    console.log(`[persistSettings] Current projects count:`, Array.isArray(current.projects) ? current.projects.length : 'N/A');
    const sanitized = sanitizeSettingsUpdate(changes);
    let next = mergePersistedSettings(current, sanitized);

    const normalizedState = normalizeSettingsPaths(next);
    if (normalizedState.changed) {
      next = normalizedState.settings;
    }

    if (Array.isArray(next.projects)) {
      console.log(`[persistSettings] Validating ${next.projects.length} projects...`);
      const validated = await validateProjectEntries(next.projects);
      console.log(`[persistSettings] After validation: ${validated.length} projects remain`);
      next = { ...next, projects: validated };
    }

    if (Array.isArray(next.projects) && next.projects.length > 0) {
      const activeId = typeof next.activeProjectId === 'string' ? next.activeProjectId : '';
      const active = next.projects.find((project) => project.id === activeId) || null;
      if (!active) {
        console.log(`[persistSettings] Active project ID ${activeId} not found, switching to ${next.projects[0].id}`);
        next = { ...next, activeProjectId: next.projects[0].id };
      }
    } else if (next.activeProjectId) {
      console.log(`[persistSettings] No projects found, clearing activeProjectId ${next.activeProjectId}`);
      next = { ...next, activeProjectId: undefined };
    }

    if (Object.prototype.hasOwnProperty.call(sanitized, 'managedRemoteTunnelPresets')) {
      await syncManagedRemoteTunnelConfigWithPresets(next.managedRemoteTunnelPresets);
    }

    if (Object.prototype.hasOwnProperty.call(sanitized, 'managedRemoteTunnelPresetTokens') && sanitized.managedRemoteTunnelPresetTokens) {
      const presetsById = new Map((next.managedRemoteTunnelPresets || []).map((entry) => [entry.id, entry]));
      const updates = Object.entries(sanitized.managedRemoteTunnelPresetTokens)
        .map(([presetId, token]) => {
          const preset = presetsById.get(presetId);
          if (!preset || typeof token !== 'string' || token.trim().length === 0) {
            return null;
          }
          return {
            id: preset.id,
            name: preset.name,
            hostname: preset.hostname,
            token: token.trim(),
          };
        })
        .filter(Boolean);

      for (const update of updates) {
        await upsertManagedRemoteTunnelToken(update);
      }
    }

    await writeSettingsToDisk(next);
    console.log(`[persistSettings] Successfully saved ${next.projects?.length || 0} projects to disk`);
    return formatSettingsResponse(next);
  });

  return persistSettingsLock;
};

// HMR-persistent state via globalThis
// These values survive Vite HMR reloads to prevent zombie OpenCode processes
const HMR_STATE_KEY = '__openchamberHmrState';
const getHmrState = () => {
  if (!globalThis[HMR_STATE_KEY]) {
    globalThis[HMR_STATE_KEY] = {
      openCodeProcess: null,
      openCodePort: null,
        openCodeWorkingDirectory: os.homedir(),
        isShuttingDown: false,
        signalsAttached: false,
        userProvidedOpenCodePassword: undefined,
        openCodeAuthPassword: null,
        openCodeAuthSource: null,
      };
  }
  return globalThis[HMR_STATE_KEY];
};
const hmrState = getHmrState();

const normalizeOpenCodePassword = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
};

if (typeof hmrState.userProvidedOpenCodePassword === 'undefined') {
  const initialPassword = normalizeOpenCodePassword(process.env.OPENCODE_SERVER_PASSWORD);
  hmrState.userProvidedOpenCodePassword = initialPassword || null;
}

// Non-HMR state (safe to reset on reload)
let healthCheckInterval = null;
let server = null;
let cachedModelsMetadata = null;
let cachedModelsMetadataTimestamp = 0;
let expressApp = null;
let currentRestartPromise = null;
let isRestartingOpenCode = false;
let openCodeApiPrefix = '';
let openCodeApiPrefixDetected = true;
let openCodeApiDetectionTimer = null;
let lastOpenCodeError = null;
let isOpenCodeReady = false;
let openCodeNotReadySince = 0;
let isExternalOpenCode = false;
let exitOnShutdown = true;
let uiAuthController = null;
let activeTunnelController = null;
const tunnelProviderRegistry = createTunnelProviderRegistry([
  createCloudflareTunnelProvider(),
]);
tunnelProviderRegistry.seal();
const tunnelAuthController = createTunnelAuth();
let runtimeManagedRemoteTunnelToken = '';
let runtimeManagedRemoteTunnelHostname = '';
let terminalRuntime = null;
const userProvidedOpenCodePassword =
  typeof hmrState.userProvidedOpenCodePassword === 'string' && hmrState.userProvidedOpenCodePassword.length > 0
    ? hmrState.userProvidedOpenCodePassword
    : null;
let openCodeAuthPassword =
  typeof hmrState.openCodeAuthPassword === 'string' && hmrState.openCodeAuthPassword.length > 0
    ? hmrState.openCodeAuthPassword
    : userProvidedOpenCodePassword;
let openCodeAuthSource =
  typeof hmrState.openCodeAuthSource === 'string' && hmrState.openCodeAuthSource.length > 0
    ? hmrState.openCodeAuthSource
    : (userProvidedOpenCodePassword ? 'user-env' : null);

// Sync helper - call after modifying any HMR state variable
const syncToHmrState = () => {
  hmrState.openCodeProcess = openCodeProcess;
  hmrState.openCodePort = openCodePort;
  hmrState.openCodeBaseUrl = openCodeBaseUrl;
  hmrState.isShuttingDown = isShuttingDown;
  hmrState.signalsAttached = signalsAttached;
  hmrState.openCodeWorkingDirectory = openCodeWorkingDirectory;
  hmrState.openCodeAuthPassword = openCodeAuthPassword;
  hmrState.openCodeAuthSource = openCodeAuthSource;
};

// Sync helper - call to restore state from HMR (e.g., on module reload)
const syncFromHmrState = () => {
  openCodeProcess = hmrState.openCodeProcess;
  openCodePort = hmrState.openCodePort;
  openCodeBaseUrl = hmrState.openCodeBaseUrl ?? null;
  isShuttingDown = hmrState.isShuttingDown;
  signalsAttached = hmrState.signalsAttached;
  openCodeWorkingDirectory = hmrState.openCodeWorkingDirectory;
  openCodeAuthPassword =
    typeof hmrState.openCodeAuthPassword === 'string' && hmrState.openCodeAuthPassword.length > 0
      ? hmrState.openCodeAuthPassword
      : userProvidedOpenCodePassword;
  openCodeAuthSource =
    typeof hmrState.openCodeAuthSource === 'string' && hmrState.openCodeAuthSource.length > 0
      ? hmrState.openCodeAuthSource
      : (userProvidedOpenCodePassword ? 'user-env' : null);
};

// Module-level variables that shadow HMR state
// These are synced to/from hmrState to survive HMR reloads
let openCodeProcess = hmrState.openCodeProcess;
let openCodePort = hmrState.openCodePort;
let openCodeBaseUrl = hmrState.openCodeBaseUrl ?? null;
let isShuttingDown = hmrState.isShuttingDown;
let signalsAttached = hmrState.signalsAttached;
let openCodeWorkingDirectory = hmrState.openCodeWorkingDirectory;

/**
 * Check if an existing OpenCode process is still alive and responding
 * Used to reuse process across HMR reloads
 */
async function isOpenCodeProcessHealthy() {
  if (!openCodeProcess || !openCodePort) {
    return false;
  }

  // Health check via HTTP since SDK object doesn't expose exitCode
  try {
    const response = await fetch(`http://127.0.0.1:${openCodePort}/session`, {
      method: 'GET',
      headers: getOpenCodeAuthHeaders(),
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Probe if an external OpenCode instance is already running on the given port.
 * Unlike isOpenCodeProcessHealthy(), this doesn't require openCodeProcess to be set.
 * Used to auto-detect and connect to an existing OpenCode instance on startup.
 */
async function probeExternalOpenCode(port, origin) {
  if (!port || port <= 0) {
    return false;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const base = origin ?? `http://127.0.0.1:${port}`;
    const response = await fetch(`${base}/global/health`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.healthy === true;
  } catch {
    return false;
  }
}

const ENV_CONFIGURED_OPENCODE_PORT = (() => {
  const raw =
    process.env.OPENCODE_PORT ||
    process.env.OPENCHAMBER_OPENCODE_PORT ||
    process.env.OPENCHAMBER_INTERNAL_PORT;
  if (!raw) {
    return null;
  }
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
})();

const ENV_CONFIGURED_OPENCODE_HOST = (() => {
  const raw = process.env.OPENCODE_HOST?.trim();
  if (!raw) return null;

  const warnInvalidHost = (reason) => {
    console.warn(`[config] Ignoring OPENCODE_HOST=${JSON.stringify(raw)}: ${reason}`);
  };

  let url;
  try {
    url = new URL(raw);
  } catch {
    warnInvalidHost('not a valid URL');
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    warnInvalidHost(`must use http or https scheme (got ${JSON.stringify(url.protocol)})`);
    return null;
  }
  const port = parseInt(url.port, 10);
  if (!Number.isFinite(port) || port <= 0) {
    warnInvalidHost('must include an explicit port (example: http://hostname:4096)');
    return null;
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    warnInvalidHost('must not include path, query, or hash');
    return null;
  }
  return { origin: url.origin, port };
})();

// OPENCODE_HOST takes precedence over OPENCODE_PORT when both are set
const ENV_EFFECTIVE_PORT = ENV_CONFIGURED_OPENCODE_HOST?.port ?? ENV_CONFIGURED_OPENCODE_PORT;

const ENV_CONFIGURED_OPENCODE_HOSTNAME = (() => {
  const raw = process.env.OPENCHAMBER_OPENCODE_HOSTNAME;
  if (typeof raw !== 'string') {
    return '127.0.0.1';
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    console.warn(
      `[config] Ignoring OPENCHAMBER_OPENCODE_HOSTNAME=${JSON.stringify(raw)}: empty after trimming`,
    );
    return '127.0.0.1';
  }
  return trimmed;
})();

const ENV_SKIP_OPENCODE_START = process.env.OPENCODE_SKIP_START === 'true' ||
                                    process.env.OPENCHAMBER_SKIP_OPENCODE_START === 'true';
const ENV_DESKTOP_NOTIFY = process.env.OPENCHAMBER_DESKTOP_NOTIFY === 'true';
const ENV_CONFIGURED_OPENCODE_WSL_DISTRO =
  typeof process.env.OPENCODE_WSL_DISTRO === 'string' && process.env.OPENCODE_WSL_DISTRO.trim().length > 0
    ? process.env.OPENCODE_WSL_DISTRO.trim()
    : (
      typeof process.env.OPENCHAMBER_OPENCODE_WSL_DISTRO === 'string' &&
      process.env.OPENCHAMBER_OPENCODE_WSL_DISTRO.trim().length > 0
        ? process.env.OPENCHAMBER_OPENCODE_WSL_DISTRO.trim()
        : null
    );

// OpenCode server authentication (Basic Auth with username "opencode")

/**
 * Returns auth headers for OpenCode server requests if OPENCODE_SERVER_PASSWORD is set.
 * Uses Basic Auth with username "opencode" and the password from the env variable.
 */
function getOpenCodeAuthHeaders() {
  const password = normalizeOpenCodePassword(openCodeAuthPassword || process.env.OPENCODE_SERVER_PASSWORD || '');
  
  if (!password) {
    return {};
  }
  
  const credentials = Buffer.from(`opencode:${password}`).toString('base64');
  return { Authorization: `Basic ${credentials}` };
}

function isOpenCodeConnectionSecure() {
  return Object.prototype.hasOwnProperty.call(getOpenCodeAuthHeaders(), 'Authorization');
}

function generateSecureOpenCodePassword() {
  return crypto
    .randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function isValidOpenCodePassword(password) {
  return typeof password === 'string' && password.trim().length > 0;
}

function setOpenCodeAuthState(password, source) {
  const normalized = normalizeOpenCodePassword(password);
  if (!isValidOpenCodePassword(normalized)) {
    openCodeAuthPassword = null;
    openCodeAuthSource = null;
    delete process.env.OPENCODE_SERVER_PASSWORD;
    syncToHmrState();
    return null;
  }

  openCodeAuthPassword = normalized;
  openCodeAuthSource = source;
  process.env.OPENCODE_SERVER_PASSWORD = normalized;
  syncToHmrState();
  return normalized;
}

async function ensureLocalOpenCodeServerPassword({ rotateManaged = false } = {}) {
  if (isValidOpenCodePassword(userProvidedOpenCodePassword)) {
    return setOpenCodeAuthState(userProvidedOpenCodePassword, 'user-env');
  }

  if (rotateManaged) {
    const rotatedPassword = setOpenCodeAuthState(generateSecureOpenCodePassword(), 'rotated');
    console.log('Rotated secure password for managed local OpenCode instance');
    return rotatedPassword;
  }

  if (isValidOpenCodePassword(openCodeAuthPassword)) {
    return setOpenCodeAuthState(openCodeAuthPassword, openCodeAuthSource || 'generated');
  }

  const generatedPassword = setOpenCodeAuthState(generateSecureOpenCodePassword(), 'generated');
  console.log('Generated secure password for managed local OpenCode instance');
  return generatedPassword;
}

let cachedLoginShellEnvSnapshot = undefined;

function parseNullSeparatedEnvSnapshot(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }

  const result = {};
  const entries = raw.split('\0');
  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    const idx = entry.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = entry.slice(0, idx);
    const value = entry.slice(idx + 1);
    result[key] = value;
  }

  return Object.keys(result).length > 0 ? result : null;
}

function getLoginShellEnvSnapshot() {
  if (cachedLoginShellEnvSnapshot !== undefined) {
    return cachedLoginShellEnvSnapshot;
  }

  if (process.platform === 'win32') {
    const windowsSnapshot = getWindowsShellEnvSnapshot();
    cachedLoginShellEnvSnapshot = windowsSnapshot;
    return windowsSnapshot;
  }

  const shellCandidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);

  for (const shellPath of shellCandidates) {
    if (!isExecutable(shellPath)) {
      continue;
    }

    try {
      const result = spawnSync(shellPath, ['-lic', 'env -0'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });

      if (result.status !== 0) {
        continue;
      }

      const parsed = parseNullSeparatedEnvSnapshot(result.stdout || '');
      if (parsed) {
        cachedLoginShellEnvSnapshot = parsed;
        return parsed;
      }
    } catch {
      // ignore
    }
  }

  cachedLoginShellEnvSnapshot = null;
  return null;
}

function getWindowsShellEnvSnapshot() {
  const parseResult = (stdout) => parseNullSeparatedEnvSnapshot(typeof stdout === 'string' ? stdout : '');

  const psScript =
    "Get-ChildItem Env: | ForEach-Object { [Console]::Out.Write($_.Name); [Console]::Out.Write('='); [Console]::Out.Write($_.Value); [Console]::Out.Write([char]0) }";

  const powershellCandidates = [
    'pwsh.exe',
    'powershell.exe',
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];

  for (const shellPath of powershellCandidates) {
    try {
      const result = spawnSync(shellPath, ['-NoLogo', '-Command', psScript], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
      if (result.status !== 0) {
        continue;
      }
      const parsed = parseResult(result.stdout);
      if (parsed) {
        return parsed;
      }
    } catch {
      // ignore
    }
  }

  const comspec = process.env.ComSpec || 'cmd.exe';
  try {
    const result = spawnSync(comspec, ['/d', '/s', '/c', 'set'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.status === 0 && typeof result.stdout === 'string' && result.stdout.length > 0) {
      return parseNullSeparatedEnvSnapshot(result.stdout.replace(/\r?\n/g, '\0'));
    }
  } catch {
    // ignore
  }

  return null;
}

function mergePathValues(preferred, fallback) {
  const merged = new Set();

  const addSegments = (value) => {
    if (typeof value !== 'string' || !value) {
      return;
    }
    for (const segment of value.split(path.delimiter)) {
      if (segment) {
        merged.add(segment);
      }
    }
  };

  addSegments(preferred);
  addSegments(fallback);

  return Array.from(merged).join(path.delimiter);
}

function applyLoginShellEnvSnapshot() {
  const snapshot = getLoginShellEnvSnapshot();
  if (!snapshot) {
    return;
  }

  const skipKeys = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);

  for (const [key, value] of Object.entries(snapshot)) {
    if (skipKeys.has(key)) {
      continue;
    }
    const existing = process.env[key];
    if (typeof existing === 'string' && existing.length > 0) {
      continue;
    }
    process.env[key] = value;
  }

  process.env.PATH = mergePathValues(snapshot.PATH || '', process.env.PATH || '');
}

applyLoginShellEnvSnapshot();

const ENV_CONFIGURED_API_PREFIX = normalizeApiPrefix(
  process.env.OPENCODE_API_PREFIX || process.env.OPENCHAMBER_API_PREFIX || ''
);

  if (ENV_CONFIGURED_API_PREFIX && ENV_CONFIGURED_API_PREFIX !== '') {
  console.warn('Ignoring configured OpenCode API prefix; API runs at root.');
}

let globalEventWatcherAbortController = null;

let resolvedOpencodeBinary = null;
let resolvedOpencodeBinarySource = null;
let resolvedNodeBinary = null;
let resolvedBunBinary = null;
let resolvedGitBinary = null;
let useWslForOpencode = false;
let resolvedWslBinary = null;
let resolvedWslOpencodePath = null;
let resolvedWslDistro = null;

function resolveGitBinaryForSpawn() {
  if (process.platform !== 'win32') {
    return 'git';
  }

  if (resolvedGitBinary) {
    return resolvedGitBinary;
  }

  const explicit = [process.env.GIT_BINARY, process.env.OPENCHAMBER_GIT_BINARY]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  for (const candidate of explicit) {
    if (isExecutable(candidate)) {
      resolvedGitBinary = candidate;
      return resolvedGitBinary;
    }
  }

  const candidates = [];
  const normalizeGitCandidate = (candidate) => {
    if (typeof candidate !== 'string') {
      return '';
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      return '';
    }
    const ext = path.extname(trimmed).toLowerCase();
    if (ext === '.cmd' || ext === '.bat' || ext === '.com') {
      const exeCandidate = trimmed.slice(0, -ext.length) + '.exe';
      if (isExecutable(exeCandidate)) {
        return exeCandidate;
      }
    }
    return trimmed;
  };

  const pathCandidate = normalizeGitCandidate(searchPathFor('git'));
  if (pathCandidate && isExecutable(pathCandidate)) {
    candidates.push(pathCandidate);
  }

  const pathExeCandidate = normalizeGitCandidate(searchPathFor('git.exe'));
  if (pathExeCandidate && isExecutable(pathExeCandidate)) {
    candidates.push(pathExeCandidate);
  }

  const programRoots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LocalAppData,
  ]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  for (const root of programRoots) {
    const installCandidates = [
      path.join(root, 'Git', 'cmd', 'git.exe'),
      path.join(root, 'Git', 'bin', 'git.exe'),
      path.join(root, 'Git', 'mingw64', 'bin', 'git.exe'),
      path.join(root, 'Programs', 'Git', 'cmd', 'git.exe'),
      path.join(root, 'Programs', 'Git', 'bin', 'git.exe'),
    ];
    for (const candidate of installCandidates) {
      const normalized = normalizeGitCandidate(candidate);
      if (normalized && isExecutable(normalized)) {
        candidates.push(normalized);
      }
    }
  }

  const preferredExe = candidates.find((candidate) => candidate.toLowerCase().endsWith('.exe'));
  resolvedGitBinary = preferredExe || candidates[0] || 'git.exe';
  return resolvedGitBinary;
}

function isExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') {
      const ext = path.extname(filePath).toLowerCase();
      if (!ext) return true;
      return ['.exe', '.cmd', '.bat', '.com'].includes(ext);
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function prependToPath(dir) {
  const trimmed = typeof dir === 'string' ? dir.trim() : '';
  if (!trimmed) return;
  const current = process.env.PATH || '';
  const parts = current.split(path.delimiter).filter(Boolean);
  if (parts.includes(trimmed)) return;
  process.env.PATH = [trimmed, ...parts].join(path.delimiter);
}

function searchPathFor(binaryName) {
  const current = process.env.PATH || '';
  const parts = current.split(path.delimiter).filter(Boolean);
  for (const dir of parts) {
    const candidate = path.join(dir, binaryName);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isWslExecutableValue(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /(^|[\\/])wsl(\.exe)?$/i.test(trimmed);
}

function clearWslOpencodeResolution() {
  useWslForOpencode = false;
  resolvedWslBinary = null;
  resolvedWslOpencodePath = null;
  resolvedWslDistro = null;
}

function resolveWslExecutablePath() {
  if (process.platform !== 'win32') {
    return null;
  }

  const explicit = [process.env.WSL_BINARY, process.env.OPENCHAMBER_WSL_BINARY]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);

  for (const candidate of explicit) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  try {
    const result = spawnSync('where', ['wsl'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (result.status === 0) {
      const lines = (result.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const found = lines.find((line) => isExecutable(line));
      if (found) {
        return found;
      }
    }
  } catch {
    // ignore
  }

  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const fallback = path.join(systemRoot, 'System32', 'wsl.exe');
  if (isExecutable(fallback)) {
    return fallback;
  }

  return null;
}

function buildWslExecArgs(execArgs, distroOverride = null) {
  const distro = typeof distroOverride === 'string' && distroOverride.trim().length > 0
    ? distroOverride.trim()
    : ENV_CONFIGURED_OPENCODE_WSL_DISTRO;

  const prefix = distro ? ['-d', distro] : [];
  return [...prefix, '--exec', ...execArgs];
}

function probeWslForOpencode() {
  if (process.platform !== 'win32') {
    return null;
  }

  const wslBinary = resolveWslExecutablePath();
  if (!wslBinary) {
    return null;
  }

  try {
    const result = spawnSync(
      wslBinary,
      buildWslExecArgs(['sh', '-lc', 'command -v opencode']),
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 6000,
        windowsHide: true,
      },
    );

    if (result.status !== 0) {
      return null;
    }

    const lines = (result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const found = lines[0] || '';
    if (!found) {
      return null;
    }

    return {
      wslBinary,
      opencodePath: found,
      distro: ENV_CONFIGURED_OPENCODE_WSL_DISTRO,
    };
  } catch {
    return null;
  }
}

function applyWslOpencodeResolution({ wslBinary, opencodePath, source = 'wsl', distro = null } = {}) {
  const resolvedWsl = wslBinary || resolveWslExecutablePath();
  if (!resolvedWsl) {
    return null;
  }

  useWslForOpencode = true;
  resolvedWslBinary = resolvedWsl;
  resolvedWslOpencodePath = typeof opencodePath === 'string' && opencodePath.trim().length > 0
    ? opencodePath.trim()
    : 'opencode';
  resolvedWslDistro = typeof distro === 'string' && distro.trim().length > 0 ? distro.trim() : ENV_CONFIGURED_OPENCODE_WSL_DISTRO;
  resolvedOpencodeBinary = `wsl:${resolvedWslOpencodePath}`;
  resolvedOpencodeBinarySource = source;

  // Keep OPENCODE_BINARY empty in WSL mode to avoid native spawn attempts.
  delete process.env.OPENCODE_BINARY;
  return resolvedOpencodeBinary;
}

function resolveOpencodeCliPath() {
  const explicit = [
    process.env.OPENCODE_BINARY,
    process.env.OPENCODE_PATH,
    process.env.OPENCHAMBER_OPENCODE_PATH,
    process.env.OPENCHAMBER_OPENCODE_BIN,
  ]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);

  for (const candidate of explicit) {
    if (isExecutable(candidate)) {
      clearWslOpencodeResolution();
      resolvedOpencodeBinarySource = 'env';
      return candidate;
    }
  }

  const resolvedFromPath = searchPathFor('opencode');
  if (resolvedFromPath) {
    clearWslOpencodeResolution();
    resolvedOpencodeBinarySource = 'path';
    return resolvedFromPath;
  }

  const home = os.homedir();
  const unixFallbacks = [
    path.join(home, '.opencode', 'bin', 'opencode'),
    path.join(home, '.bun', 'bin', 'opencode'),
    path.join(home, '.local', 'bin', 'opencode'),
    path.join(home, 'bin', 'opencode'),
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
    '/usr/bin/opencode',
    '/bin/opencode',
  ];

  const winFallbacks = (() => {
    const userProfile = process.env.USERPROFILE || home;
    const appData = process.env.APPDATA || '';
    const localAppData = process.env.LOCALAPPDATA || '';
    const programData = process.env.ProgramData || 'C:\\ProgramData';

    return [
      path.join(userProfile, '.opencode', 'bin', 'opencode.exe'),
      path.join(userProfile, '.opencode', 'bin', 'opencode.cmd'),
      path.join(appData, 'npm', 'opencode.cmd'),
      path.join(userProfile, 'scoop', 'shims', 'opencode.cmd'),
      path.join(programData, 'chocolatey', 'bin', 'opencode.exe'),
      path.join(programData, 'chocolatey', 'bin', 'opencode.cmd'),
      path.join(userProfile, '.bun', 'bin', 'opencode.exe'),
      path.join(userProfile, '.bun', 'bin', 'opencode.cmd'),
      localAppData ? path.join(localAppData, 'Programs', 'opencode', 'opencode.exe') : '',
    ].filter(Boolean);
  })();

  const fallbacks = process.platform === 'win32' ? winFallbacks : unixFallbacks;
  for (const candidate of fallbacks) {
    if (isExecutable(candidate)) {
      clearWslOpencodeResolution();
      resolvedOpencodeBinarySource = 'fallback';
      return candidate;
    }
  }

  if (process.platform === 'win32') {
    try {
      const result = spawnSync('where', ['opencode'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      if (result.status === 0) {
        const lines = (result.stdout || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const found = lines.find((line) => isExecutable(line));
        if (found) {
          clearWslOpencodeResolution();
          resolvedOpencodeBinarySource = 'where';
          return found;
        }
      }
    } catch {
      // ignore
    }
    const wsl = probeWslForOpencode();
    if (wsl) {
      return applyWslOpencodeResolution({
        wslBinary: wsl.wslBinary,
        opencodePath: wsl.opencodePath,
        source: 'wsl',
        distro: wsl.distro,
      });
    }
    return null;
  }

  const shells = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);
  for (const shell of shells) {
    if (!isExecutable(shell)) continue;
    try {
      const result = spawnSync(shell, ['-lic', 'command -v opencode'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      if (result.status === 0) {
        const found = (result.stdout || '').trim().split(/\s+/).pop() || '';
        if (found && isExecutable(found)) {
          clearWslOpencodeResolution();
          resolvedOpencodeBinarySource = 'shell';
          return found;
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function resolveNodeCliPath() {
  const explicit = [process.env.NODE_BINARY, process.env.OPENCHAMBER_NODE_BINARY]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);

  for (const candidate of explicit) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  const resolvedFromPath = searchPathFor('node');
  if (resolvedFromPath) {
    return resolvedFromPath;
  }

  const unixFallbacks = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    '/bin/node',
  ];
  for (const candidate of unixFallbacks) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  if (process.platform === 'win32') {
    try {
      const result = spawnSync('where', ['node'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      if (result.status === 0) {
        const lines = (result.stdout || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const found = lines.find((line) => isExecutable(line));
        if (found) return found;
      }
    } catch {
      // ignore
    }
    return null;
  }

  const shells = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);
  for (const shell of shells) {
    if (!isExecutable(shell)) continue;
    try {
      const result = spawnSync(shell, ['-lic', 'command -v node'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      if (result.status === 0) {
        const found = (result.stdout || '').trim().split(/\s+/).pop() || '';
        if (found && isExecutable(found)) {
          return found;
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function resolveBunCliPath() {
  const explicit = [process.env.BUN_BINARY, process.env.OPENCHAMBER_BUN_BINARY]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);

  for (const candidate of explicit) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  const resolvedFromPath = searchPathFor('bun');
  if (resolvedFromPath) {
    return resolvedFromPath;
  }

  const home = os.homedir();
  const unixFallbacks = [
    path.join(home, '.bun', 'bin', 'bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
    '/usr/bin/bun',
    '/bin/bun',
  ];
  for (const candidate of unixFallbacks) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  if (process.platform === 'win32') {
    const userProfile = process.env.USERPROFILE || home;
    const winFallbacks = [
      path.join(userProfile, '.bun', 'bin', 'bun.exe'),
      path.join(userProfile, '.bun', 'bin', 'bun.cmd'),
    ];
    for (const candidate of winFallbacks) {
      if (isExecutable(candidate)) return candidate;
    }

    try {
      const result = spawnSync('where', ['bun'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      if (result.status === 0) {
        const lines = (result.stdout || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const found = lines.find((line) => isExecutable(line));
        if (found) return found;
      }
    } catch {
      // ignore
    }
    return null;
  }

  const shells = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);
  for (const shell of shells) {
    if (!isExecutable(shell)) continue;
    try {
      const result = spawnSync(shell, ['-lic', 'command -v bun'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      if (result.status === 0) {
        const found = (result.stdout || '').trim().split(/\s+/).pop() || '';
        if (found && isExecutable(found)) {
          return found;
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function ensureBunCliEnv() {
  if (resolvedBunBinary) {
    return resolvedBunBinary;
  }

  const resolved = resolveBunCliPath();
  if (resolved) {
    prependToPath(path.dirname(resolved));
    resolvedBunBinary = resolved;
    return resolved;
  }

  return null;
}

function ensureNodeCliEnv() {
  if (resolvedNodeBinary) {
    return resolvedNodeBinary;
  }

  const resolved = resolveNodeCliPath();
  if (resolved) {
    prependToPath(path.dirname(resolved));
    resolvedNodeBinary = resolved;
    return resolved;
  }

  return null;
}

function readShebang(opencodePath) {
  if (!opencodePath || typeof opencodePath !== 'string') {
    return null;
  }
  try {
    // Best effort: detect "#!/usr/bin/env <runtime>" without reading whole file.
    const fd = fs.openSync(opencodePath, 'r');
    try {
      const buf = Buffer.alloc(256);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = buf.subarray(0, bytes).toString('utf8');
      const firstLine = head.split(/\r?\n/, 1)[0] || '';
      if (!firstLine.startsWith('#!')) {
        return null;
      }
      const shebang = firstLine.slice(2).trim();
      if (!shebang) {
        return null;
      }
      return shebang;
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  } catch {
    return null;
  }
}

function opencodeShimInterpreter(opencodePath) {
  const shebang = readShebang(opencodePath);
  if (!shebang) return null;
  if (/\bnode\b/i.test(shebang)) return 'node';
  if (/\bbun\b/i.test(shebang)) return 'bun';
  return null;
}

function ensureOpencodeShimRuntime(opencodePath) {
  const runtime = opencodeShimInterpreter(opencodePath);
  if (runtime === 'node') {
    ensureNodeCliEnv();
  }
  if (runtime === 'bun') {
    ensureBunCliEnv();
  }
}

function normalizeOpencodeBinarySetting(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = normalizeDirectoryPath(raw).trim();
  if (!trimmed) {
    return '';
  }

  try {
    const stat = fs.statSync(trimmed);
    if (stat.isDirectory()) {
      const bin = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
      return path.join(trimmed, bin);
    }
  } catch {
    // ignore
  }

  return trimmed;
}

async function applyOpencodeBinaryFromSettings() {
  try {
    const settings = await readSettingsFromDiskMigrated();
    if (!settings || typeof settings !== 'object') {
      return null;
    }
    if (!Object.prototype.hasOwnProperty.call(settings, 'opencodeBinary')) {
      return null;
    }

    const normalized = normalizeOpencodeBinarySetting(settings.opencodeBinary);

    if (normalized === '') {
      delete process.env.OPENCODE_BINARY;
      resolvedOpencodeBinary = null;
      resolvedOpencodeBinarySource = null;
      clearWslOpencodeResolution();
      return null;
    }

    const raw = typeof settings.opencodeBinary === 'string' ? settings.opencodeBinary.trim() : '';

    const explicitWslPath = process.platform === 'win32' && typeof raw === 'string'
      ? raw.match(/^wsl:\s*(.+)$/i)
      : null;

    if (explicitWslPath && explicitWslPath[1] && explicitWslPath[1].trim().length > 0) {
      const probe = probeWslForOpencode();
      const applied = applyWslOpencodeResolution({
        wslBinary: probe?.wslBinary || resolveWslExecutablePath(),
        opencodePath: explicitWslPath[1].trim(),
        source: 'settings-wsl-path',
        distro: probe?.distro || ENV_CONFIGURED_OPENCODE_WSL_DISTRO,
      });
      if (applied) {
        return applied;
      }
    }

    if (process.platform === 'win32' && (isWslExecutableValue(raw) || isWslExecutableValue(normalized || ''))) {
      const probe = probeWslForOpencode();
      const applied = applyWslOpencodeResolution({
        wslBinary: probe?.wslBinary || normalized || raw || null,
        opencodePath: probe?.opencodePath || 'opencode',
        source: 'settings-wsl',
        distro: probe?.distro || ENV_CONFIGURED_OPENCODE_WSL_DISTRO,
      });
      if (applied) {
        return applied;
      }
    }

    if (normalized && isExecutable(normalized)) {
      clearWslOpencodeResolution();
      process.env.OPENCODE_BINARY = normalized;
      prependToPath(path.dirname(normalized));
      resolvedOpencodeBinary = normalized;
      resolvedOpencodeBinarySource = 'settings';
      ensureOpencodeShimRuntime(normalized);
      return normalized;
    }

    if (raw) {
      console.warn(`Configured settings.opencodeBinary is not executable: ${raw}`);
    }
  } catch {
    // ignore
  }

  return null;
}

function ensureOpencodeCliEnv() {
  if (resolvedOpencodeBinary) {
    if (useWslForOpencode) {
      return resolvedOpencodeBinary;
    }
    ensureOpencodeShimRuntime(resolvedOpencodeBinary);
    return resolvedOpencodeBinary;
  }

  const existing = typeof process.env.OPENCODE_BINARY === 'string' ? process.env.OPENCODE_BINARY.trim() : '';
  if (existing && isExecutable(existing)) {
    clearWslOpencodeResolution();
    resolvedOpencodeBinary = existing;
    resolvedOpencodeBinarySource = resolvedOpencodeBinarySource || 'env';
    prependToPath(path.dirname(existing));
    ensureOpencodeShimRuntime(existing);
    return resolvedOpencodeBinary;
  }

  const resolved = resolveOpencodeCliPath();
  if (resolved) {
    if (useWslForOpencode) {
      resolvedOpencodeBinary = resolved;
      resolvedOpencodeBinarySource = resolvedOpencodeBinarySource || 'wsl';
      console.log(`Resolved opencode CLI via WSL: ${resolvedWslOpencodePath || 'opencode'}`);
      return resolved;
    }

    process.env.OPENCODE_BINARY = resolved;
    prependToPath(path.dirname(resolved));
    ensureOpencodeShimRuntime(resolved);
    resolvedOpencodeBinary = resolved;
    resolvedOpencodeBinarySource = resolvedOpencodeBinarySource || 'unknown';
    console.log(`Resolved opencode CLI: ${resolved}`);
    return resolved;
  }

  clearWslOpencodeResolution();
  return null;
}

const startGlobalEventWatcher = async () => {
  if (globalEventWatcherAbortController) {
    return;
  }

  await waitForOpenCodePort();

  globalEventWatcherAbortController = new AbortController();
  const signal = globalEventWatcherAbortController.signal;

  let attempt = 0;

  const run = async () => {
    while (!signal.aborted) {
      attempt += 1;
      let upstream;
      let reader;
      try {
        const url = buildOpenCodeUrl('/global/event', '');
        upstream = await fetch(url, {
          headers: {
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...getOpenCodeAuthHeaders(),
          },
          signal,
        });

        if (!upstream.ok || !upstream.body) {
          throw new Error(`bad status ${upstream.status}`);
        }

        console.log('[PushWatcher] connected');

        const decoder = new TextDecoder();
        reader = upstream.body.getReader();
        let buffer = '';

        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

          let separatorIndex = buffer.indexOf('\n\n');
          while (separatorIndex !== -1) {
            const block = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + 2);
            separatorIndex = buffer.indexOf('\n\n');
            const payload = parseSseDataPayload(block);
            // Cache session titles from session.updated/session.created events
            maybeCacheSessionInfoFromEvent(payload);
            void maybeSendPushForTrigger(payload);
            // Track session activity independently of UI (mirrors Tauri desktop behavior)
            const transitions = deriveSessionActivityTransitions(payload);
            if (transitions && transitions.length > 0) {
              for (const activity of transitions) {
                setSessionActivityPhase(activity.sessionId, activity.phase);
              }
            }

            // Update authoritative session state from OpenCode events
            if (payload && payload.type === 'session.status') {
              const update = extractSessionStatusUpdate(payload);
              if (update) {
                updateSessionState(update.sessionId, update.type, update.eventId || `sse-${Date.now()}`, {
                  attempt: update.attempt,
                  message: update.message,
                  next: update.next,
                });
              }
            }
          }
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        console.warn('[PushWatcher] disconnected', error?.message ?? error);
      } finally {
        try {
          if (reader) {
            await reader.cancel();
            reader.releaseLock();
          } else if (upstream?.body && !upstream.body.locked) {
            await upstream.body.cancel();
          }
        } catch {
          // ignore
        }
      }

      const backoffMs = Math.min(1000 * Math.pow(2, Math.min(attempt, 5)), 30000);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  };

  void run();
};

const stopGlobalEventWatcher = () => {
  if (!globalEventWatcherAbortController) {
    return;
  }
  try {
    globalEventWatcherAbortController.abort();
  } catch {
    // ignore
  }
  globalEventWatcherAbortController = null;
};


function setOpenCodePort(port) {
  if (!Number.isFinite(port) || port <= 0) {
    return;
  }

  const numericPort = Math.trunc(port);
  const portChanged = openCodePort !== numericPort;

  if (portChanged || openCodePort === null) {
    openCodePort = numericPort;
    syncToHmrState();
    console.log(`Detected OpenCode port: ${openCodePort}`);

    if (portChanged) {
      isOpenCodeReady = false;
    }
    openCodeNotReadySince = Date.now();
  }

  lastOpenCodeError = null;
}

async function waitForOpenCodePort(timeoutMs = 15000) {
  if (openCodePort !== null) {
    return openCodePort;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (openCodePort !== null) {
      return openCodePort;
    }
  }

  throw new Error('Timed out waiting for OpenCode port');
}

function getLoginShellPath() {
  const snapshot = getLoginShellEnvSnapshot();
  if (!snapshot || typeof snapshot.PATH !== 'string' || snapshot.PATH.length === 0) {
    return null;
  }
  return snapshot.PATH;
}

function buildAugmentedPath() {
  const augmented = new Set();

  const loginShellPath = getLoginShellPath();
  if (loginShellPath) {
    for (const segment of loginShellPath.split(path.delimiter)) {
      if (segment) {
        augmented.add(segment);
      }
    }
  }

  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const segment of current) {
    augmented.add(segment);
  }

  return Array.from(augmented).join(path.delimiter);
}

const API_PREFIX_CANDIDATES = [''];

async function waitForReady(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${url.replace(/\/+$/, '')}/global/health`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.healthy === true) {
          return true;
        }
      }
    } catch {
      // ignore
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

function normalizeApiPrefix(prefix) {
  if (!prefix) {
    return '';
  }

  if (prefix.includes('://')) {
    try {
      const parsed = new URL(prefix);
      return normalizeApiPrefix(parsed.pathname);
    } catch (error) {
      return '';
    }
  }

  const trimmed = prefix.trim();
  if (!trimmed || trimmed === '/') {
    return '';
  }
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading;
}

function setDetectedOpenCodeApiPrefix() {
  openCodeApiPrefix = '';
  openCodeApiPrefixDetected = true;
  if (openCodeApiDetectionTimer) {
    clearTimeout(openCodeApiDetectionTimer);
    openCodeApiDetectionTimer = null;
  }
}

function getCandidateApiPrefixes() {
  return API_PREFIX_CANDIDATES;
}

function buildOpenCodeUrl(path, prefixOverride) {
  if (!openCodePort) {
    throw new Error('OpenCode port is not available');
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const prefix = normalizeApiPrefix(prefixOverride !== undefined ? prefixOverride : '');
  const fullPath = `${prefix}${normalizedPath}`;
  const base = openCodeBaseUrl ?? `http://localhost:${openCodePort}`;
  return `${base}${fullPath}`;
}

function parseSseDataPayload(block) {
  if (!block || typeof block !== 'string') {
    return null;
  }
  const dataLines = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^\s/, ''));

  if (dataLines.length === 0) {
    return null;
  }

  const payloadText = dataLines.join('\n').trim();
  if (!payloadText) {
    return null;
  }

  try {
    const parsed = JSON.parse(payloadText);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.payload === 'object' &&
      parsed.payload !== null
    ) {
      return parsed.payload;
    }
    return parsed;
  } catch {
    return null;
  }
}

function extractSessionStatusUpdate(payload) {
  if (!payload || typeof payload !== 'object' || payload.type !== 'session.status') {
    return null;
  }

  const props = payload.properties ?? {};
  const status =
    props.status ??
    props.session?.status ??
    props.sessionInfo?.status;
  const metadata =
    props.metadata ??
    (typeof status === 'object' && status !== null ? status.metadata : null);

  const sessionId = props.sessionID ?? props.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return null;
  }

  const statusType =
    typeof status === 'string'
      ? status
      : typeof status?.type === 'string'
        ? status.type
        : typeof status?.status === 'string'
          ? status.status
          : typeof props.type === 'string'
            ? props.type
            : typeof props.phase === 'string'
              ? props.phase
              : typeof props.state === 'string'
                ? props.state
                : null;

  const normalizedType =
    statusType === 'idle' || statusType === 'busy' || statusType === 'retry'
      ? statusType
      : null;

  if (!normalizedType) {
    return null;
  }

  const attempt =
    typeof status?.attempt === 'number'
      ? status.attempt
      : typeof props.attempt === 'number'
        ? props.attempt
        : typeof metadata?.attempt === 'number'
          ? metadata.attempt
          : undefined;
  const message =
    typeof status?.message === 'string'
      ? status.message
      : typeof props.message === 'string'
        ? props.message
        : typeof metadata?.message === 'string'
          ? metadata.message
          : undefined;
  const next =
    typeof status?.next === 'number'
      ? status.next
      : typeof props.next === 'number'
        ? props.next
        : typeof metadata?.next === 'number'
          ? metadata.next
          : undefined;

  return {
    sessionId,
    type: normalizedType,
    attempt,
    message,
    next,
    eventId: typeof props.eventId === 'string' ? props.eventId : null,
  };
}

function emitDesktopNotification(payload) {
  if (!ENV_DESKTOP_NOTIFY) {
    return;
  }

  if (!payload || typeof payload !== 'object') {
    return;
  }

  try {
    // One-line protocol consumed by the Tauri shell.
    process.stdout.write(`${DESKTOP_NOTIFY_PREFIX}${JSON.stringify(payload)}\n`);
  } catch {
    // ignore
  }
}

function broadcastUiNotification(payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  if (uiNotificationClients.size === 0) {
    return;
  }

  for (const res of uiNotificationClients) {
    try {
      writeSseEvent(res, {
        type: 'openchamber:notification',
        properties: {
          ...payload,
          // Tell the UI whether the sidecar stdout notification channel is active.
          // When true, the desktop UI should skip this SSE notification to avoid duplicates.
          // When false (e.g. tauri dev), the UI must handle this SSE notification itself.
          desktopStdoutActive: ENV_DESKTOP_NOTIFY,
        },
      });
    } catch {
      // ignore
    }
  }
}

function isStreamingAssistantPart(properties) {
  if (!properties || typeof properties !== 'object') {
    return false;
  }

  const info = properties?.info;
  const role = info?.role;
  if (role !== 'assistant') {
    return false;
  }

  const part = properties?.part;
  const partType = part?.type;
  return (
    partType === 'step-start' ||
    partType === 'text' ||
    partType === 'tool' ||
    partType === 'reasoning' ||
    partType === 'file' ||
    partType === 'patch'
  );
}

function deriveSessionActivityTransitions(payload) {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  if (payload.type === 'session.status') {
    const update = extractSessionStatusUpdate(payload);
    if (update) {
      const phase = update.type === 'busy' || update.type === 'retry' ? 'busy' : 'idle';
      return [{ sessionId: update.sessionId, phase }];
    }
  }

  if (payload.type === 'message.updated') {
    const info = payload.properties?.info;
    const sessionId = info?.sessionID ?? info?.sessionId ?? payload.properties?.sessionID ?? payload.properties?.sessionId;
    const role = info?.role;
    const finish = info?.finish;
    if (typeof sessionId === 'string' && sessionId.length > 0 && role === 'assistant' && finish === 'stop') {
      return [{ sessionId, phase: 'cooldown' }];
    }
  }

  if (payload.type === 'message.part.updated' || payload.type === 'message.part.delta') {
    const info = payload.properties?.info;
    const sessionId = info?.sessionID ?? info?.sessionId ?? payload.properties?.sessionID ?? payload.properties?.sessionId;
    const role = info?.role;
    const finish = info?.finish;

    if (typeof sessionId === 'string' && sessionId.length > 0 && role === 'assistant') {
      const transitions = [];

      // Desktop parity: mark busy when we see assistant parts streaming.
      if (isStreamingAssistantPart(payload.properties)) {
        transitions.push({ sessionId, phase: 'busy' });
      }

      // Desktop parity: enter cooldown when finish==stop.
      if (finish === 'stop') {
        transitions.push({ sessionId, phase: 'cooldown' });
      }

      return transitions;
    }
  }

  if (payload.type === 'session.idle') {
    const sessionId = payload.properties?.sessionID ?? payload.properties?.sessionId;
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      return [{ sessionId, phase: 'idle' }];
    }
  }

  return [];
}

const PUSH_READY_COOLDOWN_MS = 5000;
const PUSH_QUESTION_DEBOUNCE_MS = 500;
const PUSH_PERMISSION_DEBOUNCE_MS = 500;
const pushQuestionDebounceTimers = new Map();
const pushPermissionDebounceTimers = new Map();
const notifiedPermissionRequests = new Set();
const lastReadyNotificationAt = new Map();

// Cache: sessionId -> parentID (string) or null (no parent). Undefined = unknown.
const sessionParentIdCache = new Map();
const SESSION_PARENT_CACHE_TTL_MS = 60 * 1000;

const getCachedSessionParentId = (sessionId) => {
  const entry = sessionParentIdCache.get(sessionId);
  if (!entry) return undefined;
  if (Date.now() - entry.at > SESSION_PARENT_CACHE_TTL_MS) {
    sessionParentIdCache.delete(sessionId);
    return undefined;
  }
  return entry.parentID;
};

const setCachedSessionParentId = (sessionId, parentID) => {
  sessionParentIdCache.set(sessionId, { parentID: parentID ?? null, at: Date.now() });
};

const fetchSessionParentId = async (sessionId) => {
  if (!sessionId) return undefined;

  const cached = getCachedSessionParentId(sessionId);
  if (cached !== undefined) return cached;

  try {
    const response = await fetch(buildOpenCodeUrl('/session', ''), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...getOpenCodeAuthHeaders(),
       },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      return undefined;
    }
    const data = await response.json().catch(() => null);
    if (!Array.isArray(data)) {
      return undefined;
    }

    const match = data.find((s) => s && typeof s === 'object' && s.id === sessionId);
    const parentID = match?.parentID ? match.parentID : null;
    setCachedSessionParentId(sessionId, parentID);
    return parentID;
  } catch {
    return undefined;
  }
};

const extractSessionIdFromPayload = (payload) => {
  if (!payload || typeof payload !== 'object') return null;
  const props = payload.properties;
  const info = props?.info;
  const sessionId =
    info?.sessionID ??
    info?.sessionId ??
    props?.sessionID ??
    props?.sessionId ??
    props?.session ??
    null;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
};

const maybeSendPushForTrigger = async (payload) => {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  const sessionId = extractSessionIdFromPayload(payload);

  const formatMode = (raw) => {
    const value = typeof raw === 'string' ? raw.trim() : '';
    const normalized = value.length > 0 ? value : 'agent';
    return normalized
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
      .join(' ');
  };

  const formatModelId = (raw) => {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      return 'Assistant';
    }

    const tokens = value.split(/[-_]+/).filter(Boolean);
    const result = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const current = tokens[i];
      const next = tokens[i + 1];
      if (/^\d+$/.test(current) && next && /^\d+$/.test(next)) {
        result.push(`${current}.${next}`);
        i += 1;
        continue;
      }
      result.push(current);
    }

    return result
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  };

  if (payload.type === 'message.updated') {
    const info = payload.properties?.info;
    if (info?.role === 'assistant' && info?.finish === 'stop' && sessionId) {
      // Check if this is a subtask and if we should notify for subtasks
      const settings = await readSettingsFromDisk();

      if (settings.notifyOnSubtasks === false) {
        // Prefer parentID on payload (if present), else fetch from sessions list.
        const sessionInfo = payload.properties?.session;
        const parentIDFromPayload = sessionInfo?.parentID ?? payload.properties?.parentID;
        const parentID = parentIDFromPayload
          ? parentIDFromPayload
          : await fetchSessionParentId(sessionId);

        // Fail open: if parentID cannot be resolved, send notification.
        if (parentID) {
          return;
        }
      }

      // Check if completion notifications are enabled
      if (settings.notifyOnCompletion === false) {
        return;
      }

      const now = Date.now();
      const lastAt = lastReadyNotificationAt.get(sessionId) ?? 0;
      if (now - lastAt < PUSH_READY_COOLDOWN_MS) {
        return;
      }
      lastReadyNotificationAt.set(sessionId, now);

      // Resolve templates with fallback to legacy hardcoded values
      let title = `${formatMode(info?.mode)} agent is ready`;
      let body = `${formatModelId(info?.modelID)} completed the task`;

      try {
        const templates = settings.notificationTemplates || {};
        const isSubtask = await fetchSessionParentId(sessionId);
        const completionTemplate = isSubtask && settings.notifyOnSubtasks !== false
          ? (templates.subtask || templates.completion || { title: '{agent_name} is ready', message: '{model_name} completed the task' })
          : (templates.completion || { title: '{agent_name} is ready', message: '{model_name} completed the task' });

        const variables = await buildTemplateVariables(payload, sessionId);

        // Try fast-path (inline parts) first, then fetch from API
        const messageId = info?.id;
        let lastMessage = extractLastMessageText(payload);
        if (!lastMessage) {
          lastMessage = await fetchLastAssistantMessageText(sessionId, messageId);
        }

        const notifZenModel = await resolveZenModel(settings?.zenModel);
        variables.last_message = await prepareNotificationLastMessage({
          message: lastMessage,
          settings,
          summarize: (text, len) => summarizeText(text, len, notifZenModel),
        });

        const resolvedTitle = resolveNotificationTemplate(completionTemplate.title, variables);
        const resolvedBody = resolveNotificationTemplate(completionTemplate.message, variables);
        if (resolvedTitle) title = resolvedTitle;
        if (shouldApplyResolvedTemplateMessage(completionTemplate.message, resolvedBody, variables)) body = resolvedBody;
      } catch (err) {
        console.warn('[Notification] Template resolution failed, using defaults:', err?.message || err);
      }

      if (settings.nativeNotificationsEnabled) {
        const notificationPayload = {
          title,
          body,
          tag: `ready-${sessionId}`,
          kind: 'ready',
          sessionId,
          requireHidden: settings.notificationMode !== 'always',
        };
        emitDesktopNotification(notificationPayload);
        broadcastUiNotification(notificationPayload);
      }

      await sendPushToAllUiSessions(
        {
          title,
          body,
          tag: `ready-${sessionId}`,
          data: {
            url: buildSessionDeepLinkUrl(sessionId),
            sessionId,
            type: 'ready',
          }
        },
        { requireNoSse: true }
      );
    }

    // Check for error finish
    if (info?.role === 'assistant' && info?.finish === 'error' && sessionId) {
      const settings = await readSettingsFromDisk();
      if (settings.notifyOnError === false) return;

      let title = 'Tool error';
      let body = 'An error occurred';

      try {
        const variables = await buildTemplateVariables(payload, sessionId);

        // Try fast-path (inline parts) first, then fetch from API
        const errorMessageId = info?.id;
        let lastMessage = extractLastMessageText(payload);
        if (!lastMessage) {
          lastMessage = await fetchLastAssistantMessageText(sessionId, errorMessageId);
        }

        const errZenModel = await resolveZenModel(settings?.zenModel);
        variables.last_message = await prepareNotificationLastMessage({
          message: lastMessage,
          settings,
          summarize: (text, len) => summarizeText(text, len, errZenModel),
        });

        const errorTemplate = (settings.notificationTemplates || {}).error || { title: 'Tool error', message: '{last_message}' };
        const resolvedTitle = resolveNotificationTemplate(errorTemplate.title, variables);
        const resolvedBody = resolveNotificationTemplate(errorTemplate.message, variables);
        if (resolvedTitle) title = resolvedTitle;
        if (shouldApplyResolvedTemplateMessage(errorTemplate.message, resolvedBody, variables)) body = resolvedBody;
      } catch (err) {
        console.warn('[Notification] Error template resolution failed, using defaults:', err?.message || err);
      }

      if (settings.nativeNotificationsEnabled) {
        const notificationPayload = {
          title,
          body,
          tag: `error-${sessionId}`,
          kind: 'error',
          sessionId,
          requireHidden: settings.notificationMode !== 'always',
        };
        emitDesktopNotification(notificationPayload);
        broadcastUiNotification(notificationPayload);
      }

      await sendPushToAllUiSessions(
        {
          title,
          body,
          tag: `error-${sessionId}`,
          data: {
            url: buildSessionDeepLinkUrl(sessionId),
            sessionId,
            type: 'error',
          }
        },
        { requireNoSse: true }
      );
    }

    return;
  }


  if (payload.type === 'question.asked' && sessionId) {
    const existingTimer = pushQuestionDebounceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      pushQuestionDebounceTimers.delete(sessionId);

      const settings = await readSettingsFromDisk();

      // Check if question notifications are enabled
      if (settings.notifyOnQuestion === false) {
        return;
      }

      if (!settings.nativeNotificationsEnabled) {
        // Still send push even if native notifications are disabled
      }

      const firstQuestion = payload.properties?.questions?.[0];
      const header = typeof firstQuestion?.header === 'string' ? firstQuestion.header.trim() : '';
      const questionText = typeof firstQuestion?.question === 'string' ? firstQuestion.question.trim() : '';

      // Legacy fallback title
      let title = /plan\s*mode/i.test(header)
        ? 'Switch to plan mode'
        : /build\s*agent/i.test(header)
          ? 'Switch to build mode'
          : header || 'Input needed';
      let body = questionText || 'Agent is waiting for your response';

      try {
        // Build template variables
        const variables = await buildTemplateVariables(payload, sessionId);
        variables.last_message = questionText || header || '';

        // Get question template
        const templates = settings.notificationTemplates || {};
        const questionTemplate = templates.question || { title: 'Input needed', message: '{last_message}' };

        // Resolve templates with fallback to legacy behavior
        const resolvedTitle = resolveNotificationTemplate(questionTemplate.title, variables);
        const resolvedBody = resolveNotificationTemplate(questionTemplate.message, variables);
        if (resolvedTitle) title = resolvedTitle;
        if (shouldApplyResolvedTemplateMessage(questionTemplate.message, resolvedBody, variables)) body = resolvedBody;
      } catch (err) {
        console.warn('[Notification] Question template resolution failed, using defaults:', err?.message || err);
      }

      if (settings.nativeNotificationsEnabled) {
        emitDesktopNotification({
          kind: 'question',
          title,
          body,
          tag: `question-${sessionId}`,
          sessionId,
          requireHidden: settings.notificationMode !== 'always',
        });

        broadcastUiNotification({
          kind: 'question',
          title,
          body,
          tag: `question-${sessionId}`,
          sessionId,
          requireHidden: settings.notificationMode !== 'always',
        });
      }

      void sendPushToAllUiSessions(
        {
          title,
          body,
          tag: `question-${sessionId}`,
          data: {
            url: buildSessionDeepLinkUrl(sessionId),
            sessionId,
            type: 'question',
          }
        },
        { requireNoSse: true }
      );
    }, PUSH_QUESTION_DEBOUNCE_MS);

    pushQuestionDebounceTimers.set(sessionId, timer);
    return;
  }

  if (payload.type === 'permission.asked' && sessionId) {
    const requestId = payload.properties?.id;
    const permission = payload.properties?.permission;
    const requestKey = typeof requestId === 'string' ? `${sessionId}:${requestId}` : null;
    if (requestKey && notifiedPermissionRequests.has(requestKey)) {
      return;
    }

    const existingTimer = pushPermissionDebounceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      pushPermissionDebounceTimers.delete(sessionId);
      const settings = await readSettingsFromDisk();

      // Permission requests use the question event toggle (since permission requests are a type of "agent needs input")
      if (settings.notifyOnQuestion === false) {
        return;
      }

      if (!settings.nativeNotificationsEnabled) {
        // Still send push even if native notifications are disabled
      }

      const sessionTitle = payload.properties?.sessionTitle;
      const permissionText = typeof permission === 'string' && permission.length > 0 ? permission : '';
      const fallbackMessage = typeof sessionTitle === 'string' && sessionTitle.trim().length > 0
        ? sessionTitle.trim()
        : permissionText || 'Agent is waiting for your approval';

      let title = 'Permission required';
      let body = fallbackMessage;

      try {
        // Build template variables
        const variables = await buildTemplateVariables(payload, sessionId);
        variables.last_message = fallbackMessage;

        // Get question template (permission uses question template since it's an input request)
        const templates = settings.notificationTemplates || {};
        const questionTemplate = templates.question || { title: 'Permission required', message: '{last_message}' };

        // Resolve templates with fallback to legacy behavior
        const resolvedTitle = resolveNotificationTemplate(questionTemplate.title, variables);
        const resolvedBody = resolveNotificationTemplate(questionTemplate.message, variables);
        if (resolvedTitle) title = resolvedTitle;
        if (shouldApplyResolvedTemplateMessage(questionTemplate.message, resolvedBody, variables)) body = resolvedBody;
      } catch (err) {
        console.warn('[Notification] Permission template resolution failed, using defaults:', err?.message || err);
      }

      if (settings.nativeNotificationsEnabled) {
        emitDesktopNotification({
          kind: 'permission',
          title,
          body,
          tag: requestKey ? `permission-${requestKey}` : `permission-${sessionId}`,
          sessionId,
          requireHidden: settings.notificationMode !== 'always',
        });

        broadcastUiNotification({
          kind: 'permission',
          title,
          body,
          tag: requestKey ? `permission-${requestKey}` : `permission-${sessionId}`,
          sessionId,
          requireHidden: settings.notificationMode !== 'always',
        });
      }

      if (requestKey) {
        notifiedPermissionRequests.add(requestKey);
      }

      void sendPushToAllUiSessions(
        {
          title,
          body,
          tag: `permission-${sessionId}`,
          data: {
            url: buildSessionDeepLinkUrl(sessionId),
            sessionId,
            type: 'permission',
          }
        },
        { requireNoSse: true }
      );
    }, PUSH_PERMISSION_DEBOUNCE_MS);

    pushPermissionDebounceTimers.set(sessionId, timer);
  }
};

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function extractApiPrefixFromUrl() {
  return '';
}

function detectOpenCodeApiPrefix() {
  openCodeApiPrefixDetected = true;
  openCodeApiPrefix = '';
  return true;
}

function ensureOpenCodeApiPrefix() {
  return detectOpenCodeApiPrefix();
}

function scheduleOpenCodeApiDetection() {
  return;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const envPassword =
    process.env.OPENCHAMBER_UI_PASSWORD ||
    process.env.OPENCODE_UI_PASSWORD ||
    null;
  const envCfTunnel = process.env.OPENCHAMBER_TRY_CF_TUNNEL === 'true';
  const envTunnelProvider = process.env.OPENCHAMBER_TUNNEL_PROVIDER || undefined;
  const envTunnelMode = process.env.OPENCHAMBER_TUNNEL_MODE || undefined;
  const envTunnelConfigRaw = process.env.OPENCHAMBER_TUNNEL_CONFIG;
  const envTunnelConfig = typeof envTunnelConfigRaw === 'string'
    ? (envTunnelConfigRaw.trim().length > 0 ? envTunnelConfigRaw.trim() : null)
    : undefined;
  const envTunnelToken = process.env.OPENCHAMBER_TUNNEL_TOKEN || undefined;
  const envTunnelHostname = process.env.OPENCHAMBER_TUNNEL_HOSTNAME || undefined;

  const options = {
    port: DEFAULT_PORT,
    host: undefined,
    uiPassword: envPassword,
    tryCfTunnel: envCfTunnel,
    tunnelProvider: envTunnelProvider,
    tunnelMode: envTunnelMode,
    tunnelConfigPath: envTunnelConfig,
    tunnelToken: envTunnelToken,
    tunnelHostname: envTunnelHostname,
  };

  const consumeValue = (currentIndex, inlineValue) => {
    if (typeof inlineValue === 'string') {
      return { value: inlineValue, nextIndex: currentIndex };
    }
    const nextArg = args[currentIndex + 1];
    if (typeof nextArg === 'string' && !nextArg.startsWith('--')) {
      return { value: nextArg, nextIndex: currentIndex + 1 };
    }
    return { value: undefined, nextIndex: currentIndex };
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      continue;
    }

    const eqIndex = arg.indexOf('=');
    const optionName = eqIndex >= 0 ? arg.slice(2, eqIndex) : arg.slice(2);
    const inlineValue = eqIndex >= 0 ? arg.slice(eqIndex + 1) : undefined;

    if (optionName === 'port' || optionName === 'p') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      const parsedPort = parseInt(value ?? '', 10);
      options.port = Number.isFinite(parsedPort) ? parsedPort : DEFAULT_PORT;
      continue;
    }

    if (optionName === 'host') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.host = typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
      continue;
    }

    if (optionName === 'ui-password') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.uiPassword = typeof value === 'string' ? value : '';
      continue;
    }

    if (optionName === 'try-cf-tunnel') {
      options.tryCfTunnel = true;
      continue;
    }

    if (optionName === 'tunnel-provider') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelProvider = typeof value === 'string' ? value : options.tunnelProvider;
      continue;
    }

    if (optionName === 'tunnel-mode') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelMode = typeof value === 'string' ? value : options.tunnelMode;
      continue;
    }

    if (optionName === 'tunnel-config') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelConfigPath = typeof value === 'string' ? value : null;
      continue;
    }

    if (optionName === 'tunnel-token') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelToken = typeof value === 'string' ? value : options.tunnelToken;
      continue;
    }

    if (optionName === 'tunnel-hostname') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelHostname = typeof value === 'string' ? value : options.tunnelHostname;
      continue;
    }

    if (optionName === 'tunnel') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelProvider = TUNNEL_PROVIDER_CLOUDFLARE;
      options.tunnelMode = TUNNEL_MODE_MANAGED_LOCAL;
      options.tunnelConfigPath = typeof value === 'string' ? value : null;
      continue;
    }
  }

  return options;
}

function killProcessOnPort(port) {
  if (!port) return;
  try {
    // Kill any process listening on our port to clean up orphaned children.
    const result = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const output = result.stdout || '';
    const myPid = process.pid;
    for (const pidStr of output.split(/\s+/)) {
      const pid = parseInt(pidStr.trim(), 10);
      if (pid && pid !== myPid) {
        try {
          spawnSync('kill', ['-9', String(pid)], { stdio: 'ignore', timeout: 2000 });
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Ignore - process may already be dead
  }
}

async function createManagedOpenCodeServerProcess({
  hostname,
  port,
  timeout,
  cwd,
  env,
}) {
  let binary = (process.env.OPENCODE_BINARY || 'opencode').trim() || 'opencode';
  let args = ['serve', '--hostname', hostname, '--port', String(port)];

  if (process.platform === 'win32' && useWslForOpencode) {
    const wslBinary = resolvedWslBinary || resolveWslExecutablePath();
    if (!wslBinary) {
      throw new Error('WSL executable not found while attempting to launch OpenCode from WSL');
    }

    const wslOpencode = resolvedWslOpencodePath && resolvedWslOpencodePath.trim().length > 0
      ? resolvedWslOpencodePath.trim()
      : 'opencode';
    const serveHost = hostname === '127.0.0.1' ? '0.0.0.0' : hostname;

    binary = wslBinary;
    args = buildWslExecArgs([
      wslOpencode,
      'serve',
      '--hostname',
      serveHost,
      '--port',
      String(port),
    ], resolvedWslDistro);
  }

  // On Windows, Bun/Node cannot directly spawn shell wrapper scripts (#!/bin/sh).
  // Detect if the resolved binary is a shim that wraps a Node/Bun script and
  // resolve the actual target so we can spawn it with the correct interpreter.
  if (process.platform === 'win32' && !useWslForOpencode) {
    const interpreter = opencodeShimInterpreter(binary);
    if (interpreter) {
      // Binary itself has a node/bun shebang – spawn via that interpreter.
      args.unshift(binary);
      binary = interpreter;
    } else {
      // The wrapper might be a shell shim generated by npm.  Try to find the
      // real JS entry point next to it (e.g. node_modules/opencode-ai/bin/opencode).
      try {
        const shimContent = fs.readFileSync(binary, 'utf8');
        const jsMatch = shimContent.match(/node_modules[\\/]opencode[^\s"']*/);
        if (jsMatch) {
          const candidate = path.resolve(path.dirname(binary), jsMatch[0]);
          if (fs.existsSync(candidate)) {
            const realInterp = opencodeShimInterpreter(candidate);
            if (realInterp) {
              args.unshift(candidate);
              binary = realInterp;
            }
          }
        }
      } catch {
        // ignore – fall through to default spawn
      }
    }
  }

  const child = spawn(binary, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const url = await new Promise((resolve, reject) => {
    let output = '';
    let done = false;
    const finish = (handler, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
      handler(value);
    };

    const onStdout = (chunk) => {
      output += chunk.toString();
      const lines = output.split('\n');
      for (const line of lines) {
        if (!line.startsWith('opencode server listening')) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match) {
          finish(reject, new Error(`Failed to parse server url from output: ${line}`));
          return;
        }
        finish(resolve, match[1]);
        return;
      }
    };

    const onStderr = (chunk) => {
      output += chunk.toString();
    };

    const onExit = (code) => {
      finish(reject, new Error(`OpenCode exited with code ${code}. Output: ${output}`));
    };

    const onError = (error) => {
      finish(reject, error);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error(`Timeout waiting for OpenCode to start after ${timeout}ms`));
    }, timeout);

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('exit', onExit);
    child.on('error', onError);
  });

  return {
    url,
    close() {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    },
  };
}

async function resolveManagedOpenCodePort(requestedPort, hostname = '127.0.0.1') {
  if (typeof requestedPort === 'number' && Number.isFinite(requestedPort) && requestedPort > 0) {
    return requestedPort;
  }

  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    const cleanup = () => {
      server.removeAllListeners('error');
      server.removeAllListeners('listening');
    };

    server.once('error', (error) => {
      cleanup();
      reject(error);
    });

    server.once('listening', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => {
        cleanup();
        if (port > 0) {
          resolve(port);
          return;
        }
        reject(new Error('Failed to allocate OpenCode port'));
      });
    });

    server.listen(0, hostname);
  });
}

async function startOpenCode() {
  const desiredPort = ENV_CONFIGURED_OPENCODE_PORT ?? 0;
  const spawnPort = await resolveManagedOpenCodePort(desiredPort, ENV_CONFIGURED_OPENCODE_HOSTNAME);
  console.log(
    desiredPort > 0
      ? `Starting OpenCode on requested port ${desiredPort}...`
      : `Starting OpenCode on allocated port ${spawnPort}...`
  );

  await applyOpencodeBinaryFromSettings();
  ensureOpencodeCliEnv();
  const openCodePassword = await ensureLocalOpenCodeServerPassword({
    rotateManaged: true,
  });

  try {
    const serverInstance = await createManagedOpenCodeServerProcess({
      hostname: ENV_CONFIGURED_OPENCODE_HOSTNAME,
      port: spawnPort,
      timeout: 30000,
      cwd: openCodeWorkingDirectory,
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: openCodePassword,
      },
    });

    if (!serverInstance || !serverInstance.url) {
      throw new Error('OpenCode server started but URL is missing');
    }

    const url = new URL(serverInstance.url);
    const port = parseInt(url.port, 10);
    const prefix = normalizeApiPrefix(url.pathname);

    if (await waitForReady(serverInstance.url, 10000)) {
      setOpenCodePort(port);
      setDetectedOpenCodeApiPrefix(prefix); // SDK URL typically includes the prefix if any

      isOpenCodeReady = true;
      lastOpenCodeError = null;
      openCodeNotReadySince = 0;

      return serverInstance;
    } else {
      try {
        serverInstance.close();
      } catch {
        // ignore
      }
      throw new Error('Server started but health check failed (timeout)');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastOpenCodeError = message;
    openCodePort = null;
    syncToHmrState();
    console.error(`Failed to start OpenCode: ${message}`);
    throw error;
  }
}

async function restartOpenCode() {
  if (isShuttingDown) return;
  if (currentRestartPromise) {
    await currentRestartPromise;
    return;
  }

  currentRestartPromise = (async () => {
    isRestartingOpenCode = true;
    isOpenCodeReady = false;
    openCodeNotReadySince = Date.now();
    console.log('Restarting OpenCode process...');

    // For external OpenCode servers, re-probe instead of kill + respawn
    if (isExternalOpenCode) {
      console.log('Re-probing external OpenCode server...');
      const probePort = openCodePort || ENV_CONFIGURED_OPENCODE_PORT || 4096;
      const probeOrigin = openCodeBaseUrl ?? ENV_CONFIGURED_OPENCODE_HOST?.origin;
      const healthy = await probeExternalOpenCode(probePort, probeOrigin);
      if (healthy) {
        console.log(`External OpenCode server on port ${probePort} is healthy`);
        setOpenCodePort(probePort);
        isOpenCodeReady = true;
        lastOpenCodeError = null;
        openCodeNotReadySince = 0;
        syncToHmrState();
      } else {
        lastOpenCodeError = `External OpenCode server on port ${probePort} is not responding`;
        console.error(lastOpenCodeError);
        throw new Error(lastOpenCodeError);
      }

      if (expressApp) {
        setupProxy(expressApp);
        ensureOpenCodeApiPrefix();
      }
      return;
    }

    const portToKill = openCodePort;

    if (openCodeProcess) {
      console.log('Stopping existing OpenCode process...');
      try {
        openCodeProcess.close();
      } catch (error) {
        console.warn('Error closing OpenCode process:', error);
      }
      openCodeProcess = null;
      syncToHmrState();
    }

    killProcessOnPort(portToKill);

    // Brief delay to allow port release
    await new Promise((resolve) => setTimeout(resolve, 250));

    if (ENV_CONFIGURED_OPENCODE_PORT) {
      console.log(`Using OpenCode port from environment: ${ENV_CONFIGURED_OPENCODE_PORT}`);
      setOpenCodePort(ENV_CONFIGURED_OPENCODE_PORT);
    } else {
      openCodePort = null;
      syncToHmrState();
    }

    openCodeApiPrefixDetected = true;
    openCodeApiPrefix = '';
    if (openCodeApiDetectionTimer) {
      clearTimeout(openCodeApiDetectionTimer);
      openCodeApiDetectionTimer = null;
    }

    lastOpenCodeError = null;
    openCodeProcess = await startOpenCode();
    syncToHmrState();

    if (expressApp) {
      setupProxy(expressApp);
      // Ensure prefix is set correctly (SDK usually handles this, but just in case)
      ensureOpenCodeApiPrefix();
    }
  })();

  try {
    await currentRestartPromise;
  } catch (error) {
    console.error(`Failed to restart OpenCode: ${error.message}`);
    lastOpenCodeError = error.message;
    if (!ENV_CONFIGURED_OPENCODE_PORT) {
      openCodePort = null;
      syncToHmrState();
    }
    openCodeApiPrefixDetected = true;
    openCodeApiPrefix = '';
    throw error;
  } finally {
    currentRestartPromise = null;
    isRestartingOpenCode = false;
  }
}

async function waitForOpenCodeReady(timeoutMs = 20000, intervalMs = 400) {
  if (!openCodePort) {
    throw new Error('OpenCode port is not available');
  }

  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const [configResult, agentResult] = await Promise.all([
        fetch(buildOpenCodeUrl('/config', ''), {
          method: 'GET',
          headers: { Accept: 'application/json',  ...getOpenCodeAuthHeaders()  }
        }).catch((error) => error),
        fetch(buildOpenCodeUrl('/agent', ''), {
          method: 'GET',
          headers: { Accept: 'application/json',  ...getOpenCodeAuthHeaders()  }
        }).catch((error) => error)
      ]);

      if (configResult instanceof Error) {
        lastError = configResult;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }

      if (!configResult.ok) {
        lastError = new Error(`OpenCode config endpoint responded with status ${configResult.status}`);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }

      await configResult.json().catch(() => null);

      if (agentResult instanceof Error) {
        lastError = agentResult;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }

      if (!agentResult.ok) {
        lastError = new Error(`Agent endpoint responded with status ${agentResult.status}`);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }

      await agentResult.json().catch(() => []);

      isOpenCodeReady = true;
      lastOpenCodeError = null;
      return;
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  if (lastError) {
    lastOpenCodeError = lastError.message || String(lastError);
    throw lastError;
  }

  const timeoutError = new Error('Timed out waiting for OpenCode to become ready');
  lastOpenCodeError = timeoutError.message;
  throw timeoutError;
}

async function waitForAgentPresence(agentName, timeoutMs = 15000, intervalMs = 300) {
  if (!openCodePort) {
    throw new Error('OpenCode port is not available');
  }

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(buildOpenCodeUrl('/agent'), {
        method: 'GET',
        headers: { Accept: 'application/json',  ...getOpenCodeAuthHeaders()  }
      });

      if (response.ok) {
        const agents = await response.json();
        if (Array.isArray(agents) && agents.some((agent) => agent?.name === agentName)) {
          return;
        }
      }
    } catch (error) {

    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Agent "${agentName}" not available after OpenCode restart`);
}

async function fetchAgentsSnapshot() {
  if (!openCodePort) {
    throw new Error('OpenCode port is not available');
  }

  const response = await fetch(buildOpenCodeUrl('/agent'), {
    method: 'GET',
    headers: { Accept: 'application/json',  ...getOpenCodeAuthHeaders()  }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch agents snapshot (status ${response.status})`);
  }

  const agents = await response.json().catch(() => null);
  if (!Array.isArray(agents)) {
    throw new Error('Invalid agents payload from OpenCode');
  }
  return agents;
}

async function fetchProvidersSnapshot() {
  if (!openCodePort) {
    throw new Error('OpenCode port is not available');
  }

  const response = await fetch(buildOpenCodeUrl('/provider'), {
    method: 'GET',
    headers: { Accept: 'application/json',  ...getOpenCodeAuthHeaders()  }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch providers snapshot (status ${response.status})`);
  }

  const providers = await response.json().catch(() => null);
  if (!Array.isArray(providers)) {
    throw new Error('Invalid providers payload from OpenCode');
  }
  return providers;
}

async function fetchModelsSnapshot() {
  if (!openCodePort) {
    throw new Error('OpenCode port is not available');
  }

  const response = await fetch(buildOpenCodeUrl('/model'), {
    method: 'GET',
    headers: { Accept: 'application/json',  ...getOpenCodeAuthHeaders()  }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch models snapshot (status ${response.status})`);
  }

  const models = await response.json().catch(() => null);
  if (!Array.isArray(models)) {
    throw new Error('Invalid models payload from OpenCode');
  }
  return models;
}

async function refreshOpenCodeAfterConfigChange(reason, options = {}) {
  const { agentName } = options;

  console.log(`Refreshing OpenCode after ${reason}`);

  // Settings might include a new opencodeBinary; drop cache before restart.
  resolvedOpencodeBinary = null;
  await applyOpencodeBinaryFromSettings();

  await restartOpenCode();

  try {
    await waitForOpenCodeReady();
    isOpenCodeReady = true;
    openCodeNotReadySince = 0;

    if (agentName) {
      await waitForAgentPresence(agentName);
    }

    isOpenCodeReady = true;
    openCodeNotReadySince = 0;
  } catch (error) {

    isOpenCodeReady = false;
    openCodeNotReadySince = Date.now();
    console.error(`Failed to refresh OpenCode after ${reason}:`, error.message);
    throw error;
  }
}

async function bootstrapOpenCodeAtStartup() {
  try {
    syncFromHmrState();
    if (await isOpenCodeProcessHealthy()) {
      console.log(`[HMR] Reusing existing OpenCode process on port ${openCodePort}`);
    } else if (ENV_SKIP_OPENCODE_START && ENV_EFFECTIVE_PORT) {
      const label = ENV_CONFIGURED_OPENCODE_HOST ? ENV_CONFIGURED_OPENCODE_HOST.origin : `http://localhost:${ENV_EFFECTIVE_PORT}`;
      console.log(`Using external OpenCode server at ${label} (skip-start mode)`);
      openCodeBaseUrl = ENV_CONFIGURED_OPENCODE_HOST?.origin ?? null;
      setOpenCodePort(ENV_EFFECTIVE_PORT);
      isOpenCodeReady = true;
      isExternalOpenCode = true;
      lastOpenCodeError = null;
      openCodeNotReadySince = 0;
      syncToHmrState();
    } else if (ENV_EFFECTIVE_PORT && await probeExternalOpenCode(ENV_EFFECTIVE_PORT, ENV_CONFIGURED_OPENCODE_HOST?.origin)) {
      const label = ENV_CONFIGURED_OPENCODE_HOST ? ENV_CONFIGURED_OPENCODE_HOST.origin : `http://localhost:${ENV_EFFECTIVE_PORT}`;
      console.log(`Auto-detected existing OpenCode server at ${label}`);
      openCodeBaseUrl = ENV_CONFIGURED_OPENCODE_HOST?.origin ?? null;
      setOpenCodePort(ENV_EFFECTIVE_PORT);
      isOpenCodeReady = true;
      isExternalOpenCode = true;
      lastOpenCodeError = null;
      openCodeNotReadySince = 0;
      syncToHmrState();
    } else if (!ENV_EFFECTIVE_PORT && await probeExternalOpenCode(4096)) {
      console.log('Auto-detected existing OpenCode server on default port 4096');
      setOpenCodePort(4096);
      isOpenCodeReady = true;
      isExternalOpenCode = true;
      lastOpenCodeError = null;
      openCodeNotReadySince = 0;
      syncToHmrState();
    } else {
      if (ENV_EFFECTIVE_PORT) {
        console.log(`Using OpenCode port from environment: ${ENV_EFFECTIVE_PORT}`);
        setOpenCodePort(ENV_EFFECTIVE_PORT);
      } else {
        openCodePort = null;
        syncToHmrState();
      }

      lastOpenCodeError = null;
      openCodeProcess = await startOpenCode();
      syncToHmrState();
    }
    await waitForOpenCodePort();
    try {
      await waitForOpenCodeReady();
    } catch (error) {
      console.error(`OpenCode readiness check failed: ${error.message}`);
      scheduleOpenCodeApiDetection();
    }
    scheduleOpenCodeApiDetection();
    startHealthMonitoring();
    void startGlobalEventWatcher().catch((error) => {
      console.warn(`Global event watcher startup failed: ${error?.message || error}`);
    });
  } catch (error) {
    console.error(`Failed to start OpenCode: ${error.message}`);
    console.log('Continuing without OpenCode integration...');
    lastOpenCodeError = error.message;
    scheduleOpenCodeApiDetection();
  }
}

function setupProxy(app) {
  if (app.get('opencodeProxyConfigured')) {
    return;
  }

  if (openCodePort) {
    console.log(`Setting up proxy to OpenCode on port ${openCodePort}`);
  } else {
    console.log('Setting up OpenCode API gate (OpenCode not started yet)');
  }
  app.set('opencodeProxyConfigured', true);

  const stripApiPrefix = (rawUrl) => {
    if (typeof rawUrl !== 'string' || !rawUrl) {
      return '/';
    }
    if (rawUrl === '/api') {
      return '/';
    }
    if (rawUrl.startsWith('/api/')) {
      return rawUrl.slice(4);
    }
    return rawUrl;
  };

  // Keep route matching stable; only rewrite the proxied upstream path.
  const rewriteWindowsDirectoryParam = (upstreamPath) => {
    if (process.platform !== 'win32') {
      return upstreamPath;
    }
    try {
      const parsed = new URL(upstreamPath, 'http://openchamber.local');
      const pathname = parsed.pathname || '/';
      if (pathname === '/session' || pathname.startsWith('/session/')) {
        return upstreamPath;
      }
      const directory = parsed.searchParams.get('directory');
      if (!directory || !directory.includes('/')) {
        return upstreamPath;
      }
      const fixed = directory.replace(/\//g, '\\');
      parsed.searchParams.set('directory', fixed);
      const rewritten = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      if (rewritten !== upstreamPath) {
        console.log(`[Win32PathFix] Rewrote directory: "${directory}" → "${fixed}"`);
        console.log(`[Win32PathFix] URL: "${upstreamPath}" → "${rewritten}"`);
      }
      return rewritten;
    } catch {
      return upstreamPath;
    }
  };

  const getUpstreamPathForRequest = (req) => {
    const rawUrl = (typeof req.originalUrl === 'string' && req.originalUrl)
      ? req.originalUrl
      : (typeof req.url === 'string' ? req.url : '/');
    return rewriteWindowsDirectoryParam(stripApiPrefix(rawUrl));
  };

  app.use('/api', (req, res, next) => {
    if (
      req.path.startsWith('/themes/custom') ||
      req.path.startsWith('/push') ||
      req.path.startsWith('/config/agents') ||
      req.path.startsWith('/config/opencode-resolution') ||
      req.path.startsWith('/config/settings') ||
      req.path.startsWith('/config/skills') ||
      req.path === '/config/reload' ||
      req.path === '/health'
    ) {
      return next();
    }

    const waitElapsed = openCodeNotReadySince === 0 ? 0 : Date.now() - openCodeNotReadySince;
    const stillWaiting =
      (!isOpenCodeReady && (openCodeNotReadySince === 0 || waitElapsed < OPEN_CODE_READY_GRACE_MS)) ||
      isRestartingOpenCode ||
      !openCodePort;

    if (stillWaiting) {
      return res.status(503).json({
        error: 'OpenCode is restarting',
        restarting: true,
      });
    }

    next();
  });

  const isSseApiPath = (path) => path === '/event' || path === '/global/event';

  const forwardSseRequest = async (req, res, options = {}) => {
    const startedAt = Date.now();
    const {
      upstreamPath: explicitUpstreamPath,
      directory = null,
      registerUiClient = false,
    } = options;
    const upstreamPath = explicitUpstreamPath || getUpstreamPathForRequest(req);
    const targetUrl = new URL(buildOpenCodeUrl(upstreamPath, ''));
    if (typeof directory === 'string' && directory.trim().length > 0) {
      targetUrl.searchParams.set('directory', directory.trim());
    }
    const authHeaders = getOpenCodeAuthHeaders();

    const requestHeaders = {
      ...(typeof req.headers.accept === 'string' ? { accept: req.headers.accept } : { accept: 'text/event-stream' }),
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...(authHeaders.Authorization ? { Authorization: authHeaders.Authorization } : {}),
    };

    const lastEventId = req.header('Last-Event-ID');
    if (typeof lastEventId === 'string' && lastEventId.length > 0) {
      requestHeaders['Last-Event-ID'] = lastEventId;
    }

    const controller = new AbortController();
    let connectTimer = null;
    let idleTimer = null;
    let heartbeatTimer = null;
    let endedBy = 'upstream-end';

    const cleanup = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (registerUiClient) {
        uiNotificationClients.delete(res);
      }
      req.off('close', onClientClose);
      req.off('error', onClientClose);
    };

    const resetIdleTimeout = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        endedBy = 'idle-timeout';
        controller.abort();
      }, 5 * 60 * 1000);
    };

    const onClientClose = () => {
      endedBy = 'client-disconnect';
      controller.abort();
    };

    req.on('close', onClientClose);
    req.on('error', onClientClose);

    try {
      connectTimer = setTimeout(() => {
        endedBy = 'connect-timeout';
        controller.abort();
      }, 10 * 1000);

      const upstreamResponse = await fetch(targetUrl, {
        method: 'GET',
        headers: requestHeaders,
        signal: controller.signal,
      });

      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }

      if (!upstreamResponse.ok || !upstreamResponse.body) {
        const body = await upstreamResponse.text().catch(() => '');
        cleanup();
        if (!res.headersSent) {
          if (upstreamResponse.headers.has('content-type')) {
            res.setHeader('content-type', upstreamResponse.headers.get('content-type'));
          }
          res.status(upstreamResponse.status).send(body);
        }
        return;
      }

      const upstreamContentType = upstreamResponse.headers.get('content-type') || 'text/event-stream';
      res.status(upstreamResponse.status);
      res.setHeader('content-type', upstreamContentType);
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('x-accel-buffering', 'no');
      res.setHeader('x-content-type-options', 'nosniff');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      if (registerUiClient) {
        uiNotificationClients.add(res);
      }

      resetIdleTimeout();
      heartbeatTimer = setInterval(() => {
        if (res.writableEnded || controller.signal.aborted) {
          return;
        }
        try {
          res.write(': ping\n\n');
          resetIdleTimeout();
        } catch {
        }
      }, 30 * 1000);

      const reader = upstreamResponse.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            endedBy = endedBy === 'upstream-end' ? 'upstream-finished' : endedBy;
            break;
          }
          if (controller.signal.aborted) {
            break;
          }
          if (value && value.length > 0) {
            res.write(Buffer.from(value));
            resetIdleTimeout();
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
        }
      }

      cleanup();
      if (!res.writableEnded) {
        res.end();
      }
      console.log(`SSE forward ${upstreamPath} closed (${endedBy}) in ${Date.now() - startedAt}ms`);
    } catch (error) {
      cleanup();
      const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      if (!res.headersSent) {
        res.status(isTimeout ? 504 : 503).json({
          error: isTimeout ? 'OpenCode SSE forward timed out' : 'OpenCode SSE forward failed',
        });
      } else if (!res.writableEnded) {
        res.end();
      }
      console.warn(`SSE forward ${upstreamPath} failed (${endedBy}):`, error?.message || error);
    }
  };

  app.get('/api/global/event', async (req, res) => {
    await forwardSseRequest(req, res, {
      upstreamPath: '/global/event',
      registerUiClient: true,
    });
  });

  app.get('/api/event', async (req, res) => {
    const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
    const directoryParam = Array.isArray(req.query.directory)
      ? req.query.directory[0]
      : req.query.directory;
    const resolvedDirectory = headerDirectory || directoryParam || null;

    await forwardSseRequest(req, res, {
      upstreamPath: '/event',
      directory: typeof resolvedDirectory === 'string' ? resolvedDirectory : null,
    });
  });

  app.use('/api', (_req, _res, next) => {
    ensureOpenCodeApiPrefix();
    next();
  });

  app.use('/api', (req, res, next) => {
    if (
      req.path.startsWith('/themes/custom') ||
      req.path.startsWith('/config/agents') ||
      req.path.startsWith('/config/opencode-resolution') ||
      req.path.startsWith('/config/settings') ||
      req.path.startsWith('/config/skills') ||
      req.path === '/health'
    ) {
      return next();
    }
    console.log(`API → OpenCode: ${req.method} ${req.path}`);
    next();
  });


  const hopByHopRequestHeaders = new Set([
    'host',
    'connection',
    'content-length',
    'transfer-encoding',
    'keep-alive',
    'te',
    'trailer',
    'upgrade',
  ]);

  const hopByHopResponseHeaders = new Set([
    'connection',
    'content-length',
    'transfer-encoding',
    'keep-alive',
    'te',
    'trailer',
    'upgrade',
    'www-authenticate',
  ]);

  const collectForwardHeaders = (req) => {
    const authHeaders = getOpenCodeAuthHeaders();
    const headers = {};

    for (const [key, value] of Object.entries(req.headers || {})) {
      if (!value) continue;
      const lowerKey = key.toLowerCase();
      if (hopByHopRequestHeaders.has(lowerKey)) continue;
      headers[lowerKey] = Array.isArray(value) ? value.join(', ') : String(value);
    }

    if (authHeaders.Authorization) {
      headers.Authorization = authHeaders.Authorization;
    }

    return headers;
  };

  const collectRequestBodyBuffer = async (req) => {
    if (Buffer.isBuffer(req.body)) {
      return req.body;
    }

    if (typeof req.body === 'string') {
      return Buffer.from(req.body);
    }

    if (req.body && typeof req.body === 'object') {
      return Buffer.from(JSON.stringify(req.body));
    }

    if (req.readableEnded) {
      return Buffer.alloc(0);
    }

    return await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  };

  const forwardGenericApiRequest = async (req, res) => {
    try {
      const upstreamPath = getUpstreamPathForRequest(req);
      const targetUrl = buildOpenCodeUrl(upstreamPath, '');
      const headers = collectForwardHeaders(req);
      const method = String(req.method || 'GET').toUpperCase();
      const hasBody = method !== 'GET' && method !== 'HEAD';
      const bodyBuffer = hasBody ? await collectRequestBodyBuffer(req) : null;

      const upstreamResponse = await fetch(targetUrl, {
        method,
        headers,
        body: hasBody ? bodyBuffer : undefined,
        signal: AbortSignal.timeout(LONG_REQUEST_TIMEOUT_MS),
      });

      for (const [key, value] of upstreamResponse.headers.entries()) {
        const lowerKey = key.toLowerCase();
        if (hopByHopResponseHeaders.has(lowerKey)) {
          continue;
        }
        res.setHeader(key, value);
      }

      const upstreamBody = Buffer.from(await upstreamResponse.arrayBuffer());
      res.status(upstreamResponse.status).send(upstreamBody);
    } catch (error) {
      if (!res.headersSent) {
        const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        res.status(isTimeout ? 504 : 503).json({
          error: isTimeout ? 'OpenCode request timed out' : 'OpenCode service unavailable',
        });
      }
    }
  };

  // Dedicated forwarder for large session message payloads.
  // This avoids edge-cases in generic proxy streaming for multi-file attachments.
  app.post('/api/session/:sessionId/message', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
    try {
      const upstreamPath = getUpstreamPathForRequest(req);
      const targetUrl = buildOpenCodeUrl(upstreamPath, '');
      const authHeaders = getOpenCodeAuthHeaders();

      const headers = {
        ...(typeof req.headers['content-type'] === 'string' ? { 'content-type': req.headers['content-type'] } : { 'content-type': 'application/json' }),
        ...(typeof req.headers.accept === 'string' ? { accept: req.headers.accept } : {}),
        ...(authHeaders.Authorization ? { Authorization: authHeaders.Authorization } : {}),
      };

      const bodyBuffer = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : '');

      const upstreamResponse = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: bodyBuffer,
        signal: AbortSignal.timeout(LONG_REQUEST_TIMEOUT_MS),
      });

      const upstreamBody = Buffer.from(await upstreamResponse.arrayBuffer());

      if (upstreamResponse.headers.has('content-type')) {
        res.setHeader('content-type', upstreamResponse.headers.get('content-type'));
      }

      res.status(upstreamResponse.status).send(upstreamBody);
    } catch (error) {
      if (!res.headersSent) {
        const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        res.status(isTimeout ? 504 : 503).json({
          error: isTimeout ? 'OpenCode message forward timed out' : 'OpenCode message forward failed',
        });
      }
    }
  });

  app.use('/api', async (req, res, next) => {
    if (isSseApiPath(req.path)) {
      return next();
    }

    if (req.method === 'POST' && /\/session\/[^/]+\/message$/.test(req.path || '')) {
      return next();
    }

    // Windows: Merge sessions from all project directories on bare GET /session
    if (process.platform === 'win32' && req.method === 'GET' && req.path === '/session') {
      const rawUrl = req.originalUrl || req.url || '';
      if (!rawUrl.includes('directory=')) {
        try {
          const authHeaders = getOpenCodeAuthHeaders();
          const fetchOpts = {
            method: 'GET',
            headers: { Accept: 'application/json', ...authHeaders },
            signal: AbortSignal.timeout(10000),
          };
          const globalRes = await fetch(buildOpenCodeUrl('/session', ''), fetchOpts);
          const globalPayload = globalRes.ok ? await globalRes.json().catch(() => []) : [];
          const globalSessions = Array.isArray(globalPayload) ? globalPayload : [];

          const settingsPath = path.join(os.homedir(), '.config', 'openchamber', 'settings.json');
          let projectDirs = [];
          try {
            const settingsRaw = fs.readFileSync(settingsPath, 'utf8');
            const settings = JSON.parse(settingsRaw);
            projectDirs = (settings.projects || [])
              .map((project) => (typeof project?.path === 'string' ? project.path.trim() : ''))
              .filter(Boolean);
          } catch {}

          const seen = new Set(
            globalSessions
              .map((session) => (session && typeof session.id === 'string' ? session.id : null))
              .filter((id) => typeof id === 'string')
          );
          const extraSessions = [];
          for (const dir of projectDirs) {
            const candidates = Array.from(new Set([
              dir,
              dir.replace(/\\/g, '/'),
              dir.replace(/\//g, '\\'),
            ]));
            for (const candidateDir of candidates) {
              const encoded = encodeURIComponent(candidateDir);
              try {
                const dirRes = await fetch(buildOpenCodeUrl(`/session?directory=${encoded}`, ''), fetchOpts);
                if (dirRes.ok) {
                  const dirPayload = await dirRes.json().catch(() => []);
                  const dirSessions = Array.isArray(dirPayload) ? dirPayload : [];
                  for (const session of dirSessions) {
                    const id = session && typeof session.id === 'string' ? session.id : null;
                    if (id && !seen.has(id)) {
                      seen.add(id);
                      extraSessions.push(session);
                    }
                  }
                }
              } catch {}
            }
          }

          const merged = [...globalSessions, ...extraSessions];
          merged.sort((a, b) => {
            const aTime = a && typeof a.time_updated === 'number' ? a.time_updated : 0;
            const bTime = b && typeof b.time_updated === 'number' ? b.time_updated : 0;
            return bTime - aTime;
          });
          console.log(`[SessionMerge] ${globalSessions.length} global + ${extraSessions.length} extra = ${merged.length} total`);
          return res.json(merged);
        } catch (error) {
          console.log(`[SessionMerge] Error: ${error.message}, falling through`);
        }
      }
    }

    return forwardGenericApiRequest(req, res);
  });
}

function startHealthMonitoring() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }

  healthCheckInterval = setInterval(async () => {
    if (!openCodeProcess || isShuttingDown || isRestartingOpenCode) return;

    try {
      const healthy = await isOpenCodeProcessHealthy();
      if (!healthy) {
        console.log('OpenCode process not running, restarting...');
        await restartOpenCode();
      }
    } catch (error) {
      console.error(`Health check error: ${error.message}`);
    }
  }, HEALTH_CHECK_INTERVAL);
}

async function gracefulShutdown(options = {}) {
  if (isShuttingDown) return;

  isShuttingDown = true;
  syncToHmrState();
  console.log('Starting graceful shutdown...');
  const exitProcess = typeof options.exitProcess === 'boolean' ? options.exitProcess : exitOnShutdown;

  stopGlobalEventWatcher();

  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }

  if (terminalRuntime) {
    try {
      await terminalRuntime.shutdown();
    } catch {
    } finally {
      terminalRuntime = null;
    }
  }

  // Only stop OpenCode if we started it ourselves (not when using external server)
  if (!ENV_SKIP_OPENCODE_START && !isExternalOpenCode) {
    const portToKill = openCodePort;

    if (openCodeProcess) {
      console.log('Stopping OpenCode process...');
      try {
        openCodeProcess.close();
      } catch (error) {
        console.warn('Error closing OpenCode process:', error);
      }
      openCodeProcess = null;
    }

    killProcessOnPort(portToKill);
  } else {
    console.log('Skipping OpenCode shutdown (external server)');
  }

  if (server) {
    await Promise.race([
      new Promise((resolve) => {
        server.close(() => {
          console.log('HTTP server closed');
          resolve();
        });
      }),
      new Promise((resolve) => {
        setTimeout(() => {
          console.warn('Server close timeout reached, forcing shutdown');
          resolve();
        }, SHUTDOWN_TIMEOUT);
      })
    ]);
  }

  if (uiAuthController) {
    uiAuthController.dispose();
    uiAuthController = null;
  }

  if (activeTunnelController) {
    console.log('Stopping active tunnel...');
    activeTunnelController.stop();
    activeTunnelController = null;
    tunnelAuthController.clearActiveTunnel();
  }

  console.log('Graceful shutdown complete');
  if (exitProcess) {
    process.exit(0);
  }
}

async function main(options = {}) {
  const port = Number.isFinite(options.port) && options.port >= 0 ? Math.trunc(options.port) : DEFAULT_PORT;
  const host = typeof options.host === 'string' && options.host.length > 0 ? options.host : undefined;
  const tryCfTunnel = options.tryCfTunnel === true;
  const shouldUseCanonicalTunnelConfig = typeof options.tunnelMode === 'string'
    || typeof options.tunnelProvider === 'string'
    || options.tunnelConfigPath === null
    || typeof options.tunnelConfigPath === 'string'
    || typeof options.tunnelToken === 'string'
    || typeof options.tunnelHostname === 'string';
  const startupTunnelRequest = shouldUseCanonicalTunnelConfig
    ? normalizeTunnelStartRequest({
        provider: normalizeTunnelProvider(options.tunnelProvider),
        mode: options.tunnelMode,
        configPath: normalizeOptionalPath(options.tunnelConfigPath),
        token: typeof options.tunnelToken === 'string' ? options.tunnelToken.trim() : '',
        hostname: normalizeManagedRemoteTunnelHostname(options.tunnelHostname),
      })
    : (tryCfTunnel
      ? {
          provider: TUNNEL_PROVIDER_CLOUDFLARE,
          mode: TUNNEL_MODE_QUICK,
          configPath: undefined,
          token: '',
          hostname: undefined,
        }
      : null);
  const attachSignals = options.attachSignals !== false;
  const onTunnelReady = typeof options.onTunnelReady === 'function' ? options.onTunnelReady : null;
  if (typeof options.exitOnShutdown === 'boolean') {
    exitOnShutdown = options.exitOnShutdown;
  }

  console.log(`Starting OpenChamber on port ${port === 0 ? 'auto' : port}`);

  // Check macOS Say TTS availability once at startup
  let sayTTSCapability = { available: false, voices: [], reason: 'Not checked' };
  if (process.platform === 'darwin') {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      const { stdout } = await execAsync('say -v "?"');
      const voices = stdout.split('\n')
        .filter(line => line.trim())
        .map(line => {
          const match = line.match(/^(.+?)\s+([a-zA-Z]{2}_[a-zA-Z]{2,3})\s+#/);
          if (match) {
            return { name: match[1].trim(), locale: match[2] };
          }
          return null;
        })
        .filter(Boolean);
      sayTTSCapability = { available: true, voices };
      console.log(`macOS Say TTS available with ${voices.length} voices`);
    } catch (error) {
      sayTTSCapability = { available: false, voices: [], reason: 'say command not available' };
      console.log('macOS Say TTS not available:', error.message);
    }
  } else {
    sayTTSCapability = { available: false, voices: [], reason: 'Not macOS' };
  }

  // Startup model validation is best-effort and runs in background.
  void validateZenModelAtStartup();

  const app = express();
  const serverStartedAt = new Date().toISOString();
  app.set('trust proxy', true);
  expressApp = app;
  server = http.createServer(app);

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      openCodePort: openCodePort,
      openCodeRunning: Boolean(openCodePort && isOpenCodeReady && !isRestartingOpenCode),
      openCodeSecureConnection: isOpenCodeConnectionSecure(),
      openCodeAuthSource: openCodeAuthSource || null,
      openCodeApiPrefix: '',
      openCodeApiPrefixDetected: true,
      isOpenCodeReady,
      lastOpenCodeError,
      opencodeBinaryResolved: resolvedOpencodeBinary || null,
      opencodeBinarySource: resolvedOpencodeBinarySource || null,
      opencodeShimInterpreter: resolvedOpencodeBinary ? opencodeShimInterpreter(resolvedOpencodeBinary) : null,
      opencodeViaWsl: useWslForOpencode,
      opencodeWslBinary: resolvedWslBinary || null,
      opencodeWslPath: resolvedWslOpencodePath || null,
      opencodeWslDistro: resolvedWslDistro || null,
      nodeBinaryResolved: resolvedNodeBinary || null,
      bunBinaryResolved: resolvedBunBinary || null,
    });
  });

  app.post('/api/system/shutdown', (req, res) => {
    res.json({ ok: true });
    gracefulShutdown({ exitProcess: false }).catch((error) => {
      console.error('Shutdown request failed:', error?.message || error);
    });
  });

  app.get('/api/system/info', (req, res) => {
    res.json({
      openchamberVersion: OPENCHAMBER_VERSION,
      runtime: process.env.OPENCHAMBER_RUNTIME || 'web',
      pid: process.pid,
      startedAt: serverStartedAt,
    });
  });

  app.use((req, res, next) => {
    if (
      req.path.startsWith('/api/config/agents') ||
      req.path.startsWith('/api/config/commands') ||
      req.path.startsWith('/api/config/mcp') ||
      req.path.startsWith('/api/config/settings') ||
      req.path.startsWith('/api/config/skills') ||
      req.path.startsWith('/api/projects') ||
      req.path.startsWith('/api/fs') ||
      req.path.startsWith('/api/git') ||
      req.path.startsWith('/api/prompts') ||
      req.path.startsWith('/api/terminal') ||
      req.path.startsWith('/api/opencode') ||
      req.path.startsWith('/api/push') ||
      req.path.startsWith('/api/voice') ||
      req.path.startsWith('/api/tts') ||
      req.path.startsWith('/api/openchamber/tunnel')
    ) {

      express.json({ limit: '50mb' })(req, res, next);
    } else if (req.path.startsWith('/api')) {

      next();
    } else {

      express.json({ limit: '50mb' })(req, res, next);
    }
  });
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
  });

  const uiPassword = typeof options.uiPassword === 'string' ? options.uiPassword : null;
  uiAuthController = createUiAuth({ password: uiPassword });
  if (uiAuthController.enabled) {
    console.log('UI password protection enabled for browser sessions');
  }

  app.get('/auth/session', async (req, res) => {
    const requestScope = tunnelAuthController.classifyRequestScope(req);
    if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
      const tunnelSession = tunnelAuthController.getTunnelSessionFromRequest(req);
      if (tunnelSession) {
        return res.json({ authenticated: true, scope: 'tunnel' });
      }
      tunnelAuthController.clearTunnelSessionCookie(req, res);
      return res.status(401).json({ authenticated: false, locked: true, tunnelLocked: true });
    }

    try {
      await uiAuthController.handleSessionStatus(req, res);
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  app.post('/auth/session', (req, res) => {
    const requestScope = tunnelAuthController.classifyRequestScope(req);
    if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
      return res.status(403).json({ error: 'Password login is disabled for tunnel scope', tunnelLocked: true });
    }
    return uiAuthController.handleSessionCreate(req, res);
  });

  app.get('/connect', async (req, res) => {
    try {
      const token = typeof req.query?.t === 'string' ? req.query.t : '';
      const settings = await readSettingsFromDiskMigrated();
      const tunnelSessionTtlMs = normalizeTunnelSessionTtlMs(settings?.tunnelSessionTtlMs);

      const exchange = tunnelAuthController.exchangeBootstrapToken({
        req,
        res,
        token,
        sessionTtlMs: tunnelSessionTtlMs,
      });

      res.setHeader('Cache-Control', 'no-store');

      if (!exchange.ok) {
        if (exchange.reason === 'rate-limited') {
          res.setHeader('Retry-After', String(exchange.retryAfter || 60));
          return res.status(429).type('text/plain').send('Too many attempts. Please try again later.');
        }
        return res.status(401).type('text/plain').send('Connection link is invalid or expired.');
      }

      return res.redirect(302, '/');
    } catch (error) {
      return res.status(500).type('text/plain').send('Failed to process connect request.');
    }
  });

  app.use('/api', async (req, res, next) => {
    try {
      const requestScope = tunnelAuthController.classifyRequestScope(req);
      if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
        return tunnelAuthController.requireTunnelSession(req, res, next);
      }
      await uiAuthController.requireAuth(req, res, next);
    } catch (err) {
      next(err);
    }
  });

  const parsePushSubscribeBody = (body) => {
    if (!body || typeof body !== 'object') return null;
    const endpoint = body.endpoint;
    const keys = body.keys;
    const p256dh = keys?.p256dh;
    const auth = keys?.auth;

    if (typeof endpoint !== 'string' || endpoint.trim().length === 0) return null;
    if (typeof p256dh !== 'string' || p256dh.trim().length === 0) return null;
    if (typeof auth !== 'string' || auth.trim().length === 0) return null;

    return {
      endpoint: endpoint.trim(),
      keys: { p256dh: p256dh.trim(), auth: auth.trim() },
    };
  };

  const parsePushUnsubscribeBody = (body) => {
    if (!body || typeof body !== 'object') return null;
    const endpoint = body.endpoint;
    if (typeof endpoint !== 'string' || endpoint.trim().length === 0) return null;
    return { endpoint: endpoint.trim() };
  };

  app.get('/api/push/vapid-public-key', async (req, res) => {
    try {
      await ensurePushInitialized();
      const keys = await getOrCreateVapidKeys();
      res.json({ publicKey: keys.publicKey });
    } catch (error) {
      console.warn('[Push] Failed to load VAPID key:', error);
      res.status(500).json({ error: 'Failed to load push key' });
    }
  });

  app.post('/api/push/subscribe', async (req, res) => {
    await ensurePushInitialized();

    const uiToken = uiAuthController?.ensureSessionToken
      ? await uiAuthController.ensureSessionToken(req, res)
      : getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const parsed = parsePushSubscribeBody(req.body);
    if (!parsed) {
      return res.status(400).json({ error: 'Invalid body' });
    }

    const { endpoint, keys } = parsed;

    const origin = typeof req.body?.origin === 'string' ? req.body.origin.trim() : '';
    if (origin.startsWith('http://') || origin.startsWith('https://')) {
      try {
        const settings = await readSettingsFromDiskMigrated();
        if (typeof settings?.publicOrigin !== 'string' || settings.publicOrigin.trim().length === 0) {
          await writeSettingsToDisk({
            ...settings,
            publicOrigin: origin,
          });
          // allow next sends to pick it up
          pushInitialized = false;
        }
      } catch {
        // ignore
      }
    }

    await addOrUpdatePushSubscription(
      uiToken,
      {
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      },
      req.headers['user-agent']
    );

    res.json({ ok: true });
  });


  app.delete('/api/push/subscribe', async (req, res) => {
    await ensurePushInitialized();

    const uiToken = uiAuthController?.ensureSessionToken
      ? await uiAuthController.ensureSessionToken(req, res)
      : getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const parsed = parsePushUnsubscribeBody(req.body);
    if (!parsed) {
      return res.status(400).json({ error: 'Invalid body' });
    }

    await removePushSubscription(uiToken, parsed.endpoint);
    res.json({ ok: true });
  });

  app.post('/api/push/visibility', async (req, res) => {
    const uiToken = uiAuthController?.ensureSessionToken
      ? await uiAuthController.ensureSessionToken(req, res)
      : getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const visible = req.body && typeof req.body === 'object' ? req.body.visible : null;
    updateUiVisibility(uiToken, visible === true);
    res.json({ ok: true });
  });

  app.get('/api/push/visibility', (req, res) => {
    const uiToken = getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    res.json({
      ok: true,
      visible: isUiVisible(uiToken),
    });
  });

  // Session activity status endpoint - returns tracked activity phases for all sessions
  // Used by UI on visibility restore to get accurate status without waiting for SSE
  app.get('/api/session-activity', (_req, res) => {
    res.json(getSessionActivitySnapshot());
  });

  // Voice token endpoint - returns OpenAI TTS availability status
  registerTtsRoutes(app, { resolveZenModel, sayTTSCapability });

  // New authoritative session status endpoints
  // Server maintains the source of truth, clients only query

  // GET /api/sessions/snapshot - Combined status + attention snapshot
  app.get('/api/sessions/snapshot', (_req, res) => {
    res.json({
      statusSessions: getSessionStateSnapshot(),
      attentionSessions: getSessionAttentionSnapshot(),
      serverTime: Date.now()
    });
  });

  // GET /api/sessions/status - Get status for all sessions
  app.get('/api/sessions/status', (_req, res) => {
    const snapshot = getSessionStateSnapshot();
    res.json({
      sessions: snapshot,
      serverTime: Date.now()
    });
  });

  // GET /api/sessions/:id/status - Get status for a specific session
  app.get('/api/sessions/:id/status', (req, res) => {
    const sessionId = req.params.id;
    const state = getSessionState(sessionId);

    if (!state) {
      return res.status(404).json({
        error: 'Session not found or no state available',
        sessionId
      });
    }

    res.json({
      sessionId,
      ...state
    });
  });

  // Session attention tracking endpoints
  // GET /api/sessions/attention - Get attention state for all sessions
  app.get('/api/sessions/attention', (_req, res) => {
    const snapshot = getSessionAttentionSnapshot();
    res.json({
      sessions: snapshot,
      serverTime: Date.now()
    });
  });

  // GET /api/sessions/:id/attention - Get attention state for a specific session
  app.get('/api/sessions/:id/attention', (req, res) => {
    const sessionId = req.params.id;
    const state = getSessionAttentionState(sessionId);

    if (!state) {
      return res.status(404).json({
        error: 'Session not found or no attention state available',
        sessionId
      });
    }

    res.json({
      sessionId,
      ...state
    });
  });

  // POST /api/sessions/:id/view - Client reports viewing this session
  app.post('/api/sessions/:id/view', (req, res) => {
    const sessionId = req.params.id;
    const clientId = req.headers['x-client-id'] || req.ip || 'anonymous';

    markSessionViewed(sessionId, clientId);

    res.json({
      success: true,
      sessionId,
      viewed: true
    });
  });

  // POST /api/sessions/:id/unview - Client reports leaving this session
  app.post('/api/sessions/:id/unview', (req, res) => {
    const sessionId = req.params.id;
    const clientId = req.headers['x-client-id'] || req.ip || 'anonymous';

    markSessionUnviewed(sessionId, clientId);

    res.json({
      success: true,
      sessionId,
      viewed: false
    });
  });

  // POST /api/sessions/:id/message-sent - User sent a message in this session
  app.post('/api/sessions/:id/message-sent', (req, res) => {
    const sessionId = req.params.id;

    markUserMessageSent(sessionId);

    res.json({
      success: true,
      sessionId,
      messageSent: true
    });
  });

  app.get('/api/openchamber/update-check', async (req, res) => {
    try {
      const { checkForUpdates } = await import('./lib/package-manager.js');
      const parseString = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined);
      const parseReportUsage = (value) => {
        if (typeof value !== 'string') return true;
        const normalized = value.trim().toLowerCase();
        if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
        return true;
      };
      const inferDeviceClass = (ua) => {
        const value = (ua || '').toLowerCase();
        if (!value) return 'unknown';
        if (value.includes('ipad') || value.includes('tablet')) return 'tablet';
        if (value.includes('mobi') || value.includes('android') || value.includes('iphone')) return 'mobile';
        return 'desktop';
      };
      const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';

      const updateInfo = await checkForUpdates({
        appType: parseString(req.query.appType),
        deviceClass: parseString(req.query.deviceClass) || inferDeviceClass(userAgent),
        platform: parseString(req.query.platform),
        arch: parseString(req.query.arch),
        instanceMode: parseString(req.query.instanceMode),
        currentVersion: parseString(req.query.currentVersion),
        reportUsage: parseReportUsage(parseString(req.query.reportUsage)),
      });
      res.json(updateInfo);
    } catch (error) {
      console.error('Failed to check for updates:', error);
      res.status(500).json({
        available: false,
        error: error instanceof Error ? error.message : 'Failed to check for updates',
      });
    }
  });

  app.post('/api/openchamber/update-install', async (_req, res) => {
    try {
      const { spawn: spawnChild } = await import('child_process');
      const {
        checkForUpdates,
        getUpdateCommand,
        detectPackageManager,
      } = await import('./lib/package-manager.js');

      // Verify update is available
      const updateInfo = await checkForUpdates();
      if (!updateInfo.available) {
        return res.status(400).json({ error: 'No update available' });
      }

      const pm = detectPackageManager();
      const updateCmd = getUpdateCommand(pm);
      const isContainer =
        fs.existsSync('/.dockerenv') ||
        Boolean(process.env.CONTAINER) ||
        process.env.container === 'docker';

      if (isContainer) {
        res.json({
          success: true,
          message: 'Update starting, server will stay online',
          version: updateInfo.version,
          packageManager: pm,
          autoRestart: false,
        });

        setTimeout(() => {
          console.log(`\nInstalling update using ${pm} (container mode)...`);
          console.log(`Running: ${updateCmd}`);

          const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'sh';
          const shellFlag = process.platform === 'win32' ? '/c' : '-c';
          const child = spawnChild(shell, [shellFlag, updateCmd], {
            detached: true,
            stdio: 'ignore',
            env: process.env,
          });
          child.unref();
        }, 500);

        return;
      }

      // Get current server port for restart
      const currentPort = server.address()?.port || 3000;

      // Try to read stored instance options for restart
      const tmpDir = os.tmpdir();
      const instanceFilePath = path.join(tmpDir, `openchamber-${currentPort}.json`);
      let storedOptions = { port: currentPort, daemon: true };
      try {
        const content = await fs.promises.readFile(instanceFilePath, 'utf8');
        storedOptions = JSON.parse(content);
      } catch {
        // Use defaults
      }

      const isWindows = process.platform === 'win32';

      const quotePosix = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
      const quoteCmd = (value) => {
        const stringValue = String(value);
        return `"${stringValue.replace(/"/g, '""')}"`;
      };

      // Build restart command using explicit runtime + CLI path.
      // Avoids relying on `openchamber` being in PATH for service environments.
      const cliPath = path.resolve(__dirname, '..', 'bin', 'cli.js');
      const restartParts = [
        isWindows ? quoteCmd(process.execPath) : quotePosix(process.execPath),
        isWindows ? quoteCmd(cliPath) : quotePosix(cliPath),
        'serve',
        '--port',
        String(storedOptions.port),
        '--daemon',
      ];
      let restartCmdPrimary = restartParts.join(' ');
      let restartCmdFallback = `openchamber serve --port ${storedOptions.port} --daemon`;
      if (storedOptions.uiPassword) {
        if (isWindows) {
          // Escape for cmd.exe quoted argument
          const escapedPw = storedOptions.uiPassword.replace(/"/g, '""');
          restartCmdPrimary += ` --ui-password "${escapedPw}"`;
          restartCmdFallback += ` --ui-password "${escapedPw}"`;
        } else {
          // Escape for POSIX single-quoted argument
          const escapedPw = storedOptions.uiPassword.replace(/'/g, "'\\''");
          restartCmdPrimary += ` --ui-password '${escapedPw}'`;
          restartCmdFallback += ` --ui-password '${escapedPw}'`;
        }
      }
      const restartCmd = `(${restartCmdPrimary}) || (${restartCmdFallback})`;

      // Respond immediately - update will happen after response
      res.json({
        success: true,
        message: 'Update starting, server will restart shortly',
        version: updateInfo.version,
        packageManager: pm,
        autoRestart: true,
      });

      // Give time for response to be sent
      setTimeout(() => {
        console.log(`\nInstalling update using ${pm}...`);
        console.log(`Running: ${updateCmd}`);

        // Create a script that will:
        // 1. Wait for current process to exit
        // 2. Run the update
        // 3. Restart the server with original options
        const shell = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'sh';
        const shellFlag = isWindows ? '/c' : '-c';
        const script = isWindows
          ? `
            timeout /t 2 /nobreak >nul
            ${updateCmd}
            if %ERRORLEVEL% EQU 0 (
              echo Update successful, restarting OpenChamber...
              ${restartCmd}
            ) else (
              echo Update failed
              exit /b 1
            )
          `
          : `
            sleep 2
            ${updateCmd}
            if [ $? -eq 0 ]; then
              echo "Update successful, restarting OpenChamber..."
              ${restartCmd}
            else
              echo "Update failed"
              exit 1
            fi
          `;

        // Spawn detached shell to run update after we exit.
        // Capture output to disk so restart failures are diagnosable.
        const updateLogPath = path.join(OPENCHAMBER_DATA_DIR, 'update-install.log');
        let logFd = null;
        try {
          fs.mkdirSync(path.dirname(updateLogPath), { recursive: true });
          logFd = fs.openSync(updateLogPath, 'a');
        } catch (logError) {
          console.warn('Failed to open update log file, continuing without log capture:', logError);
        }

        const child = spawnChild(shell, [shellFlag, script], {
          detached: true,
          stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
          env: process.env,
        });
        child.unref();

        if (logFd !== null) {
          try {
            fs.closeSync(logFd);
          } catch {
            // ignore
          }
        }

        console.log('Update process spawned, shutting down server...');

        // Give child process time to start, then exit
        setTimeout(() => {
          process.exit(0);
        }, 500);
      }, 500);
    } catch (error) {
      console.error('Failed to install update:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to install update',
      });
    }
  });

  app.get('/api/openchamber/models-metadata', async (req, res) => {
    const now = Date.now();

    if (cachedModelsMetadata && now - cachedModelsMetadataTimestamp < MODELS_METADATA_CACHE_TTL) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.json(cachedModelsMetadata);
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 8000) : null;

    try {
      const response = await fetch(MODELS_DEV_API_URL, {
        signal: controller?.signal,
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`models.dev responded with status ${response.status}`);
      }

      const metadata = await response.json();
      cachedModelsMetadata = metadata;
      cachedModelsMetadataTimestamp = Date.now();

      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json(metadata);
    } catch (error) {
      console.warn('Failed to fetch models.dev metadata via server:', error);

      if (cachedModelsMetadata) {
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json(cachedModelsMetadata);
      } else {
        const statusCode = error?.name === 'AbortError' ? 504 : 502;
        res.status(statusCode).json({ error: 'Failed to retrieve model metadata' });
      }
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  });

  // Zen models endpoint - returns available free models from the zen API
  app.get('/api/zen/models', async (_req, res) => {
    try {
      const models = await fetchFreeZenModels();
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({ models });
    } catch (error) {
      console.warn('Failed to fetch zen models:', error);
      // Serve stale cache if available
      if (cachedZenModels) {
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json(cachedZenModels);
      } else {
        const statusCode = error?.name === 'AbortError' ? 504 : 502;
        res.status(statusCode).json({ error: 'Failed to retrieve zen models' });
      }
    }
  });

  const tunnelService = createTunnelService({
    registry: tunnelProviderRegistry,
    getController: () => activeTunnelController,
    setController: (controller) => {
      activeTunnelController = controller;
    },
    getActivePort: () => activePort,
    onQuickTunnelWarning: () => {
      printTunnelWarning();
    },
  });

  const resolveActiveNormalizedTunnelMode = () => {
    const mode = tunnelService.resolveActiveMode();
    if (mode === TUNNEL_MODE_MANAGED_LOCAL) {
      return TUNNEL_MODE_MANAGED_LOCAL;
    }
    if (mode === TUNNEL_MODE_MANAGED_REMOTE) {
      return TUNNEL_MODE_MANAGED_REMOTE;
    }
    return TUNNEL_MODE_QUICK;
  };

  const resolveNormalizedTunnelHost = (publicUrl) => {
    if (typeof publicUrl !== 'string' || publicUrl.trim().length === 0) {
      return null;
    }
    try {
      return new URL(publicUrl).hostname.toLowerCase();
    } catch {
      return null;
    }
  };

  const resolvePreferredTunnelProvider = async (reqBody = null) => {
    if (typeof reqBody?.provider === 'string' && reqBody.provider.trim().length > 0) {
      return normalizeTunnelProvider(reqBody.provider);
    }
    const activeProvider = tunnelService.resolveActiveProvider();
    if (activeProvider) {
      return normalizeTunnelProvider(activeProvider);
    }
    const settings = await readSettingsFromDiskMigrated();
    return normalizeTunnelProvider(settings?.tunnelProvider);
  };

  const startTunnelWithNormalizedRequest = async ({
    provider,
    mode,
    intent,
    hostname,
    token,
    configPath,
    selectedPresetId,
    selectedPresetName,
  }) => {
    if (provider === TUNNEL_PROVIDER_CLOUDFLARE && mode === TUNNEL_MODE_MANAGED_REMOTE) {
      runtimeManagedRemoteTunnelHostname = hostname;
      runtimeManagedRemoteTunnelToken = token;

      if (token && hostname) {
        await upsertManagedRemoteTunnelToken({
          id: selectedPresetId || hostname,
          name: selectedPresetName || hostname,
          hostname,
          token,
        });
      }
    }

    const result = await tunnelService.start({
      provider,
      mode,
      intent,
      configPath,
      token,
      hostname,
    });

    console.log(`Tunnel active (${result.provider}): ${result.publicUrl}`);
    return {
      publicUrl: result.publicUrl,
      mode: result.activeMode,
      provider: result.provider,
      providerMetadata: result.providerMetadata,
    };
  };

  const createGenericModeChecks = ({ modeKey, requiredFields, doctorRequest, startupReady }) => {
    const checks = [
      {
        id: 'startup_readiness',
        label: 'Provider startup readiness',
        status: startupReady ? 'pass' : 'fail',
        detail: startupReady
          ? 'Provider dependency checks passed.'
          : 'Resolve provider checks before starting tunnels.',
      },
    ];

    for (const field of requiredFields) {
      const value = doctorRequest?.[field];
      const present = typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
      checks.push({
        id: `requirement_${field}`,
        label: `Required: ${field}`,
        status: present ? 'pass' : 'fail',
        detail: present
          ? `${field} is configured.`
          : `${field} is required for ${modeKey}.`,
      });
    }

    const failures = checks.filter((entry) => entry.status === 'fail').length;
    const warnings = checks.filter((entry) => entry.status === 'warn').length;
    return {
      mode: modeKey,
      checks,
      summary: {
        ready: failures === 0,
        failures,
        warnings,
      },
      ready: failures === 0,
      blockers: checks
        .filter((entry) => entry.status === 'fail' && entry.id !== 'startup_readiness')
        .map((entry) => entry.detail || entry.label || entry.id),
    };
  };

  const runTunnelDoctor = async ({ providerId, modeFilter, doctorRequest }) => {
    const provider = tunnelProviderRegistry.get(providerId);
    if (!provider) {
      throw new TunnelServiceError('provider_unsupported', `Unsupported tunnel provider: ${providerId}`);
    }

    const capabilities = provider.capabilities || {};
    const modeKeys = Array.isArray(capabilities.modes)
      ? capabilities.modes.map((entry) => entry?.key).filter((key) => typeof key === 'string' && key.length > 0)
      : [];

    if (modeFilter && !modeKeys.includes(modeFilter)) {
      throw new TunnelServiceError('mode_unsupported', `Provider '${providerId}' does not support mode '${modeFilter}'`);
    }

    if (typeof provider.diagnose === 'function') {
      const diagnosed = await provider.diagnose({
        ...doctorRequest,
        mode: modeFilter || doctorRequest?.mode,
      }, {
        capabilities,
      });
      const providerChecks = Array.isArray(diagnosed?.providerChecks) ? diagnosed.providerChecks : [];
      const allModes = Array.isArray(diagnosed?.modes) ? diagnosed.modes : [];
      const modes = modeFilter ? allModes.filter((entry) => entry?.mode === modeFilter) : allModes;
      return {
        ok: true,
        provider: providerId,
        providerChecks,
        modes,
      };
    }

    const availability = await tunnelService.checkAvailability(providerId);
    const dependencyAvailable = Boolean(availability?.available);
    const providerChecks = [{
      id: 'dependency',
      label: 'Provider dependency',
      status: dependencyAvailable ? 'pass' : 'fail',
      detail: dependencyAvailable
        ? (availability?.version || 'available')
        : (availability?.message || 'Required provider dependency is unavailable.'),
    }];

    const targetModes = (Array.isArray(capabilities.modes) ? capabilities.modes : [])
      .filter((entry) => !modeFilter || entry?.key === modeFilter);
    const modes = targetModes.map((entry) => createGenericModeChecks({
      modeKey: entry.key,
      requiredFields: Array.isArray(entry?.requires) ? entry.requires : [],
      doctorRequest,
      startupReady: dependencyAvailable,
    }));

    return {
      ok: true,
      provider: providerId,
      providerChecks,
      modes,
    };
  };

  // ── Tunnel API ─────────────────────────────────────────────────────

  app.get('/api/openchamber/tunnel/check', async (req, res) => {
    try {
      const requestedProvider = typeof req?.query?.provider === 'string' && req.query.provider.trim().length > 0
        ? normalizeTunnelProvider(req.query.provider)
        : await resolvePreferredTunnelProvider();
      const result = await tunnelService.checkAvailability(requestedProvider);
      res.json({
        available: result.available,
        provider: requestedProvider,
        version: result.version || null,
      });
    } catch (error) {
      console.warn('Tunnel dependency check failed:', error);
      res.json({ available: false, provider: null, version: null });
    }
  });

  // Accept both POST (preferred, tokens in body) and GET (backward compat, no tokens in URL).
  const handleTunnelDoctor = async (req, res) => {
    try {
      const params = req.query || {};
      // Sensitive fields (tokens) are read from the request body only, never from query params.
      const body = req.body || {};

      const providerId = typeof params.provider === 'string' && params.provider.trim().length > 0
        ? normalizeTunnelProvider(params.provider)
        : await resolvePreferredTunnelProvider();
      const modeFilter = typeof params.mode === 'string' && params.mode.trim().length > 0
        ? params.mode.trim().toLowerCase()
        : null;

      const settings = await readSettingsFromDiskMigrated();
      const selectedPresetId = typeof params.managedRemoteTunnelPresetId === 'string'
        ? params.managedRemoteTunnelPresetId.trim()
        : '';
      const requestConfigPath = normalizeOptionalPath(params.configPath)
        ?? normalizeOptionalPath(settings?.managedLocalTunnelConfigPath);
      const requestManagedRemoteHostname = normalizeManagedRemoteTunnelHostname(params.managedRemoteTunnelHostname);
      const requestTunnelHostname = normalizeManagedRemoteTunnelHostname(params.tunnelHostname);
      const requestHostname = normalizeManagedRemoteTunnelHostname(params.hostname);
      const hostnameFromSettings = normalizeManagedRemoteTunnelHostname(settings?.managedRemoteTunnelHostname);
      const hostname = requestHostname || requestTunnelHostname || requestManagedRemoteHostname || hostnameFromSettings;

      const requestManagedRemoteToken = typeof body.managedRemoteTunnelToken === 'string'
        ? body.managedRemoteTunnelToken.trim()
        : '';
      const requestTunnelToken = typeof body.tunnelToken === 'string'
        ? body.tunnelToken.trim()
        : '';
      const requestToken = typeof body.token === 'string'
        ? body.token.trim()
        : '';
      const requestTokenProvided = body.managedRemoteTunnelTokenProvided === true
        || body.tunnelTokenProvided === true
        || body.tokenProvided === true;
      const requestHostnameProvided = body.managedRemoteTunnelHostnameProvided === true
        || body.tunnelHostnameProvided === true
        || body.hostnameProvided === true;
      const storedManagedRemoteToken = typeof settings?.managedRemoteTunnelToken === 'string'
        ? settings.managedRemoteTunnelToken.trim()
        : '';
      const managedRemoteTunnelConfig = await readManagedRemoteTunnelConfigFromDisk();
      const serverHasSavedManagedRemoteProfile = managedRemoteTunnelConfig.tunnels.some((entry) => {
        const savedHostname = normalizeManagedRemoteTunnelHostname(entry?.hostname);
        const savedToken = typeof entry?.token === 'string' ? entry.token.trim() : '';
        return Boolean(savedHostname && savedToken);
      });
      const cliHasSavedManagedRemoteProfile = params.hasSavedManagedRemoteProfile === '1';
      const hasSavedManagedRemoteProfile = serverHasSavedManagedRemoteProfile || cliHasSavedManagedRemoteProfile;
      const configManagedRemoteToken = providerId === TUNNEL_PROVIDER_CLOUDFLARE
        ? await resolveManagedRemoteTunnelToken({ presetId: selectedPresetId, hostname })
        : '';
      const token = requestToken
        || requestTunnelToken
        || requestManagedRemoteToken
        || ((runtimeManagedRemoteTunnelHostname && hostname && runtimeManagedRemoteTunnelHostname === hostname) ? runtimeManagedRemoteTunnelToken : '')
        || configManagedRemoteToken
        || storedManagedRemoteToken;

      const doctorRequest = {
        mode: modeFilter,
        hostname,
        token,
        tokenProvided: requestTokenProvided,
        hostnameProvided: requestHostnameProvided,
        configPath: requestConfigPath,
        hasSavedManagedRemoteProfile,
      };

      const result = await runTunnelDoctor({
        providerId,
        modeFilter,
        doctorRequest,
      });
      return res.json(result);
    } catch (error) {
      if (error instanceof TunnelServiceError) {
        return res.status(400).json({ ok: false, error: error.message, code: error.code });
      }
      console.warn('Tunnel doctor failed:', error);
      return res.status(500).json({ ok: false, error: 'Failed to run tunnel doctor' });
    }
  };
  app.post('/api/openchamber/tunnel/doctor', handleTunnelDoctor);
  app.get('/api/openchamber/tunnel/doctor', handleTunnelDoctor);

  app.get('/api/openchamber/tunnel/providers', (_req, res) => {
    const providers = tunnelProviderRegistry.listCapabilities();
    return res.json({ providers });
  });

  app.get('/api/openchamber/tunnel/status', async (_req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      const normalizedMode = normalizeTunnelMode(settings?.tunnelMode);
      const managedRemoteHostname = normalizeManagedRemoteTunnelHostname(settings?.managedRemoteTunnelHostname);
      const managedRemoteTunnelConfig = await readManagedRemoteTunnelConfigFromDisk();
      const managedRemoteTunnelPresetSummaries = managedRemoteTunnelConfig.tunnels.map((entry) => ({
        id: entry.id,
        name: entry.name,
        hostname: entry.hostname,
      }));
      const hasStoredManagedRemoteToken = typeof settings?.managedRemoteTunnelToken === 'string' && settings.managedRemoteTunnelToken.trim().length > 0;
      const hasManagedRemoteTunnelToken = runtimeManagedRemoteTunnelToken.length > 0 || managedRemoteTunnelConfig.tunnels.length > 0 || hasStoredManagedRemoteToken;
      const bootstrapTtlMs = settings?.tunnelBootstrapTtlMs === null
        ? null
        : normalizeTunnelBootstrapTtlMs(settings?.tunnelBootstrapTtlMs);
      const sessionTtlMs = normalizeTunnelSessionTtlMs(settings?.tunnelSessionTtlMs);
      const activeSessions = tunnelAuthController.listTunnelSessions();
      const activeProvider = tunnelService.resolveActiveProvider();
      const provider = activeProvider || normalizeTunnelProvider(settings?.tunnelProvider);

      const publicUrl = tunnelService.getPublicUrl();
      if (!publicUrl) {
        return res.json({
          active: false,
          url: null,
          mode: normalizedMode,
          provider,
          providerMetadata: null,
          hasManagedRemoteTunnelToken,
          managedRemoteTunnelHostname: managedRemoteHostname || null,
          managedRemoteTunnelPresets: managedRemoteTunnelPresetSummaries,
          managedRemoteTunnelTokenPresetIds: managedRemoteTunnelConfig.tunnels.map((entry) => entry.id),
          hasBootstrapToken: false,
          bootstrapExpiresAt: null,
          policy: 'tunnel-gated',
          activeTunnelMode: tunnelAuthController.getActiveTunnelMode() || null,
          activeSessions,
          localPort: activePort,
          ttlConfig: {
            bootstrapTtlMs,
            sessionTtlMs,
          },
        });
      }

      const activeNormalizedMode = resolveActiveNormalizedTunnelMode();
      const activeTunnelId = tunnelAuthController.getActiveTunnelId();
      const activeTunnelHost = tunnelAuthController.getActiveTunnelHost();
      const resolvedTunnelHost = resolveNormalizedTunnelHost(publicUrl);
      const activeTunnelMode = tunnelAuthController.getActiveTunnelMode();
      const needsActiveTunnelSync = !activeTunnelId
        || !activeTunnelHost
        || !resolvedTunnelHost
        || activeTunnelHost !== resolvedTunnelHost
        || activeTunnelMode !== activeNormalizedMode;
      if (needsActiveTunnelSync) {
        tunnelAuthController.setActiveTunnel({
          tunnelId: activeTunnelId || crypto.randomUUID(),
          publicUrl,
          mode: activeNormalizedMode,
        });
      }

      const bootstrapStatus = tunnelAuthController.getBootstrapStatus();
      const providerMetadata = tunnelService.getProviderMetadata();

      return res.json({
         active: true,
         url: publicUrl,
         mode: activeNormalizedMode,
         provider,
         providerMetadata,
         hasManagedRemoteTunnelToken,
         managedRemoteTunnelHostname: managedRemoteHostname || null,
         managedRemoteTunnelPresets: managedRemoteTunnelPresetSummaries,
         managedRemoteTunnelTokenPresetIds: managedRemoteTunnelConfig.tunnels.map((entry) => entry.id),
        hasBootstrapToken: bootstrapStatus.hasBootstrapToken,
        bootstrapExpiresAt: bootstrapStatus.bootstrapExpiresAt,
        policy: 'tunnel-gated',
         activeTunnelMode: activeNormalizedMode,
        activeSessions: tunnelAuthController.listTunnelSessions(),
        localPort: activePort,
        ttlConfig: {
          bootstrapTtlMs,
          sessionTtlMs,
        },
      });
    } catch (error) {
      return res.status(500).json({ error: 'Failed to get tunnel status' });
    }
  });

  app.put('/api/openchamber/tunnel/managed-remote-token', async (req, res) => {
    try {
      // Token presets are currently Cloudflare-specific.
      const presetId = typeof req?.body?.presetId === 'string' ? req.body.presetId.trim() : '';
      const presetName = typeof req?.body?.presetName === 'string' ? req.body.presetName.trim() : '';
      const managedRemoteTunnelHostname = normalizeManagedRemoteTunnelHostname(req?.body?.managedRemoteTunnelHostname);
      const managedRemoteTunnelToken = typeof req?.body?.managedRemoteTunnelToken === 'string' ? req.body.managedRemoteTunnelToken.trim() : '';

      if (!presetId || !presetName || !managedRemoteTunnelHostname || !managedRemoteTunnelToken) {
        return res.status(400).json({ ok: false, error: 'presetId, presetName, managedRemoteTunnelHostname and managedRemoteTunnelToken are required' });
      }

      await upsertManagedRemoteTunnelToken({
        id: presetId,
        name: presetName,
        hostname: managedRemoteTunnelHostname,
        token: managedRemoteTunnelToken,
      });

      const managedRemoteTunnelConfig = await readManagedRemoteTunnelConfigFromDisk();
      return res.json({ ok: true, managedRemoteTunnelTokenPresetIds: managedRemoteTunnelConfig.tunnels.map((entry) => entry.id) });
    } catch (error) {
      return res.status(500).json({ ok: false, error: 'Failed to save managed remote tunnel token' });
    }
  });

  app.post('/api/openchamber/tunnel/start', async (_req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      // Reject explicitly supplied unknown providers/modes early, before normalization converts them to defaults.
      if (typeof _req?.body?.provider === 'string' && _req.body.provider.trim().length > 0) {
        const rawProvider = _req.body.provider.trim().toLowerCase();
        if (!tunnelProviderRegistry.get(rawProvider)) {
          return res.status(422).json({ ok: false, error: `Unsupported tunnel provider: ${rawProvider}`, code: 'provider_unsupported' });
        }
      }
      const provider = normalizeTunnelProvider(_req?.body?.provider ?? settings?.tunnelProvider);
      const modeInput = _req?.body?.mode ?? settings?.tunnelMode;
      const intent = typeof _req?.body?.intent === 'string' ? _req.body.intent.trim().toLowerCase() : undefined;
      const mode = typeof modeInput === 'string'
        ? modeInput.trim().toLowerCase()
        : normalizeTunnelMode(modeInput);
      if (typeof _req?.body?.mode === 'string' && _req.body.mode.trim().length > 0 && !isSupportedTunnelMode(mode)) {
        return res.status(422).json({ ok: false, error: `Unsupported tunnel mode: ${mode}`, code: 'mode_unsupported' });
      }
      const selectedPresetId = typeof _req?.body?.managedRemoteTunnelPresetId === 'string' ? _req.body.managedRemoteTunnelPresetId.trim() : '';
      const selectedPresetName = typeof _req?.body?.managedRemoteTunnelPresetName === 'string' ? _req.body.managedRemoteTunnelPresetName.trim() : '';
      const requestConfigPath = normalizeOptionalPath(_req?.body?.configPath)
        ?? normalizeOptionalPath(settings?.managedLocalTunnelConfigPath);
      const requestManagedRemoteHostname = normalizeManagedRemoteTunnelHostname(_req?.body?.managedRemoteTunnelHostname);
      const requestTunnelHostname = normalizeManagedRemoteTunnelHostname(_req?.body?.tunnelHostname);
      const requestHostname = normalizeManagedRemoteTunnelHostname(_req?.body?.hostname);
      const hostnameFromSettings = normalizeManagedRemoteTunnelHostname(settings?.managedRemoteTunnelHostname);
      const hostname = requestHostname || requestTunnelHostname || requestManagedRemoteHostname || hostnameFromSettings;
      const requestManagedRemoteToken = typeof _req?.body?.managedRemoteTunnelToken === 'string' ? _req.body.managedRemoteTunnelToken.trim() : '';
      const requestTunnelToken = typeof _req?.body?.tunnelToken === 'string' ? _req.body.tunnelToken.trim() : '';
      const requestToken = typeof _req?.body?.token === 'string' ? _req.body.token.trim() : '';
      const storedManagedRemoteToken = typeof settings?.managedRemoteTunnelToken === 'string' ? settings.managedRemoteTunnelToken.trim() : '';
      const configManagedRemoteToken = provider === TUNNEL_PROVIDER_CLOUDFLARE
        ? await resolveManagedRemoteTunnelToken({ presetId: selectedPresetId, hostname })
        : '';
      const token = requestToken
        || requestTunnelToken
        || requestManagedRemoteToken
        || ((runtimeManagedRemoteTunnelHostname && hostname && runtimeManagedRemoteTunnelHostname === hostname) ? runtimeManagedRemoteTunnelToken : '')
        || configManagedRemoteToken
        || storedManagedRemoteToken;
      const requestConnectTtlMs = typeof _req?.body?.connectTtlMs === 'number' && Number.isFinite(_req.body.connectTtlMs)
        ? normalizeTunnelBootstrapTtlMs(_req.body.connectTtlMs)
        : undefined;
      const requestSessionTtlMs = typeof _req?.body?.sessionTtlMs === 'number' && Number.isFinite(_req.body.sessionTtlMs)
        ? normalizeTunnelSessionTtlMs(_req.body.sessionTtlMs)
        : undefined;
      const bootstrapTtlMs = requestConnectTtlMs ?? (settings?.tunnelBootstrapTtlMs === null
        ? null
        : normalizeTunnelBootstrapTtlMs(settings?.tunnelBootstrapTtlMs));
      const sessionTtlMs = requestSessionTtlMs ?? normalizeTunnelSessionTtlMs(settings?.tunnelSessionTtlMs);

      const previousTunnelId = tunnelAuthController.getActiveTunnelId();
      const previousMode = tunnelAuthController.getActiveTunnelMode();
      const previousProvider = tunnelService.resolveActiveProvider();
      const previousUrl = tunnelService.getPublicUrl();

      const { publicUrl, provider: activeProvider, providerMetadata } = await startTunnelWithNormalizedRequest({
        provider,
        mode,
        intent,
        hostname,
        token,
        configPath: requestConfigPath,
        selectedPresetId,
        selectedPresetName,
      });

      const replacedTunnel = Boolean(previousTunnelId) && (
        previousMode !== mode
        || previousProvider !== activeProvider
        || previousUrl !== publicUrl
      );
      let revokedBootstrapCount = 0;
      let invalidatedSessionCount = 0;
      if (replacedTunnel && previousTunnelId) {
        const revoked = tunnelAuthController.revokeTunnelArtifacts(previousTunnelId);
        revokedBootstrapCount = revoked.revokedBootstrapCount;
        invalidatedSessionCount = revoked.invalidatedSessionCount;
      }

      tunnelAuthController.setActiveTunnel({
        tunnelId: replacedTunnel || !previousTunnelId ? crypto.randomUUID() : previousTunnelId,
        publicUrl,
        mode,
      });

      const bootstrapToken = tunnelAuthController.issueBootstrapToken({ ttlMs: bootstrapTtlMs });
      const connectUrl = `${publicUrl.replace(/\/$/, '')}/connect?t=${encodeURIComponent(bootstrapToken.token)}`;
      const managedRemoteTunnelConfig = await readManagedRemoteTunnelConfigFromDisk();
      const isCloudflareProvider = activeProvider === TUNNEL_PROVIDER_CLOUDFLARE;

      return res.json({
        ok: true,
        url: publicUrl,
        mode,
        provider: activeProvider,
        providerMetadata,
        managedRemoteTunnelHostname: isCloudflareProvider ? (hostname || null) : null,
        managedRemoteTunnelTokenPresetIds: isCloudflareProvider ? managedRemoteTunnelConfig.tunnels.map((entry) => entry.id) : [],
        connectUrl,
        bootstrapExpiresAt: bootstrapToken.expiresAt,
        replacedTunnel,
        replaced: replacedTunnel
          ? {
            mode: previousMode,
            provider: previousProvider,
            url: previousUrl,
          }
          : null,
        revokedBootstrapCount,
        invalidatedSessionCount,
        policy: 'tunnel-gated',
        activeTunnelMode: mode,
        activeSessions: tunnelAuthController.listTunnelSessions(),
        localPort: activePort,
        ttlConfig: {
          bootstrapTtlMs,
          sessionTtlMs,
        },
      });
    } catch (error) {
      console.error('Failed to start tunnel:', error);
      activeTunnelController = null;
      tunnelAuthController.clearActiveTunnel();
      if (error instanceof TunnelServiceError) {
        const status = error.code === 'missing_dependency'
          ? 400
          : (error.code === 'validation_error' || error.code === 'provider_unsupported' || error.code === 'mode_unsupported'
            ? 422
            : 500);
        return res.status(status).json({ ok: false, error: error.message, code: error.code });
      }
      return res.status(500).json({ ok: false, error: 'Failed to start tunnel', code: 'startup_failed' });
    }
  });

  app.post('/api/openchamber/tunnel/stop', (_req, res) => {
    let revokedBootstrapCount = 0;
    let invalidatedSessionCount = 0;
    const activeTunnelId = tunnelAuthController.getActiveTunnelId();

    if (activeTunnelId) {
      const revoked = tunnelAuthController.revokeTunnelArtifacts(activeTunnelId);
      revokedBootstrapCount = revoked.revokedBootstrapCount;
      invalidatedSessionCount = revoked.invalidatedSessionCount;
    }

    if (activeTunnelController) {
      console.log('Stopping active tunnel (user requested)...');
      tunnelService.stop();
    }

    tunnelAuthController.clearActiveTunnel();
    res.json({ ok: true, revokedBootstrapCount, invalidatedSessionCount });
  });

  // ── End Tunnel API ────────────────────────────────────────────────

  const getOpenCodeResolutionSnapshot = async (settings) => {
    const configured = typeof settings?.opencodeBinary === 'string' ? settings.opencodeBinary : null;

    const previousSource = resolvedOpencodeBinarySource;
    const detectedNow = resolveOpencodeCliPath();
    const rawDetectedSourceNow = resolvedOpencodeBinarySource;
    resolvedOpencodeBinarySource = previousSource;

    await applyOpencodeBinaryFromSettings();
    ensureOpencodeCliEnv();

    const resolved = resolvedOpencodeBinary || null;
    const source = resolvedOpencodeBinarySource || null;
    const detectedSourceNow =
      detectedNow &&
      resolved &&
      detectedNow === resolved &&
      rawDetectedSourceNow === 'env' &&
      source &&
      source !== 'env'
        ? source
        : rawDetectedSourceNow;
    const shim = resolved ? opencodeShimInterpreter(resolved) : null;

    return {
      configured,
      resolved,
      resolvedDir: resolved ? path.dirname(resolved) : null,
      source,
      detectedNow,
      detectedSourceNow,
      shim,
      viaWsl: useWslForOpencode,
      wslBinary: resolvedWslBinary || null,
      wslPath: resolvedWslOpencodePath || null,
      wslDistro: resolvedWslDistro || null,
      node: resolvedNodeBinary || null,
      bun: resolvedBunBinary || null,
    };
  };

  app.get('/api/config/themes', async (_req, res) => {
    try {
      const customThemes = await readCustomThemesFromDisk();
      res.json({ themes: customThemes });
    } catch (error) {
      console.error('Failed to load custom themes:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load custom themes' });
    }
  });

  registerOpenCodeRoutes(app, {
    crypto,
    clientReloadDelayMs: CLIENT_RELOAD_DELAY_MS,
    getOpenCodeResolutionSnapshot,
    formatSettingsResponse,
    readSettingsFromDisk,
    readSettingsFromDiskMigrated,
    persistSettings,
    sanitizeProjects,
    validateDirectoryPath,
    resolveProjectDirectory,
    getProviderSources,
    removeProviderConfig,
    refreshOpenCodeAfterConfigChange,
  });

  app.get('/api/projects/:projectId/icon', async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId.trim() : '';
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      const { project } = findProjectById(settings, projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const metadataMime = normalizeProjectIconMime(project.iconImage?.mime);
      const preferredPath = metadataMime ? projectIconPathForMime(projectId, metadataMime) : null;
      const candidates = preferredPath
        ? [preferredPath, ...projectIconPathCandidates(projectId).filter((candidate) => candidate !== preferredPath)]
        : projectIconPathCandidates(projectId);

      const themeQuery = Array.isArray(req.query?.theme) ? req.query.theme[0] : req.query?.theme;
      const requestedThemeVariant = normalizeProjectIconThemeVariant(themeQuery);
      const iconColorQuery = Array.isArray(req.query?.iconColor) ? req.query.iconColor[0] : req.query?.iconColor;
      const requestedIconColor = normalizeProjectIconColor(iconColorQuery);

      for (const iconPath of candidates) {
        try {
          const data = await fsPromises.readFile(iconPath);
          const ext = path.extname(iconPath).slice(1).toLowerCase();
          const resolvedMime = metadataMime || PROJECT_ICON_EXTENSION_TO_MIME[ext] || 'application/octet-stream';
          const contentType = resolvedMime === 'image/svg+xml' ? 'image/svg+xml; charset=utf-8' : resolvedMime;

          if (resolvedMime === 'image/svg+xml' && requestedThemeVariant) {
            const svgMarkup = data.toString('utf8');
            const themedSvgMarkup = applyProjectIconSvgTheme(svgMarkup, requestedThemeVariant, requestedIconColor);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            return res.send(themedSvgMarkup);
          }

          if (resolvedMime === 'image/svg+xml' && requestedIconColor) {
            const svgMarkup = data.toString('utf8');
            const themedSvgMarkup = applyProjectIconSvgTheme(svgMarkup, requestedThemeVariant, requestedIconColor);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            return res.send(themedSvgMarkup);
          }

          res.setHeader('Content-Type', contentType);
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          return res.send(data);
        } catch (error) {
          if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
            console.warn('Failed to read project icon:', error);
            return res.status(500).json({ error: 'Failed to read project icon' });
          }
        }
      }

      return res.status(404).json({ error: 'Project icon not found' });
    } catch (error) {
      console.warn('Failed to load project icon:', error);
      return res.status(500).json({ error: 'Failed to load project icon' });
    }
  });

  app.put('/api/projects/:projectId/icon', async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId.trim() : '';
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const parsed = parseProjectIconDataUrl(req.body?.dataUrl);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      const { projects, project } = findProjectById(settings, projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const iconPath = projectIconPathForMime(projectId, parsed.mime);
      if (!iconPath) {
        return res.status(400).json({ error: 'Unsupported icon format' });
      }

      await fsPromises.mkdir(PROJECT_ICONS_DIR_PATH, { recursive: true });
      await fsPromises.writeFile(iconPath, parsed.bytes);
      await removeProjectIconFiles(projectId, iconPath);

      const updatedAt = Date.now();
      const nextProjects = projects.map((entry) => (
        entry.id === projectId
          ? { ...entry, iconImage: { mime: parsed.mime, updatedAt, source: 'custom' } }
          : entry
      ));
      const updatedSettings = await persistSettings({ projects: nextProjects });
      const updatedProject = (updatedSettings.projects || []).find((entry) => entry.id === projectId) || null;

      return res.json({ project: updatedProject, settings: updatedSettings });
    } catch (error) {
      console.warn('Failed to upload project icon:', error);
      return res.status(500).json({ error: 'Failed to upload project icon' });
    }
  });

  app.delete('/api/projects/:projectId/icon', async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId.trim() : '';
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      const { projects, project } = findProjectById(settings, projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      await removeProjectIconFiles(projectId);

      const nextProjects = projects.map((entry) => (
        entry.id === projectId
          ? { ...entry, iconImage: null }
          : entry
      ));
      const updatedSettings = await persistSettings({ projects: nextProjects });
      const updatedProject = (updatedSettings.projects || []).find((entry) => entry.id === projectId) || null;

      return res.json({ project: updatedProject, settings: updatedSettings });
    } catch (error) {
      console.warn('Failed to remove project icon:', error);
      return res.status(500).json({ error: 'Failed to remove project icon' });
    }
  });

  const fsSearchRuntime = createFsSearchRuntime({
    fsPromises,
    path,
    spawn,
    resolveGitBinaryForSpawn,
  });

  app.post('/api/projects/:projectId/icon/discover', async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId.trim() : '';
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      const { projects, project } = findProjectById(settings, projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const force = req.body?.force === true;
      if (project.iconImage?.source === 'custom' && !force) {
        return res.json({
          project,
          skipped: true,
          reason: 'custom-icon-present',
        });
      }

      const faviconCandidates = await fsSearchRuntime.searchFilesystemFiles(project.path, {
        limit: 200,
        query: 'favicon',
        includeHidden: true,
        respectGitignore: false,
      });

      const filtered = faviconCandidates
        .filter((entry) => /(^|\/)favicon\.(ico|png|svg|jpg|jpeg|webp)$/i.test(entry.path))
        .sort((a, b) => a.path.length - b.path.length);

      const selected = filtered[0];
      if (!selected) {
        return res.status(404).json({ error: 'No favicon found in project' });
      }

      const ext = path.extname(selected.path).slice(1).toLowerCase();
      const mime = PROJECT_ICON_EXTENSION_TO_MIME[ext] || null;
      if (!mime) {
        return res.status(415).json({ error: 'Unsupported favicon format' });
      }

      const bytes = await fsPromises.readFile(selected.path);
      if (bytes.length === 0) {
        return res.status(400).json({ error: 'Discovered icon is empty' });
      }
      if (bytes.length > PROJECT_ICON_MAX_BYTES) {
        return res.status(400).json({ error: 'Discovered icon exceeds size limit (5 MB)' });
      }

      const iconPath = projectIconPathForMime(projectId, mime);
      if (!iconPath) {
        return res.status(415).json({ error: 'Unsupported favicon format' });
      }

      await fsPromises.mkdir(PROJECT_ICONS_DIR_PATH, { recursive: true });
      await fsPromises.writeFile(iconPath, bytes);
      await removeProjectIconFiles(projectId, iconPath);

      const updatedAt = Date.now();
      const nextProjects = projects.map((entry) => (
        entry.id === projectId
          ? { ...entry, iconImage: { mime, updatedAt, source: 'auto' } }
          : entry
      ));
      const updatedSettings = await persistSettings({ projects: nextProjects });
      const updatedProject = (updatedSettings.projects || []).find((entry) => entry.id === projectId) || null;

      return res.json({
        project: updatedProject,
        settings: updatedSettings,
        discoveredPath: selected.path,
      });
    } catch (error) {
      console.warn('Failed to discover project icon:', error);
      return res.status(500).json({ error: 'Failed to discover project icon' });
    }
  });

  const {
    getAgentSources,
    getAgentScope,
    getAgentConfig,
    createAgent,
    updateAgent,
    deleteAgent,
    getCommandSources,
    getCommandScope,
    createCommand,
    updateCommand,
    deleteCommand,
    getProviderSources,
    removeProviderConfig,
    AGENT_SCOPE,
    COMMAND_SCOPE,
    listMcpConfigs,
    getMcpConfig,
    createMcpConfig,
    updateMcpConfig,
    deleteMcpConfig,
  } = await import('./lib/opencode/index.js');

  app.get('/api/config/agents/:name', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      const sources = getAgentSources(agentName, directory);

      const scope = sources.md.exists
        ? sources.md.scope
        : (sources.json.exists ? sources.json.scope : null);

      res.json({
        name: agentName,
        sources: sources,
        scope,
        isBuiltIn: !sources.md.exists && !sources.json.exists
      });
    } catch (error) {
      console.error('Failed to get agent sources:', error);
      res.status(500).json({ error: 'Failed to get agent configuration metadata' });
    }
  });

  app.get('/api/config/agents/:name/config', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      const configInfo = getAgentConfig(agentName, directory);
      res.json(configInfo);
    } catch (error) {
      console.error('Failed to get agent config:', error);
      res.status(500).json({ error: 'Failed to get agent configuration' });
    }
  });

  app.post('/api/config/agents/:name', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { scope, ...config } = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log('[Server] Creating agent:', agentName);
      console.log('[Server] Config received:', JSON.stringify(config, null, 2));
      console.log('[Server] Scope:', scope, 'Working directory:', directory);

      createAgent(agentName, config, directory, scope);
      await refreshOpenCodeAfterConfigChange('agent creation', {
        agentName
      });

      res.json({
        success: true,
        requiresReload: true,
        message: `Agent ${agentName} created successfully. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('Failed to create agent:', error);
      res.status(500).json({ error: error.message || 'Failed to create agent' });
    }
  });

  app.patch('/api/config/agents/:name', async (req, res) => {
    try {
      const agentName = req.params.name;
      const updates = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log(`[Server] Updating agent: ${agentName}`);
      console.log('[Server] Updates:', JSON.stringify(updates, null, 2));
      console.log('[Server] Working directory:', directory);

      updateAgent(agentName, updates, directory);
      await refreshOpenCodeAfterConfigChange('agent update');

      console.log(`[Server] Agent ${agentName} updated successfully`);

      res.json({
        success: true,
        requiresReload: true,
        message: `Agent ${agentName} updated successfully. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('[Server] Failed to update agent:', error);
      console.error('[Server] Error stack:', error.stack);
      res.status(500).json({ error: error.message || 'Failed to update agent' });
    }
  });

  app.delete('/api/config/agents/:name', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      deleteAgent(agentName, directory);
      await refreshOpenCodeAfterConfigChange('agent deletion');

      res.json({
        success: true,
        requiresReload: true,
        message: `Agent ${agentName} deleted successfully. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('Failed to delete agent:', error);
      res.status(500).json({ error: error.message || 'Failed to delete agent' });
    }
  });

  // ============================================================
  // MCP Config Routes
  // ============================================================

  app.get('/api/config/mcp', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const configs = listMcpConfigs(directory);
      res.json(configs);
    } catch (error) {
      console.error('[API:GET /api/config/mcp] Failed:', error);
      res.status(500).json({ error: error.message || 'Failed to list MCP configs' });
    }
  });

  app.get('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const config = getMcpConfig(name, directory);
      if (!config) {
        return res.status(404).json({ error: `MCP server "${name}" not found` });
      }
      res.json(config);
    } catch (error) {
      console.error('[API:GET /api/config/mcp/:name] Failed:', error);
      res.status(500).json({ error: error.message || 'Failed to get MCP config' });
    }
  });

  app.post('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { scope, ...config } = req.body || {};
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      console.log(`[API:POST /api/config/mcp] Creating MCP server: ${name}`);

      createMcpConfig(name, config, directory, scope);
      await refreshOpenCodeAfterConfigChange('mcp creation', { mcpName: name });

      res.json({
        success: true,
        requiresReload: true,
        message: `MCP server "${name}" created. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('[API:POST /api/config/mcp/:name] Failed:', error);
      res.status(500).json({ error: error.message || 'Failed to create MCP server' });
    }
  });

  app.patch('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const updates = req.body;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      console.log(`[API:PATCH /api/config/mcp] Updating MCP server: ${name}`);

      updateMcpConfig(name, updates, directory);
      await refreshOpenCodeAfterConfigChange('mcp update');

      res.json({
        success: true,
        requiresReload: true,
        message: `MCP server "${name}" updated. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('[API:PATCH /api/config/mcp/:name] Failed:', error);
      res.status(500).json({ error: error.message || 'Failed to update MCP server' });
    }
  });

  app.delete('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      console.log(`[API:DELETE /api/config/mcp] Deleting MCP server: ${name}`);

      deleteMcpConfig(name, directory);
      await refreshOpenCodeAfterConfigChange('mcp deletion');

      res.json({
        success: true,
        requiresReload: true,
        message: `MCP server "${name}" deleted. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('[API:DELETE /api/config/mcp/:name] Failed:', error);
      res.status(500).json({ error: error.message || 'Failed to delete MCP server' });
    }
  });

  app.get('/api/config/commands/:name', async (req, res) => {
    try {
      const commandName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      const sources = getCommandSources(commandName, directory);

      const scope = sources.md.exists
        ? sources.md.scope
        : (sources.json.exists ? sources.json.scope : null);

      res.json({
        name: commandName,
        sources: sources,
        scope,
        isBuiltIn: !sources.md.exists && !sources.json.exists
      });
    } catch (error) {
      console.error('Failed to get command sources:', error);
      res.status(500).json({ error: 'Failed to get command configuration metadata' });
    }
  });

  app.post('/api/config/commands/:name', async (req, res) => {
    try {
      const commandName = req.params.name;
      const { scope, ...config } = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log('[Server] Creating command:', commandName);
      console.log('[Server] Config received:', JSON.stringify(config, null, 2));
      console.log('[Server] Scope:', scope, 'Working directory:', directory);

      createCommand(commandName, config, directory, scope);
      await refreshOpenCodeAfterConfigChange('command creation', {
        commandName
      });

      res.json({
        success: true,
        requiresReload: true,
        message: `Command ${commandName} created successfully. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('Failed to create command:', error);
      res.status(500).json({ error: error.message || 'Failed to create command' });
    }
  });

  app.patch('/api/config/commands/:name', async (req, res) => {
    try {
      const commandName = req.params.name;
      const updates = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log(`[Server] Updating command: ${commandName}`);
      console.log('[Server] Updates:', JSON.stringify(updates, null, 2));
      console.log('[Server] Working directory:', directory);

      updateCommand(commandName, updates, directory);
      await refreshOpenCodeAfterConfigChange('command update');

      console.log(`[Server] Command ${commandName} updated successfully`);

      res.json({
        success: true,
        requiresReload: true,
        message: `Command ${commandName} updated successfully. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('[Server] Failed to update command:', error);
      console.error('[Server] Error stack:', error.stack);
      res.status(500).json({ error: error.message || 'Failed to update command' });
    }
  });

  app.delete('/api/config/commands/:name', async (req, res) => {
    try {
      const commandName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      deleteCommand(commandName, directory);
      await refreshOpenCodeAfterConfigChange('command deletion');

      res.json({
        success: true,
        requiresReload: true,
        message: `Command ${commandName} deleted successfully. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('Failed to delete command:', error);
      res.status(500).json({ error: error.message || 'Failed to delete command' });
    }
  });

  // ============== SKILL ENDPOINTS ==============

  const {
    getSkillSources,
    discoverSkills,
    createSkill,
    updateSkill,
    deleteSkill,
    readSkillSupportingFile,
    writeSkillSupportingFile,
    deleteSkillSupportingFile,
    SKILL_SCOPE,
    SKILL_DIR,
  } = await import('./lib/opencode/index.js');

  const findWorktreeRootForSkills = (workingDirectory) => {
    if (!workingDirectory) return null;
    let current = path.resolve(workingDirectory);
    while (true) {
      if (fs.existsSync(path.join(current, '.git'))) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  };

  const getSkillProjectAncestors = (workingDirectory) => {
    if (!workingDirectory) return [];
    const result = [];
    let current = path.resolve(workingDirectory);
    const stop = findWorktreeRootForSkills(workingDirectory) || current;
    while (true) {
      result.push(current);
      if (current === stop) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return result;
  };

  const isPathInside = (candidatePath, parentPath) => {
    if (!candidatePath || !parentPath) return false;
    const normalizedCandidate = path.resolve(candidatePath);
    const normalizedParent = path.resolve(parentPath);
    return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
  };

  const inferSkillScopeAndSourceFromPath = (skillPath, workingDirectory) => {
    const resolvedPath = typeof skillPath === 'string' ? path.resolve(skillPath) : '';
    const home = os.homedir();
    const source = resolvedPath.includes(`${path.sep}.agents${path.sep}skills${path.sep}`)
      ? 'agents'
      : resolvedPath.includes(`${path.sep}.claude${path.sep}skills${path.sep}`)
        ? 'claude'
        : 'opencode';

    const projectAncestors = getSkillProjectAncestors(workingDirectory);
    const isProjectScoped = projectAncestors.some((ancestor) => {
      const candidates = [
        path.join(ancestor, '.opencode'),
        path.join(ancestor, '.claude', 'skills'),
        path.join(ancestor, '.agents', 'skills'),
      ];
      return candidates.some((candidate) => isPathInside(resolvedPath, candidate));
    });

    if (isProjectScoped) {
      return { scope: SKILL_SCOPE.PROJECT, source };
    }

    const userRoots = [
      path.join(home, '.config', 'opencode'),
      path.join(home, '.opencode'),
      path.join(home, '.claude', 'skills'),
      path.join(home, '.agents', 'skills'),
      process.env.OPENCODE_CONFIG_DIR ? path.resolve(process.env.OPENCODE_CONFIG_DIR) : null,
    ].filter(Boolean);

    if (userRoots.some((root) => isPathInside(resolvedPath, root))) {
      return { scope: SKILL_SCOPE.USER, source };
    }

    return { scope: SKILL_SCOPE.USER, source };
  };

  const fetchOpenCodeDiscoveredSkills = async (workingDirectory) => {
    if (!openCodePort) {
      return null;
    }

    try {
      const url = new URL(buildOpenCodeUrl('/skill', ''));
      if (workingDirectory) {
        url.searchParams.set('directory', workingDirectory);
      }

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(8_000),
      });

      if (!response.ok) {
        return null;
      }

      const payload = await response.json();
      if (!Array.isArray(payload)) {
        return null;
      }

      return payload
        .map((item) => {
          const name = typeof item?.name === 'string' ? item.name.trim() : '';
          const location = typeof item?.location === 'string' ? item.location : '';
          const description = typeof item?.description === 'string' ? item.description : '';
          if (!name || !location) {
            return null;
          }
          const inferred = inferSkillScopeAndSourceFromPath(location, workingDirectory);
          return {
            name,
            path: location,
            scope: inferred.scope,
            source: inferred.source,
            description,
          };
        })
        .filter(Boolean);
    } catch {
      return null;
    }
  };

  // List all discovered skills
  app.get('/api/config/skills', async (req, res) => {
    try {
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      const skills = (await fetchOpenCodeDiscoveredSkills(directory)) || discoverSkills(directory);

      // Enrich with full sources info
      const enrichedSkills = skills.map(skill => {
        const sources = getSkillSources(skill.name, directory, skill);
        return {
          ...skill,
          sources
        };
      });

      res.json({ skills: enrichedSkills });
    } catch (error) {
      console.error('Failed to list skills:', error);
      res.status(500).json({ error: 'Failed to list skills' });
    }
  });

  // ============== SKILLS CATALOG + INSTALL ENDPOINTS ==============

  const {
    getCuratedSkillsSources,
    getCacheKey,
    getCachedScan,
    setCachedScan,
    parseSkillRepoSource,
    scanSkillsRepository,
    installSkillsFromRepository,
    scanClawdHubPage,
    installSkillsFromClawdHub,
    isClawdHubSource,
  } = await import('./lib/skills-catalog/index.js');
  const { getProfiles, getProfile } = await import('./lib/git/index.js');

  const listGitIdentitiesForResponse = () => {
    try {
      const profiles = getProfiles();
      return profiles.map((p) => ({ id: p.id, name: p.name }));
    } catch {
      return [];
    }
  };

  const resolveGitIdentity = (profileId) => {
    if (!profileId) {
      return null;
    }
    try {
      const profile = getProfile(profileId);
      const sshKey = profile?.sshKey;
      if (typeof sshKey === 'string' && sshKey.trim()) {
        return { sshKey: sshKey.trim() };
      }
    } catch {
      // ignore
    }
    return null;
  };

  app.get('/api/config/skills/catalog', async (req, res) => {
    try {
      const { error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }

      const curatedSources = getCuratedSkillsSources();
      const settings = await readSettingsFromDisk();
      const customSourcesRaw = sanitizeSkillCatalogs(settings.skillCatalogs) || [];

      const customSources = customSourcesRaw.map((entry) => ({
        id: entry.id,
        label: entry.label,
        description: entry.source,
        source: entry.source,
        defaultSubpath: entry.subpath,
        gitIdentityId: entry.gitIdentityId,
      }));

      const sources = [...curatedSources, ...customSources];
      const sourcesForUi = sources.map(({ gitIdentityId, ...rest }) => rest);

      res.json({ ok: true, sources: sourcesForUi, itemsBySource: {}, pageInfoBySource: {} });
    } catch (error) {
      console.error('Failed to load skills catalog:', error);
      res.status(500).json({ ok: false, error: { kind: 'unknown', message: error.message || 'Failed to load catalog' } });
    }
  });

  app.get('/api/config/skills/catalog/source', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ ok: false, error: { kind: 'invalidSource', message: error } });
      }

      const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : null;
      if (!sourceId) {
        return res.status(400).json({ ok: false, error: { kind: 'invalidSource', message: 'Missing sourceId' } });
      }

      const refresh = String(req.query.refresh || '').toLowerCase() === 'true';
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;

      const curatedSources = getCuratedSkillsSources();
      const settings = await readSettingsFromDisk();
      const customSourcesRaw = sanitizeSkillCatalogs(settings.skillCatalogs) || [];

      const customSources = customSourcesRaw.map((entry) => ({
        id: entry.id,
        label: entry.label,
        description: entry.source,
        source: entry.source,
        defaultSubpath: entry.subpath,
        gitIdentityId: entry.gitIdentityId,
      }));

      const sources = [...curatedSources, ...customSources];
      const src = sources.find((entry) => entry.id === sourceId);

      if (!src) {
        return res.status(404).json({ ok: false, error: { kind: 'invalidSource', message: 'Unknown source' } });
      }

      const discovered = directory
        ? ((await fetchOpenCodeDiscoveredSkills(directory)) || discoverSkills(directory))
        : [];
      const installedByName = new Map(discovered.map((s) => [s.name, s]));

      if (src.sourceType === 'clawdhub' || isClawdHubSource(src.source)) {
        const scanned = await scanClawdHubPage({ cursor: cursor || null });
        if (!scanned.ok) {
          return res.status(500).json({ ok: false, error: scanned.error });
        }

        const items = (scanned.items || []).map((item) => {
          const installed = installedByName.get(item.skillName);
          return {
            ...item,
            sourceId: src.id,
            installed: installed
              ? { isInstalled: true, scope: installed.scope, source: installed.source }
              : { isInstalled: false },
          };
        });

        return res.json({ ok: true, items, nextCursor: scanned.nextCursor || null });
      }

      const parsed = parseSkillRepoSource(src.source);
      if (!parsed.ok) {
        return res.status(400).json({ ok: false, error: parsed.error });
      }

      const effectiveSubpath = src.defaultSubpath || parsed.effectiveSubpath || null;
      const cacheKey = getCacheKey({
        normalizedRepo: parsed.normalizedRepo,
        subpath: effectiveSubpath || '',
        identityId: src.gitIdentityId || '',
      });

      let scanResult = !refresh ? getCachedScan(cacheKey) : null;
      if (!scanResult) {
        const scanned = await scanSkillsRepository({
          source: src.source,
          subpath: src.defaultSubpath,
          defaultSubpath: src.defaultSubpath,
          identity: resolveGitIdentity(src.gitIdentityId),
        });

        if (!scanned.ok) {
          return res.status(500).json({ ok: false, error: scanned.error });
        }

        scanResult = scanned;
        setCachedScan(cacheKey, scanResult);
      }

      const items = (scanResult.items || []).map((item) => {
        const installed = installedByName.get(item.skillName);
        return {
          sourceId: src.id,
          ...item,
          gitIdentityId: src.gitIdentityId,
          installed: installed
            ? { isInstalled: true, scope: installed.scope, source: installed.source }
            : { isInstalled: false },
        };
      });

      return res.json({ ok: true, items });
    } catch (error) {
      console.error('Failed to load catalog source:', error);
      return res.status(500).json({
        ok: false,
        error: { kind: 'unknown', message: error.message || 'Failed to load catalog source' },
      });
    }
  });

  app.post('/api/config/skills/scan', async (req, res) => {
    try {
      const { source, subpath, gitIdentityId } = req.body || {};
      const identity = resolveGitIdentity(gitIdentityId);

      const result = await scanSkillsRepository({
        source,
        subpath,
        identity,
      });

      if (!result.ok) {
        if (result.error?.kind === 'authRequired') {
          return res.status(401).json({
            ok: false,
            error: {
              ...result.error,
              identities: listGitIdentitiesForResponse(),
            },
          });
        }

        return res.status(400).json({ ok: false, error: result.error });
      }

      res.json({ ok: true, items: result.items });
    } catch (error) {
      console.error('Failed to scan skills repository:', error);
      res.status(500).json({ ok: false, error: { kind: 'unknown', message: error.message || 'Failed to scan repository' } });
    }
  });

  app.post('/api/config/skills/install', async (req, res) => {
    try {
      const {
        source,
        subpath,
        gitIdentityId,
        scope,
        targetSource,
        selections,
        conflictPolicy,
        conflictDecisions,
      } = req.body || {};

      let workingDirectory = null;
      if (scope === 'project') {
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) {
          return res.status(400).json({
            ok: false,
            error: { kind: 'invalidSource', message: resolved.error || 'Project installs require a directory parameter' },
          });
        }
        workingDirectory = resolved.directory;
      }

      // Handle ClawdHub sources (ZIP download based)
      if (isClawdHubSource(source)) {
        const result = await installSkillsFromClawdHub({
          scope,
          targetSource,
          workingDirectory,
          userSkillDir: SKILL_DIR,
          selections,
          conflictPolicy,
          conflictDecisions,
        });

        if (!result.ok) {
          if (result.error?.kind === 'conflicts') {
            return res.status(409).json({ ok: false, error: result.error });
          }
          return res.status(400).json({ ok: false, error: result.error });
        }

        const installed = result.installed || [];
        const skipped = result.skipped || [];
        const requiresReload = installed.length > 0;

        if (requiresReload) {
          await refreshOpenCodeAfterConfigChange('skills install');
        }

        return res.json({
          ok: true,
          installed,
          skipped,
          requiresReload,
          message: requiresReload ? 'Skills installed successfully. Reloading interface…' : 'No skills were installed',
          reloadDelayMs: requiresReload ? CLIENT_RELOAD_DELAY_MS : undefined,
        });
      }

      // Handle GitHub sources (git clone based)
      const identity = resolveGitIdentity(gitIdentityId);

      const result = await installSkillsFromRepository({
        source,
        subpath,
        identity,
        scope,
        targetSource,
        workingDirectory,
        userSkillDir: SKILL_DIR,
        selections,
        conflictPolicy,
        conflictDecisions,
      });

      if (!result.ok) {
        if (result.error?.kind === 'conflicts') {
          return res.status(409).json({ ok: false, error: result.error });
        }

        if (result.error?.kind === 'authRequired') {
          return res.status(401).json({
            ok: false,
            error: {
              ...result.error,
              identities: listGitIdentitiesForResponse(),
            },
          });
        }

        return res.status(400).json({ ok: false, error: result.error });
      }

      const installed = result.installed || [];
      const skipped = result.skipped || [];
      const requiresReload = installed.length > 0;

      if (requiresReload) {
        await refreshOpenCodeAfterConfigChange('skills install');
      }

      res.json({
        ok: true,
        installed,
        skipped,
        requiresReload,
        message: requiresReload ? 'Skills installed successfully. Reloading interface…' : 'No skills were installed',
        reloadDelayMs: requiresReload ? CLIENT_RELOAD_DELAY_MS : undefined,
      });
    } catch (error) {
      console.error('Failed to install skills:', error);
      res.status(500).json({ ok: false, error: { kind: 'unknown', message: error.message || 'Failed to install skills' } });
    }
  });

  // Get single skill sources
  app.get('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      const discoveredSkill = ((await fetchOpenCodeDiscoveredSkills(directory)) || [])
        .find((skill) => skill.name === skillName) || null;
      const sources = getSkillSources(skillName, directory, discoveredSkill);

      res.json({
        name: skillName,
        sources: sources,
        scope: sources.md.scope,
        source: sources.md.source,
        exists: sources.md.exists
      });
    } catch (error) {
      console.error('Failed to get skill sources:', error);
      res.status(500).json({ error: 'Failed to get skill configuration metadata' });
    }
  });

  // Get skill supporting file content
  app.get('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const skillName = req.params.name;
      const filePath = decodeURIComponent(req.params.filePath); // Decode URL-encoded path
      if (isUnsafeSkillRelativePath(filePath)) {
        return res.status(400).json({ error: 'Invalid file path' });
      }
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

        const discoveredSkill = ((await fetchOpenCodeDiscoveredSkills(directory)) || [])
          .find((skill) => skill.name === skillName) || null;
        const sources = getSkillSources(skillName, directory, discoveredSkill);
      if (!sources.md.exists || !sources.md.dir) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      const content = readSkillSupportingFile(sources.md.dir, filePath);
      if (content === null) {
        return res.status(404).json({ error: 'File not found' });
      }

      res.json({ path: filePath, content });
    } catch (error) {
      if (error && typeof error === 'object' && (error.code === 'EACCES' || error.code === 'EPERM')) {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to read skill file:', error);
      res.status(500).json({ error: 'Failed to read skill file' });
    }
  });

  // Create new skill
  app.post('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const { scope, source: skillSource, ...config } = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log('[Server] Creating skill:', skillName);
      console.log('[Server] Scope:', scope, 'Working directory:', directory);

      createSkill(skillName, { ...config, source: skillSource }, directory, scope);
      await refreshOpenCodeAfterConfigChange('skill creation');

      res.json({
        success: true,
        requiresReload: true,
        message: `Skill ${skillName} created successfully. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('Failed to create skill:', error);
      res.status(500).json({ error: error.message || 'Failed to create skill' });
    }
  });

  // Update existing skill
  app.patch('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const updates = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log(`[Server] Updating skill: ${skillName}`);
      console.log('[Server] Working directory:', directory);

      updateSkill(skillName, updates, directory);
      await refreshOpenCodeAfterConfigChange('skill update');

      res.json({
        success: true,
        requiresReload: true,
        message: `Skill ${skillName} updated successfully. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('[Server] Failed to update skill:', error);
      res.status(500).json({ error: error.message || 'Failed to update skill' });
    }
  });

  // Update/create supporting file
  app.put('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const skillName = req.params.name;
      const filePath = decodeURIComponent(req.params.filePath); // Decode URL-encoded path
      if (isUnsafeSkillRelativePath(filePath)) {
        return res.status(400).json({ error: 'Invalid file path' });
      }
      const { content } = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      const discoveredSkill = ((await fetchOpenCodeDiscoveredSkills(directory)) || [])
        .find((skill) => skill.name === skillName) || null;
      const sources = getSkillSources(skillName, directory, discoveredSkill);
      if (!sources.md.exists || !sources.md.dir) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      writeSkillSupportingFile(sources.md.dir, filePath, content || '');

      res.json({
        success: true,
        message: `File ${filePath} saved successfully`,
      });
    } catch (error) {
      if (error && typeof error === 'object' && (error.code === 'EACCES' || error.code === 'EPERM')) {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to write skill file:', error);
      res.status(500).json({ error: error.message || 'Failed to write skill file' });
    }
  });

  // Delete supporting file
  app.delete('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const skillName = req.params.name;
      const filePath = decodeURIComponent(req.params.filePath); // Decode URL-encoded path
      if (isUnsafeSkillRelativePath(filePath)) {
        return res.status(400).json({ error: 'Invalid file path' });
      }
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      const discoveredSkill = ((await fetchOpenCodeDiscoveredSkills(directory)) || [])
        .find((skill) => skill.name === skillName) || null;
      const sources = getSkillSources(skillName, directory, discoveredSkill);
      if (!sources.md.exists || !sources.md.dir) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      deleteSkillSupportingFile(sources.md.dir, filePath);

      res.json({
        success: true,
        message: `File ${filePath} deleted successfully`,
      });
    } catch (error) {
      if (error && typeof error === 'object' && (error.code === 'EACCES' || error.code === 'EPERM')) {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to delete skill file:', error);
      res.status(500).json({ error: error.message || 'Failed to delete skill file' });
    }
  });

  // Delete skill
  app.delete('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      deleteSkill(skillName, directory);
      await refreshOpenCodeAfterConfigChange('skill deletion');

      res.json({
        success: true,
        requiresReload: true,
        message: `Skill ${skillName} deleted successfully. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('Failed to delete skill:', error);
      res.status(500).json({ error: error.message || 'Failed to delete skill' });
    }
  });

  app.post('/api/config/reload', async (req, res) => {
    try {
      console.log('[Server] Manual configuration reload requested');

      await refreshOpenCodeAfterConfigChange('manual configuration reload');

      res.json({
        success: true,
        requiresReload: true,
        message: 'Configuration reloaded successfully. Refreshing interface…',
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('[Server] Failed to reload configuration:', error);
      res.status(500).json({
        error: error.message || 'Failed to reload configuration',
        success: false
      });
    }
  });

  let quotaProviders = null;
  const getQuotaProviders = async () => {
    if (!quotaProviders) {
      quotaProviders = await import('./lib/quota/index.js');
    }
    return quotaProviders;
  };

  registerQuotaRoutes(app, { getQuotaProviders });

  registerGitHubRoutes(app);

  registerGitRoutes(app);
  registerFsRoutes(app, {
    os,
    path,
    fsPromises,
    spawn,
    crypto,
    normalizeDirectoryPath,
    resolveProjectDirectory,
    buildAugmentedPath,
    resolveGitBinaryForSpawn,
    openchamberUserConfigRoot: OPENCHAMBER_USER_CONFIG_ROOT,
  });

  terminalRuntime = createTerminalRuntime({
    app,
    server,
    express,
    fs,
    path,
    uiAuthController,
    buildAugmentedPath,
    searchPathFor,
    isExecutable,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
    TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS,
    TERMINAL_INPUT_WS_REBIND_WINDOW_MS,
    TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW,
  });

  setupProxy(app);
  scheduleOpenCodeApiDetection();
  void bootstrapOpenCodeAtStartup();

  const distPath = (() => {
    const env = typeof process.env.OPENCHAMBER_DIST_DIR === 'string' ? process.env.OPENCHAMBER_DIST_DIR.trim() : '';
    if (env) {
      return path.resolve(env);
    }
    return path.join(__dirname, '..', 'dist');
  })();

    if (fs.existsSync(distPath)) {
      console.log(`Serving static files from ${distPath}`);
      app.use(express.static(distPath, {
        setHeaders(res, filePath) {
          // Service workers should never be long-cached; iOS is especially sensitive.
          if (typeof filePath === 'string' && filePath.endsWith(`${path.sep}sw.js`)) {
            res.setHeader('Cache-Control', 'no-store');
          }
        },
      }));

      const recentPwaSessionsCache = new Map();

      const getRecentPwaSessionShortcuts = async (req) => {
        const now = Date.now();

        const resolvedDirectoryResult = await resolveProjectDirectory(req).catch(() => ({ directory: null }));
        const preferredDirectory = typeof resolvedDirectoryResult?.directory === 'string'
          ? resolvedDirectoryResult.directory
          : null;

        const cacheKey = preferredDirectory ? `dir:${preferredDirectory}` : 'global';
        const cached = recentPwaSessionsCache.get(cacheKey);
        if (cached && now - cached.at < 5000) {
          return cached.data;
        }

        const normalizeShortcutTitle = (value, fallback) => {
          const normalized = normalizePwaAppName(value, fallback);
          return normalized.length > 48 ? normalized.slice(0, 48) : normalized;
        };

        const toFiniteNumber = (value) => {
          if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
          }
          if (typeof value === 'string' && value.trim().length > 0) {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) {
              return parsed;
            }
          }
          return null;
        };

        const normalizeDirectory = (value) => {
          if (typeof value !== 'string') {
            return '';
          }
          const trimmed = value.trim();
          if (!trimmed) {
            return '';
          }
          const normalized = trimmed.replace(/\\/g, '/');
          if (normalized === '/') {
            return '/';
          }
          return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
        };

        const sessionUpdatedAt = (session) => {
          const time = session && typeof session.time === 'object' ? session.time : null;
          return toFiniteNumber(time?.updated) ?? toFiniteNumber(time?.created) ?? 0;
        };

        const filterSessionsByDirectory = (sessions, directory) => {
          const normalizedDirectory = normalizeDirectory(directory);
          if (!normalizedDirectory) {
            return sessions;
          }

          const prefix = normalizedDirectory === '/' ? '/' : `${normalizedDirectory}/`;
          return sessions.filter((session) => {
            const sessionDirectory = normalizeDirectory(session?.directory);
            if (!sessionDirectory) {
              return false;
            }
            return sessionDirectory === normalizedDirectory || (prefix !== '/' && sessionDirectory.startsWith(prefix));
          });
        };

        const listSessions = async (directory) => {
          const query = (() => {
            if (typeof directory !== 'string' || directory.length === 0) {
              return '';
            }
            const preparedDirectory = process.platform === 'win32'
              ? directory.replace(/\//g, '\\')
              : directory;
            return `?directory=${encodeURIComponent(preparedDirectory)}`;
          })();

          const response = await fetch(buildOpenCodeUrl(`/session${query}`, ''), {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              ...getOpenCodeAuthHeaders(),
            },
            signal: AbortSignal.timeout(2500),
          });

          if (!response.ok) {
            return [];
          }

          const payload = await response.json().catch(() => null);
          return Array.isArray(payload) ? payload : [];
        };

        try {
          let payload = [];

          if (preferredDirectory) {
            const scopedPayload = await listSessions(preferredDirectory);
            const filteredScopedPayload = filterSessionsByDirectory(scopedPayload, preferredDirectory);

            if (filteredScopedPayload.length > 0) {
              payload = filteredScopedPayload;
            } else {
              const globalPayload = await listSessions(null);
              const filteredGlobalPayload = filterSessionsByDirectory(globalPayload, preferredDirectory);
              payload = filteredGlobalPayload.length > 0 ? filteredGlobalPayload : globalPayload;
            }
          } else {
            payload = await listSessions(null);
          }

          const seen = new Set();
          const rows = [];

          for (const item of payload) {
            if (!item || typeof item !== 'object') {
              continue;
            }

            const id = typeof item.id === 'string' ? item.id.trim().slice(0, 160) : '';
            if (!id || seen.has(id)) {
              continue;
            }

            seen.add(id);
            const title = normalizeShortcutTitle(item.title, `Session ${rows.length + 1}`);
            const updatedAt = sessionUpdatedAt(item);

            rows.push({ id, title, updatedAt });
          }

          rows.sort((a, b) => b.updatedAt - a.updatedAt);

          const shortcuts = rows.slice(0, 3).map((session) => ({
            name: session.title,
            short_name: session.title.length > 32 ? session.title.slice(0, 32) : session.title,
            description: 'Open recent session',
            url: `/?session=${encodeURIComponent(session.id)}`,
            icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
          }));

          recentPwaSessionsCache.set(cacheKey, { at: now, data: shortcuts });
          return shortcuts;
        } catch {
          recentPwaSessionsCache.set(cacheKey, { at: now, data: [] });
          return [];
        }
      };

      app.get('/manifest.webmanifest', async (req, res) => {
        const hasQueryOverride =
          typeof req.query?.pwa_name === 'string'
          || typeof req.query?.app_name === 'string'
          || typeof req.query?.appName === 'string';

        let queryValueRaw = '';
        if (typeof req.query?.pwa_name === 'string') {
          queryValueRaw = req.query.pwa_name;
        } else if (typeof req.query?.app_name === 'string') {
          queryValueRaw = req.query.app_name;
        } else if (typeof req.query?.appName === 'string') {
          queryValueRaw = req.query.appName;
        }

        const queryOverrideName = normalizePwaAppName(queryValueRaw, '');

        let storedName = '';
        try {
          const settings = await readSettingsFromDiskMigrated();
          storedName = normalizePwaAppName(settings?.pwaAppName, '');
        } catch {
          storedName = '';
        }

        const appName = hasQueryOverride
          ? (queryOverrideName || DEFAULT_PWA_APP_NAME)
          : (storedName || DEFAULT_PWA_APP_NAME);

        const shortName = appName.length > 30 ? appName.slice(0, 30) : appName;
        const recentSessionShortcuts = await getRecentPwaSessionShortcuts(req);

        const manifest = {
          name: appName,
          short_name: shortName,
          description: 'Web interface companion for OpenCode AI coding agent',
          id: '/',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          background_color: '#151313',
          theme_color: '#edb449',
          orientation: 'any',
          icons: [
            { src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/pwa-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
            { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
            { src: '/apple-touch-icon-180x180.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
            { src: '/apple-touch-icon-152x152.png', sizes: '152x152', type: 'image/png', purpose: 'any' },
            { src: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
            { src: '/favicon-16.png', sizes: '16x16', type: 'image/png' },
          ],
          shortcuts: [
            {
              name: 'Appearance Settings',
              short_name: 'Settings',
              description: 'Open appearance settings',
              url: '/?settings=appearance',
              icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
            },
            ...recentSessionShortcuts,
          ],
          categories: ['developer', 'tools', 'productivity'],
          lang: 'en',
        };

        res.setHeader('Cache-Control', 'no-store, must-revalidate');
        res.type('application/manifest+json');
        res.send(JSON.stringify(manifest));
      });

    app.get(/^(?!\/api|.*\.(js|css|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|map)).*$/, (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    console.warn(`Warning: ${distPath} not found, static files will not be served`);
    app.get(/^(?!\/api|.*\.(js|css|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|map)).*$/, (req, res) => {
      res.status(404).send('Static files not found. Please build the application first.');
    });
  }

  let activePort = port;

  const bindHost = host
    || (typeof process.env.OPENCHAMBER_HOST === 'string' && process.env.OPENCHAMBER_HOST.trim().length > 0
      ? process.env.OPENCHAMBER_HOST.trim()
      : '127.0.0.1');

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('error', onError);
      reject(error);
    };
    server.once('error', onError);
    const onListening = async () => {
      server.off('error', onError);
      const addressInfo = server.address();
      activePort = typeof addressInfo === 'object' && addressInfo ? addressInfo.port : port;

      try {
        process.send?.({ type: 'openchamber:ready', port: activePort });
      } catch {
        // ignore
      }

      const displayHost = (bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '[::]')
        ? 'localhost'
        : (bindHost.includes(':') ? `[${bindHost}]` : bindHost);
      console.log(`OpenChamber server listening on ${bindHost}:${activePort}`);
      console.log(`Health check: http://${displayHost}:${activePort}/health`);
      console.log(`Web interface: http://${displayHost}:${activePort}`);

      if (startupTunnelRequest) {
        const startupModeLabel = startupTunnelRequest.mode === TUNNEL_MODE_QUICK
          ? 'Quick Tunnel'
          : (startupTunnelRequest.mode === TUNNEL_MODE_MANAGED_LOCAL
            ? 'Managed Local Tunnel'
            : (startupTunnelRequest.mode === TUNNEL_MODE_MANAGED_REMOTE ? 'Managed Remote Tunnel' : 'Tunnel'));
        console.log(`\nInitializing ${startupModeLabel} for provider '${startupTunnelRequest.provider}'...`);
        try {
          const { publicUrl, mode } = await startTunnelWithNormalizedRequest({
            provider: startupTunnelRequest.provider,
            mode: startupTunnelRequest.mode,
            intent: startupTunnelRequest.intent,
            hostname: startupTunnelRequest.hostname,
            token: startupTunnelRequest.token,
            configPath: startupTunnelRequest.configPath,
            selectedPresetId: '',
            selectedPresetName: '',
          });
          if (publicUrl) {
            tunnelAuthController.setActiveTunnel({
              tunnelId: crypto.randomUUID(),
              publicUrl,
              mode,
            });
            const settings = await readSettingsFromDiskMigrated();
            const bootstrapTtlMs = settings?.tunnelBootstrapTtlMs === null
              ? null
              : normalizeTunnelBootstrapTtlMs(settings?.tunnelBootstrapTtlMs);
            const bootstrapToken = tunnelAuthController.issueBootstrapToken({ ttlMs: bootstrapTtlMs });
            const connectUrl = `${publicUrl.replace(/\/$/, '')}/connect?t=${encodeURIComponent(bootstrapToken.token)}`;
            if (onTunnelReady) {
              onTunnelReady(publicUrl, connectUrl);
            } else {
              console.log(`\n🌐 Tunnel URL: ${connectUrl}`);
              console.log('🔑 One-time connect link (expires after first use)\n');
            }
          } else if (onTunnelReady) {
            onTunnelReady(publicUrl, null);
          }
        } catch (error) {
          console.error(`Failed to start tunnel: ${error.message}`);
          console.log('Continuing without tunnel...');
        }
      }

      resolve();
    };

    server.listen(port, bindHost, onListening);
  });

  if (attachSignals && !signalsAttached) {
    const handleSignal = async () => {
      await gracefulShutdown();
    };
    process.on('SIGTERM', handleSignal);
    process.on('SIGINT', handleSignal);
    process.on('SIGQUIT', handleSignal);
    signalsAttached = true;
    syncToHmrState();
  }

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });

  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    gracefulShutdown();
  });

  return {
    expressApp: app,
    httpServer: server,
    getPort: () => activePort,
    getOpenCodePort: () => openCodePort,
    getTunnelUrl: () => tunnelService.getPublicUrl(),
    isReady: () => isOpenCodeReady,
    restartOpenCode: () => restartOpenCode(),
    stop: (shutdownOptions = {}) =>
      gracefulShutdown({ exitProcess: shutdownOptions.exitProcess ?? false })
  };
}

const isCliExecution = process.argv[1] === __filename;

if (isCliExecution) {
  const cliOptions = parseArgs();
  exitOnShutdown = true;
  main({
    port: cliOptions.port,
    host: cliOptions.host,
    tryCfTunnel: cliOptions.tryCfTunnel,
    tunnelProvider: cliOptions.tunnelProvider,
    tunnelMode: cliOptions.tunnelMode,
    tunnelConfigPath: cliOptions.tunnelConfigPath,
    tunnelToken: cliOptions.tunnelToken,
    tunnelHostname: cliOptions.tunnelHostname,
    attachSignals: true,
    exitOnShutdown: true,
    uiPassword: cliOptions.uiPassword
  }).catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}

export { gracefulShutdown, setupProxy, restartOpenCode, main as startWebUiServer, parseArgs };
