import { describe, expect, it } from "@effect/vitest";
import {
  blockLibraryQueryInput,
  blockLibraryTargets,
  blockLibraryView,
} from "@t3tools/client-runtime/automations/blockLibrary";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  ConnectionBlockedError,
  ConnectionTransientError,
  presentConnectionState,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import { createBlockLibraryQuery } from "@t3tools/client-runtime/state/automations";
import { type AutomationBlockLibraryResult, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { FolderId, type SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

const ENVIRONMENT = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("cloud"),
  label: "Cloud",
  httpBaseUrl: "https://cloud.example.test",
  wsBaseUrl: "wss://cloud.example.test",
});
const PERSONAL = SignalboxContextId.make("personal");
const NORTHWIND = ProjectId.make("drive:northwind");

const connected = (
  overrides: Partial<SupervisorConnectionState> = {},
): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  attempt: 1,
  generation: 1,
  ...overrides,
});

/** The block query on a fake connection that answers `send`. */
const makeBlocks = Effect.fn("TestBlockLibrary.make")(function* (
  send: (input: {
    readonly projectId: ProjectId;
  }) => Effect.Effect<AutomationBlockLibraryResult, string>,
) {
  const state = yield* SubscriptionRef.make(connected());
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: ENVIRONMENT,
    state,
    session: yield* SubscriptionRef.make(Option.some({} as RpcSession)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  type Registry = EnvironmentRegistry.EnvironmentRegistry["Service"];
  const run: Registry["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: Registry["followStream"] = (_environmentId, stream) =>
    Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const registry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream,
    stateChanges: () => SubscriptionRef.changes(state),
  } as unknown as Registry);
  const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry));
  return { blocks: createBlockLibraryQuery(runtime, send), state };
});

const mount = Effect.fn("TestBlockLibrary.mount")(function* <A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) {
  const registry = AtomRegistry.make();
  const unmount = registry.mount(atom);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unmount();
      registry.dispose();
    }),
  );
  return registry;
});

const settle = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) =>
  AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }).pipe(
    Effect.exit,
    Effect.tap(() => Effect.yieldNow),
  );

const ONLINE = presentConnectionState(connected());

/** What both clients' `useEnvironmentQuery` hands the view. */
const asQuery = (result: AsyncResult.AsyncResult<AutomationBlockLibraryResult, unknown>) => ({
  data: Option.getOrNull(AsyncResult.value(result)),
  error: result._tag === "Failure" ? "The environment request failed." : null,
  isPending: result.waiting,
});

const answer = (...names: ReadonlyArray<string>): AutomationBlockLibraryResult => ({
  projectId: NORTHWIND,
  blocks: names.map((name) => ({
    name,
    description: null,
    source: { type: "folder", projectId: NORTHWIND },
    availability: { enabled: true, hasLiveVersion: true, runtimeMode: null },
  })),
});

/** Northwind (files) under Clients under Work (files), or moved under Ops (files). */
const tree = (parentId: string): SignalboxFoldersSnapshot => {
  const folder = (id: string, parent: string | null, files: ProjectId | null) => ({
    id: FolderId.make(id),
    name: id,
    parentId: parent === null ? null : FolderId.make(parent),
    position: 0,
    ownerId: PERSONAL,
    ...(files === null ? {} : { files: { projectId: files } }),
  });
  return {
    revision: 1,
    top: {},
    folders: [
      folder("work", null, ProjectId.make("drive:work")),
      folder("clients", "work", null),
      folder("ops", null, ProjectId.make("drive:ops")),
      folder("northwind", parentId, NORTHWIND),
    ],
    threadHomes: [],
    projectHomes: [],
    pools: { top: null, folders: [] },
  };
};
const contexts = {
  contexts: [{ id: PERSONAL, kind: "personal" as const, name: "Personal", projectIds: [] }],
};
const northwindIn = (parentId: string) =>
  blockLibraryTargets(ENVIRONMENT.environmentId, contexts, tree(parentId)).find(
    (target) => target.projectId === NORTHWIND,
  )!;

describe("block library query", () => {
  it.effect("asks again for a folder moved under other levels, sending only its project", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sent: Array<unknown> = [];
        const answers = [answer("From Work"), answer("From Ops")];
        const { blocks } = yield* makeBlocks((input) => {
          sent.push(input);
          return Effect.succeed(answers[sent.length - 1]!);
        });
        const before = northwindIn("clients");
        const after = northwindIn("ops");
        // Same folder, same project: only the levels above it changed.
        expect(after.key).toBe(before.key);
        expect(after.projectId).toBe(before.projectId);

        const beforeAtom = blocks({
          environmentId: ENVIRONMENT.environmentId,
          input: blockLibraryQueryInput(before),
        });
        const registry = yield* mount(beforeAtom);
        expect(yield* settle(registry, beforeAtom)).toEqual(Exit.succeed(answers[0]));

        // The page stays mounted through the move, in the same registry.
        const afterAtom = blocks({
          environmentId: ENVIRONMENT.environmentId,
          input: blockLibraryQueryInput(after),
        });
        expect(yield* settle(registry, afterAtom)).toEqual(Exit.succeed(answers[1]));
        expect(sent).toEqual([{ projectId: NORTHWIND }, { projectId: NORTHWIND }]);
      }),
    ),
  );

  it.effect("hides blocks it can't confirm and shows them again once a retry succeeds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        // Requests 4 and 5 are held until released, so their in-flight state can be read.
        const held = [4, 5].map(() => ({
          started: Latch.makeUnsafe(),
          release: Latch.makeUnsafe(),
        }));
        const { blocks, state } = yield* makeBlocks(() => {
          calls += 1;
          const reply: Effect.Effect<AutomationBlockLibraryResult, string> =
            calls === 2 || calls === 5
              ? Effect.fail("revoked")
              : Effect.succeed(answer(`Answer ${calls}`));
          const hold = calls === 4 ? held[0] : calls === 5 ? held[1] : undefined;
          return hold === undefined
            ? reply
            : Effect.sync(() => hold.started.openUnsafe()).pipe(
                Effect.andThen(hold.release.await),
                Effect.andThen(reply),
              );
        });
        const atom = blocks({
          environmentId: ENVIRONMENT.environmentId,
          input: blockLibraryQueryInput(northwindIn("clients")),
        });
        const registry = yield* mount(atom);
        yield* settle(registry, atom);
        expect(blockLibraryView(asQuery(registry.get(atom)), ONLINE)).toMatchObject({
          _tag: "Ready",
          blocks: [{ name: "Answer 1" }],
        });

        // The failed refresh keeps the old answer in the query, but not on screen.
        registry.refresh(atom);
        expect(Exit.isFailure(yield* settle(registry, atom))).toBe(true);
        const failed = registry.get(atom);
        expect(Option.getOrNull(AsyncResult.value(failed))?.blocks[0]?.name).toBe("Answer 1");
        expect(blockLibraryView(asQuery(failed), ONLINE)._tag).toBe("Failed");

        registry.refresh(atom);
        yield* settle(registry, atom);
        expect(blockLibraryView(asQuery(registry.get(atom)), ONLINE)).toMatchObject({
          _tag: "Ready",
          blocks: [{ name: "Answer 3" }],
        });

        // Reconnecting also keeps the old answer, which can't be confirmed meanwhile.
        const retrying = connected({
          phase: "backoff",
          stage: null,
          lastFailure: new ConnectionTransientError({ reason: "transport", detail: "Retrying." }),
          retryAt: 1,
        });
        yield* SubscriptionRef.set(state, retrying);
        yield* Effect.yieldNow;
        const reconnecting = registry.get(atom);
        expect(reconnecting).toMatchObject({ _tag: "Success", waiting: true });
        expect(
          blockLibraryView(asQuery(reconnecting), presentConnectionState(retrying)),
        ).toMatchObject({ _tag: "Disconnected", connecting: true });

        // Back online, the old answer still isn't current until the new request settles.
        yield* SubscriptionRef.set(state, connected({ generation: 2 }));
        yield* held[0]!.started.await;
        const asking = registry.get(atom);
        expect(asking).toMatchObject({ _tag: "Success", waiting: true });
        expect(Option.getOrNull(AsyncResult.value(asking))?.blocks[0]?.name).toBe("Answer 3");
        expect(blockLibraryView(asQuery(asking), ONLINE)._tag).toBe("Loading");
        held[0]!.release.openUnsafe();
        yield* settle(registry, atom);
        expect(blockLibraryView(asQuery(registry.get(atom)), ONLINE)).toMatchObject({
          _tag: "Ready",
          blocks: [{ name: "Answer 4" }],
        });

        // And when that request fails, the kept answer stays hidden behind the error.
        yield* SubscriptionRef.set(state, retrying);
        yield* Effect.yieldNow;
        yield* SubscriptionRef.set(state, connected({ generation: 3 }));
        yield* held[1]!.started.await;
        expect(blockLibraryView(asQuery(registry.get(atom)), ONLINE)._tag).toBe("Loading");
        held[1]!.release.openUnsafe();
        expect(Exit.isFailure(yield* settle(registry, atom))).toBe(true);
        expect(blockLibraryView(asQuery(registry.get(atom)), ONLINE)._tag).toBe("Failed");
      }),
    ),
  );

  it("only says it's connecting while a connection attempt is under way", () => {
    const kept = { data: answer("Kept"), error: null, isPending: false };
    const view = (state: SupervisorConnectionState) =>
      blockLibraryView(kept, presentConnectionState(state));
    expect(view(connected({ phase: "connecting", stage: "opening" }))).toEqual({
      _tag: "Disconnected",
      status: "Connecting...",
      connecting: true,
    });
    // Nothing is retrying in these, so nothing spins and the status stays put.
    expect(view(connected({ phase: "offline" }))).toEqual({
      _tag: "Disconnected",
      status: "Offline",
      connecting: false,
    });
    expect(view({ ...AVAILABLE_CONNECTION_STATE })).toEqual({
      _tag: "Disconnected",
      status: "Not connected",
      connecting: false,
    });
    expect(
      view(
        connected({
          phase: "blocked",
          lastFailure: new ConnectionBlockedError({ reason: "unsupported", detail: "Too old." }),
        }),
      ),
    ).toMatchObject({ status: "Client not supported", connecting: false });
    expect(
      view(
        connected({
          phase: "blocked",
          lastFailure: new ConnectionBlockedError({ reason: "permission", detail: "Denied." }),
        }),
      ),
    ).toMatchObject({ connecting: false });
    expect(blockLibraryView(kept, null)).toMatchObject({
      status: "Not connected",
      connecting: false,
    });
  });
});
