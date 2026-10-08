import {
  type ModelGatewayProvider,
  RUNNER_PROTOCOL_VERSION,
  type RunnerHello,
  type RunnerItem,
  type RunnerRefusal,
  type RunnerTurn,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { OrchestrationV2ThreadProjection, RunId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { gatewayProviderFor } from "../providerCatalog.ts";
import * as ThreadEngine from "../ThreadEngine.ts";
import * as ThreadStore from "../ThreadStore.ts";
import { MachineBackend } from "./MachineBackend.ts";
import { isModelToken, type ModelGrant, modelToken } from "./modelToken.ts";
import {
  failRunEvents,
  harnessRun,
  runnerBatchEvents,
  runnerTurnFor,
  unknownFailure,
} from "./runnerTurn.ts";

/**
 * A thread's side of its Runner: the machine lease, the `hello` handshake
 * and the batches the Runner streams. Everything runs under the thread's
 * lock through `ThreadEngine.apply`, so a batch's events and its
 * acknowledgement commit together: a resent batch is recognized by its
 * sequence and changes nothing.
 *
 * The lease moves toward what the thread needs whenever the object asks
 * (`reconcile`): a live run on Claude or Codex gets a machine at the next
 * generation, a run whose machine never connects (within the backend's
 * connect timeout) or is lost fails with a reason, and an idle machine is
 * released after its tail. Whenever no lease stands, the plan says to stop
 * the machine; the next run starts it again at a new generation.
 *
 * An open preview (`PreviewHold`) keeps a connected machine up as a live run
 * does, and the idle tail counts from the later of the last run and the last
 * preview traffic. Previews never start a machine.
 *
 * The thread also answers the ModelGateway: a model token is good while the
 * run it was minted for is live on the machine holding the lease.
 */

/** How long a Runner whose socket dropped mid-turn has to come back. */
const RECONNECT_TIMEOUT_MS = 60_000;
/** How long an idle machine stays up for the next message (#110: 10 minutes, heavy class). */
export const IDLE_TAIL_MS = 10 * 60_000;
/** Retry interval for a backend that has not confirmed a request. */
const ENSURE_RETRY_MS = 5_000;

export type HelloResult =
  | {
      readonly _tag: "welcome";
      readonly generation: number;
      /** Names this connection, so the close of one it replaced cannot mark it gone. */
      readonly connection: number;
      readonly ackedSequence: number;
      readonly activeRunId: RunId | null;
    }
  | { readonly _tag: "refused"; readonly reason: RunnerRefusal; readonly message: string };

export type BatchResult =
  | { readonly _tag: "ack"; readonly sequence: number }
  /** The socket's generation no longer holds the lease. */
  | { readonly _tag: "stale" }
  /** A gap: the Runner must reconnect and resend after `ackedSequence`. */
  | { readonly _tag: "out_of_order"; readonly ackedSequence: number };

/**
 * The thread's previews as the lease sees them (see `preview/PreviewGateway.ts`).
 * Open preview sockets survive hibernation; the last traffic time is in memory,
 * so after an eviction the tail counts from the last run, a little early at
 * worst.
 */
export const PreviewHold = Context.Reference<{
  /** Whether a preview is open on the leased machine right now. */
  readonly held: Effect.Effect<boolean>;
  /** When preview traffic last passed, if any did. */
  readonly lastActiveAt: Effect.Effect<number | null>;
}>("@signalbox/cloud/thread/runner/ThreadRunner/PreviewHold", {
  defaultValue: () => ({ held: Effect.succeed(false), lastActiveAt: Effect.succeed(null) }),
});

export type ModelAuthorization =
  | { readonly _tag: "granted"; readonly runId: RunId }
  | { readonly _tag: "denied"; readonly reason: string };

/** What the object must do for the lease, and when to look again. */
export interface MachinePlan {
  /** Ask the backend for this machine. Idempotent per generation. */
  readonly ensure: { readonly generation: number; readonly token: string } | null;
  /** End any Runner of this generation: its lease is gone. */
  readonly release: number | null;
  /** No lease stands: the machine should be stopped. */
  readonly stop: boolean;
  /** A connected machine is running a turn: keep its TTL pushed out. */
  readonly busy: boolean;
  readonly wakeAt: number | null;
}

/** What the connected Runner should be doing right now. */
export interface RunnerWork {
  readonly generation: number;
  /** Whether `reconcile` has something to do now: ask, retry, time out or start the idle tail. */
  readonly needsUpkeep: boolean;
  /** The turn to start, while its run waits for the Runner. */
  readonly turn: RunnerTurn | null;
  /** `turn`'s credential at the ModelGateway. */
  readonly modelToken: string | null;
  readonly activeRunId: RunId | null;
}

export class ThreadRunner extends Context.Service<
  ThreadRunner,
  {
    readonly hello: (hello: RunnerHello) => Effect.Effect<HelloResult>;
    readonly batch: (input: {
      readonly generation: number;
      readonly sequence: number;
      readonly items: ReadonlyArray<RunnerItem>;
    }) => Effect.Effect<BatchResult>;
    /** The Runner said `end`: its machine is going away, and with it any turn it ran. */
    readonly ended: (generation: number) => Effect.Effect<void>;
    readonly disconnected: (input: {
      readonly generation: number;
      readonly connection: number;
    }) => Effect.Effect<void>;
    /** The backend confirmed a request. */
    readonly ensured: (generation: number) => Effect.Effect<void>;
    readonly work: Effect.Effect<RunnerWork>;
    readonly reconcile: Effect.Effect<MachinePlan>;
    /** Whether the ModelGateway may serve `token` for `provider` right now. */
    readonly authorizeModel: (
      token: string,
      provider: ModelGatewayProvider,
    ) => Effect.Effect<ModelAuthorization>;
    /**
     * The lease token, when `generation` holds the lease and `token` is its
     * token (a preview tunnel's hello), or when only `generation` is given.
     * Null otherwise. Reads committed state without the thread's lock.
     */
    readonly leaseToken: (generation: number, token?: string) => Effect.Effect<string | null>;
  }
>()("@signalbox/cloud/thread/runner/ThreadRunner") {}

const IDLE: MachinePlan = { ensure: null, release: null, stop: false, busy: false, wakeAt: null };
const BUSY: MachinePlan = { ...IDLE, busy: true };
const UNNEEDED: MachinePlan = { ...IDLE, stop: true };

/** What the live harness run's model token is for, if a run is live. */
const modelGrantFor = (projection: OrchestrationV2ThreadProjection): ModelGrant | undefined => {
  const run = harnessRun(projection);
  const provider = run === undefined ? undefined : gatewayProviderFor(run.providerInstanceId);
  return run === undefined || provider === undefined
    ? undefined
    : { threadId: projection.thread.id, runId: run.id, provider };
};

/**
 * Mirrors `reconcile`: true exactly when it would act or needs to schedule a
 * check. `live`: a harness run is live; `previewHeld`: a preview is open.
 */
const needsUpkeep = (lease: ThreadStore.MachineLease, live: boolean, previewHeld: boolean) => {
  const held = live || previewHeld;
  switch (lease.status) {
    case "none":
      return live;
    case "requested":
      return true;
    case "connected":
      return (
        lease.disconnectedAt !== null ||
        (held ? lease.idleSince !== null : lease.idleSince === null)
      );
  }
};

const make = Effect.gen(function* () {
  const engine = yield* ThreadEngine.ThreadEngine;
  const previews = yield* PreviewHold;
  const store = yield* ThreadStore.ThreadStore;
  const crypto = yield* Crypto.Crypto;
  const { connectTimeoutMs } = yield* MachineBackend;

  const lease = Effect.orDie(store.machine);
  const newToken = Effect.orDie(
    Effect.map(Effect.all([crypto.randomUUIDv4, crypto.randomUUIDv4]), (parts) =>
      parts.join("").replaceAll("-", ""),
    ),
  );

  /** Decides against the projection and lease, then commits events and the new lease together. */
  const withLease = <A>(
    decide: (
      input: {
        readonly projection: Parameters<Parameters<typeof engine.apply>[0]>[0];
        readonly lease: ThreadStore.MachineLease;
        readonly now: number;
      },
      ctx: Parameters<Parameters<typeof engine.apply>[0]>[1],
    ) => Effect.Effect<ThreadEngine.EngineDecision<A>>,
  ) =>
    engine.apply((projection, ctx) =>
      Effect.gen(function* () {
        // A thread that does not exist yet has no tables to read a lease from.
        const current = projection === null ? ThreadStore.NO_MACHINE : yield* lease;
        return yield* decide(
          { projection, lease: current, now: yield* Clock.currentTimeMillis },
          ctx,
        );
      }),
    );

  const keep = <A>(result: A): ThreadEngine.EngineDecision<A> => ({ events: [], result });

  const hello: ThreadRunner["Service"]["hello"] = (hello) =>
    withLease(({ projection, lease, now }) => {
      const refuse = (reason: RunnerRefusal, message: string) =>
        Effect.succeed(keep<HelloResult>({ _tag: "refused", reason, message }));
      if (projection === null || projection.thread.id !== hello.threadId) {
        return refuse("unknown_thread", "This thread does not exist.");
      }
      if (hello.protocolVersion !== RUNNER_PROTOCOL_VERSION) {
        return refuse(
          "protocol_version",
          `This thread speaks Runner protocol ${RUNNER_PROTOCOL_VERSION}.`,
        );
      }
      if (hello.generation > lease.generation) {
        return refuse("unknown_generation", "This thread never asked for that machine.");
      }
      if (hello.generation < lease.generation || lease.status === "none") {
        return refuse("stale_generation", "A newer machine replaced this one.");
      }
      if (hello.token !== lease.token) return refuse("bad_token", "Wrong machine token.");
      const connection = (lease.connection ?? 0) + 1;
      return Effect.succeed({
        events: [],
        machine: {
          ...lease,
          status: "connected",
          connection,
          ensuredAt: lease.ensuredAt ?? now,
          disconnectedAt: null,
        },
        result: {
          _tag: "welcome",
          generation: lease.generation,
          connection,
          ackedSequence: lease.ackedSequence,
          activeRunId: harnessRun(projection)?.id ?? null,
        },
      });
    });

  const batch: ThreadRunner["Service"]["batch"] = (input) =>
    withLease(({ projection, lease }, ctx) => {
      if (
        projection === null ||
        lease.status !== "connected" ||
        input.generation !== lease.generation
      ) {
        return Effect.succeed(keep<BatchResult>({ _tag: "stale" }));
      }
      if (input.sequence <= lease.ackedSequence) {
        return Effect.succeed(keep<BatchResult>({ _tag: "ack", sequence: input.sequence }));
      }
      if (input.sequence !== lease.ackedSequence + 1) {
        return Effect.succeed(
          keep<BatchResult>({ _tag: "out_of_order", ackedSequence: lease.ackedSequence }),
        );
      }
      const { events, undecodable } = runnerBatchEvents(projection, input.items, ctx);
      return Effect.as(
        undecodable.length === 0
          ? Effect.void
          : Effect.logWarning("dropped Runner events this build cannot read", { undecodable }),
        {
          events,
          machine: { ...lease, ackedSequence: input.sequence },
          result: { _tag: "ack", sequence: input.sequence } as const,
        },
      );
    });

  /** Updates the lease when it is still at `generation`. */
  const updateLease = (
    generation: number,
    update: (lease: ThreadStore.MachineLease, now: number) => ThreadStore.MachineLease | null,
  ) =>
    withLease(({ lease, now }) => {
      const next = lease.generation === generation ? update(lease, now) : null;
      return Effect.succeed(
        next === null ? keep(undefined) : { events: [], machine: next, result: undefined },
      );
    });

  const released = (lease: ThreadStore.MachineLease): ThreadStore.MachineLease => ({
    ...ThreadStore.NO_MACHINE,
    generation: lease.generation,
  });

  const ended: ThreadRunner["Service"]["ended"] = (generation) =>
    withLease(({ projection, lease }, ctx) => {
      if (lease.generation !== generation || lease.status === "none") {
        return Effect.succeed(keep(undefined));
      }
      const run = projection === null ? undefined : harnessRun(projection);
      return Effect.succeed({
        events:
          projection === null || run === undefined
            ? []
            : failRunEvents(
                projection,
                run,
                unknownFailure("The machine running this turn went away."),
                ctx,
              ),
        machine: released(lease),
        result: undefined,
      });
    });

  const disconnected: ThreadRunner["Service"]["disconnected"] = ({ generation, connection }) =>
    updateLease(generation, (lease, now) =>
      lease.status === "connected" && (lease.connection ?? 0) === connection
        ? { ...lease, disconnectedAt: now }
        : null,
    );

  const ensured: ThreadRunner["Service"]["ensured"] = (generation) =>
    updateLease(generation, (lease, now) =>
      lease.status === "none" || lease.ensuredAt !== null ? null : { ...lease, ensuredAt: now },
    );

  const work: ThreadRunner["Service"]["work"] = withLease(({ projection, lease }) =>
    Effect.gen(function* () {
      const turn = projection === null ? null : runnerTurnFor(projection);
      const grant = projection === null ? undefined : modelGrantFor(projection);
      const live = projection !== null && harnessRun(projection) !== undefined;
      return keep<RunnerWork>({
        generation: lease.generation,
        needsUpkeep: needsUpkeep(lease, live, yield* previews.held),
        turn,
        modelToken:
          turn === null || grant === undefined || lease.token === null
            ? null
            : yield* modelToken(lease.token, grant),
        activeRunId: projection === null ? null : (harnessRun(projection)?.id ?? null),
      });
    }),
  );

  // Reads committed state without the thread's lock: model requests arrive all
  // through a turn and must not queue behind the Runner's batch commits.
  const authorizeModel: ThreadRunner["Service"]["authorizeModel"] = (token, provider) =>
    Effect.gen(function* () {
      const deny = (reason: string): ModelAuthorization => ({ _tag: "denied", reason });
      const projection = yield* engine.projection;
      const grant = projection === null ? undefined : modelGrantFor(projection);
      // A thread that does not exist yet has no tables to read a lease from.
      const leaseToken = grant === undefined ? null : (yield* lease).token;
      if (grant === undefined || leaseToken === null) {
        return deny("No turn is running on this thread.");
      }
      if (grant.provider !== provider) return deny(`The running turn does not use ${provider}.`);
      return (yield* isModelToken(token, leaseToken, grant))
        ? ({ _tag: "granted", runId: grant.runId } satisfies ModelAuthorization)
        : deny("This token is not for the running turn.");
    });

  const reconcile: ThreadRunner["Service"]["reconcile"] = withLease(
    ({ projection, lease, now }, ctx) =>
      Effect.gen(function* () {
        const run = projection === null ? undefined : harnessRun(projection);
        const release = (reason: string | null): ThreadEngine.EngineDecision<MachinePlan> => ({
          events:
            projection === null || run === undefined || reason === null
              ? []
              : failRunEvents(projection, run, unknownFailure(reason), ctx),
          machine: released(lease),
          result: { ...UNNEEDED, release: lease.generation },
        });
        if (lease.status === "none") {
          if (run === undefined) return keep(UNNEEDED);
          const generation = lease.generation + 1;
          const token = yield* newToken;
          return {
            events: [],
            machine: {
              ...ThreadStore.NO_MACHINE,
              generation,
              token,
              status: "requested",
              requestedAt: now,
            },
            result: {
              ensure: { generation, token },
              release: null,
              stop: false,
              busy: false,
              wakeAt: now + ENSURE_RETRY_MS,
            },
          };
        }
        if (lease.status === "requested") {
          // Nothing needs it any more (the run was stopped before a Runner came).
          if (run === undefined) return release(null);
          const deadline = (lease.requestedAt ?? now) + connectTimeoutMs;
          if (now >= deadline) return release("No machine came up to run this turn.");
          const token = lease.ensuredAt === null ? lease.token : null;
          return keep<MachinePlan>({
            ensure: token === null ? null : { generation: lease.generation, token },
            release: null,
            stop: false,
            busy: false,
            wakeAt: token === null ? deadline : Math.min(deadline, now + ENSURE_RETRY_MS),
          });
        }
        if (lease.disconnectedAt !== null) {
          const deadline = lease.disconnectedAt + RECONNECT_TIMEOUT_MS;
          if (now < deadline) return keep({ ...IDLE, wakeAt: deadline });
          return release(run === undefined ? null : "Lost the machine running this turn.");
        }
        if (run !== undefined || (yield* previews.held)) {
          return lease.idleSince === null
            ? keep(BUSY)
            : { events: [], machine: { ...lease, idleSince: null }, result: BUSY };
        }
        const idleSince = lease.idleSince ?? now;
        const tailFrom = Math.max(idleSince, (yield* previews.lastActiveAt) ?? 0);
        if (now - tailFrom >= IDLE_TAIL_MS) return release(null);
        return {
          events: [],
          ...(lease.idleSince === null ? { machine: { ...lease, idleSince } } : {}),
          result: { ...IDLE, wakeAt: tailFrom + IDLE_TAIL_MS },
        };
      }),
  );

  const leaseToken: ThreadRunner["Service"]["leaseToken"] = (generation, token) =>
    Effect.gen(function* () {
      // A thread that does not exist yet has no tables to read a lease from.
      if ((yield* engine.projection) === null) return null;
      const current = yield* lease;
      if (current.status === "none" || current.generation !== generation) return null;
      if (current.token === null || (token !== undefined && token !== current.token)) return null;
      return current.token;
    });

  return ThreadRunner.of({
    leaseToken,
    hello,
    batch,
    ended,
    disconnected,
    ensured,
    work,
    reconcile,
    authorizeModel,
  });
});

export const layer = Layer.effect(ThreadRunner, make);
