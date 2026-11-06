/// <reference lib="webworker" />

/**
 * Architectural decision: conditional Workbox routes for TWA (Android)
 *
 * This service worker provides two sets of behaviour:
 *
 * 1. **Push notifications** — always active on every platform (install,
 *    activate, push, notificationclick). These are harmless on browsers
 *    that don't support push because the events simply never fire.
 *
 * 2. **Workbox caching routes** (precacheAndRoute, navigation NetworkFirst,
 *    API NetworkFirst, static-asset CacheFirst) — registered ONLY after the
 *    page signals TWA context via a `{ type: 'TWA_CONTEXT' }` postMessage.
 *    This avoids regressions on iOS Safari where the upstream codebase
 *    deliberately avoided runtime Workbox routing (3 s navigation timeout,
 *    stale cached API responses, and SSE/WebSocket interference).
 *
 * The TWA detection flow:
 *   a. The Android WebView injects `AndroidNotificationBridge` via
 *      `addDocumentStartJavaScript` (or onPageStarted fallback).
 *   b. The page's `useIsAndroidTwa` hook (or main.tsx) detects the bridge
 *      and sends `navigator.serviceWorker.controller.postMessage({
 *      type: 'TWA_CONTEXT' })`.
 *   c. The service worker receives the message and registers the Workbox
 *      routes. Until that message arrives, the service worker is a
 *      pass-through — all requests go to the network unintercepted.
 */

import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { NetworkFirst, CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import type { RouteHandler } from 'workbox-core';
import { sanitizeNotificationUrl } from './sw-url-utils';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision?: string }>;
};

// ---------------------------------------------------------------------------
// Push notification handlers — always active
// ---------------------------------------------------------------------------

type PushPayload = {
  title?: string;
  body?: string;
  tag?: string;
  data?: {
    url?: string;
    sessionId?: string;
    type?: string;
  };
  icon?: string;
  badge?: string;
};

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    if (await readTwaContextFlag()) {
      registerTwaRoutes();
    }
  })());
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload: PushPayload | null;
    try {
      payload = (event.data?.json() ?? null) as PushPayload | null;
    } catch {
      // Push payload was not valid JSON — ignore silently
      return;
    }
    if (!payload) {
      return;
    }

    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hasVisibleClient = clients.some((client) => client.visibilityState === 'visible' || client.focused);
    if (hasVisibleClient) {
      return;
    }

    const title = payload.title || 'OpenChamber';
    const body = payload.body ?? '';
    const icon = payload.icon ?? '/apple-touch-icon-180x180.png';
    const badge = payload.badge ?? '/favicon-32.png';

    await self.registration.showNotification(title, {
      body,
      icon,
      badge,
      tag: payload.tag,
      data: payload.data,
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = (event.notification.data ?? null) as { url?: string } | null;
  const url = sanitizeNotificationUrl(data?.url, self.location.origin);

 event.waitUntil(
 (async () => {
 // Focus an existing window client (e.g. TWA/Chrome Custom Tab)
 // instead of opening a new tab, which breaks TWA notification clicks.
 const clientList = await self.clients.matchAll({
 type: 'window',
 includeUncontrolled: true,
 });
 for (const client of clientList) {
 if (
 client.url.includes(self.location.origin) &&
 'focus' in client
 ) {
 client.postMessage({ type: 'NAVIGATE', url });
 return (client as WindowClient).focus();
 }
 }
 // No existing window — open a new one
 return self.clients.openWindow(url);
 })(),
 );
});

// ---------------------------------------------------------------------------
// Workbox caching routes — registered only in TWA context
// ---------------------------------------------------------------------------

let twaRoutesRegistered = false;

// ---------------------------------------------------------------------------
// TWA context flag persistence — survives SW restart via Cache API
// ---------------------------------------------------------------------------

/** Cache name for the TWA routes flag. */
export const TWA_FLAG_CACHE = 'twa-routes-flag';

/** Key used inside the cache to store the TWA flag. */
export const TWA_FLAG_KEY = 'TWA_ROUTES_ACTIVE';

/**
 * Thin wrapper around the Cache API, injectable for testing.
 * The default implementation uses the service worker `caches` global.
 */
export interface CacheStore {
  open(name: string): Promise<CacheStoreEntry>;
}

export interface CacheStoreEntry {
  put(key: string, response: Response): Promise<void>;
  match(key: string): Promise<Response | undefined>;
  delete(key: string): Promise<boolean>;
}

const defaultCacheStore: CacheStore = {
  open(name: string) {
    return caches.open(name) as unknown as Promise<CacheStoreEntry>;
  },
};

let cacheStore: CacheStore = defaultCacheStore;

/** Replace the cache store with a mock implementation (testing only). */
export function _setCacheStoreForTesting(store: CacheStore): void {
  cacheStore = store;
}

/** Read the in-memory twaRoutesRegistered flag (testing only). */
export function _getTwaRoutesRegistered(): boolean {
  return twaRoutesRegistered;
}

/** Reset the in-memory twaRoutesRegistered flag (testing only). */
export function _resetTwaRoutesRegistered(): void {
  twaRoutesRegistered = false;
}

/**
 * Persist the TWA context flag to Cache API so it survives SW restarts.
 * Called after registering Workbox routes.
 */
export async function persistTwaContextFlag(): Promise<void> {
  try {
    const cache = await cacheStore.open(TWA_FLAG_CACHE);
    await cache.put(TWA_FLAG_KEY, new Response('1'));
  } catch {
    // Cache API unavailable — flag won't persist across restarts.
    // The runtime TWA_CONTEXT message will still work for the current lifecycle.
  }
}

/**
 * Read the TWA context flag from Cache API.
 * Returns true if the flag exists (meaning routes were previously registered
 * in a TWA context), false otherwise.
 */
export async function readTwaContextFlag(): Promise<boolean> {
  try {
    const cache = await cacheStore.open(TWA_FLAG_CACHE);
    const response = await cache.match(TWA_FLAG_KEY);
    return response !== undefined;
  } catch {
    return false;
  }
}

/**
 * Remove the TWA context flag from Cache API.
 * Useful if the app needs to explicitly clear the TWA routing state.
 */
export async function clearTwaContextFlag(): Promise<void> {
  try {
    const cache = await cacheStore.open(TWA_FLAG_CACHE);
    await cache.delete(TWA_FLAG_KEY);
  } catch {
    // Cache API unavailable — nothing to clear.
  }
}

const OFFLINE_BODY = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenChamber – Offline</title>
<style>
 body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#100f0f;color:#fffcf0}
 .card{text-align:center;max-width:360px;padding:2rem}
 h1{font-size:1.5rem;margin:0 0 .5rem}
 p{color:#9e9b93;margin:0 0 1.5rem;line-height:1.5}
 button{background:#66800b;color:#fffcf0;border:none;border-radius:.5rem;padding:.6rem 1.4rem;font-size:1rem;cursor:pointer}
 button:hover{background:#4d6008}
</style>
</head>
<body><div class="card">
<h1>You're offline</h1>
<p>OpenChamber can't reach the server right now. Check your connection and try again.</p>
<button onclick="location.reload()">Retry</button>
</div></body>
</html>`;

const offlineFallbackResponse = () => new Response(OFFLINE_BODY, {
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
});

export function registerTwaRoutes() {
  if (twaRoutesRegistered) return;
  twaRoutesRegistered = true;

  precacheAndRoute(self.__WB_MANIFEST);

  const navHandler = new NetworkFirst({
    networkTimeoutSeconds: 3,
    cacheName: 'nav-cache',
    plugins: [
      new ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 7 * 24 * 60 * 60 }),
      {
        handlerDidError: async () => offlineFallbackResponse(),
      },
    ],
  }) as unknown as RouteHandler;

  registerRoute(new NavigationRoute(navHandler));

  // API caching — exclude WebSocket event-stream paths to avoid
  // interfering with the real-time SSE/WebSocket connections used by
  // /api/global/event/ws and /api/event/ws.
  registerRoute(
    ({ url }: { url: URL }) =>
      url.pathname.startsWith('/api/')
      && !url.pathname.includes('/event/ws'),
    new NetworkFirst({
      networkTimeoutSeconds: 30,
      cacheName: 'api-cache',
      plugins: [
        new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 5 * 60 }),
      ],
    }) as unknown as RouteHandler,
  );

  registerRoute(
    ({ request }: { request: Request }) =>
      request.destination === 'image' || request.destination === 'font',
    new CacheFirst({
      cacheName: 'static-assets',
      plugins: [
        new ExpirationPlugin({
          maxEntries: 200,
          maxAgeSeconds: 30 * 24 * 60 * 60,
        }),
      ],
    }) as unknown as RouteHandler,
  );

  // Persist the TWA flag so routes are re-registered after SW restart
  persistTwaContextFlag();
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'TWA_CONTEXT') {
    registerTwaRoutes();
  }
});
