import { describe, expect, test } from "bun:test";
import { hasAndroidNotificationBridge } from "./useIsAndroidTwa";

describe("hasAndroidNotificationBridge", () => {
  const originalWindow = globalThis.window;

  function restoreWindow() {
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      writable: true,
      configurable: true,
    });
  }

  test("returns true when openNotificationSettings is a function", () => {
    Object.defineProperty(globalThis, "window", {
      value: {
        AndroidNotificationBridge: {
          openNotificationSettings: () => {},
        },
      },
      writable: true,
      configurable: true,
    });

    expect(hasAndroidNotificationBridge()).toBe(true);

    restoreWindow();
  });

  test("returns false when AndroidNotificationBridge is undefined", () => {
    Object.defineProperty(globalThis, "window", {
      value: {},
      writable: true,
      configurable: true,
    });

    expect(hasAndroidNotificationBridge()).toBe(false);

    restoreWindow();
  });

  test("returns false when openNotificationSettings is not a function", () => {
    Object.defineProperty(globalThis, "window", {
      value: {
        AndroidNotificationBridge: {
          openNotificationSettings: "not-a-function",
        },
      },
      writable: true,
      configurable: true,
    });

    expect(hasAndroidNotificationBridge()).toBe(false);

    restoreWindow();
  });

  test("returns false when openNotificationSettings is missing", () => {
    Object.defineProperty(globalThis, "window", {
      value: {
        AndroidNotificationBridge: {
          getServerUrl: () => "http://test",
        },
      },
      writable: true,
      configurable: true,
    });

    expect(hasAndroidNotificationBridge()).toBe(false);

    restoreWindow();
  });

  test("returns false when window is undefined (SSR)", () => {
    Object.defineProperty(globalThis, "window", {
      value: undefined,
      writable: true,
      configurable: true,
    });

    expect(hasAndroidNotificationBridge()).toBe(false);

    restoreWindow();
  });
});
