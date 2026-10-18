import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { NewProjectScriptInput } from "../projectScriptEditor";

const permissions = vi.hoisted(() => ({
  settings: true,
  upsert: true,
  remove: true,
  serverSettingsWrite: true,
  terminal: true,
  keybindingsWrite: false,
  deniedEnvironment: "",
}));

const commands = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  upsertKeybinding: vi.fn(),
  removeKeybinding: vi.fn(),
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => permissions.settings,
}));
vi.mock(import("../../rpc/atomRegistry"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    appAtomRegistry: {
      ...actual.appAtomRegistry,
      get: ((atom: { kind: "config" | "upsert" | "remove"; environmentId: string }) => {
        if (atom.kind === "config") {
          return {
            environment: {
              capabilities: {
                serverSettingsWrite: permissions.serverSettingsWrite,
                terminal: permissions.terminal,
                keybindingsWrite: permissions.keybindingsWrite,
              },
            },
          };
        }
        return atom.environmentId !== permissions.deniedEnvironment && permissions[atom.kind];
      }) as never,
    },
  };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [],
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      updateSettings: "updateSettings",
      configValueAtom: (environmentId: string) => ({ kind: "config", environmentId }),
      upsertKeybinding: {
        name: "upsertKeybinding",
        permissionAtom: (environmentId: string) => ({ kind: "upsert", environmentId }),
      },
      removeKeybinding: {
        name: "removeKeybinding",
        permissionAtom: (environmentId: string) => ({ kind: "remove", environmentId }),
      },
    } as unknown as typeof actual.serverEnvironment,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: keyof typeof commands | { name: keyof typeof commands }) =>
    commands[typeof command === "string" ? command : command.name]) as never,
}));

import { useProjectScriptSettings } from "./useProjectScriptSettings";

const environmentId = EnvironmentId.make("remote");
const lint: ProjectScript = {
  id: "lint",
  name: "Lint",
  command: "vp lint",
  icon: "lint",
  runOnWorktreeCreate: false,
};
const lintBinding: ResolvedKeybindingsConfig = [
  {
    command: "script.lint.run",
    shortcut: {
      key: "k",
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      modKey: true,
    },
  },
];
const input = (keybinding: string | null | undefined): NewProjectScriptInput => ({
  name: lint.name,
  command: lint.command,
  icon: lint.icon,
  runOnWorktreeCreate: false,
  waitForSetup: false,
  runOnSettle: false,
  ...(keybinding === undefined ? {} : { keybinding }),
  previewUrl: null,
  autoOpenPreview: false,
});

type ProjectScriptSettings = ReturnType<typeof useProjectScriptSettings>;

function Probe(props: {
  keybindings: ResolvedKeybindingsConfig;
  onResult: (settings: ProjectScriptSettings) => void;
  settings?: typeof DEFAULT_SERVER_SETTINGS;
  secondEnvironment?: boolean;
}) {
  props.onResult(
    useProjectScriptSettings(
      (props.secondEnvironment
        ? [environmentId, EnvironmentId.make("second")]
        : [environmentId]
      ).map((environmentId) => ({
        environmentId,
        settings: props.settings ?? DEFAULT_SERVER_SETTINGS,
        keybindings: props.keybindings,
        project: { id: ProjectId.make("project"), scripts: [lint] },
      })),
    ),
  );
  return null;
}

let root: Root;
let container: HTMLDivElement;

async function renderSettings(
  keybindings: ResolvedKeybindingsConfig,
  options: { settings?: typeof DEFAULT_SERVER_SETTINGS; secondEnvironment?: boolean } = {},
) {
  let settings: ProjectScriptSettings | undefined;
  await act(async () =>
    root.render(
      <Probe {...options} keybindings={keybindings} onResult={(next) => (settings = next)} />,
    ),
  );
  return settings!;
}

async function submitInAct(
  submit: ProjectScriptSettings["submit"],
  keybinding: string | null | undefined,
) {
  let result: Awaited<ReturnType<typeof submit>> | undefined;
  await act(async () => {
    result = await submit(lint.id, input(keybinding));
  });
  return result!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  Object.assign(permissions, {
    settings: true,
    upsert: true,
    remove: true,
    serverSettingsWrite: true,
    terminal: true,
    keybindingsWrite: false,
    deniedEnvironment: "",
  });
  for (const command of Object.values(commands)) {
    command.mockResolvedValue(AsyncResult.success(undefined));
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("useProjectScriptSettings", () => {
  it("saves a recorded action shortcut", async () => {
    const { submit } = await renderSettings([]);

    const result = await submitInAct(submit, "mod+shift+k");

    expect(result._tag).toBe("Success");
    expect(commands.upsertKeybinding).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({ key: "mod+shift+k", command: "script.lint.run" }),
    });
  });

  it("removes a cleared action shortcut", async () => {
    const { submit } = await renderSettings(lintBinding);

    const result = await submitInAct(submit, null);

    expect(result._tag).toBe("Success");
    expect(commands.removeKeybinding).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({ key: "mod+shift+k", command: "script.lint.run" }),
    });
    expect(commands.upsertKeybinding).not.toHaveBeenCalled();
  });
});

describe("project action shortcut authorization", () => {
  it.each(["mod+shift+j", null])(
    "rejects a denied shortcut edit before saving scripts (%s)",
    async (keybinding) => {
      const { submit } = await renderSettings(lintBinding);
      permissions.upsert = false;
      permissions.remove = false;

      expect((await submitInAct(submit, keybinding))._tag).toBe("Failure");
      expect(commands.updateSettings).not.toHaveBeenCalled();
      expect(commands.upsertKeybinding).not.toHaveBeenCalled();
      expect(commands.removeKeybinding).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "mod+shift+k"])(
    "saves scripts without shortcut permission when the shortcut is unchanged (%s)",
    async (keybinding) => {
      permissions.upsert = false;
      permissions.remove = false;
      const { submit } = await renderSettings(lintBinding);

      expect((await submitInAct(submit, keybinding))._tag).toBe("Success");
      expect(commands.updateSettings).toHaveBeenCalledOnce();
      expect(commands.upsertKeybinding).not.toHaveBeenCalled();
      expect(commands.removeKeybinding).not.toHaveBeenCalled();
    },
  );

  it.each(["upsert", "remove", "serverSettingsWrite"] as const)(
    "returns failure when %s changes during the settings save",
    async (permission) => {
      const { submit } = await renderSettings(lintBinding);
      commands.updateSettings.mockImplementationOnce(async () => {
        permissions[permission] = false;
        return AsyncResult.success(undefined);
      });

      const result = await submitInAct(submit, permission === "remove" ? null : "mod+shift+j");

      expect(result._tag).toBe("Failure");
      expect(commands.updateSettings).toHaveBeenCalledOnce();
      expect(commands.upsertKeybinding).not.toHaveBeenCalled();
      expect(commands.removeKeybinding).not.toHaveBeenCalled();
    },
  );

  it("checks every target before saving any scripts", async () => {
    const { submit } = await renderSettings([], { secondEnvironment: true });
    permissions.deniedEnvironment = "second";

    expect((await submitInAct(submit, "mod+shift+k"))._tag).toBe("Failure");
    expect(commands.updateSettings).not.toHaveBeenCalled();
  });

  it.each(["settings", "serverSettingsWrite", "terminal"] as const)(
    "keeps the general script guard separate from shortcut grants (%s)",
    async (permission) => {
      permissions[permission] = false;
      permissions.keybindingsWrite = true;
      const { submit } = await renderSettings([]);

      expect((await submitInAct(submit, "mod+shift+k"))._tag).toBe("Failure");
      expect(commands.updateSettings).not.toHaveBeenCalled();
      expect(commands.upsertKeybinding).not.toHaveBeenCalled();
    },
  );

  it("retains a shared shortcut when deleting a project override without shortcut permission", async () => {
    permissions.remove = false;
    const { persist } = await renderSettings(lintBinding, {
      settings: { ...DEFAULT_SERVER_SETTINGS, defaultProjectScripts: [lint] },
    });
    let result: Awaited<ReturnType<typeof persist>> | undefined;
    await act(async () => {
      result = await persist(() => []);
    });

    expect(result?._tag).toBe("Success");
    expect(commands.updateSettings).toHaveBeenCalledOnce();
    expect(commands.removeKeybinding).not.toHaveBeenCalled();
  });

  it("requires removal permission for a deleted action's last shortcut", async () => {
    permissions.remove = false;
    const { persist } = await renderSettings(lintBinding);
    let result: Awaited<ReturnType<typeof persist>> | undefined;
    await act(async () => {
      result = await persist(() => []);
    });

    expect(result?._tag).toBe("Failure");
    expect(commands.updateSettings).not.toHaveBeenCalled();
  });
});
