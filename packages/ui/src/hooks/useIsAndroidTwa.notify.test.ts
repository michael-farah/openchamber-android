import { describe, expect, test } from 'bun:test'

/**
 * Tests for notifyServiceWorkerTwaContext — the async version that
 * waits for navigator.serviceWorker.ready before posting TWA_CONTEXT.
 *
 * Since the function uses window/navigator globals, we mock them.
 * bun:test doesn't have afterEach or jest-style mock assertions,
 * so we use simpler patterns.
 */

// We'll test the behavior by checking side effects on our mocks.
// The function is exported from useIsAndroidTwa.ts.

describe('notifyServiceWorkerTwaContext', () => {
  let postMessageCalls: { type: string }[] = []


  function setupMocks(opts: {
    hasBridge?: boolean
    hasServiceWorker?: boolean
    activePostMessage?: ((msg: unknown) => void) | null
    controllerPostMessage?: ((msg: unknown) => void) | null
    readyRejects?: boolean
  }) {
    postMessageCalls = []

    const {
      hasBridge = true,
      hasServiceWorker = true,
      activePostMessage = (msg: unknown) => {
        postMessageCalls.push(msg as { type: string })
      },
      controllerPostMessage = null,
      readyRejects = false,
    } = opts
    const active = activePostMessage ? { postMessage: activePostMessage } : null
    const controller = controllerPostMessage ? { postMessage: controllerPostMessage } : null

    const fakeRegistration = { active } as unknown as ServiceWorkerRegistration

    const bridge = hasBridge
      ? { getServerUrl: () => 'http://test' }
      : undefined

    const serviceWorker = hasServiceWorker
      ? {
          ready: readyRejects
            ? Promise.reject(new Error('SW registration failed'))
            : Promise.resolve(fakeRegistration),
          controller,
        }
      : undefined

    // Mock window and navigator on globalThis
    // @ts-expect-error — test-only global mutation
    globalThis.window = { AndroidNotificationBridge: bridge }
    // @ts-expect-error — test-only global mutation
    globalThis.navigator = { serviceWorker }
  }

  function cleanupMocks() {
    // @ts-expect-error — test-only global restore
    globalThis.window = undefined
    // @ts-expect-error — test-only global restore
    globalThis.navigator = undefined
  }

  test('waits for serviceWorker.ready and posts TWA_CONTEXT to registration.active', async () => {
    setupMocks({})

    // Import dynamically to get the current module state
    const { notifyServiceWorkerTwaContext } = await import('./useIsAndroidTwa')
    await notifyServiceWorkerTwaContext()

    expect(postMessageCalls.length).toBe(1)
    expect(postMessageCalls[0]).toEqual({ type: 'TWA_CONTEXT' })

    cleanupMocks()
  })

  test('posts to registration.active, not navigator.serviceWorker.controller', async () => {
    let controllerPostCount = 0
    const controllerPostMessage = () => { controllerPostCount++ }

    setupMocks({ controllerPostMessage })

    const { notifyServiceWorkerTwaContext } = await import('./useIsAndroidTwa')
    await notifyServiceWorkerTwaContext()

    // Should post via registration.active, NOT controller
    expect(postMessageCalls.length).toBe(1)
    expect(controllerPostCount).toBe(0)

    cleanupMocks()
  })

  test('does not post when bridge is absent', async () => {
    setupMocks({ hasBridge: false })

    const { notifyServiceWorkerTwaContext } = await import('./useIsAndroidTwa')
    await notifyServiceWorkerTwaContext()

    expect(postMessageCalls.length).toBe(0)

    cleanupMocks()
  })

  test('does not post when serviceWorker is not supported', async () => {
    setupMocks({ hasServiceWorker: false })

    const { notifyServiceWorkerTwaContext } = await import('./useIsAndroidTwa')
    // Should not throw
    await notifyServiceWorkerTwaContext()

    expect(postMessageCalls.length).toBe(0)

    cleanupMocks()
  })

  test('handles ready rejection gracefully', async () => {
    setupMocks({ readyRejects: true })

    const { notifyServiceWorkerTwaContext } = await import('./useIsAndroidTwa')
    // Should not throw even if ready rejects
    await notifyServiceWorkerTwaContext()

    expect(postMessageCalls.length).toBe(0)

    cleanupMocks()
  })

  test('does not post when registration.active is null', async () => {
    setupMocks({ activePostMessage: null })

    const { notifyServiceWorkerTwaContext } = await import('./useIsAndroidTwa')
    await notifyServiceWorkerTwaContext()

    expect(postMessageCalls.length).toBe(0)

    cleanupMocks()
  })
})
