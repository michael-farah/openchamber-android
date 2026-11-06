import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  const mockSelf = {
    addEventListener: vi.fn(),
    skipWaiting: vi.fn(),
    clients: {
      claim: vi.fn(() => Promise.resolve()),
      matchAll: vi.fn(() => Promise.resolve([])),
      openWindow: vi.fn(() => Promise.resolve()),
    },
    registration: {
      showNotification: vi.fn(() => Promise.resolve()),
    },
    location: { origin: 'http://localhost:3000' },
    __WB_MANIFEST: [] as Array<string | { url: string; revision?: string }>,
  };
  // @ts-expect-error — sw.ts expects self to be the SW globalScope
  globalThis.self = mockSelf;
});

// Mock Workbox modules before importing sw.ts (they are not available in Node)
vi.mock('workbox-precaching', () => ({
  precacheAndRoute: vi.fn(),
}));

vi.mock('workbox-routing', () => ({
  registerRoute: vi.fn(),
  NavigationRoute: vi.fn(function() { return {}; }),
}));

vi.mock('workbox-strategies', () => ({
  NetworkFirst: vi.fn(function() { return {}; }),
  CacheFirst: vi.fn(function() { return {}; }),
}));

vi.mock('workbox-expiration', () => ({
  ExpirationPlugin: vi.fn(function() { return {}; }),
}));

vi.mock('workbox-core', () => ({
  // RouteHandler is a type-only import, no runtime value needed
}));

vi.mock('./sw-url-utils', () => ({
  sanitizeNotificationUrl: vi.fn(() => '/'),
}));

import {
  TWA_FLAG_CACHE,
  TWA_FLAG_KEY,
  persistTwaContextFlag,
  readTwaContextFlag,
  clearTwaContextFlag,
  _setCacheStoreForTesting,
  _getTwaRoutesRegistered,
  _resetTwaRoutesRegistered,
  registerTwaRoutes,
} from './sw';

// ---------------------------------------------------------------------------
// In-memory Cache API mock
// ---------------------------------------------------------------------------

function createMockCacheStore() {
  const caches = new Map<string, Map<string, Response>>();

  return {
    open(name: string) {
      if (!caches.has(name)) {
        caches.set(name, new Map());
      }
      const cache = caches.get(name)!;
      return Promise.resolve({
        put(key: string, response: Response) {
          cache.set(key, response);
          return Promise.resolve();
        },
        match(key: string) {
          const response = cache.get(key);
          return Promise.resolve(response);
        },
        delete(key: string) {
          const existed = cache.delete(key);
          return Promise.resolve(existed);
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TWA context flag persistence', () => {
  let mockStore: ReturnType<typeof createMockCacheStore>;

  beforeEach(() => {
    mockStore = createMockCacheStore();
    _setCacheStoreForTesting(mockStore);
    _resetTwaRoutesRegistered();
  });

  // --- persistTwaContextFlag ---

  it('persistTwaContextFlag writes flag to Cache API', async () => {
    await persistTwaContextFlag();

    const cache = await mockStore.open(TWA_FLAG_CACHE);
    const response = await cache.match(TWA_FLAG_KEY);
    expect(response).toBeDefined();

    const text = await response!.text();
    expect(text).toBe('1');
  });

  // --- readTwaContextFlag ---

  it('readTwaContextFlag returns true when flag is present', async () => {
    await persistTwaContextFlag();

    const result = await readTwaContextFlag();
    expect(result).toBe(true);
  });

  it('readTwaContextFlag returns false when flag is absent', async () => {
    const result = await readTwaContextFlag();
    expect(result).toBe(false);
  });

  // --- clearTwaContextFlag ---

  it('clearTwaContextFlag removes flag from Cache API', async () => {
    await persistTwaContextFlag();
    expect(await readTwaContextFlag()).toBe(true);

    await clearTwaContextFlag();
    expect(await readTwaContextFlag()).toBe(false);
  });

  it('clearTwaContextFlag is idempotent when flag is absent', async () => {
    // Should not throw when clearing a non-existent flag
    await expect(clearTwaContextFlag()).resolves.toBeUndefined();
    expect(await readTwaContextFlag()).toBe(false);
  });

  // --- activate handler restores routes ---

  it('on SW activate, re-registers routes when flag is persisted', async () => {
    // Persist the flag first (simulating a previous SW lifecycle)
    await persistTwaContextFlag();

    // Reset the in-memory flag (simulating SW restart)
    _resetTwaRoutesRegistered();
    expect(_getTwaRoutesRegistered()).toBe(false);

    // Simulate activate: read flag and register routes
    // This mirrors the activate handler logic in sw.ts
    if (await readTwaContextFlag()) {
      registerTwaRoutes();
    }

    expect(_getTwaRoutesRegistered()).toBe(true);
  });

  it('on SW activate, does NOT register routes when flag is absent', async () => {
    // No flag persisted — non-TWA context
    _resetTwaRoutesRegistered();
    expect(_getTwaRoutesRegistered()).toBe(false);

    if (await readTwaContextFlag()) {
      // Should not reach here
      registerTwaRoutes();
    }

    expect(_getTwaRoutesRegistered()).toBe(false);
  });
});
