import type {
  KeybindingCommand,
  ProjectId,
  ProjectScript,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
  environmentCanWriteKeybindings,
  environmentSupports,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
} from "../../lib/projectScriptKeybindings";
import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptIdFromCommand,
  releaseClaimedRoles,
} from "../../projectScripts";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjects } from "../../state/entities";
import { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Adds, edits, and deletes the active project's scripts. A script's keyboard
 * shortcut lives in the environment's keybindings, so each change writes the
 * script settings first and then reconciles the shortcut.
 */
export function useProjectScriptEditing(input: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject | null;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly settings: UnifiedSettings;
}) {
  const { environmentId, project, scripts, settings } = input;
  const allProjects = useProjects();
  const updateProjectScriptSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybinding = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });
  const persistProjectScripts = async (input: {
    projectId: ProjectId;
    projectCwd: string;
    previousScripts: ReadonlyArray<ProjectScript>;
    nextScripts: ReadonlyArray<ProjectScript>;
    keybinding: NewProjectScriptInput["keybinding"];
    keybindingCommand: KeybindingCommand | null;
  }): Promise<AtomCommandResult<void, unknown>> => {
    const serverConfig = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
    const previousKeybinding = keybindingValueForCommand(
      serverConfig?.keybindings ?? [],
      input.keybindingCommand,
    );
    // signalbox: shortcut support does not grant support for project script settings.
    if (
      !environmentSupports(serverConfig?.environment.capabilities, "serverSettingsWrite") ||
      !environmentSupports(serverConfig?.environment.capabilities, "terminal")
    ) {
      return AsyncResult.failure(
        Cause.fail(new Error("This environment cannot change project actions.")),
      );
    }
    const isDeletingScript = !input.nextScripts.some(
      (script) => commandForProjectScript(script.id) === input.keybindingCommand,
    );
    const changesKeybinding =
      input.keybinding !== undefined &&
      (input.keybinding?.trim() || null) !== previousKeybinding &&
      // signalbox: deletion may leave a reusable shortcut when cleanup is not permitted.
      (!isDeletingScript ||
        (environmentCanWriteKeybindings(serverConfig?.environment.capabilities) &&
          appAtomRegistry.get(serverEnvironment.removeKeybinding.permissionAtom(environmentId))));
    const keybindingRule = changesKeybinding
      ? decodeProjectScriptKeybindingRule({
          keybinding: input.keybinding,
          command: input.keybindingCommand,
        })
      : null;
    const scriptId = input.keybindingCommand
      ? projectScriptIdFromCommand(input.keybindingCommand)
      : null;
    const retainedElsewhere =
      !input.nextScripts.some((script) => script.id === scriptId) &&
      (settings.defaultProjectScripts.some((script) => script.id === scriptId) ||
        Object.entries(settings.projectSettingsOverrides).some(
          ([projectId, entry]) =>
            projectId !== input.projectId &&
            entry.defaultProjectScripts?.some((script) => script.id === scriptId),
        ) ||
        allProjects.some(
          (other) =>
            other.environmentId === environmentId &&
            other.id !== input.projectId &&
            resolveProjectScripts(settings, other).some((script) => script.id === scriptId),
        ));
    const previousRules = (changesKeybinding ? (serverConfig?.keybindings ?? []) : []).flatMap(
      (binding) => {
        if (binding.command !== input.keybindingCommand || binding.whenAst) return [];
        const previous = decodeProjectScriptKeybindingRule({
          keybinding: keybindingValueForCommand([binding], input.keybindingCommand),
          command: input.keybindingCommand,
        });
        return previous ? [previous] : [];
      },
    );
    const previous = previousRules.at(-1);
    const rulesToRemove = !changesKeybinding
      ? []
      : keybindingRule
        ? previousRules.slice(0, -1)
        : retainedElsewhere || !input.previousScripts.some((script) => script.id === scriptId)
          ? []
          : previousRules;
    const keybindingCommands = [
      ...(keybindingRule ? [serverEnvironment.upsertKeybinding] : []),
      ...(rulesToRemove.length > 0 ? [serverEnvironment.removeKeybinding] : []),
    ];
    const canWriteKeybindings = (commands = keybindingCommands) => {
      if (commands.length === 0) return true;
      const capabilities = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))
        ?.environment.capabilities;
      return (
        environmentCanWriteKeybindings(capabilities) &&
        commands.every((command) => appAtomRegistry.get(command.permissionAtom(environmentId)))
      );
    };
    const denied = (saved = false) =>
      AsyncResult.failure<void, EnvironmentAuthorizationError>(
        Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: AuthSettingsWriteScope,
            message: saved
              ? "The script was saved, but this connection can no longer change keyboard shortcuts."
              : "This connection cannot change keyboard shortcuts.",
          }),
        ),
      );
    if (!canWriteKeybindings()) return denied();
    const updateResult = mapAtomCommandResult(
      await updateProjectScriptSettings({
        environmentId,
        input: {
          patch:
            serverConfig?.environment.capabilities.projectSettingsOverrides === true
              ? {
                  projectSettingsOverrides: {
                    [input.projectId]: {
                      ...settings.projectSettingsOverrides[input.projectId],
                      defaultProjectScripts: input.nextScripts,
                    },
                  },
                }
              : {
                  projectScriptOverrides: {
                    [input.projectId]: input.nextScripts,
                  },
                },
        },
      }),
      () => undefined,
    );
    if (updateResult._tag === "Failure") {
      return updateResult;
    }

    if (!canWriteKeybindings()) return denied(true);
    for (const rule of rulesToRemove) {
      if (!canWriteKeybindings([serverEnvironment.removeKeybinding])) return denied(true);
      const result = await removeKeybinding({ environmentId, input: rule });
      if (result._tag === "Failure") return mapAtomCommandResult(result, () => undefined);
    }
    if (keybindingRule && !canWriteKeybindings([serverEnvironment.upsertKeybinding])) {
      return denied(true);
    }
    return keybindingRule
      ? mapAtomCommandResult(
          await upsertKeybinding({
            environmentId,
            input:
              previous && previous.key !== keybindingRule.key
                ? { ...keybindingRule, replace: previous }
                : keybindingRule,
          }),
          () => undefined,
        )
      : updateResult;
  };
  const saveProjectScript = async (
    input: NewProjectScriptInput,
  ): Promise<AtomCommandResult<void, unknown>> => {
    if (!project) {
      return AsyncResult.success(undefined);
    }
    const nextId = nextProjectScriptId(
      input.name,
      scripts.map((script) => script.id),
    );
    const nextScript = buildProjectScript(nextId, input);
    const nextScripts = [
      ...scripts.map((script) => releaseClaimedRoles(script, input)),
      nextScript,
    ];

    return persistProjectScripts({
      projectId: project.id,
      projectCwd: project.workspaceRoot,
      previousScripts: scripts,
      nextScripts,
      keybinding: input.keybinding,
      keybindingCommand: commandForProjectScript(nextId),
    });
  };
  const updateProjectScript = async (
    scriptId: string,
    input: NewProjectScriptInput,
  ): Promise<AtomCommandResult<void, unknown>> => {
    if (!project) {
      return AsyncResult.success(undefined);
    }
    const existingScript = scripts.find((script) => script.id === scriptId);
    if (!existingScript) {
      return AsyncResult.failure(Cause.fail(new Error("Script not found.")));
    }

    const updatedScript = buildProjectScript(existingScript.id, input);
    const nextScripts = scripts.map((script) =>
      script.id === scriptId ? updatedScript : releaseClaimedRoles(script, input),
    );

    return persistProjectScripts({
      projectId: project.id,
      projectCwd: project.workspaceRoot,
      previousScripts: scripts,
      nextScripts,
      keybinding: input.keybinding,
      keybindingCommand: commandForProjectScript(scriptId),
    });
  };
  const deleteProjectScript = async (
    scriptId: string,
  ): Promise<AtomCommandResult<void, unknown>> => {
    if (!project) {
      return AsyncResult.success(undefined);
    }
    const nextScripts = scripts.filter((script) => script.id !== scriptId);

    const deletedName = scripts.find((s) => s.id === scriptId)?.name;

    const result = await persistProjectScripts({
      projectId: project.id,
      projectCwd: project.workspaceRoot,
      previousScripts: scripts,
      nextScripts,
      keybinding: null,
      keybindingCommand: commandForProjectScript(scriptId),
    });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: `Deleted action "${deletedName ?? "Unknown"}"`,
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not delete action",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    }
    return result;
  };
  return {
    saveProjectScript: useStableCallback(saveProjectScript),
    updateProjectScript: useStableCallback(updateProjectScript),
    deleteProjectScript: useStableCallback(deleteProjectScript),
  };
}
