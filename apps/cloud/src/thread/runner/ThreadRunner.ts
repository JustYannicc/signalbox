import type { DriveAccess } from "@signalbox/runner-protocol/DriveProtocol";
import type { SessionAccess } from "@signalbox/runner-protocol/SessionProtocol";
import {
  type MachineClass,
  type ModelGatewayProvider,
  RUNNER_PROTOCOL_VERSION,
  type RunnerHello,
  type RunnerItem,
  type RunnerRefusal,
  type RunnerTurn,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import { myDriveId } from "../../drive/driveAccess.ts";
import { isRemoteToken, remoteToken } from "../../drive/remoteToken.ts";
import type { UserObjectError } from "../../user/UserDirectory.ts";
import { traceIdOf } from "../diagnostics/traceId.ts";
import { TurnDiagnostics } from "../diagnostics/TurnDiagnostics.ts";
import { driveToken, isDriveToken } from "../../drive/driveToken.ts";
import { gatewayProviderFor } from "../providerCatalog.ts";
import { sessionToken } from "../session/sessionToken.ts";
import * as ThreadEngine from "../ThreadEngine.ts";
import { applyEvents } from "../threadProjection.ts";
import * as ThreadStore from "../ThreadStore.ts";
import type { StopReason } from "../diagnostics/DiagnosticsStore.ts";
import { isLeaseToken } from "./leaseToken.ts";
import { MachineBackend } from "./MachineBackend.ts";
import { machineClassFor } from "./machineClass.ts";
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
 * (`reconcile`): a live run on Claude or Codex gets a machine of its class
 * (`machineClass.ts`) at the next generation, a run whose machine never
 * connects (within the backend's connect timeout) fails with a reason, a run
 * whose machine is lost goes on as a continuation on the next one
 * (`runRecovery.ts`), and an idle machine is released after its class's tail.
 * Whenever no lease stands, the plan says to stop the machine; the next run
 * starts it again at a new generation.
 *
 * A run on a light machine that needs more moves up the same way: its Runner
 * reports `machine.outgrown` once everything is saved (or its machine dies
 * mid-turn), and the run continues on a heavy machine, as does every later one.
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

/** What a drive token lets its holder do right now (see `drive/driveRoutes.ts`). */
export type DriveAuthorization =
  | {
      readonly _tag: "granted";
      readonly threadId: string;
      /** The thread's owner, whose role the drive checks again on every write. */
      readonly userId: string;
      readonly driveId: string;
      readonly generation: number;
      /** Whether a turn runs: `main` only moves during one. */
      readonly live: boolean;
    }
  | { readonly _tag: "denied"; readonly reason: string }
  /** The owner's access couldn't be checked just now; the Runner retries. */
  | { readonly _tag: "unavailable" };

/**
 * Whether this cloud stores drives, and whether a thread's owner may still
 * change files in its drive: asked of their own object on every drive call,
 * so leaving an organization or a drive stops their threads' writes at once.
 * Without drives, turns run in a plain directory.
 */
export class ThreadDrives extends Context.Service<
  ThreadDrives,
  {
    readonly enabled: boolean;
    readonly writes: (userId: string, driveId: string) => Effect.Effect<boolean, UserObjectError>;
  }
>()("@signalbox/cloud/thread/runner/ThreadRunner/ThreadDrives") {}

/** What a remote token lets its holder fetch right now. */
export type RemoteAuthorization =
  | {
      readonly _tag: "granted";
      readonly threadId: string;
      readonly driveId: string;
      /** Whose GitHub connection reaches the remote. */
      readonly userId: string;
    }
  | { readonly _tag: "denied"; readonly reason: string }
  | { readonly _tag: "unavailable" };

/** Whether a session token may write the thread's session rows right now, and for which machine. */
export type SessionAuthorization =
  | { readonly _tag: "granted"; readonly generation: number }
  | { readonly _tag: "denied"; readonly reason: string };

export type ModelAuthorization =
  | { readonly _tag: "granted"; readonly runId: RunId; readonly traceId: string }
  | { readonly _tag: "denied"; readonly reason: string };

/** What the object must do for the lease, and when to look again. */
export interface MachinePlan {
  /** Ask the backend for this machine. Idempotent per generation. */
  readonly ensure: { readonly generation: number; readonly token: string } | null;
  /** The class of the lease the plan is about, current or just released: `ensure`'s too. */
  readonly machineClass: MachineClass;
  /** End any Runner of this generation: its lease is gone. */
  readonly release: number | null;
  /** No lease stands: the machine should be stopped. */
  readonly stop: boolean;
  /** A connected machine is running a turn: keep its TTL pushed out. */
  readonly busy: boolean;
  readonly wakeAt: number | null;
  /** The live harness run, for what the object logs about the machine. */
  readonly runId: RunId | null;
  /** `release`'s Runner vanished rather than being let go: its machine may have stopped itself. */
  readonly lost: boolean;
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
    readonly ended: (generation: number, reason: string) => Effect.Effect<void>;
    /**
     * The machine running `generation` stopped on its own (its backend saw it
     * exit). A light one that dies mid-turn most likely ran out of memory, so
     * its run moves up. An exit of an older generation's machine changes nothing.
     */
    readonly machineExited: (generation: number, detail: string) => Effect.Effect<void>;
    readonly disconnected: (input: {
      readonly generation: number;
      readonly connection: number;
      /** The socket's close code and reason, for diagnostics. */
      readonly detail: string;
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
    /** Whether the drive API may act for `token`'s holder, and as whom. */
    readonly authorizeDrive: (token: string) => Effect.Effect<DriveAuthorization>;
    /** Whether the session API may act for `token`'s holder: the machine holding the lease. */
    readonly authorizeSession: (token: string) => Effect.Effect<SessionAuthorization>;
    /** Whether `token` may fetch the thread's drive's remote right now (#135). */
    readonly authorizeRemote: (token: string) => Effect.Effect<RemoteAuthorization>;
  }
>()("@signalbox/cloud/thread/runner/ThreadRunner") {}

const IDLE: MachinePlan = {
  ensure: null,
  machineClass: "heavy",
  release: null,
  stop: false,
  busy: false,
  wakeAt: null,
  runId: null,
  lost: false,
};
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
  const backends = yield* MachineBackend;
  const classOf = (lease: ThreadStore.MachineLease): MachineClass => lease.machineClass ?? "heavy";
  const diagnostics = yield* TurnDiagnostics;
  const withCrypto = <A>(effect: Effect.Effect<A, never, Crypto.Crypto>) =>
    Effect.provideService(effect, Crypto.Crypto, crypto);
  const drives = yield* Effect.serviceOption(ThreadDrives);
  const drivesEnabled = drives._tag === "Some" && drives.value.enabled;
  const driveIdOf = (owner: ThreadStore.ThreadOwner) =>
    owner.driveId ?? myDriveId(owner.contextId, owner.userId);
  const driveOf = Effect.map(Effect.orDie(store.owner), (owner) =>
    owner === null ? null : driveIdOf(owner),
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
      if (projection === null || projection.thread.id !== hello.threadId) {
        return Effect.succeed(
          keep<HelloResult>({
            _tag: "refused",
            reason: "unknown_thread",
            message: "This thread does not exist.",
          }),
        );
      }
      const run = harnessRun(projection) ?? null;
      // Anyone can say hello, so a refusal goes to the Worker's logs, not the thread's record.
      const refuse = (reason: RunnerRefusal, message: string) =>
        Effect.as(
          Effect.logWarning("refused a Runner", {
            reason,
            generation: hello.generation,
            machineId: hello.machineId,
          }),
          keep<HelloResult>({ _tag: "refused", reason, message }),
        );
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
      return Effect.as(diagnostics.runnerConnected({ hello, connection, run, now }), {
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
          activeRunId: run?.id ?? null,
        },
      } satisfies ThreadEngine.EngineDecision<HelloResult>);
    });

  const batch: ThreadRunner["Service"]["batch"] = (input) =>
    withLease(({ projection, lease, now }, ctx) => {
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
      const { events, undecodable, outgrown } = runnerBatchEvents(projection, input.items, ctx);
      const recorded = Effect.andThen(
        diagnostics.batch({
          ...input,
          liveRunId: harnessRun(projection)?.id ?? null,
          runs: projection.runs,
          now,
        }),
        undecodable.length === 0
          ? Effect.void
          : Effect.logWarning("dropped Runner events this build cannot read", { undecodable }),
      );
      const acked = { _tag: "ack", sequence: input.sequence } as const;
      // The Runner saved everything and stopped reporting: its machine is done
      // either way, and only a light one's run moves up.
      if (outgrown !== null) {
        return Effect.andThen(
          recorded,
          Effect.map(
            machineGone({ projection, lease, now, ctx, detail: outgrown, moveUp: true, events }),
            (gone) => ({ ...gone, result: acked }),
          ),
        );
      }
      return Effect.as(recorded, {
        events,
        machine: { ...lease, ackedSequence: input.sequence },
        result: acked,
      });
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
    machineClass: lease.machineClass,
    movedUp: lease.movedUp,
  });

  /** Ends the lease's machine session in the diagnostics. */
  const sessionEnded = (
    lease: ThreadStore.MachineLease,
    input: {
      readonly reason: StopReason;
      readonly detail: string | null;
      readonly runId: RunId | null;
      readonly now: number;
      /** When the idle tail began, if not when the lease went idle (an open preview pushed it out). */
      readonly idleSince?: number;
    },
  ) =>
    diagnostics.released({
      ...input,
      generation: lease.generation,
      idleSince: input.idleSince ?? lease.idleSince,
    });

  /**
   * The lease's machine goes, whatever the reason: its session ends, a live run
   * continues on the next machine (`runRecovery.ts`), and with `moveUp` a light
   * machine's run moves to the heavy class for good. `events` are the reporting
   * batch's own, which go first.
   */
  const machineGone = (input: {
    readonly projection: OrchestrationV2ThreadProjection;
    readonly lease: ThreadStore.MachineLease;
    readonly now: number;
    readonly ctx: Parameters<typeof recoverRunEvents>[2];
    readonly detail: string;
    readonly moveUp: boolean;
    readonly events?: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => {
    const { lease, ctx, detail, events = [] } = input;
    const after = events.length === 0 ? input.projection : applyEvents(input.projection, events);
    const run = after === null ? undefined : harnessRun(after);
    const moves = input.moveUp && run !== undefined && classOf(lease) === "light";
    return Effect.as(
      sessionEnded(lease, {
        reason: moves ? "outgrown" : "error",
        detail,
        runId: run?.id ?? null,
        now: input.now,
      }),
      {
        events: [
          ...events,
          ...(after === null || run === undefined
            ? []
            : recoverRunEvents(after, run, ctx, moves ? { reason: detail } : undefined)),
        ],
        machine: { ...released(lease), movedUp: lease.movedUp === true || moves },
      },
    );
  };

  const ended: ThreadRunner["Service"]["ended"] = (generation, reason) =>
    withLease(({ projection, lease, now }, ctx) => {
      if (projection === null || lease.generation !== generation || lease.status === "none") {
        return Effect.succeed(keep(undefined));
      }
      // A machine that goes away mid-turn is a lost machine: the run goes on.
      return Effect.map(
        machineGone({
          projection,
          lease,
          now,
          ctx,
          detail: `The Runner ended: ${reason}`,
          moveUp: false,
        }),
        (gone) => ({ ...gone, result: undefined }),
      );
    });

  const machineExited: ThreadRunner["Service"]["machineExited"] = (generation, detail) =>
    withLease(({ projection, lease, now }, ctx) =>
      projection === null || lease.status === "none" || lease.generation !== generation
        ? Effect.succeed(keep(undefined))
        : Effect.map(
            machineGone({ projection, lease, now, ctx, detail, moveUp: true }),
            (gone) => ({ ...gone, result: undefined }),
          ),
    );

  const disconnected: ThreadRunner["Service"]["disconnected"] = ({
    generation,
    connection,
    detail,
  }) =>
    withLease(({ projection, lease, now }) => {
      if (
        projection === null ||
        lease.generation !== generation ||
        lease.status !== "connected" ||
        (lease.connection ?? 0) !== connection
      ) {
        return Effect.succeed(keep(undefined));
      }
      return Effect.as(
        diagnostics.runnerClosed({
          generation,
          runId: harnessRun(projection)?.id ?? null,
          detail,
          now,
        }),
        { events: [], machine: { ...lease, disconnectedAt: now }, result: undefined },
      );
    });

  const ensured: ThreadRunner["Service"]["ensured"] = (generation) =>
    updateLease(generation, (lease, now) =>
      lease.status === "none" || lease.ensuredAt !== null ? null : { ...lease, ensuredAt: now },
    );

  const work: ThreadRunner["Service"]["work"] = withLease(({ projection, lease }) =>
    Effect.gen(function* () {
      const untraced = projection === null ? null : runnerTurnFor(projection);
      const turn =
        untraced === null
          ? null
          : { ...untraced, traceId: yield* withCrypto(traceIdOf(untraced.runId)) };
      const grant = projection === null ? undefined : modelGrantFor(projection);
      const run = projection === null ? undefined : harnessRun(projection);
      const driveId = turn === null || !drivesEnabled ? null : yield* driveOf;
      return keep<RunnerWork>({
        generation: lease.generation,
        needsUpkeep: needsUpkeep(lease, run !== undefined, yield* previews.held),
        turn,
        modelToken:
          turn === null || grant === undefined || lease.token === null
            ? null
            : yield* modelToken(lease.token, grant),
        drive:
          driveId === null || lease.token === null || projection === null || run === undefined
            ? null
            : {
                driveId,
                token: yield* driveToken(lease.token, projection.thread.id, lease.generation),
                // Any drive may have a remote to fetch, or a shortcut to one (#142).
                remoteToken: yield* remoteToken(lease.token, projection.thread.id, run.id),
              },
        sessions:
          turn === null || lease.token === null || projection === null
            ? null
            : { token: yield* sessionTokenOf(lease.token, projection.thread.id, lease.generation) },
        activeRunId: run?.id ?? null,
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
        ? ({
            _tag: "granted",
            runId: grant.runId,
            traceId: yield* withCrypto(traceIdOf(grant.runId)),
          } satisfies ModelAuthorization)
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
      const owner = yield* Effect.orDie(store.owner);
      if (owner === null) return deny("This thread has no drive.");
      const driveId = driveIdOf(owner);
      if (drives._tag === "Some") {
        const writes = yield* drives.value.writes(owner.userId, driveId).pipe(Effect.result);
        if (writes._tag === "Failure") {
          yield* Effect.logWarning("drive access check failed", { cause: writes.failure });
          return { _tag: "unavailable" } satisfies DriveAuthorization;
        }
        if (!writes.success) return deny("You no longer have access to change this drive.");
      }
      return {
        _tag: "granted",
        threadId,
        userId: owner.userId,
        driveId,
        generation: current.generation,
        live: harnessRun(projection) !== undefined,
      } satisfies DriveAuthorization;
    });

  // Like drive calls, remote fetches read committed state without the lock.
  const authorizeRemote: ThreadRunner["Service"]["authorizeRemote"] = (token) =>
    Effect.gen(function* () {
      const deny = (reason: string): RemoteAuthorization => ({ _tag: "denied", reason });
      if (!drivesEnabled) return deny("This cloud stores no drives.");
      const projection = yield* engine.projection;
      const run = projection === null ? undefined : harnessRun(projection);
      const leaseToken = run === undefined ? null : (yield* lease).token;
      if (projection === null || run === undefined || leaseToken === null) {
        return deny("No turn is running on this thread.");
      }
      const threadId = projection.thread.id;
      if (!(yield* isRemoteToken(token, leaseToken, threadId, run.id))) {
        return deny("This token is not for the running turn.");
      }
      const owner = yield* Effect.orDie(store.owner);
      if (owner === null) return deny("This thread has no drive.");
      const driveId = driveIdOf(owner);
      // Fetching acts with the owner's GitHub connection, so it needs their access to the drive.
      if (drives._tag === "Some") {
        const writes = yield* drives.value.writes(owner.userId, driveId).pipe(Effect.result);
        if (writes._tag === "Failure") {
          yield* Effect.logWarning("drive access check failed", { cause: writes.failure });
          return { _tag: "unavailable" } satisfies RemoteAuthorization;
        }
        if (!writes.success) return deny("You no longer have access to change this drive.");
      }
      return {
        _tag: "granted",
        threadId,
        driveId,
        userId: owner.userId,
      } satisfies RemoteAuthorization;
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
        const backend = backends[classOf(lease)];
        const run = projection === null ? undefined : harnessRun(projection);
        const runId = run?.id ?? null;
        /**
         * Lets the machine go. `failure` fails the live run with it; `recover`
         * continues it on the next machine (`runRecovery.ts`), and then the
         * object looks again at once, to ask for that machine.
         */
        const release = (input: {
          readonly reason: StopReason;
          readonly detail: string;
          readonly failure?: string;
          readonly recover?: boolean;
          readonly lost?: boolean;
          readonly idleSince?: number;
        }) => {
          const events =
            projection === null || run === undefined
              ? []
              : input.recover === true
                ? recoverRunEvents(projection, run, ctx)
                : input.failure === undefined
                  ? []
                  : failRunEvents(projection, run, unknownFailure(input.failure), ctx);
          const after = projection === null ? null : applyEvents(projection, events);
          const continues = after !== null && harnessRun(after) !== undefined;
          return Effect.as(
            projection === null ? Effect.void : sessionEnded(lease, { ...input, runId, now }),
            {
              events,
              machine: released(lease),
              result: {
                ...UNNEEDED,
                release: lease.generation,
                runId,
                lost: input.lost === true,
                wakeAt: continues ? now : null,
              },
            } satisfies ThreadEngine.EngineDecision<MachinePlan>,
          );
        };
        if (lease.status === "none") {
          if (run === undefined || projection === null) return keep(UNNEEDED);
          const generation = lease.generation + 1;
          const token = yield* newToken;
          const machineClass = machineClassFor({
            worktreePath: projection.thread.worktreePath,
            movedUp: lease.movedUp === true,
          });
          yield* diagnostics.machineRequested({ generation, run, now, machineClass });
          return {
            events: [],
            machine: {
              ...ThreadStore.NO_MACHINE,
              generation,
              token,
              status: "requested" as const,
              requestedAt: now,
              machineClass,
              movedUp: lease.movedUp,
            },
            result: {
              ...IDLE,
              ensure: { generation, token },
              wakeAt: now + ENSURE_RETRY_MS,
              runId,
            },
          };
        }
        if (lease.status === "requested") {
          // Nothing needs it any more (the run was stopped before a Runner came).
          if (run === undefined) {
            return yield* release({ reason: "idle", detail: "No turn needs it any more." });
          }
          const deadline = (lease.requestedAt ?? now) + backend.connectTimeoutMs;
          if (now >= deadline) {
            const failure = "No machine came up to run this turn.";
            return yield* release({
              reason: "error",
              detail: `No Runner connected within ${Math.round(backend.connectTimeoutMs / 1000)} s.`,
              failure,
            });
          }
          const token = lease.ensuredAt === null ? lease.token : null;
          return keep<MachinePlan>({
            ...IDLE,
            ensure: token === null ? null : { generation: lease.generation, token },
            wakeAt: token === null ? deadline : Math.min(deadline, now + ENSURE_RETRY_MS),
            runId,
          });
        }
        if (lease.disconnectedAt !== null) {
          const deadline = lease.disconnectedAt + RECONNECT_TIMEOUT_MS;
          if (now < deadline) return keep({ ...IDLE, wakeAt: deadline, runId });
          return yield* release({
            reason: "error",
            detail: `The Runner did not reconnect within ${RECONNECT_TIMEOUT_MS / 1000} s.`,
            lost: true,
            recover: run !== undefined,
          });
        }
        if (run !== undefined || (yield* previews.held)) {
          const busy = { ...BUSY, runId };
          return lease.idleSince === null
            ? keep(busy)
            : { events: [], machine: { ...lease, idleSince: null }, result: busy };
        }
        const idleSince = lease.idleSince ?? now;
        // An open preview pushes the tail out to its last traffic.
        const tailFrom = Math.max(idleSince, (yield* previews.lastActiveAt) ?? 0);
        if (now - tailFrom >= backend.idleTailMs) {
          return yield* release({
            reason: "idle",
            detail: `Idle for ${formatDuration(now - tailFrom)}.`,
            idleSince: tailFrom,
          });
        }
        return {
          events: [],
          ...(lease.idleSince === null ? { machine: { ...lease, idleSince } } : {}),
          result: { ...IDLE, wakeAt: tailFrom + backend.idleTailMs },
        };
      }).pipe(
        // Every plan names the class of the lease it is about, for the object's backend calls.
        Effect.map((decision) => ({
          ...decision,
          result: {
            ...decision.result,
            machineClass: classOf(decision.machine ?? lease),
          },
        })),
      ),
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
    machineExited,
    disconnected,
    ensured,
    work,
    reconcile,
    authorizeModel,
    authorizeDrive,
    authorizeSession,
    authorizeRemote,
  });
});

export const layer = Layer.effect(ThreadRunner, make);
