import { EnvironmentId, ProjectId, WS_METHODS, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createEnvironmentSectionAtoms } from "./sections.ts";
import type { SectionsSnapshot } from "@t3tools/contracts/sections";

const ENVIRONMENT_A = EnvironmentId.make("sections-a");
const ENVIRONMENT_B = EnvironmentId.make("sections-b");

interface TestSubscription {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
  readonly events: Queue.Queue<SectionsSnapshot>;
  readonly closed: Deferred.Deferred<void>;
}

const configWithSections = {
  environment: { capabilities: { sections: true } },
} as unknown as ServerConfig;
const oldServerConfig = {
  environment: { capabilities: {} },
} as unknown as ServerConfig;

function sectionSnapshot(revision: number, sectionId: string): SectionsSnapshot {
  return {
    revision,
    sections: [{ id: sectionId, name: sectionId, parentId: null, position: 0 }],
    projectPlacements: [],
  };
}

const awaitSnapshot = (
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<SectionsSnapshot | null>,
  revision: number,
) =>
  AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter((snapshot) => snapshot !== null && snapshot.revision === revision),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const makeHarness = Effect.fn("TestSectionsAtoms.makeHarness")(function* (options: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly supportsSections: boolean;
    readonly projects: ReadonlyArray<{ readonly id: ProjectId }>;
  }>;
  readonly subscriptionFailure?: Error;
}) {
  let subscriptionFailureUsed = false;
  const subscriptions = yield* Queue.unbounded<TestSubscription>();
  const supervisors = new Map<
    EnvironmentId,
    {
      readonly supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"];
      readonly session: SubscriptionRef.SubscriptionRef<Option.Option<RpcSession>>;
    }
  >();
  let opened = 0;
  let active = 0;

  const makeSession = (environmentId: EnvironmentId, sessionId: string): RpcSession => {
    const client = {
      [WS_METHODS.sectionsSubscribe]: () => {
        if (options.subscriptionFailure !== undefined && !subscriptionFailureUsed) {
          subscriptionFailureUsed = true;
          return Stream.fail(options.subscriptionFailure);
        }
        return Stream.unwrap(
          Effect.gen(function* () {
            const events = yield* Queue.unbounded<SectionsSnapshot>();
            const closed = yield* Deferred.make<void>();
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                opened += 1;
                active += 1;
              }),
              () =>
                Effect.sync(() => {
                  active -= 1;
                }).pipe(Effect.andThen(Deferred.succeed(closed, undefined))),
            );
            yield* Queue.offer(subscriptions, { environmentId, sessionId, events, closed });
            return Stream.fromQueue(events);
          }),
        );
      },
    } as unknown as WsRpcProtocolClient;
    return {
      client,
      initialConfig: Effect.succeed(oldServerConfig),
      subscribeServerConfig: (input) => client.subscribeServerConfig(input),
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
    };
  };

  for (const environment of options.environments) {
    const target = new PrimaryConnectionTarget({
      environmentId: environment.environmentId,
      label: environment.environmentId,
      httpBaseUrl: `https://${environment.environmentId}.example.test`,
      wsBaseUrl: `wss://${environment.environmentId}.example.test`,
    });
    const initialSession = makeSession(environment.environmentId, "initial");
    const session = yield* SubscriptionRef.make(Option.some(initialSession));
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target,
      state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
      session,
      prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    supervisors.set(environment.environmentId, { supervisor, session });
  }

  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (environmentId, effect) =>
    Effect.provideService(
      effect,
      EnvironmentSupervisor.EnvironmentSupervisor,
      supervisors.get(environmentId)!.supervisor,
    );
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    environmentId,
    stream,
  ) =>
    Stream.provideService(
      stream,
      EnvironmentSupervisor.EnvironmentSupervisor,
      supervisors.get(environmentId)!.supervisor,
    );
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
  );
  const configAtoms = Atom.family((environmentId: EnvironmentId) =>
    Atom.make<ServerConfig | null>(
      options.environments.find((environment) => environment.environmentId === environmentId)
        ?.supportsSections
        ? configWithSections
        : oldServerConfig,
    ),
  );
  const projectAtoms = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      options.environments.find((environment) => environment.environmentId === environmentId)
        ?.projects ?? [],
    ),
  );
  const sections = createEnvironmentSectionAtoms(runtime, {
    serverConfigValueAtom: configAtoms,
    projectsAtom: projectAtoms,
  });
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));

  return {
    registry,
    sections,
    projectAtoms,
    subscriptions,
    supervisors,
    opened: () => opened,
    active: () => active,
    makeSession,
  };
});

describe("environment section subscriptions", () => {
  it.effect("skips the RPC on older servers and leaves existing projects at root", () =>
    Effect.gen(function* () {
      const project = { id: ProjectId.make("existing-project") };
      const harness = yield* makeHarness({
        environments: [
          { environmentId: ENVIRONMENT_B, supportsSections: false, projects: [project] },
        ],
      });

      expect(harness.registry.get(harness.sections.snapshotAtom(ENVIRONMENT_B))).toBeNull();
      expect(harness.registry.get(harness.sections.stateAtom(ENVIRONMENT_B))).toEqual({
        _tag: "Unsupported",
      });
      expect(harness.registry.get(harness.sections.treeAtom(ENVIRONMENT_B))).toEqual({
        roots: [],
        rootProjects: [],
        unplacedProjects: [project],
      });
      expect(harness.opened()).toBe(0);
    }),
  );

  it.effect("surfaces a failed subscription and retries it on request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        environments: [{ environmentId: ENVIRONMENT_A, supportsSections: true, projects: [] }],
        subscriptionFailure: new Error("sections unavailable"),
      });
      const stateAtom = harness.sections.stateAtom(ENVIRONMENT_A);
      const unmount = harness.registry.mount(stateAtom);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));

      const state = yield* AtomRegistry.toStream(harness.registry, stateAtom).pipe(
        Stream.filter((value) => value._tag === "Failure"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );

      expect(state).toEqual({ _tag: "Failure", error: "sections unavailable" });
      expect(harness.registry.get(harness.sections.snapshotAtom(ENVIRONMENT_A))).toBeNull();

      const retry = harness.sections.retry;
      const unmountRetry = harness.registry.mount(retry);
      yield* Effect.addFinalizer(() => Effect.sync(unmountRetry));
      harness.registry.set(retry, ENVIRONMENT_A);
      yield* AtomRegistry.getResult(harness.registry, retry, { suspendOnWaiting: true });

      const subscription = yield* Queue.take(harness.subscriptions);
      yield* Queue.offer(subscription.events, sectionSnapshot(1, "after-retry"));
      yield* awaitSnapshot(harness.registry, harness.sections.snapshotAtom(ENVIRONMENT_A), 1);
      expect(harness.registry.get(stateAtom)).toEqual({ _tag: "Ready" });
    }),
  );

  it.effect(
    "keeps environments independent, resumes on reconnect, and tears subscriptions down",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          environments: [
            { environmentId: ENVIRONMENT_A, supportsSections: true, projects: [] },
            { environmentId: ENVIRONMENT_B, supportsSections: true, projects: [] },
          ],
        });
        const snapshotA = harness.sections.snapshotAtom(ENVIRONMENT_A);
        const snapshotB = harness.sections.snapshotAtom(ENVIRONMENT_B);
        const unmountA = harness.registry.mount(snapshotA);
        const unmountB = harness.registry.mount(snapshotB);
        const waitForA1 = awaitSnapshot(harness.registry, snapshotA, 7);
        const waitForB1 = awaitSnapshot(harness.registry, snapshotB, 3);
        const initialSubscriptions = [
          yield* Queue.take(harness.subscriptions),
          yield* Queue.take(harness.subscriptions),
        ];
        const firstA = initialSubscriptions.find((item) => item.environmentId === ENVIRONMENT_A)!;
        const firstB = initialSubscriptions.find((item) => item.environmentId === ENVIRONMENT_B)!;

        yield* Queue.offer(firstA.events, sectionSnapshot(7, "a-v1"));
        yield* Queue.offer(firstB.events, sectionSnapshot(3, "b-v1"));
        expect(yield* waitForA1).toMatchObject({ revision: 7, sections: [{ id: "a-v1" }] });
        expect(yield* waitForB1).toMatchObject({ revision: 3, sections: [{ id: "b-v1" }] });

        const reconnectSession = harness.makeSession(ENVIRONMENT_A, "reconnected");
        yield* SubscriptionRef.set(
          harness.supervisors.get(ENVIRONMENT_A)!.session,
          Option.some(reconnectSession),
        );
        yield* Deferred.await(firstA.closed);
        const reconnected = yield* Queue.take(harness.subscriptions);
        expect(reconnected).toMatchObject({
          environmentId: ENVIRONMENT_A,
          sessionId: "reconnected",
        });
        const waitForA2 = awaitSnapshot(harness.registry, snapshotA, 1);
        yield* Queue.offer(reconnected.events, sectionSnapshot(1, "a-v2"));
        expect(yield* waitForA2).toMatchObject({ revision: 1, sections: [{ id: "a-v2" }] });
        expect(harness.registry.get(snapshotB)).toMatchObject({
          revision: 3,
          sections: [{ id: "b-v1" }],
        });

        unmountA();
        unmountB();
        yield* Deferred.await(reconnected.closed);
        yield* Deferred.await(firstB.closed);
        expect(harness.active()).toBe(0);
        expect(harness.opened()).toBe(3);
      }),
  );
});
