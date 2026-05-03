import React from 'react';

const STORAGE_KEY = 'openchamber:isAndroidTwa';

type AndroidNotificationBridge = {
  getServerUrl?: () => string;
  openAppSettings?: () => void;
  getPermission?: () => string;
  showNotification?: (title: string, body: string) => void;
  requestPermission?: (callbackId: string) => void;
  openNotificationSettings?: () => void;
};

declare global {
  interface Window {
    AndroidNotificationBridge?: AndroidNotificationBridge;
  }
}

function checkBridge(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof window.AndroidNotificationBridge?.getServerUrl === 'function';
}

/**
 * Detect TWA/standalone mode via CSS display-mode media query.
 * Returns true when running in standalone/fullscreen/minimal-ui
 * AND the user-agent indicates Android.
 * This works in TWA Chrome Custom Tab mode where the bridge
 * is NOT injected (unlike WebView fallback).
 */
function checkDisplayModeStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (!/android/i.test(navigator.userAgent)) return false;
  const standalone = window.matchMedia('(display-mode: standalone)');
  if (standalone.matches) return true;
  const fullscreen = window.matchMedia('(display-mode: fullscreen)');
  if (fullscreen.matches) return true;
  const minimal = window.matchMedia('(display-mode: minimal-ui)');
  if (minimal.matches) return true;
  return false;
}

/**
 * Only notify the SW about TWA context when the bridge exists
 * (WebView fallback mode). TWA Chrome Custom Tab mode does NOT
 * need Workbox caching routes — they cause layout regressions
 * on mobile viewports.
 */
function notifyServiceWorkerTwaContext(): void {
  // Only send TWA_CONTEXT when bridge exists (WebView fallback).
  // DO NOT send for display-mode-detected TWA (Chrome Custom Tab).
  if (!checkBridge()) return;
  if (typeof navigator === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  const controller = navigator.serviceWorker.controller;
  if (controller) {
    controller.postMessage({ type: 'TWA_CONTEXT' });
  }
}

/**
 * Computes the current TWA detection result from both detection paths.
 * - Bridge present → WebView fallback (TWA + SW routes)
 * - Display-mode standalone + Android UA → TWA Chrome Custom Tab (no SW routes)
 */
function detectIsAndroidTwa(): boolean {
  if (typeof window === 'undefined') return false;
  if (checkBridge()) return true;
  if (checkDisplayModeStandalone()) return true;
  return false;
}

/**
 * Detects whether the app is running inside an Android TWA/WebView shell.
 *
 * Detection strategy (two paths, decoupled from SW messaging):
 * 1. Bridge detection: `AndroidNotificationBridge.getServerUrl` exists
 *    → WebView fallback. Send TWA_CONTEXT to SW for Workbox routes.
 * 2. Display-mode detection: `matchMedia('(display-mode: standalone)')`
 *    + Android user-agent → TWA Chrome Custom Tab mode.
 *    Do NOT send TWA_CONTEXT — Workbox routes cause layout regressions.
 * 3. Persist result in localStorage (bridge-only, to avoid stale TWA
 *    flags leaking into regular Chrome sessions via shared origin).
 * 4. Listen for bridge installation events and display-mode changes.
 */
export const useIsAndroidTwa = (): boolean => {
  const [isAndroidTwa, setIsAndroidTwa] = React.useState(() => {
    if (typeof window === 'undefined') return false;
    // Bridge present → WebView fallback (full TWA context + SW routes)
    if (checkBridge()) {
      localStorage.setItem(STORAGE_KEY, 'true');
      notifyServiceWorkerTwaContext();
      return true;
    }
    // Display-mode standalone + Android → TWA Chrome Custom Tab
    // No TWA_CONTEXT sent to SW — avoids Workbox layout regressions.
    if (checkDisplayModeStandalone()) {
      return true;
    }
    // Clear stale flag from a prior TWA session (shared localStorage).
    localStorage.removeItem(STORAGE_KEY);
    return false;
  });

  React.useEffect(() => {
    // Re-evaluate on bridge installation or display-mode change.
    const updateState = () => {
      const detected = detectIsAndroidTwa();
      setIsAndroidTwa(detected);

      if (checkBridge()) {
        localStorage.setItem(STORAGE_KEY, 'true');
        notifyServiceWorkerTwaContext();
      } else if (!detected) {
        localStorage.removeItem(STORAGE_KEY);
      }
    };

    // Initial check in case bridge was installed after first render.
    updateState();

    const handleBridgeInstalled = () => {
      updateState();
    };

    // Listen for display-mode changes (e.g. PWA install on Android).
    const displayModeQueries = [
      window.matchMedia('(display-mode: standalone)'),
      window.matchMedia('(display-mode: fullscreen)'),
      window.matchMedia('(display-mode: minimal-ui)'),
    ];

    const handleDisplayModeChange = () => {
      updateState();
    };

    for (const query of displayModeQueries) {
      query.addEventListener('change', handleDisplayModeChange);
    }

    window.addEventListener('notificationbridgeinstalled', handleBridgeInstalled);

    // Handle navigation messages from the service worker (notificationclick).
    // When the user taps a push notification, the SW focuses the existing
    // window client and sends NAVIGATE so we navigate in-place instead of
    // opening a new tab (which breaks TWA).
    const handleSwMessage = (event: MessageEvent) => {
      if (event.data?.type === 'NAVIGATE' && typeof event.data.url === 'string') {
        const target = event.data.url;
        // Only navigate if we're not already on that path
        if (window.location.pathname + window.location.search !== target) {
          window.location.href = target;
        }
      }
    };

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handleSwMessage);
    }

    return () => {
      window.removeEventListener('notificationbridgeinstalled', handleBridgeInstalled);
      for (const query of displayModeQueries) {
        query.removeEventListener('change', handleDisplayModeChange);
      }
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', handleSwMessage);
      }
    };
  }, []);

  return isAndroidTwa;
};
