import {
  DEFAULT_CLIENT_SETTINGS,
  type ConfirmDialogOptions,
  type ContextMenuItem,
  type DesktopBridge,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();
const dismissContextMenuMock = vi.fn<() => void>();

const requestConfirmDialogMock =
  vi.fn<(message: string, options?: ConfirmDialogOptions) => Promise<boolean> | undefined>();

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
  dismissContextMenu: dismissContextMenuMock,
}));

vi.mock("./confirmDialog", () => ({
  requestConfirmDialog: requestConfirmDialogMock,
}));

function createLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

function testWindow(): Window & typeof globalThis {
  return globalThis.window ?? (globalThis as unknown as Window & typeof globalThis);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  if (globalThis.window === undefined) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: globalThis,
    });
  }
  Reflect.deleteProperty(testWindow(), "desktopBridge");
  Object.defineProperty(testWindow(), "localStorage", {
    configurable: true,
    value: createLocalStorageStub(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LocalApi", () => {
  it("keeps backend operations out of the local host facade", async () => {
    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi();

    expect(api).not.toHaveProperty("server");
    expect(api.shell).not.toHaveProperty("openInEditor");
  });

  it("uses the browser context-menu fallback without a desktop bridge", async () => {
    showContextMenuFallbackMock.mockResolvedValue("rename");
    const { createLocalApi } = await import("./localApi");
    const items = [{ id: "rename", label: "Rename" }] as const;

    await expect(createLocalApi().contextMenu.show(items, { x: 4, y: 5 })).resolves.toBe("rename");
    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(items, { x: 4, y: 5 });
  });

  it("dismisses an open browser context menu without a desktop bridge", async () => {
    const { createLocalApi } = await import("./localApi");

    await createLocalApi().contextMenu.close();

    expect(dismissContextMenuMock).toHaveBeenCalledOnce();
  });

  it("uses the themed confirmation host when it is available", async () => {
    requestConfirmDialogMock.mockResolvedValue(true);
    const { createLocalApi } = await import("./localApi");
    const options = { variant: "destructive" } as const;

    await expect(createLocalApi().dialogs.confirm("Delete this thread?", options)).resolves.toBe(
      true,
    );
    expect(requestConfirmDialogMock).toHaveBeenCalledWith("Delete this thread?", options);
  });

  it("fails closed in a browser when no themed host is available", async () => {
    requestConfirmDialogMock.mockReturnValue(undefined);
    const { createLocalApi } = await import("./localApi");

    await expect(createLocalApi().dialogs.confirm("Delete this thread?")).resolves.toBe(false);
  });

  it("rejects opening System Settings when the desktop bridge is unavailable", async () => {
    const { createLocalApi } = await import("./localApi");

    await expect(createLocalApi().shell.openSystemSettings("full-disk-access")).rejects.toThrow(
      "Unable to open System Settings.",
    );
  });

  it("delegates host capabilities and persistence to the desktop bridge", async () => {
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    const pickFolder = vi.fn().mockResolvedValue("/tmp/project");
    const getClientSettings = vi.fn().mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    const setClientSettings = vi.fn().mockResolvedValue(undefined);
    testWindow().desktopBridge = {
      showContextMenu,
      pickFolder,
      getClientSettings,
      setClientSettings,
    } as unknown as DesktopBridge;

    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi();
    const items = [{ id: "delete", label: "Delete" }] as const;

    await expect(api.contextMenu.show(items)).resolves.toBe("delete");
    requestConfirmDialogMock.mockReturnValue(undefined);
    await expect(api.dialogs.confirm("Install update?")).resolves.toBe(false);
    await expect(api.dialogs.pickFolder({ initialPath: "/tmp" })).resolves.toBe("/tmp/project");
    await expect(api.persistence.getClientSettings()).resolves.toEqual(DEFAULT_CLIENT_SETTINGS);
    await api.persistence.setClientSettings(DEFAULT_CLIENT_SETTINGS);

    expect(showContextMenu).toHaveBeenCalledWith(items, undefined);
    expect(pickFolder).toHaveBeenCalledWith({ initialPath: "/tmp" });
    expect(getClientSettings).toHaveBeenCalledTimes(1);
    expect(setClientSettings).toHaveBeenCalledWith(DEFAULT_CLIENT_SETTINGS);
  });

  // signalbox: #43. A failed default migration must not undo a later opt-out.
  describe("needs-you default adoption", () => {
    const ADOPTED_KEY = "signalbox:needs-you-defaults:v1";
    const SETTINGS_KEY = "t3code:client-settings:v1";
    const off = { ...DEFAULT_CLIENT_SETTINGS, inAppNotificationsEnabled: false };

    function browserStorage() {
      const storage = createLocalStorageStub();
      const write = storage.setItem.bind(storage);
      const state = { failSettingsWrites: true };
      storage.setItem = (key, value) => {
        if (key === SETTINGS_KEY && state.failSettingsWrites) throw new Error("quota exceeded");
        write(key, value);
      };
      write(SETTINGS_KEY, JSON.stringify(off));
      Object.defineProperty(testWindow(), "localStorage", { configurable: true, value: storage });
      return { storage, state };
    }

    it("keeps a browser opt-out saved after a failed migration write", async () => {
      const { storage, state } = browserStorage();
      const { createLocalApi } = await import("./localApi");
      const api = createLocalApi();
      await expect(api.persistence.getClientSettings()).resolves.toMatchObject({
        inAppNotificationsEnabled: true,
      });
      expect(storage.getItem(ADOPTED_KEY)).toBeNull();

      state.failSettingsWrites = false;
      await api.persistence.setClientSettings(off);
      expect(storage.getItem(ADOPTED_KEY)).toBe("1");
      await expect(createLocalApi().persistence.getClientSettings()).resolves.toEqual(off);
    });

    it("leaves a browser's adoption unset when its save is rejected", async () => {
      const { storage } = browserStorage();
      const { createLocalApi } = await import("./localApi");
      const api = createLocalApi();
      await api.persistence.getClientSettings();
      await expect(api.persistence.setClientSettings(off)).rejects.toThrow();
      expect(storage.getItem(ADOPTED_KEY)).toBeNull();
    });

    function desktopBridge(saves: Array<"reject" | "resolve">) {
      const setClientSettings = vi.fn(() =>
        saves.shift() === "reject"
          ? Promise.reject(new Error("bridge unavailable"))
          : Promise.resolve(),
      );
      testWindow().desktopBridge = {
        getClientSettings: vi.fn().mockResolvedValue(off),
        setClientSettings,
      } as unknown as DesktopBridge;
      return setClientSettings;
    }

    it("keeps a desktop opt-out saved after a failed migration write", async () => {
      desktopBridge(["reject", "resolve"]);
      const { createLocalApi } = await import("./localApi");
      const api = createLocalApi();
      await expect(api.persistence.getClientSettings()).resolves.toMatchObject({
        inAppNotificationsEnabled: true,
      });
      expect(testWindow().localStorage.getItem(ADOPTED_KEY)).toBeNull();

      await api.persistence.setClientSettings(off);
      expect(testWindow().localStorage.getItem(ADOPTED_KEY)).toBe("1");
      await expect(createLocalApi().persistence.getClientSettings()).resolves.toEqual(off);
    });

    it("leaves a desktop's adoption unset when its save is rejected", async () => {
      desktopBridge(["reject", "reject"]);
      const { createLocalApi } = await import("./localApi");
      const api = createLocalApi();
      await api.persistence.getClientSettings();
      await expect(api.persistence.setClientSettings(off)).rejects.toThrow("bridge unavailable");
      expect(testWindow().localStorage.getItem(ADOPTED_KEY)).toBeNull();
    });
  });

  it("persists client settings in browser storage", async () => {
    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi();
    const settings = {
      ...DEFAULT_CLIENT_SETTINGS,
      timestampFormat: "12-hour" as const,
    };

    await api.persistence.setClientSettings(settings);
    await expect(api.persistence.getClientSettings()).resolves.toEqual(settings);
  });
});
