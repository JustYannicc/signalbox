import {
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
  environmentCanWriteKeybindings,
  environmentSupports,
} from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { clearProjectSettingsOverrides } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";

import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
} from "../../lib/projectScriptKeybindings";
import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
  releaseClaimedRoles,
} from "../../projectScripts";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { NewProjectScriptInput } from "../projectScriptEditor";
import { toastManager } from "../ui/toast";

function reportScriptFailure(result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Failed to save project actions",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
  return mapAtomCommandResult(result, () => undefined);
}

export function useProjectScriptSettings(
  targets: readonly {
    environmentId: EnvironmentId;
    settings: ServerSettings;
    keybindings: ResolvedKeybindingsConfig;
    project?: { id: ProjectId; scripts: readonly ProjectScript[] };
  }[],
) {
  const projects = useProjects();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "project actions update");
  const upsertKeybinding = useAtomCommand(
    serverEnvironment.upsertKeybinding,
    "action shortcut update",
  );
  const removeKeybinding = useAtomCommand(
    serverEnvironment.removeKeybinding,
    "action shortcut removal",
  );

  async function persist(
    transform: (current: readonly ProjectScript[]) => readonly ProjectScript[] | null,
    scriptId?: string,
    keybinding?: string | null,
  ): Promise<AtomCommandResult<void, unknown>> {
    if (savingRef.current || targets.length === 0) {
      const message = "No available machine, or another action change is saving.";
      toastManager.add({ type: "error", title: "Actions not saved", description: message });
      return AsyncResult.failure(Cause.fail(new Error(message)));
    }
    if (
      targets.some(({ environmentId }) => {
        const capabilities = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))
          ?.environment.capabilities;
        return (
          !readEnvironmentScope(environmentId, AuthSettingsWriteScope) ||
          !environmentSupports(capabilities, "serverSettingsWrite") ||
          !environmentSupports(capabilities, "terminal")
        );
      })
    ) {
      return reportScriptFailure(
        AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              requiredScope: AuthSettingsWriteScope,
              message: "This connection cannot change environment settings.",
            }),
          ),
        ),
      );
    }
    savingRef.current = true;
    setSaving(true);
    return writeTargets(transform, scriptId, keybinding).finally(() => {
      savingRef.current = false;
      setSaving(false);
    });
  }

  async function writeTargets(
    transform: (current: readonly ProjectScript[]) => readonly ProjectScript[] | null,
    scriptId: string | undefined,
    keybinding: string | null | undefined,
  ): Promise<AtomCommandResult<void, unknown>> {
    const plans = targets.map(({ environmentId, settings, keybindings, project }) => {
      const current = project
        ? resolveProjectScripts(settings, project)
        : settings.defaultProjectScripts;
      const nextScripts = transform(current);
      const effectiveScripts = nextScripts ?? settings.defaultProjectScripts;
      const changedIds = scriptId
        ? [scriptId]
        : current
            .filter((script) => !effectiveScripts.some((next) => next.id === script.id))
            .map((script) => script.id);
      const bindings = changedIds.flatMap((id) => {
        const command = commandForProjectScript(id);
        const previousValue = keybindingValueForCommand(keybindings, command);
        if (
          scriptId &&
          (keybinding === undefined || (keybinding?.trim() || null) === previousValue)
        ) {
          return [];
        }
        const previous = previousValue
          ? decodeProjectScriptKeybindingRule({ keybinding: previousValue, command })
          : null;
        const next = decodeProjectScriptKeybindingRule({ keybinding, command });
        const retainedElsewhere =
          !nextScripts?.some((script) => script.id === id) &&
          ((project && settings.defaultProjectScripts.some((script) => script.id === id)) ||
            Object.entries(settings.projectSettingsOverrides).some(
              ([projectId, entry]) =>
                projectId !== project?.id &&
                entry.defaultProjectScripts?.some((script) => script.id === id),
            ) ||
            projects.some(
              (other) =>
                other.environmentId === environmentId &&
                other.id !== project?.id &&
                (project ? resolveProjectScripts(settings, other) : other.scripts).some(
                  (script) => script.id === id,
                ),
            ));
        return next || (previous && !retainedElsewhere) ? [{ previous, next }] : [];
      });
      return { environmentId, settings, project, nextScripts, bindings };
    });
    // signalbox: reject every requested shortcut write before changing any target's scripts.
    const canWriteBindings = (
      plan: (typeof plans)[number],
      only?: (typeof plans)[number]["bindings"],
    ) => {
      const bindings = only ?? plan.bindings;
      const capabilities = appAtomRegistry.get(
        serverEnvironment.configValueAtom(plan.environmentId),
      )?.environment.capabilities;
      return (
        bindings.length === 0 ||
        (environmentCanWriteKeybindings(capabilities) &&
          bindings.every(({ next }) =>
            appAtomRegistry.get(
              next
                ? serverEnvironment.upsertKeybinding.permissionAtom(plan.environmentId)
                : serverEnvironment.removeKeybinding.permissionAtom(plan.environmentId),
            ),
          ))
      );
    };
    let savedScripts = false;
    const denied = () =>
      reportScriptFailure(
        AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              requiredScope: AuthSettingsWriteScope,
              message: savedScripts
                ? "Scripts were saved, but this connection can no longer change keyboard shortcuts."
                : "This connection cannot change keyboard shortcuts.",
            }),
          ),
        ),
      );
    if (plans.some((plan) => !canWriteBindings(plan))) return denied();
    for (const plan of plans) {
      const { environmentId, settings, project, nextScripts, bindings } = plan;
      if (!canWriteBindings(plan)) return denied();
      const result = await updateSettings({
        environmentId,
        input: {
          patch: project
            ? {
                projectSettingsOverrides: {
                  [project.id]:
                    nextScripts === null
                      ? clearProjectSettingsOverrides(settings, project.id, [
                          "defaultProjectScripts",
                        ])
                      : {
                          ...settings.projectSettingsOverrides[project.id],
                          defaultProjectScripts: nextScripts,
                        },
                },
              }
            : { defaultProjectScripts: nextScripts ?? [] },
        },
      });
      if (result._tag === "Failure") return reportScriptFailure(result);
      savedScripts = true;
      if (!canWriteBindings(plan)) return denied();
      for (const { previous, next } of bindings) {
        if (!canWriteBindings(plan, [{ previous, next }])) return denied();
        const bindingResult = next
          ? await upsertKeybinding({
              environmentId,
              input: previous && previous.key !== next.key ? { ...next, replace: previous } : next,
            })
          : previous
            ? await removeKeybinding({ environmentId, input: previous })
            : null;
        if (bindingResult?._tag === "Failure") return reportScriptFailure(bindingResult);
      }
    }
    return AsyncResult.success(undefined);
  }

  function submit(scriptId: string | null, input: NewProjectScriptInput) {
    const existingIds = [
      ...projects.flatMap((project) => project.scripts.map((script) => script.id)),
      ...targets.flatMap(({ settings, project }) =>
        [
          ...settings.defaultProjectScripts,
          ...Object.values(settings.projectSettingsOverrides).flatMap(
            (entry) => entry.defaultProjectScripts ?? [],
          ),
          ...(project?.scripts ?? []),
        ].map((script) => script.id),
      ),
    ];
    const id = scriptId ?? nextProjectScriptId(input.name, existingIds);
    const next = buildProjectScript(id, input);
    return persist(
      (current) => {
        const updated = current.map((script) =>
          script.id === id ? next : releaseClaimedRoles(script, input),
        );
        return scriptId === null ? [...updated, next] : updated;
      },
      id,
      input.keybinding,
    );
  }

  return { saving, persist, submit };
}
