import {
  CommandId,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  sessionGrantsScope,
  ThreadId,
  type OrchestrationV2DispatchCommandResult,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { managedRelaySessionAtom } from "../relay/managedRelayState.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { isOptimisticCommandOutcomeUnknown } from "./optimisticCommandFailure.ts";
import {
  createOptimisticLedger,
  type OptimisticScope,
  type OptimisticStatus,
} from "./optimisticLedger.ts";
import type { AtomCommand, AtomCommandResult } from "./runtime.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

type Receipt = OrchestrationV2DispatchCommandResult;
type PreflightError = EnvironmentAuthorizationError | EnvironmentRpcUnavailableError;
type ThreadSource = {
  readonly sequence: number | null;
  readonly thread: OrchestrationV2ThreadShell | null;
  readonly sharedSequence: boolean;
};

// An intent needs its ID before the async command lane can allocate one.
let operationOrdinal = 0;
const allocateCommandId = (now: DateTime.Utc) =>
  CommandId.make(
    `client:${DateTime.toEpochMillis(now).toString(36)}:${++operationOrdinal}:${Effect.runSync(Random.nextInt).toString(36)}`,
  );

export function createOptimisticThreadLifecycle<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  sourceSnapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationV2ShellSnapshot | null>,
) {
  const sessions = createEnvironmentSessionAtoms(runtime);
  const options = {
    permissions: createCommandPermissions(runtime, ORCHESTRATION_V2_WS_METHODS.dispatchCommand),
    configAtom: sessions.initialConfigValueAtom,
    sessionAtom: sessions.sessionStateValueAtom,
  };
  const accountId = (session: { readonly accountId: string } | null) =>
    JSON.stringify([session?.accountId ?? null]);
  const scope = (
    account: string,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ): OptimisticScope => ({
    accountId: account,
    environmentId,
    resourceId: threadId,
  });
  const threadsById = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) =>
        new Map(
          get(sourceSnapshotAtom(environmentId))?.threads.map((thread) => [thread.id, thread]) ??
            [],
        ),
    ),
  );
  const sources = Atom.family((environmentId: EnvironmentId) =>
    Atom.family((threadId: ThreadId) =>
      Atom.make((get): ThreadSource => {
        const snapshot = get(sourceSnapshotAtom(environmentId));
        const config = get(options.configAtom(environmentId));
        return {
          sequence: snapshot?.snapshotSequence ?? null,
          thread: get(threadsById(environmentId)).get(threadId) ?? null,
          // Cloud's thread receipts and user index have independent counters.
          sharedSequence:
            config !== null && config.environment.capabilities.signalboxCloud !== true,
        };
      }),
    ),
  );
  const ledger = createOptimisticLedger<ThreadSource, Receipt, Cause.Cause<unknown>>({
    sourceAtom: (key) =>
      sources(EnvironmentId.make(key.environmentId))(ThreadId.make(key.resourceId)),
  });
  const entries = Atom.family((environmentId: EnvironmentId) =>
    Atom.family((threadId: ThreadId) =>
      Atom.family((status: OptimisticStatus | undefined) =>
        Atom.make((get) =>
          get(
            ledger.entriesAtom(
              scope(accountId(get(managedRelaySessionAtom)), environmentId, threadId),
              status,
            ),
          ),
        ),
      ),
    ),
  );
  const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const snapshot = get(sourceSnapshotAtom(environmentId));
      if (snapshot === null) return null;
      const account = accountId(get(managedRelaySessionAtom));
      let changed = false;
      const threads = snapshot.threads.map((thread) => {
        const projected = get(ledger.snapshotAtom(scope(account, environmentId, thread.id))).thread;
        if (projected === null || projected === thread) return thread;
        changed = true;
        return projected;
      });
      return changed ? { ...snapshot, threads } : snapshot;
    }),
  );
  const lifetimes = new WeakMap<AtomRegistry.AtomRegistry, Map<string, () => void>>();
  function observeAccount(registry: AtomRegistry.AtomRegistry, key: OptimisticScope) {
    let active = lifetimes.get(registry);
    if (active === undefined) {
      active = new Map();
      lifetimes.set(registry, active);
    }
    const id = JSON.stringify([key.accountId, key.environmentId, key.resourceId]);
    if (active.has(id)) return;
    const unsubscribeAccount = registry.subscribe(managedRelaySessionAtom, (session) => {
      if (accountId(session) !== key.accountId) ledger.clear(registry, key);
    });
    const unsubscribeEntries = registry.subscribe(ledger.entriesAtom(key), (current) => {
      if (current.some((entry) => entry.status !== "rejected")) return;
      active.get(id)?.();
      active.delete(id);
    });
    active.set(id, () => {
      unsubscribeAccount();
      unsubscribeEntries();
    });
  }

  function wrap<
    Input extends { readonly threadId: ThreadId; readonly commandId?: CommandId },
    E,
    Properties extends object,
  >(
    command: AtomCommand<
      {
        readonly environmentId: EnvironmentId;
        readonly input: Input;
      },
      Receipt,
      E
    > &
      Properties,
    apply: (
      thread: OrchestrationV2ThreadShell,
      input: Input,
      now: DateTime.Utc,
      accepted: boolean,
    ) => OrchestrationV2ThreadShell,
    capability?: "threadPinning" | "threadPinReorder",
  ) {
    return {
      ...command,
      requiredScopes: options.permissions.requiredScopes,
      permissionAtom: options.permissions.permissionAtom,
      run: async (
        registry: AtomRegistry.AtomRegistry,
        target: { readonly environmentId: EnvironmentId; readonly input: Input },
      ): Promise<AtomCommandResult<Receipt, E | PreflightError>> => {
        const session = registry.get(options.sessionAtom(target.environmentId));
        const missingScope =
          session === null
            ? undefined
            : options.permissions
                .requiredScopes(target.input)
                .find((required) => !sessionGrantsScope(session, required));
        if (missingScope !== undefined) {
          return AsyncResult.failure(
            Cause.fail(
              new EnvironmentAuthorizationError({
                requiredScope: missingScope,
                message: "This connection cannot change threads.",
              }),
            ),
          );
        }
        const config = registry.get(options.configAtom(target.environmentId));
        if (
          capability !== undefined &&
          config !== null &&
          config.environment.capabilities[capability] !== true
        ) {
          return AsyncResult.failure(
            Cause.fail(
              new EnvironmentRpcUnavailableError({
                environmentId: target.environmentId,
                message:
                  capability === "threadPinReorder"
                    ? "This environment does not support reordering pinned threads."
                    : "This environment does not support pinning threads.",
              }),
            ),
          );
        }
        const now = DateTime.nowUnsafe();
        const input = {
          ...target.input,
          commandId: target.input.commandId ?? allocateCommandId(now),
        };
        const key = {
          ...scope(
            accountId(registry.get(managedRelaySessionAtom)),
            target.environmentId,
            input.threadId,
          ),
          commandId: input.commandId,
        };
        let accepted = false;
        const intent = ledger.begin(registry, {
          key,
          actionId: command.label,
          startedAt: DateTime.toEpochMillis(now),
          project: (source) =>
            source.thread === null
              ? source
              : {
                  ...source,
                  thread: apply(source.thread, input, now, accepted),
                },
          confirm: (source, acknowledgment) =>
            acknowledgment.status === "acknowledged" &&
            (acknowledgment.receipt.summaryRevision !== undefined
              ? source.thread?.summaryRevision !== undefined &&
                source.thread.summaryRevision >= acknowledgment.receipt.summaryRevision
              : source.sharedSequence &&
                source.sequence !== null &&
                source.sequence >= acknowledgment.receipt.sequence),
        });
        observeAccount(registry, key);
        try {
          const result = await command.run(registry, { ...target, input });
          if (result._tag === "Success") {
            accepted = true;
            intent.acknowledge(result.value);
          } else if (isOptimisticCommandOutcomeUnknown(result.cause)) {
            intent.markUnknown();
          } else {
            intent.reject(result.cause);
          }
          return result;
        } catch (error) {
          intent.markUnknown();
          throw error;
        }
      },
    };
  }

  return {
    snapshotAtom,
    wrap,
    dismissRejection: ledger.dismissRejection,
    entriesAtom: (environmentId: EnvironmentId, threadId: ThreadId, status?: OptimisticStatus) =>
      entries(environmentId)(threadId)(status),
  };
}
