import type { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const state = vi.hoisted(() => ({
  canOperate: false,
  canWriteSettings: true,
  connected: true,
  serverSettingsWrite: true,
  openEditor: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "config-path" ? "/fixture/keybindings.json" : []),
}));

vi.mock("@tanstack/react-router", () => ({ useLocation: () => "" }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../state/server", () => ({
  primaryServerKeybindingsAtom: "keybindings",
  primaryServerKeybindingsConfigPathAtom: "config-path",
  primaryServerAvailableEditorsAtom: "editors",
  serverEnvironment: { upsertKeybinding: state.upsert, removeKeybinding: state.remove },
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: "primary-settings" }),
}));

vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => {
    const environment = {
      environmentId: "primary-settings",
      serverConfig: {
        environment: { capabilities: { serverSettingsWrite: state.serverSettingsWrite } },
        keybindings: [],
        keybindingsConfigPath: "/fixture/keybindings.json",
        availableEditors: [],
      },
    };
    return state.connected
      ? { environment, connectedEnvironments: [environment] }
      : { environment: null, connectedEnvironments: [] };
  },
}));

vi.mock("../../state/session", () => {
  const hasScope = (environmentId: EnvironmentId | null, scope: string) =>
    environmentId === "primary-settings" &&
    (scope === "orchestration:operate"
      ? state.canOperate
      : scope === "settings:write" && state.canWriteSettings);
  return {
    useEnvironmentScope: hasScope,
    readEnvironmentScope: hasScope,
    useEnvironmentsWithScope: () => new Set(state.canWriteSettings ? ["primary-settings"] : []),
  };
});

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));

vi.mock("../../editorPreferences", () => ({
  useOpenInPreferredEditor: (environmentId: EnvironmentId) => (path: string) =>
    state.openEditor({ environmentId, path }),
}));

import { KeybindingsSettingsPanel } from "./KeybindingsSettings";

function renderPanel() {
  hooks.beginRender();
  return KeybindingsSettingsPanel();
}

function openButton(panel: unknown) {
  const button = visitElements(
    panel,
    (element) => element.props["aria-label"] === "Open keybindings.json",
  );
  if (!button) throw new Error("Missing Open keybindings.json action.");
  return button;
}

describe("KeybindingsSettings editor permission", () => {
  beforeEach(() => {
    hooks.reset();
    state.canOperate = false;
    state.canWriteSettings = true;
    state.connected = true;
    state.serverSettingsWrite = true;
    state.openEditor.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    state.upsert.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    state.remove.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  });

  it("rejects editor launches when settings writes are the only write grant", () => {
    const button = openButton(renderPanel());
    (button.props.onClick as () => void)();

    expect(state.openEditor).not.toHaveBeenCalled();
    expect(button.props.disabled).toBe(true);
  });

  it("opens the primary environment's file after operate is granted without settings writes", () => {
    state.canWriteSettings = false;
    renderPanel();
    state.canOperate = true;
    const button = openButton(renderPanel());
    expect(button.props.disabled).toBe(false);
    (button.props.onClick as () => void)();

    expect(state.openEditor).toHaveBeenCalledWith({
      environmentId: "primary-settings",
      path: "/fixture/keybindings.json",
    });
  });

  it("rejects a queued editor launch after operate is revoked", () => {
    state.canOperate = true;
    const open = openButton(renderPanel()).props.onClick as () => void;
    state.canOperate = false;
    open();

    expect(state.openEditor).not.toHaveBeenCalled();
    expect(openButton(renderPanel()).props.disabled).toBe(true);
  });
});

function noticeText(panel: unknown) {
  const notice = visitElements(panel, (element) => element.type === "p");
  return notice?.props.children;
}

describe("KeybindingsSettings write notice", () => {
  beforeEach(() => {
    hooks.reset();
    state.canWriteSettings = true;
    state.connected = true;
    state.serverSettingsWrite = true;
  });

  it("asks for a connected environment when none is connected", () => {
    state.connected = false;
    expect(noticeText(renderPanel())).toBe("Connect an environment to change keybindings.");
  });

  it("names the permission when the connection cannot write settings", () => {
    state.canWriteSettings = false;
    expect(noticeText(renderPanel())).toBe(
      "This connection can view keybindings but cannot change them.",
    );
  });
});

describe("KeybindingsSettings unsupported writes", () => {
  it("blocks save and remove even when the session grants settings writes", () => {
    hooks.reset();
    state.connected = true;
    state.canWriteSettings = true;
    state.serverSettingsWrite = false;
    state.upsert.mockClear();
    state.remove.mockClear();
    const groups = visitElements(
      renderPanel(),
      (element) => typeof element.props.onSave === "function",
    );
    if (!groups) throw new Error("Missing keybinding reference groups");
    (groups.props.onSave as (input: unknown) => void)({ command: "chat.new", key: "mod+n" });
    (groups.props.onRemove as (row: unknown) => void)({ command: "chat.new", key: "mod+n" });
    expect(state.upsert).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
    expect(groups.props.readOnly).toBe(true);
    state.serverSettingsWrite = true;
  });
});
