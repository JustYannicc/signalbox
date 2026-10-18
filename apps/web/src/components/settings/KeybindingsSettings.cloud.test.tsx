import type { EnvironmentId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
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

vi.mock("@effect/atom-react", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return {
    useAtomValue: <A,>(atom: Atom.Atom<A>) => {
      const registry = AtomRegistry.make();
      try {
        return registry.get(atom);
      } finally {
        registry.dispose();
      }
    },
  };
});

vi.mock("@tanstack/react-router", () => ({ useLocation: () => "" }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const permissionAtom = (environmentId: EnvironmentId) =>
    Atom.make(environmentId === "primary-settings" && state.canWriteSettings);
  return {
    primaryServerConfigAtom: Atom.make(null),
    environmentServerConfigsAtom: Atom.make(new Map()),
    serverEnvironment: {
      upsertKeybinding: Object.assign(state.upsert, { permissionAtom }),
      removeKeybinding: Object.assign(state.remove, { permissionAtom }),
    },
  };
});

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

// signalbox: kept out of upstream's test file so upstream merges stay clean.
describe("KeybindingsSettings unsupported writes", () => {
  beforeEach(() => {
    hooks.reset();
    state.connected = true;
    state.canWriteSettings = true;
    state.serverSettingsWrite = true;
    state.upsert.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    state.remove.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  });

  it("blocks save and remove even when the session grants settings writes", () => {
    state.serverSettingsWrite = false;
    const groups = visitElements(
      renderPanel(),
      (element) => typeof element.props.onSave === "function",
    );
    if (!groups) throw new Error("Missing keybinding reference groups");
    (groups.props.onSave as (input: unknown) => void)({ command: "chat.new", key: "mod+n" });
    (groups.props.onRemove as (row: unknown) => void)({
      command: "chat.new",
      key: "mod+n",
      when: "",
    });
    expect(state.upsert).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
    expect(groups.props.readOnly).toBe(true);
  });
});
