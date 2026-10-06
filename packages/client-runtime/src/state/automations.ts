import {
  AUTOMATION_WS_METHODS,
  EnvironmentId,
  type Automation,
  type AutomationNotice,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

const RECENT_NOTICES = 20;

/** One environment's automation list as it stands. */
export interface EnvironmentAutomationList {
  readonly environmentId: EnvironmentId;
  /** Null until it arrives, or when it couldn't load. */
  readonly automations: ReadonlyArray<Automation> | null;
  readonly failure: Cause.Cause<unknown> | null;
  /** No answer yet. */
  readonly loading: boolean;
}

/** The key `lists` and `waitingCount` take: environment ids, sorted, one per line. */
export const environmentListKey = (environmentIds: Iterable<EnvironmentId>) =>
  [...environmentIds].sort().join("\n");

/**
 * Automation state shared by web and mobile. Each client builds it once on its
 * connection runtime: `createAutomationAtoms(connectionAtomRuntime)`.
 */
export function createAutomationAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  /** Whether `w.call` can reach Executor and which accounts it has. Input `{}`. */
  const connectionStatus = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:automations:connection-status",
    tag: AUTOMATION_WS_METHODS.automationsConnectionStatus,
    staleTimeMs: 60_000,
  });
  /** Every automation with its last run, live. Input `{}`. */
  const list = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:automations:list",
    tag: AUTOMATION_WS_METHODS.automationsSubscribe,
  });
  /**
   * Several environments' lists in one atom, so every view of them shares one
   * subscription per environment. An environment whose server has no
   * automations (an older version) never answers and stays loading.
   */
  const lists = Atom.family((key: string) =>
    Atom.make((get): ReadonlyArray<EnvironmentAutomationList> =>
      (key ? key.split("\n") : []).map((id) => {
        const environmentId = EnvironmentId.make(id);
        const result = get(list({ environmentId, input: {} }));
        return {
          environmentId,
          automations: Option.getOrNull(AsyncResult.value(result))?.automations ?? null,
          failure: result._tag === "Failure" ? result.cause : null,
          loading: result._tag === "Initial",
        };
      }),
    ).pipe(Atom.withLabel(`automations:lists:${key}`)),
  );
  const refreshStatus = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() =>
      registry.refresh(connectionStatus({ environmentId: target.environmentId, input: {} })),
    );
  return {
    connectionStatus,
    /** Verifies `{ url, apiKey }` by listing connections, then saves it. */
    connect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automations:connect",
      tag: AUTOMATION_WS_METHODS.automationsConnect,
      onSuccess: refreshStatus,
    }),
    disconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automations:disconnect",
      tag: AUTOMATION_WS_METHODS.automationsDisconnect,
      onSuccess: refreshStatus,
    }),
    list,
    lists,
    /** How many automations wait on an answer across `lists(key)`; a number, so badges only redraw when it changes. */
    waitingCount: Atom.family((key: string) =>
      Atom.make((get) =>
        get(lists(key)).reduce(
          (sum, entry) =>
            sum +
            (entry.automations?.filter((automation) => automation.waiting.length > 0).length ?? 0),
          0,
        ),
      ),
    ),
    /** One automation with its source, graph and recent runs, live. Input `{ automationId }`. */
    detail: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:automations:detail",
      tag: AUTOMATION_WS_METHODS.automationsSubscribeOne,
    }),
    /**
     * The latest notices (questions and `w.notify` messages), newest last, at
     * most 20. A list rather than the latest value, so two arriving together
     * both reach the notifier. Live only: nothing replays on subscribe. Input `{}`.
     */
    notices: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:automations:notices",
      tag: AUTOMATION_WS_METHODS.automationsSubscribeNotices,
      transform: (stream) =>
        stream.pipe(
          Stream.scan(
            (): ReadonlyArray<AutomationNotice> => [],
            (recent, notice) => [...recent, notice].slice(-RECENT_NOTICES),
          ),
        ),
    }),
    /** One run with its graph and steps, live. Input `{ runId }`. */
    run: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:automations:run",
      tag: AUTOMATION_WS_METHODS.automationsSubscribeRun,
    }),
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automations:set-enabled",
      tag: AUTOMATION_WS_METHODS.automationsSetEnabled,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automations:delete",
      tag: AUTOMATION_WS_METHODS.automationsDelete,
    }),
    /** Replaces the webhook token; the old URL stops working. Input `{ automationId }`. */
    rotateWebhook: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automations:rotate-webhook",
      tag: AUTOMATION_WS_METHODS.automationsRotateWebhook,
    }),
    runNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automations:run-now",
      tag: AUTOMATION_WS_METHODS.automationsRunNow,
    }),
    cancelRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automations:cancel-run",
      tag: AUTOMATION_WS_METHODS.automationsCancelRun,
    }),
    /** Retries a failed or cancelled run as a new run. Input `{ runId, version? }`. */
    retryRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automations:retry-run",
      tag: AUTOMATION_WS_METHODS.automationsRetryRun,
    }),
    /** Makes the pending draft live. Input `{ automationId }`. */
    publish: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automations:publish",
      tag: AUTOMATION_WS_METHODS.automationsPublish,
    }),
    /** Drops the pending draft. Input `{ automationId }`. */
    discardDraft: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automations:discard-draft",
      tag: AUTOMATION_WS_METHODS.automationsDiscardDraft,
    }),
    answer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automations:answer",
      tag: AUTOMATION_WS_METHODS.automationsAnswer,
    }),
  };
}

export type AutomationAtoms = ReturnType<typeof createAutomationAtoms>;
