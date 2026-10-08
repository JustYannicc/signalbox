import type { DriveAccess } from "@signalbox/runner-protocol/DriveProtocol";
import type { SessionAccess } from "@signalbox/runner-protocol/SessionProtocol";
import {
  type ModelGatewayProvider,
  RUNNER_PROTOCOL_VERSION,
  type RunnerHello,
  type RunnerItem,
  type RunnerRefusal,
  type RunnerTurn,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { OrchestrationV2ThreadProjection, RunId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { myDriveId } from "../../drive/DriveDirectory.ts";
import { driveToken, isDriveToken } from "../../drive/driveToken.ts";
import { gatewayProviderFor } from "../providerCatalog.ts";
import { sessionToken } from "../session/sessionToken.ts";
import * as ThreadEngine from "../ThreadEngine.ts";
import { applyEvents } from "../threadProjection.ts";
import * as ThreadStore from "../ThreadStore.ts";
import { isLeaseToken } from "./leaseToken.ts";
import { MachineBackend } from "./MachineBackend.ts";
import { isModelToken, type ModelGrant, modelToken } from "./modelToken.ts";
import { recoverRunEvents } from "./runRecovery.ts";
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
 * connect timeout) fails with a reason, a run whose machine is lost goes on
 * as a continuation on the next one (`runRecovery.ts`), and an idle machine
 * is released after its tail. Whenever no lease stands, the plan says to stop
 * the machine; the next run starts it again at a new generation.
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

/** What a drive token lets its holder do right now (see `drive/driveRoutes.ts`). */
export type DriveAuthorization =
  | {
      readonly _tag: "granted";
      readonly threadId: string;
      readonly driveId: string;
      readonly generation: number;
      /** Whether a turn runs: `main` only moves during one. */
      readonly live: boolean;
    }
  | { readonly _tag: "denied"; readonly reason: string };

/** Whether this cloud stores drives. Without it, turns run in a plain directory. */
export class ThreadDrives extends Context.Service<ThreadDrives, { readonly enabled: boolean }>()(
  "@signalbox/cloud/thread/runner/ThreadRunner/ThreadDrives",
) {}

/** Whether a session token may write the thread's session rows right now, and for which machine. */
export type SessionAuthorization =
  | { readonly _tag: "granted"; readonly generation: number }
  | { readonly _tag: "denied"; readonly reason: string };

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
  /** The drive `turn` works in, and the machine's token for it. */
  readonly drive: DriveAccess | null;
  /** The machine's token for the thread's session rows. */
  readonly sessions: SessionAccess | null;
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
    /** Whether the drive API may act for `token`'s holder, and as whom. */
    readonly authorizeDrive: (token: string) => Effect.Effect<DriveAuthorization>;
    /** Whether the session API may act for `token`'s holder: the machine holding the lease. */
    readonly authorizeSession: (token: string) => Effect.Effect<SessionAuthorization>;
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

/** Mirrors `reconcile`: true exactly when it would act or needs to schedule a check. */
const needsUpkeep = (lease: ThreadStore.MachineLease, live: boolean) => {
  switch (lease.status) {
    case "none":
      return live;
    case "requested":
      return true;
    case "connected":
      return (
        lease.disconnectedAt !== null ||
        (live ? lease.idleSince !== null : lease.idleSince === null)
      );
  }
};

const make = Effect.gen(function* () {
  const engine = yield* ThreadEngine.ThreadEngine;
  const store = yield* ThreadStore.ThreadStore;
  const crypto = yield* Crypto.Crypto;
  const { connectTimeoutMs } = yield* MachineBackend;
  const drives = yield* Effect.serviceOption(ThreadDrives);
  const drivesEnabled = drives._tag === "Some" && drives.value.enabled;
  const driveOf = Effect.map(Effect.orDie(store.owner), (owner) =>
    owner === null ? null : myDriveId(owner.contextId, owner.userId),
  );

  const lease = Effect.orDie(store.machine);

  /** The current lease's session token, signed once: the Runner presents it with every append. */
  let sessionTokenCache: { readonly key: string; readonly token: string } | null = null;
  const sessionTokenOf = (leaseToken: string, threadId: ThreadId, generation: number) =>
    Effect.suspend(() => {
      const key = `${leaseToken}\n${generation}`;
      if (sessionTokenCache?.key === key) return Effect.succeed(sessionTokenCache.token);
      return Effect.tap(sessionToken(leaseToken, threadId, generation), (token) =>
        Effect.sync(() => {
          sessionTokenCache = { key, token };
        }),
      );
    });
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
          projection === null || run === undefined ? [] : recoverRunEvents(projection, run, ctx),
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
      const driveId = turn === null || !drivesEnabled ? null : yield* driveOf;
      return keep<RunnerWork>({
        generation: lease.generation,
        needsUpkeep: needsUpkeep(
          lease,
          projection !== null && harnessRun(projection) !== undefined,
        ),
        turn,
        modelToken:
          turn === null || grant === undefined || lease.token === null
            ? null
            : yield* modelToken(lease.token, grant),
        drive:
          driveId === null || lease.token === null || projection === null
            ? null
            : {
                driveId,
                token: yield* driveToken(lease.token, projection.thread.id, lease.generation),
              },
        sessions:
          turn === null || lease.token === null || projection === null
            ? null
            : { token: yield* sessionTokenOf(lease.token, projection.thread.id, lease.generation) },
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

  // Like model requests, drive calls read committed state without the lock.
  const authorizeDrive: ThreadRunner["Service"]["authorizeDrive"] = (token) =>
    Effect.gen(function* () {
      const deny = (reason: string): DriveAuthorization => ({ _tag: "denied", reason });
      if (!drivesEnabled) return deny("This cloud stores no drives.");
      const projection = yield* engine.projection;
      if (projection === null) return deny("This thread does not exist.");
      const current = yield* lease;
      if (current.status === "none" || current.token === null) {
        return deny("This thread has no machine.");
      }
      const threadId = projection.thread.id;
      if (!(yield* isDriveToken(token, current.token, threadId, current.generation))) {
        return deny("This token is not for this thread's machine.");
      }
      const driveId = yield* driveOf;
      if (driveId === null) return deny("This thread has no drive.");
      return {
        _tag: "granted",
        threadId,
        driveId,
        generation: current.generation,
        live: harnessRun(projection) !== undefined,
      } satisfies DriveAuthorization;
    });

  // Like drive calls, session writes read committed state without the lock;
  // the session API checks the generation again as it writes.
  const authorizeSession: ThreadRunner["Service"]["authorizeSession"] = (token) =>
    Effect.gen(function* () {
      const deny = (reason: string): SessionAuthorization => ({ _tag: "denied", reason });
      const projection = yield* engine.projection;
      if (projection === null) return deny("This thread does not exist.");
      const current = yield* lease;
      if (current.status === "none" || current.token === null) {
        return deny("This thread has no machine.");
      }
      if (
        !(yield* isLeaseToken(
          token,
          sessionTokenOf(current.token, projection.thread.id, current.generation),
        ))
      ) {
        return deny("This token is not for this thread's machine.");
      }
      return { _tag: "granted", generation: current.generation } satisfies SessionAuthorization;
    });

  const reconcile: ThreadRunner["Service"]["reconcile"] = withLease(
    ({ projection, lease, now }, ctx) =>
      Effect.gen(function* () {
        const run = projection === null ? undefined : harnessRun(projection);
        /**
         * Ends the lease. A live run fails with `ending` or, when its machine
         * was lost, goes on: then the object looks again at once, to ask for
         * the next machine.
         */
        const release = (
          ending: { readonly fail: string } | "recover" | null,
        ): ThreadEngine.EngineDecision<MachinePlan> => {
          const events =
            projection === null || run === undefined || ending === null
              ? []
              : ending === "recover"
                ? recoverRunEvents(projection, run, ctx)
                : failRunEvents(projection, run, unknownFailure(ending.fail), ctx);
          const after = projection === null ? null : applyEvents(projection, events);
          const continues = after !== null && harnessRun(after) !== undefined;
          return {
            events,
            machine: released(lease),
            result: { ...UNNEEDED, release: lease.generation, wakeAt: continues ? now : null },
          };
        };
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
          if (now >= deadline) return release({ fail: "No machine came up to run this turn." });
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
          return release(run === undefined ? null : "recover");
        }
        if (run !== undefined) {
          return lease.idleSince === null
            ? keep(BUSY)
            : { events: [], machine: { ...lease, idleSince: null }, result: BUSY };
        }
        const idleSince = lease.idleSince ?? now;
        if (now - idleSince >= IDLE_TAIL_MS) return release(null);
        return {
          events: [],
          ...(lease.idleSince === null ? { machine: { ...lease, idleSince } } : {}),
          result: { ...IDLE, wakeAt: idleSince + IDLE_TAIL_MS },
        };
      }),
  );

  return ThreadRunner.of({
    hello,
    batch,
    ended,
    disconnected,
    ensured,
    work,
    reconcile,
    authorizeModel,
    authorizeDrive,
    authorizeSession,
  });
});

export const layer = Layer.effect(ThreadRunner, make);
