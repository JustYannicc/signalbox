import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  browserProfileRemovalAvailable,
  clearBrowserProfileData,
  importFailureReason,
} from "./IntegrationsSettings";
import { resolveBrowserSettingsAvailability } from "./browserSettings.logic";

const environmentId = "environment-a" as EnvironmentId;
const secondEnvironmentId = "environment-b" as EnvironmentId;
const thirdEnvironmentId = "environment-c" as EnvironmentId;

describe("browserSettingsAvailability", () => {
  it("enables browser controls only on connected servers with preview permission", () => {
    const result = resolveBrowserSettingsAvailability({
      isElectron: false,
      environmentsReady: true,
      environments: [
        {
          environmentId,
          connectionPhase: "connected",
          configKnown: true,
          serverBrowser: true,
          devices: false,
          previewPermission: "granted",
        },
        {
          environmentId: secondEnvironmentId,
          connectionPhase: "offline",
          configKnown: true,
          serverBrowser: true,
          devices: false,
          previewPermission: "granted",
        },
        {
          environmentId: thirdEnvironmentId,
          connectionPhase: "connected",
          configKnown: true,
          serverBrowser: true,
          devices: false,
          previewPermission: "denied",
        },
      ],
    });

    expect(result.serverBrowserEnvironmentIds).toEqual([environmentId]);
    expect(result.serverBrowserClearEnvironmentIds).toEqual([
      environmentId,
      secondEnvironmentId,
      thirdEnvironmentId,
    ]);
    expect(result.browserProfiles).toBe(true);
    expect(result.viewport).toBe(true);
    expect(result.desktopViewDefaults).toBe(false);
    expect(result.recording).toBe(false);
  });

  it("keeps an unresolved session permission in checking state", () => {
    const result = resolveBrowserSettingsAvailability({
      isElectron: false,
      environmentsReady: true,
      environments: [
        {
          environmentId,
          connectionPhase: "connected",
          configKnown: true,
          serverBrowser: true,
          devices: false,
          previewPermission: "unresolved",
        },
      ],
    });

    expect(result.serverBrowserEnvironmentIds).toEqual([]);
    expect(result.serverBrowserClearEnvironmentIds).toEqual([environmentId]);
    expect(result.checkingBrowserSettings).toBe(true);
    expect(result.checkingAppLinkTarget).toBe(true);
  });

  it("does not show floating-preview checking when a device is already available", () => {
    const result = resolveBrowserSettingsAvailability({
      isElectron: false,
      environmentsReady: true,
      environments: [
        {
          environmentId,
          connectionPhase: "connected",
          configKnown: true,
          serverBrowser: false,
          devices: true,
          previewPermission: "denied",
        },
        {
          environmentId: secondEnvironmentId,
          connectionPhase: "connecting",
          configKnown: false,
          serverBrowser: false,
          devices: false,
          previewPermission: "unresolved",
        },
      ],
    });

    expect(result.browserProfiles).toBe(false);
    expect(result.viewport).toBe(false);
    expect(result.appLinkTarget).toBe(false);
    expect(result.floatingPreview).toBe(true);
    expect(result.checkingBrowserSettings).toBe(true);
    expect(result.checkingFloatingPreview).toBe(false);
  });
});

describe("clearBrowserProfileData", () => {
  it("waits for cookie and cache cleanup", async () => {
    const clearCookies = vi.fn().mockResolvedValue(undefined);
    const clearCache = vi.fn().mockResolvedValue(undefined);

    await clearBrowserProfileData({ clearCookies, clearCache }, [environmentId], "profile-a");

    expect(clearCookies).toHaveBeenCalledWith(environmentId, "profile-a");
    expect(clearCache).toHaveBeenCalledWith(environmentId, "profile-a");
  });

  it("clears every known environment before succeeding", async () => {
    const clearCookies = vi.fn().mockResolvedValue(undefined);
    const clearCache = vi.fn().mockResolvedValue(undefined);

    await clearBrowserProfileData(
      { clearCookies, clearCache },
      [environmentId, secondEnvironmentId],
      "profile-a",
    );

    expect(clearCookies.mock.calls).toEqual([
      [environmentId, "profile-a"],
      [secondEnvironmentId, "profile-a"],
    ]);
    expect(clearCache.mock.calls).toEqual([
      [environmentId, "profile-a"],
      [secondEnvironmentId, "profile-a"],
    ]);
  });

  it("propagates cleanup failures", async () => {
    const failure = new Error("clear failed");
    await expect(
      clearBrowserProfileData(
        {
          clearCookies: vi.fn().mockRejectedValue(failure),
          clearCache: vi.fn().mockResolvedValue(undefined),
        },
        [environmentId],
        "profile-a",
      ),
    ).rejects.toBe(failure);
  });

  it("does not report success without an environment or bridge", async () => {
    const bridge = {
      clearCookies: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn().mockResolvedValue(undefined),
    };

    await expect(clearBrowserProfileData(bridge, [], "profile-a")).rejects.toThrow();
    await expect(clearBrowserProfileData(null, [environmentId], "profile-a")).rejects.toThrow();
    expect(bridge.clearCookies).not.toHaveBeenCalled();
    expect(bridge.clearCache).not.toHaveBeenCalled();
  });
});

describe("clearBrowserProfileData with server browsers", () => {
  it("clears server-hosted profiles without a desktop bridge", async () => {
    const clear = vi.fn().mockResolvedValue(undefined);
    await clearBrowserProfileData(null, [environmentId, secondEnvironmentId], "profile-a", {
      environmentIds: [secondEnvironmentId],
      clear,
    });
    expect(clear).toHaveBeenCalledExactlyOnceWith(secondEnvironmentId, "profile-a");
  });

  it("clears both copies and fails when the server copy fails", async () => {
    const bridge = {
      clearCookies: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn().mockResolvedValue(undefined),
    };
    const failure = new Error("server failed");
    await expect(
      clearBrowserProfileData(bridge, [environmentId], "profile-a", {
        environmentIds: [environmentId],
        clear: vi.fn().mockRejectedValue(failure),
      }),
    ).rejects.toBe(failure);
    expect(bridge.clearCookies).toHaveBeenCalledWith(environmentId, "profile-a");
  });

  it("attempts every configured server target and fails if one is disconnected or unauthorized", async () => {
    const targets = resolveBrowserSettingsAvailability({
      isElectron: false,
      environmentsReady: true,
      environments: [
        {
          environmentId,
          connectionPhase: "connected",
          configKnown: true,
          serverBrowser: true,
          devices: false,
          previewPermission: "granted",
        },
        {
          environmentId: secondEnvironmentId,
          connectionPhase: "offline",
          configKnown: true,
          serverBrowser: true,
          devices: false,
          previewPermission: "granted",
        },
        {
          environmentId: thirdEnvironmentId,
          connectionPhase: "connected",
          configKnown: true,
          serverBrowser: true,
          devices: false,
          previewPermission: "denied",
        },
      ],
    }).serverBrowserClearEnvironmentIds;
    const calls: Array<EnvironmentId> = [];

    await expect(
      clearBrowserProfileData(null, [], "profile-a", {
        environmentIds: targets,
        clear: async (target) => {
          calls.push(target);
          if (target !== environmentId) throw new Error("target cannot be reached");
        },
      }),
    ).rejects.toThrow("target cannot be reached");
    expect(calls.toSorted()).toEqual(targets.toSorted());
  });
});

describe("browserProfileRemovalAvailable", () => {
  it("accepts a server browser in place of the desktop bridge", () => {
    expect(browserProfileRemovalAvailable(false, true, 1, 1)).toBe(true);
  });

  it("requires a ready non-empty catalog and desktop bridge", () => {
    expect(browserProfileRemovalAvailable(true, true, 1)).toBe(true);
    expect(browserProfileRemovalAvailable(true, true, 0)).toBe(false);
    expect(browserProfileRemovalAvailable(true, false, 1)).toBe(false);
    expect(browserProfileRemovalAvailable(false, true, 1)).toBe(false);
  });
});

// Mirrors `BrowserImportFailedError.message`, which IPC flattens to a string
// before the renderer sees it.
const failure = (reason: string) => ({
  message: `Importing cookies from safari failed: ${reason}.`,
});

describe("importFailureReason", () => {
  it("recovers the reason token from the flattened message", () => {
    expect(importFailureReason(failure("needsFullDiskAccess"))).toBe("needsFullDiskAccess");
    expect(importFailureReason(failure("browserRunning"))).toBe("browserRunning");
    expect(importFailureReason(failure("readFailed"))).toBe("readFailed");
    expect(importFailureReason(failure("keychainUnavailable"))).toBe("keychainUnavailable");
    expect(importFailureReason(failure("profileNotSaved"))).toBe("profileNotSaved");
    expect(importFailureReason(failure("profileLimitReached"))).toBe("profileLimitReached");
  });

  it("falls back to readFailed for anything it cannot classify", () => {
    expect(importFailureReason(new Error("something else entirely"))).toBe("readFailed");
    expect(importFailureReason(undefined)).toBe("readFailed");
  });
});
