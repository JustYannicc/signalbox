import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { NewProjectScriptInput } from "../projectScriptEditor";

const state = vi.hoisted(() => ({
  upsert: true,
  remove: true,
  serverSettingsWrite: true,
  terminal: true,
  keybindingsWrite: false,
  keybindings: [] as ResolvedKeybindingsConfig,
  updateSettings: vi.fn(),
  upsertKeybinding: vi.fn(),
  removeKeybinding: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => "config",
    updateSettings: state.updateSettings,
    upsertKeybinding: Object.assign(state.upsertKeybinding, { permissionAtom: () => "upsert" }),
    removeKeybinding: Object.assign(state.removeKeybinding, { permissionAtom: () => "remove" }),
  },
}));
vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: "config" | "upsert" | "remove") =>
      atom === "config"
        ? {
            keybindings: state.keybindings,
            environment: {
              capabilities: {
                serverSettingsWrite: state.serverSettingsWrite,
                terminal: state.terminal,
                keybindingsWrite: state.keybindingsWrite,
                projectSettingsOverrides: true,
              },
            },
          }
        : state[atom],
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => false }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: state.toast },
  stackedThreadToast: (input: unknown) => input,
}));

import { useProjectScriptEditing } from "./useProjectScriptEditing";

const environmentId = EnvironmentId.make("remote");
const lint: ProjectScript = {
  id: "lint",
  name: "Lint",
  command: "vp lint",
  icon: "lint",
  runOnWorktreeCreate: false,
};
const binding = (key: string): ResolvedKeybindingsConfig[number] => ({
  command: "script.lint.run",
  shortcut: { key, modKey: true, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
});
const input = (keybinding: string | null | undefined): NewProjectScriptInput => ({
  name: "Renamed lint",
  command: lint.command,
  icon: lint.icon,
  runOnWorktreeCreate: false,
  waitForSetup: false,
  runOnSettle: false,
  ...(keybinding === undefined ? {} : { keybinding }),
  previewUrl: null,
  autoOpenPreview: false,
});
type Editing = ReturnType<typeof useProjectScriptEditing>;

function Probe(props: { retained: boolean; onResult: (editing: Editing) => void }) {
  props.onResult(
    useProjectScriptEditing({
      environmentId,
      project: {
        environmentId,
        id: ProjectId.make("project"),
        title: "Project",
        workspaceRoot: "/project",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [lint],
        createdAt: "2026-10-17T00:00:00.000Z",
        updatedAt: "2026-10-17T00:00:00.000Z",
      },
      scripts: [lint],
      settings: {
        ...DEFAULT_UNIFIED_SETTINGS,
        defaultProjectScripts: props.retained ? [lint] : [],
      },
    }),
  );
  return null;
}

let renderer: ReactTestRenderer | undefined;
function renderEditing(retained = false) {
  let editing: Editing | undefined;
  act(() => {
    renderer = create(
      <Probe
        retained={retained}
        onResult={(next) => {
          editing = next;
        }}
      />,
    );
  });
  return editing!;
}
async function runInAct(action: () => ReturnType<Editing["updateProjectScript"]>) {
  let result: Awaited<ReturnType<typeof action>> | undefined;
  await act(async () => {
    result = await action();
  });
  return result!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.assign(state, {
    upsert: true,
    remove: true,
    serverSettingsWrite: true,
    terminal: true,
    keybindingsWrite: false,
    keybindings: [binding("k")],
  });
  for (const command of [state.updateSettings, state.upsertKeybinding, state.removeKeybinding]) {
    command.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  }
  state.toast.mockReset();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("useProjectScriptEditing shortcut authorization", () => {
  it("uses the guarded command grant instead of a separate scope read", async () => {
    const editing = renderEditing();
    state.remove = false;
    const result = await runInAct(() => editing.updateProjectScript(lint.id, input("mod+j")));

    expect(result._tag).toBe("Success");
    expect(state.upsertKeybinding).toHaveBeenCalledWith({
      environmentId,
      input: {
        command: "script.lint.run",
        key: "mod+j",
        replace: { command: "script.lint.run", key: "mod+k" },
      },
    });
  });

  it.each(["mod+j", null])(
    "rejects denied shortcut edits before saving scripts (%s)",
    async (keybinding) => {
      const editing = renderEditing();
      state.upsert = false;
      state.remove = false;
      const result = await runInAct(() => editing.updateProjectScript(lint.id, input(keybinding)));

      expect(result._tag).toBe("Failure");
      expect(state.updateSettings).not.toHaveBeenCalled();
      expect(state.upsertKeybinding).not.toHaveBeenCalled();
      expect(state.removeKeybinding).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "mod+k"])(
    "saves only the script without shortcut permission (%s)",
    async (keybinding) => {
      state.upsert = false;
      state.remove = false;
      const editing = renderEditing();
      const result = await runInAct(() => editing.updateProjectScript(lint.id, input(keybinding)));

      expect(result._tag).toBe("Success");
      expect(state.updateSettings).toHaveBeenCalledWith({
        environmentId,
        input: {
          patch: {
            projectSettingsOverrides: {
              project: {
                defaultProjectScripts: [expect.objectContaining({ name: "Renamed lint" })],
              },
            },
          },
        },
      });
      expect(state.upsertKeybinding).not.toHaveBeenCalled();
      expect(state.removeKeybinding).not.toHaveBeenCalled();
    },
  );

  it.each(["upsert", "remove", "serverSettingsWrite"] as const)(
    "rechecks %s after saving settings",
    async (permission) => {
      const editing = renderEditing();
      state.updateSettings.mockImplementationOnce(async () => {
        state[permission] = false;
        return AsyncResult.success(undefined);
      });
      const result = await runInAct(() =>
        editing.updateProjectScript(lint.id, input(permission === "remove" ? null : "mod+j")),
      );

      expect(result._tag).toBe("Failure");
      expect(state.updateSettings).toHaveBeenCalledOnce();
      expect(state.upsertKeybinding).not.toHaveBeenCalled();
      expect(state.removeKeybinding).not.toHaveBeenCalled();
    },
  );

  it("requires cleanup permission before replacing duplicate shortcuts", async () => {
    state.keybindings = [binding("i"), binding("k")];
    state.remove = false;
    const editing = renderEditing();
    const result = await runInAct(() => editing.updateProjectScript(lint.id, input("mod+j")));

    expect(result._tag).toBe("Failure");
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("removes duplicate rules and replaces the last rule", async () => {
    state.keybindings = [binding("i"), binding("k")];
    const editing = renderEditing();
    const result = await runInAct(() => editing.updateProjectScript(lint.id, input("mod+j")));

    expect(result._tag).toBe("Success");
    expect(state.removeKeybinding).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { command: "script.lint.run", key: "mod+i" },
    });
    expect(state.upsertKeybinding).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({
        key: "mod+j",
        replace: { command: "script.lint.run", key: "mod+k" },
      }),
    });
  });

  it("rechecks the replacement grant after awaited duplicate cleanup", async () => {
    state.keybindings = [binding("i"), binding("k")];
    const editing = renderEditing();
    state.removeKeybinding.mockImplementationOnce(async () => {
      state.upsert = false;
      return AsyncResult.success(undefined);
    });
    const result = await runInAct(() => editing.updateProjectScript(lint.id, input("mod+j")));

    expect(result._tag).toBe("Failure");
    expect(state.removeKeybinding).toHaveBeenCalledOnce();
    expect(state.upsertKeybinding).not.toHaveBeenCalled();
  });

  it("does not require a completed cleanup grant for the remaining replacement", async () => {
    state.keybindings = [binding("i"), binding("k")];
    const editing = renderEditing();
    state.removeKeybinding.mockImplementationOnce(async () => {
      state.remove = false;
      return AsyncResult.success(undefined);
    });
    const result = await runInAct(() => editing.updateProjectScript(lint.id, input("mod+j")));

    expect(result._tag).toBe("Success");
    expect(state.removeKeybinding).toHaveBeenCalledOnce();
    expect(state.upsertKeybinding).toHaveBeenCalledOnce();
  });

  it("keeps shared shortcuts when deleting an override without shortcut permission", async () => {
    state.remove = false;
    const editing = renderEditing(true);
    const result = await runInAct(() => editing.deleteProjectScript(lint.id));

    expect(result._tag).toBe("Success");
    expect(state.updateSettings).toHaveBeenCalledOnce();
    expect(state.removeKeybinding).not.toHaveBeenCalled();
  });

  it("can delete a script while retaining its shortcut when cleanup is not permitted", async () => {
    state.remove = false;
    const editing = renderEditing();
    const result = await runInAct(() => editing.deleteProjectScript(lint.id));

    expect(result._tag).toBe("Success");
    expect(state.updateSettings).toHaveBeenCalledOnce();
    expect(state.removeKeybinding).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  });

  it("reports deletion cleanup permission lost during the settings save", async () => {
    const editing = renderEditing();
    state.updateSettings.mockImplementationOnce(async () => {
      state.remove = false;
      return AsyncResult.success(undefined);
    });
    const result = await runInAct(() => editing.deleteProjectScript(lint.id));

    expect(result._tag).toBe("Failure");
    expect(state.updateSettings).toHaveBeenCalledOnce();
    expect(state.removeKeybinding).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  });

  it.each(["serverSettingsWrite", "terminal"] as const)(
    "cannot edit scripts when %s is unavailable even with shortcut grants",
    async (capability) => {
      state[capability] = false;
      state.keybindingsWrite = true;
      const editing = renderEditing();
      const result = await runInAct(() => editing.updateProjectScript(lint.id, input("mod+j")));

      expect(result._tag).toBe("Failure");
      expect(state.updateSettings).not.toHaveBeenCalled();
      expect(state.upsertKeybinding).not.toHaveBeenCalled();
    },
  );
});
