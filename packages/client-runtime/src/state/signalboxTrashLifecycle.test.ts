import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  SIGNALBOX_TRASH_WS_METHODS,
  TrashEntryId,
  type TrashSnapshot,
} from "@t3tools/contracts/signalboxTrash";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { RpcPermissionGuard } from "../rpc/client.ts";
import * as RpcSession from "../rpc/session.ts";
import { createSignalboxTrashAtoms } from "./signalboxTrash.ts";

const ENVIRONMENT_ID = EnvironmentId.make("trash-environment");
const TARGET = new PrimaryConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Trash environment",
  httpBaseUrl: "https://trash.example.test",
  wsBaseUrl: "wss://trash.example.test",
});
const EMPTY_TRASH: TrashSnapshot = { entries: [], purgeEnabled: false };
const FOLDER_MOVED_TO_TRASH_ELSEWHERE: TrashSnapshot = {
  purgeEnabled: false,
  entries: [
    {
      id: TrashEntryId.make("folder-entry"),
      kind: "folder",
      targetId: "folder-1",
      title: "Trash preview check",
      deletedAt: 1,
      purgeAfter: 2,
      status: "trashed",
      threadIds: [ThreadId.make("thread-1")],
      plannedRemovals: [],
      removals: [],
      error: null,
    },
  ],
};

describe("Signalbox Trash atoms", () => {
  it.effect("shows a folder moved to Trash while the list was unmounted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let rpcCalls = 0;
        const serverSnapshot = yield* Ref.make(EMPTY_TRASH);
        const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online" as const,
          phase: "connected" as const,
          attempt: 1,
          generation: 1,
        });
        const client = {
          [SIGNALBOX_TRASH_WS_METHODS.list]: (_input: Record<string, never>) =>
            Ref.get(serverSnapshot).pipe(Effect.tap(() => Effect.sync(() => (rpcCalls += 1)))),
        };
        const session = { client } as unknown as RpcSession.RpcSession;
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: supervisorState,
          session: yield* SubscriptionRef.make(Option.some(session)),
          prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
          _environmentId,
          effect,
        ) =>
          Effect.provideService(
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            RpcPermissionGuard,
            { authorize: () => Effect.void },
          );
        const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
          _environmentId,
          stream,
        ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          run,
          followStream,
          stateChanges: () => SubscriptionRef.changes(supervisorState),
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const runtime = Atom.runtime(
          Layer.mergeAll(
            Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
            Layer.succeed(
              Crypto.Crypto,
              Crypto.make({
                randomBytes: (size) => new Uint8Array(size),
                digest: (_algorithm, data) => Effect.succeed(data),
              }),
            ),
          ),
        );
        const trash = createSignalboxTrashAtoms(runtime);
        const listAtom = trash.list({ environmentId: ENVIRONMENT_ID, input: {} });
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));

        const unmountFirst = registry.mount(listAtom);
        const first = yield* AtomRegistry.getResult(registry, listAtom, {
          suspendOnWaiting: true,
        });
        expect(first.entries).toEqual([]);
        expect(rpcCalls).toBe(1);
        unmountFirst();
        yield* Effect.yieldNow;

        yield* Ref.set(serverSnapshot, FOLDER_MOVED_TO_TRASH_ELSEWHERE);
        const unmountSecond = registry.mount(listAtom);
        const reopened = yield* AtomRegistry.getResult(registry, listAtom, {
          suspendOnWaiting: true,
        });
        yield* Effect.addFinalizer(() => Effect.sync(unmountSecond));

        expect(rpcCalls).toBe(2);
        expect(reopened.entries.map((entry) => entry.title)).toEqual(["Trash preview check"]);
      }),
    ),
  );
});
