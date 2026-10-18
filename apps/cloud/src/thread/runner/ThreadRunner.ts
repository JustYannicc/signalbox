import type { CommitAuthor, DriveAccess } from "@signalbox/runner-protocol/DriveProtocol";
import type { PullOperation } from "@signalbox/runner-protocol/PullProtocol";
import type { SessionAccess } from "@signalbox/runner-protocol/SessionProtocol";
import type { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import {
  type MachineClass,
  type ModelGatewayProvider,
  MIN_RUNNER_PROTOCOL_VERSION,
  RUNNER_PROTOCOL_VERSION,
  type RunnerHello,
  type RunnerItem,
  type RunnerMessageInput,
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

import type { DriveAuthorization, RemoteAuthorization } from "../ThreadAuthorization.ts";
import { myDriveId } from "../../drive/driveAccess.ts";
import { poolObjectName } from "../../pool/PoolDirectory.ts";
import type { ModelAuthorization } from "../../models/ModelProtocol.ts";
import {
  isRemoteToken,
  remoteToken,
  isRemoteOperationToken,
  remoteOperationToken,
} from "../../drive/remoteToken.ts";
import type { UserObjectError } from "../../user/UserDirectory.ts";
import { traceIdOf } from "../diagnostics/traceId.ts";
import { TurnDiagnostics } from "../diagnostics/TurnDiagnostics.ts";
import { driveToken, isDriveToken } from "../../drive/driveToken.ts";
import { gatewayProviderFor, poolIdOfInstance } from "../../models/ModelRouting.ts";
import { holdsNativeSession } from "../session/nativeSession.ts";
import * as PreviewState from "../PreviewState.ts";
import { steersOf } from "../steering.ts";
import { SessionRows } from "../session/SessionRows.ts";
import { sessionToken } from "../session/sessionToken.ts";
import * as ThreadEngine from "../ThreadEngine.ts";
import { applyEvents } from "../threadProjection.ts";
import * as ThreadStore from "../ThreadStore.ts";
import * as PullState from "../PullState.ts";
import type { StopReason } from "../diagnostics/DiagnosticsStore.ts";
import { isLeaseToken } from "./leaseToken.ts";
import { MachineBackend, type MachineExit } from "./MachineBackend.ts";
import { machineClassFor } from "./machineClass.ts";
import { isModelToken, type ModelGrant, modelToken } from "../ModelTokens.ts";
import { freshSessionText, freshSessionTurn } from "./freshSession.ts";
import { continuedRun, recoverRunEvents } from "./runRecovery.ts";
import {
  accountMovedEvents,
  failRunEvents,
  awaitsHandoff,
  harnessRun,
  runnerBatchEvents,
  runnerMessageOf,
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
 * reports `machine.outgrown` once everything is saved (or its machine runs out
 * of memory mid-turn), and the run continues on a heavy machine, as does every
 * later one.
 *
 * An open preview (`PreviewHold`) can start a machine without a live run and
 * keeps it up as a live run does. After it closes, the idle tail counts from
 * the later of the last run and the last preview traffic.
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
      /**
       * The live run this Runner already holds, so a Stop or steer that comes
       * while it runs reaches it on this connection too (#562).
       */
      readonly heldRunId: RunId | null;
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
    /** Who `userId`'s commits are by, from their GitHub connection; null without one. */
    readonly commitAuthor: (userId: string) => Effect.Effect<CommitAuthor | null, UserObjectError>;
  }
>()("@signalbox/cloud/thread/runner/ThreadRunner/ThreadDrives") {}

/**
 * The thread owner's 1Password service account token (#395), asked of their
 * own object each time a turn is handed out, so a token they replaced or
 * removed applies from the next turn without anything restarting. Without
 * it, turns get no token and so no secrets.
 */
export class ThreadSecrets extends Context.Service<
  ThreadSecrets,
  {
    /** `userId`'s token, or null when they have none connected. Never log it. */
    readonly token: (userId: string) => Effect.Effect<string | null, UserObjectError>;
  }
>()("@signalbox/cloud/thread/runner/ThreadRunner/ThreadSecrets") {}

/** Whether a session token may write the thread's session rows right now, and for which machine. */
export type SessionAuthorization =
  | { readonly _tag: "granted"; readonly generation: number }
  | { readonly _tag: "denied"; readonly reason: string };

/** What the object must do for the lease, and when to look again. */
export interface MachinePlan {
  /** Ask the backend for this machine. Idempotent per generation. */
  readonly ensure: { readonly generation: number; readonly token: string } | null;
  /** The class of the lease the plan is about, current or just released: `ensure`'s too. */
  readonly machineClass: MachineClass;
  /** End any Runner of this generation: its lease is gone. */
  readonly release: number | null;
  /**
   * Ask this generation's Runner to save everything it wrote, with this drain
   * id: its machine is about to go (#493).
   */
  readonly drain: { readonly generation: number; readonly id: number } | null;
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
  readonly pull?: {
    readonly operation: PullOperation;
    readonly drive: DriveAccess;
    readonly attempt: number;
  } | null;
  /** Whether `reconcile` has something to do now: ask, retry, time out or start the idle tail. */
  readonly needsUpkeep: boolean;
  /** A drain asked for and not answered yet (#493): asked again of each connection. */
  readonly drain: number | null;
  /** The turn to start, while its run waits for the Runner. */
  readonly turn: RunnerTurn | null;
  /** `turn`'s credential at the ModelGateway. */
  readonly modelToken: string | null;
  /** The drive `turn` works in, and the machine's token for it. */
  readonly drive: DriveAccess | null;
  /** The machine's token for the thread's session rows. */
  readonly sessions: SessionAccess | null;
  /**
   * The 1Password Environments `turn`'s chain names, top level first; empty
   * without a turn. The owner's token to read them is `secretsToken`.
   */
  readonly secrets: ReadonlyArray<OnePasswordEnvironmentId>;
  readonly activeRunId: RunId | null;
  /** The messages steered into the live run while its harness runs it, oldest first (#562). */
  readonly steers: ReadonlyArray<RunnerMessageInput>;
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
     * exit). Its run goes on, on a heavy machine only when a light one ran out
     * of memory. An exit of an older generation's machine changes nothing.
     */
    readonly machineExited: (generation: number, exit: MachineExit) => Effect.Effect<void>;
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
    /** The preview tunnel can connect before the main Runner socket, using the same lease. */
    readonly previewDrive: Effect.Effect<DriveAccess | null>;
    /** The pool moved the thread off its account during `runId` (`pool/threadAccounts.ts`). */
    readonly accountMoved: (runId: RunId, message: string) => Effect.Effect<void>;
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
    /**
     * Who the turn's drive commits are by: the owner as GitHub knows them.
     * Null when they have no GitHub connected, or it can't be asked right now:
     * the Runner then commits as `DRIVE_COMMIT_AUTHOR`.
     */
    readonly commitAuthor: Effect.Effect<CommitAuthor | null>;
    /**
     * `turn`'s prompt on a new harness session, for the Runner to start fresh
     * on should its native resume fail (#653); null for a turn already on a new
     * session. Asked only as a turn goes out: it reads the whole conversation.
     */
    readonly freshSessionText: (turn: Omit<RunnerTurn, "traceId">) => Effect.Effect<string | null>;
    /**
     * The owner's 1Password service account token, for a turn being handed
     * out (`ThreadSecrets`); null without one, or when their object didn't answer.
     */
    readonly secretsToken: Effect.Effect<string | null>;
  }
>()("@signalbox/cloud/thread/runner/ThreadRunner") {}

/**
 * How long an idle machine gets to save everything it wrote before it goes
 * anyway (#493): a save that big is still going, or the machine is wedged.
 */
export const DRAIN_TIMEOUT_MS = 2 * 60_000;

/** How long a turn start waits for its owner's commit author before going without. */
const COMMIT_AUTHOR_TIMEOUT = "5 seconds";
/** How long handing out a turn waits for its owner's 1Password token before going without. */
const SECRETS_TOKEN_TIMEOUT = "5 seconds";

const IDLE: MachinePlan = {
  ensure: null,
  machineClass: "heavy",
  release: null,
  drain: null,
  stop: false,
  busy: false,
  wakeAt: null,
  runId: null,
  lost: false,
};
const BUSY: MachinePlan = { ...IDLE, busy: true };
const UNNEEDED: MachinePlan = { ...IDLE, stop: true };

/**
 * What the live harness run's model token is for, if a run is live. The
 * thread's owner runs its turns, on the pool its chain resolved to: the run's
 * instance names that pool, since the engine moves every selection onto it
 * before a run exists (`turnPool.ts`). A pool id a client sent never gets here.
 */
const modelGrantFor = (
  projection: OrchestrationV2ThreadProjection,
  ownerId: string | null,
): ModelGrant | undefined => {
  const run = harnessRun(projection);
  if (run === undefined || ownerId === null) return undefined;
  const provider = gatewayProviderFor(run.providerInstanceId);
  const poolId = poolIdOfInstance(run.providerInstanceId);
  return provider === undefined || poolId === undefined
    ? undefined
    : {
        threadId: projection.thread.id,
        runId: run.id,
        provider,
        pool: poolObjectName(ownerId, poolId),
        requester: ownerId,
      };
};

/**
 * Mirrors `reconcile`: true exactly when it would act or needs to schedule a
 * check. `live`: a harness run is live; `previewHeld`: a preview is open.
 */
const needsUpkeep = (lease: ThreadStore.MachineLease, live: boolean, previewHeld: boolean) => {
  const held = live || previewHeld;
  switch (lease.status) {
    case "none":
      return held;
    case "requested":
      return true;
    case "connected":
      return (
        lease.disconnectedAt !== null ||
        lease.drain?._tag === "answered" ||
        (held ? lease.idleSince !== null : lease.idleSince === null)
      );
  }
};

const make = Effect.gen(function* () {
  const engine = yield* ThreadEngine.ThreadEngine;
  const previews = yield* PreviewHold;
  const previewState = yield* PreviewState.PreviewState;
  const store = yield* ThreadStore.ThreadStore;
  const pullState = yield* PullState.PullState;
  const pulls = yield* PullState.PullReports;
  const sessionRows = yield* SessionRows;
  const crypto = yield* Crypto.Crypto;
  const backends = yield* MachineBackend;
  const classOf = (lease: ThreadStore.MachineLease): MachineClass => lease.machineClass ?? "heavy";
  const diagnostics = yield* TurnDiagnostics;
  const withCrypto = <A>(effect: Effect.Effect<A, never, Crypto.Crypto>) =>
    Effect.provideService(effect, Crypto.Crypto, crypto);
  const drives = yield* Effect.serviceOption(ThreadDrives);
  const secretTokens = yield* Effect.serviceOption(ThreadSecrets);
  const drivesEnabled = drives._tag === "Some" && drives.value.enabled;
  const driveIdOf = (owner: ThreadStore.ThreadOwner) =>
    owner.driveId ?? myDriveId(owner.contextId, owner.userId);
  const driveOf = Effect.map(Effect.orDie(store.owner), (owner) =>
    owner === null ? null : driveIdOf(owner),
  );

  const lease = Effect.orDie(store.machine);

  const ownerId = Effect.map(Effect.orDie(store.owner), (owner) => owner?.userId ?? null);

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
    Effect.map(Effect.all([crypto.randomUUIDv4(), crypto.randomUUIDv4()]), (parts) =>
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
    withLease(({ projection, lease, now }, ctx) => {
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
      if (
        hello.protocolVersion < MIN_RUNNER_PROTOCOL_VERSION ||
        hello.protocolVersion > RUNNER_PROTOCOL_VERSION
      ) {
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
      // A started run is never handed out again, so one this Runner never took
      // went with an earlier process on this machine, which resumed from disk
      // on another node (#613). It continues here like one on a lost machine.
      const lost =
        run !== null &&
        !awaitsHandoff(run) &&
        hello.takenRunIds !== undefined &&
        !hello.takenRunIds.includes(run.id);
      const events = lost ? recoverRunEvents(projection, run, ctx) : [];
      const active = lost ? harnessRun(applyEvents(projection, events) ?? projection) : run;
      // A Runner too old to say what it holds is taken to hold a run it reported started.
      const heldRunId =
        active != null &&
        (hello.takenRunIds === undefined
          ? !awaitsHandoff(active)
          : hello.takenRunIds.includes(active.id))
          ? active.id
          : null;
      const replay = Effect.gen(function* () {
        if ((lease.connection ?? 0) === 0) return;
        const pending = yield* Effect.orDie(pullState.pending);
        // A process restart and a network reconnect both replay the unfinished attempt.
        if (pending?.phase === "running" && pending.generation === lease.generation) {
          yield* Effect.orDie(pullState.lost(pending.id, lease.generation));
        }
      });
      return Effect.as(
        Effect.andThen(replay, diagnostics.runnerConnected({ hello, connection, run, lost, now })),
        {
          events,
          machine: {
            ...lease,
            status: "connected",
            connection,
            ensuredAt: lease.ensuredAt ?? now,
            disconnectedAt: null,
            drains: hello.drains === true,
            steers: hello.steers === true,
            pulls: hello.pulls === true,
          },
          result: {
            _tag: "welcome",
            generation: lease.generation,
            connection,
            ackedSequence: lease.ackedSequence,
            activeRunId: active?.id ?? null,
            heldRunId,
          },
        } satisfies ThreadEngine.EngineDecision<HelloResult>,
      );
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
      const { events, undecodable, outgrown, drained } = runnerBatchEvents(
        projection,
        input.items,
        ctx,
        lease.steers === true,
      );
      const recorded = Effect.andThen(
        Effect.forEach(
          input.items,
          (item) =>
            item.kind === "git.pull.result"
              ? pulls.reported(input.generation, item.result)
              : item.kind === "git.pull.interrupted"
                ? Effect.gen(function* () {
                    const pending = yield* Effect.orDie(pullState.pending);
                    if (pending?.id === item.id && pending.generation === input.generation) {
                      yield* Effect.orDie(
                        pullState.retry(
                          item.id,
                          input.generation,
                          input.sequence,
                          now + Math.min(1_000 * 2 ** pending.attempts, 30_000),
                        ),
                      );
                    }
                  })
                : Effect.void,
          { discard: true },
        ),
        Effect.andThen(
          diagnostics.batch({
            ...input,
            liveRunId: harnessRun(projection)?.id ?? null,
            runs: projection.runs,
            now,
          }),
          undecodable.length === 0
            ? Effect.void
            : Effect.logWarning("dropped Runner events this build cannot read", { undecodable }),
        ),
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
        machine: {
          ...lease,
          ackedSequence: input.sequence,
          // Only an answer to a drain still asked for lets the machine go.
          ...(drained !== null && lease.drain?._tag === "asked" && lease.drain.id === drained.id
            ? { drain: { _tag: "answered", id: drained.id, unsaved: drained.unsaved } as const }
            : {}),
        },
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

  const machineExited: ThreadRunner["Service"]["machineExited"] = (generation, exit) =>
    withLease(({ projection, lease, now }, ctx) =>
      projection === null || lease.status === "none" || lease.generation !== generation
        ? Effect.succeed(keep(undefined))
        : Effect.map(
            machineGone({
              projection,
              lease,
              now,
              ctx,
              detail: exit.detail,
              moveUp: exit.outOfMemory,
            }),
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
        lease.disconnectedAt !== null ||
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

  /**
   * The owner's 1Password token, asked of their object outside the thread's
   * lock. A turn starts without it rather than wait: the Runner then reports
   * the secrets it couldn't load. Logged without the token or the cause's
   * details beyond the operation.
   */
  const secretsToken: ThreadRunner["Service"]["secretsToken"] = Effect.gen(function* () {
    const userId = yield* ownerId;
    if (secretTokens._tag === "None" || userId === null) return null;
    return yield* secretTokens.value.token(userId).pipe(
      Effect.timeout(SECRETS_TOKEN_TIMEOUT),
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning("reading the owner's 1Password token failed", {
            reason: error._tag,
          }),
          null,
        ),
      ),
    );
  });

  /**
   * The turn to hand the Runner, on a new harness session when there is none
   * to resume: no session ref, or one the store never got a row of (#465).
   * When the store can't be read, the turn resumes as the thread says.
   */
  const turnFor = (projection: OrchestrationV2ThreadProjection) =>
    Effect.gen(function* () {
      const turn = runnerTurnFor(projection);
      if (turn === null) return null;
      const held = yield* holdsNativeSession(sessionRows, turn.providerThread).pipe(
        Effect.catch((error) =>
          Effect.as(Effect.logWarning("reading the harness session failed", { error }), true),
        ),
      );
      return held ? turn : freshSessionTurn(projection, turn);
    });

  const work: ThreadRunner["Service"]["work"] = withLease(({ projection, lease, now }) =>
    Effect.gen(function* () {
      const untraced = projection === null ? null : yield* turnFor(projection);
      const turn =
        untraced === null
          ? null
          : { ...untraced, traceId: yield* withCrypto(traceIdOf(untraced.runId)) };
      const grant = projection === null ? undefined : modelGrantFor(projection, yield* ownerId);
      const run = projection === null ? undefined : harnessRun(projection);
      let pending = projection === null ? null : yield* Effect.orDie(pullState.pending);
      if (pending !== null && lease.status === "connected" && lease.pulls !== true) {
        yield* pulls.revoke(
          pending.id,
          "This thread's machine needs an update before it can pull.",
        );
        pending = null;
      }
      const pull =
        pending !== null &&
        projection !== null &&
        lease.status === "connected" &&
        lease.pulls === true &&
        lease.token !== null &&
        run === undefined &&
        pending.attempts < PullState.MAX_PULL_FAILURES &&
        (pending.retry_at === null || pending.retry_at <= now)
          ? {
              operation: pending.operation,
              attempt: pending.attempts,
              drive: {
                driveId: pending.drive_id,
                token: yield* driveToken(lease.token, projection.thread.id, lease.generation),
                remoteToken: yield* remoteOperationToken(
                  lease.token,
                  projection.thread.id,
                  pending.id,
                ),
              },
            }
          : null;
      if (
        pull !== null &&
        (pending?.generation !== lease.generation || pending.phase === "selected")
      ) {
        yield* Effect.orDie(pullState.assign(pull.operation.id, lease.generation));
      }
      const driveId = turn === null || !drivesEnabled ? null : yield* driveOf;
      return keep<RunnerWork>({
        generation: lease.generation,
        pull,
        needsUpkeep:
          pending?.retry_at != null ||
          (pending !== null && pending.attempts >= PullState.MAX_PULL_FAILURES) ||
          needsUpkeep(
            lease,
            run !== undefined || pending !== null,
            projection?.thread.archivedAt != null ||
              projection?.thread.settledOverride === "settled"
              ? false
              : yield* previews.held,
          ),
        drain: lease.drain?._tag === "asked" ? lease.drain.id : null,
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
                // Its folders' `AGENTS.md`, as the turn was started with (#227), also
                // when this run continues it on another machine (#620).
                instructions: yield* Effect.orDie(
                  store.instructions(continuedRun(projection, run).id),
                ),
              },
        sessions:
          turn === null || lease.token === null || projection === null
            ? null
            : { token: yield* sessionTokenOf(lease.token, projection.thread.id, lease.generation) },
        secrets: turn === null ? [] : yield* Effect.orDie(store.secrets),
        activeRunId: run?.id ?? null,
        // Only a Runner that takes steers is handed them.
        steers:
          projection === null || run?.status !== "running" || lease.steers !== true
            ? []
            : steersOf(projection, run).map(runnerMessageOf),
      });
    }),
  );

  const previewDrive: ThreadRunner["Service"]["previewDrive"] = Effect.gen(function* () {
    if (!drivesEnabled) return null;
    const projection = yield* engine.projection;
    if (projection === null) return null;
    const current = yield* lease;
    if (current.status === "none" || current.token === null) return null;
    const driveId = yield* driveOf;
    if (driveId === null) return null;
    return {
      driveId,
      token: yield* driveToken(current.token, projection.thread.id, current.generation),
      // Remotes are authenticated for a live turn only.
      remoteToken: null,
    } satisfies DriveAccess;
  });

  // Reads committed state without the thread's lock: model requests arrive all
  // through a turn and must not queue behind the Runner's batch commits.
  const authorizeModel: ThreadRunner["Service"]["authorizeModel"] = (token, provider) =>
    Effect.gen(function* () {
      const deny = (reason: string): ModelAuthorization => ({ _tag: "denied", reason });
      const projection = yield* engine.projection;
      // A thread that does not exist yet has no tables to read a lease or owner from.
      const grant = projection === null ? undefined : modelGrantFor(projection, yield* ownerId);
      // One read: the token and the registration are checked against the same machine.
      const current = grant === undefined ? null : yield* lease;
      if (grant === undefined || current === null || current.token === null) {
        return deny("No turn is running on this thread.");
      }
      if (grant.provider !== provider) return deny(`The running turn does not use ${provider}.`);
      if (!(yield* isModelToken(token, current.token, grant))) {
        return deny("This token is not for the running turn.");
      }
      const traceId = yield* withCrypto(traceIdOf(grant.runId));
      // The model never sees a secret (#591): a turn whose folders name some is
      // served only once the machine running it registered their values.
      const secrets = yield* Effect.orDie(store.secretValues);
      if (
        (yield* Effect.orDie(store.secrets)).length > 0 &&
        secrets.registered !== current.generation
      ) {
        return {
          _tag: "unregistered",
          runId: grant.runId,
          traceId,
          reason: "This machine hasn't registered the folder's secrets to hide them yet.",
        } satisfies ModelAuthorization;
      }
      return {
        _tag: "granted",
        runId: grant.runId,
        traceId,
        pool: { objectName: grant.pool, userId: grant.requester },
        secrets: secrets.values,
      } satisfies ModelAuthorization;
    });

  const accountMoved: ThreadRunner["Service"]["accountMoved"] = (runId, message) =>
    engine.apply((projection, ctx) =>
      Effect.succeed({
        events: projection === null ? [] : accountMovedEvents(projection, runId, message, ctx),
        result: undefined,
      }),
    );

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
      const pending = yield* Effect.orDie(pullState.pending);
      if (drives._tag === "Some") {
        if (
          pending !== null &&
          !(yield* drives.value
            .writes(pending.actor_id, driveId)
            .pipe(Effect.orElseSucceed(() => false)))
        ) {
          return deny("The person who requested this pull can no longer change this drive.");
        }
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
        pullOperationId: pending?.generation === current.generation ? pending.id : null,
      } satisfies DriveAuthorization;
    });

  // Like drive calls, remote fetches read committed state without the lock.
  const authorizeRemote: ThreadRunner["Service"]["authorizeRemote"] = (token) =>
    Effect.gen(function* () {
      const deny = (reason: string): RemoteAuthorization => ({ _tag: "denied", reason });
      if (!drivesEnabled) return deny("This cloud stores no drives.");
      const projection = yield* engine.projection;
      const run = projection === null ? undefined : harnessRun(projection);
      const current = projection === null ? null : yield* lease;
      const leaseToken = current?.token ?? null;
      if (projection === null || leaseToken === null || current?.status === "none") {
        return deny("This thread has no machine.");
      }
      const pending = yield* Effect.orDie(pullState.pending);
      if (run === undefined && pending === null) return deny("No turn is running on this thread.");
      const threadId = projection.thread.id;
      const forTurn =
        run !== undefined && (yield* isRemoteToken(token, leaseToken, threadId, run.id));
      const forPull =
        pending !== null &&
        pending.generation === current?.generation &&
        (yield* isRemoteOperationToken(token, leaseToken, threadId, pending.id));
      if (!forTurn && !forPull) {
        return deny("This token is not for the running turn or pull.");
      }
      const owner = yield* Effect.orDie(store.owner);
      if (owner === null) return deny("This thread has no drive.");
      const driveId = driveIdOf(owner);
      // Fetching acts with the owner's GitHub connection, so it needs their access to the drive.
      if (drives._tag === "Some") {
        if (
          forPull &&
          pending !== null &&
          !(yield* drives.value
            .writes(pending.actor_id, driveId)
            .pipe(Effect.orElseSucceed(() => false)))
        ) {
          return deny("The person who requested this pull can no longer change this drive.");
        }
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

  // Asks the owner's object, so never under the lock; a turn starts without it rather than wait.
  const commitAuthor: ThreadRunner["Service"]["commitAuthor"] = Effect.gen(function* () {
    const userId = yield* ownerId;
    if (drives._tag === "None" || userId === null) return null;
    return yield* drives.value.commitAuthor(userId).pipe(
      Effect.timeout(COMMIT_AUTHOR_TIMEOUT),
      Effect.catch((cause) =>
        Effect.as(Effect.logWarning("reading the owner's commit author failed", { cause }), null),
      ),
    );
  });

  const freshSessionTextOf: ThreadRunner["Service"]["freshSessionText"] = (turn) =>
    Effect.map(engine.projection, (projection) =>
      projection === null || turn.providerThread.nativeThreadRef === null
        ? null
        : freshSessionText(projection, turn),
    );

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
        const closing =
          projection !== null &&
          (projection.thread.archivedAt !== null ||
            projection.thread.settledOverride === "settled");
        let pending = projection === null ? null : yield* Effect.orDie(pullState.pending);
        if (
          pending !== null &&
          lease.status === "none" &&
          pending.generation === lease.generation
        ) {
          yield* Effect.orDie(pullState.lost(pending.id, lease.generation));
          pending = yield* Effect.orDie(pullState.pending);
        }
        let exhausted = false;
        if (
          pending !== null &&
          pending.phase === "selected" &&
          pending.attempts >= PullState.MAX_PULL_FAILURES
        ) {
          if (
            closing &&
            lease.status !== "none" &&
            !(lease.drain?._tag === "answered" && lease.drain.unsaved.length === 0)
          ) {
            // Exhaustion fences the drive's writer. Drain this closing machine before that fence.
            pending = null;
          } else {
            yield* pulls.exhausted(pending.id, lease.generation);
            pending = yield* Effect.orDie(pullState.pending);
            exhausted = pending === null;
          }
        }
        let revoked = false;
        if (pending !== null && drives._tag === "Some") {
          const actorWrites = yield* drives.value
            .writes(pending.actor_id, pending.drive_id)
            .pipe(Effect.result);
          const owner = yield* Effect.orDie(store.owner);
          const ownerWrites =
            owner === null
              ? null
              : yield* drives.value.writes(owner.userId, pending.drive_id).pipe(Effect.result);
          if (
            (actorWrites._tag === "Success" && !actorWrites.success) ||
            owner === null ||
            (ownerWrites?._tag === "Success" && !ownerWrites.success)
          ) {
            yield* pulls.revoke(pending.id);
            pending = null;
            revoked = true;
          }
        }
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
          const continues = pending !== null || (after !== null && harnessRun(after) !== undefined);
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
        if (exhausted || (revoked && !closing)) {
          return yield* release({
            reason: "idle",
            detail: exhausted
              ? "The pull exhausted its retry budget."
              : "The pull stopped because drive access changed.",
          });
        }
        if (lease.status === "none") {
          const previewHeld = !closing && (yield* previews.held);
          if ((run === undefined && pending === null && !previewHeld) || projection === null) {
            return keep(UNNEEDED);
          }
          const generation = lease.generation + 1;
          if (pending !== null) yield* Effect.orDie(pullState.assign(pending.id, generation));
          const token = yield* newToken;
          const savedServices = (yield* Effect.orDie(previewState.configuration)).services;
          const machineClass = machineClassFor({
            worktreePath: projection.thread.worktreePath,
            movedUp:
              lease.movedUp === true || lease.machineClass === "heavy" || savedServices.length > 0,
          });
          if (run !== undefined) {
            yield* diagnostics.machineRequested({ generation, run, now, machineClass });
          }
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
          // A preview can open its writable checkout before the main hello.
          // Let that Runner connect and drain before closing its machine.
          if (closing) {
            const token = lease.ensuredAt === null ? lease.token : null;
            return keep<MachinePlan>({
              ...IDLE,
              ensure: token === null ? null : { generation: lease.generation, token },
              wakeAt: now + (token === null ? DRAIN_TIMEOUT_MS : ENSURE_RETRY_MS),
              runId,
            });
          }
          // A preview can keep the request alive without a run to fail.
          const previewHeld = !closing && (yield* previews.held);
          if (run === undefined && pending === null && !previewHeld) {
            return yield* release({ reason: "idle", detail: "No turn needs it any more." });
          }
          const deadline = (lease.requestedAt ?? now) + backend.connectTimeoutMs;
          if (now >= deadline) {
            const failure = "No machine came up to run this turn.";
            return yield* release({
              reason: "error",
              detail:
                run === undefined
                  ? `No preview machine connected within ${Math.round(backend.connectTimeoutMs / 1000)} s.`
                  : `No Runner connected within ${Math.round(backend.connectTimeoutMs / 1000)} s.`,
              ...(run === undefined ? {} : { failure }),
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
          // A lost socket says nothing about the machine's last writes. Closing
          // work waits for its Runner to reconnect and confirm those saves.
          const saved = lease.drain?._tag === "answered" && lease.drain.unsaved.length === 0;
          if (closing && !saved) {
            return keep({ ...IDLE, wakeAt: now + DRAIN_TIMEOUT_MS, runId });
          }
          return yield* release({
            reason: "error",
            detail: `The Runner did not reconnect within ${RECONNECT_TIMEOUT_MS / 1000} s.`,
            lost: true,
            recover: run !== undefined,
          });
        }
        if (run !== undefined || pending !== null || (!closing && (yield* previews.held))) {
          const busy = { ...BUSY, runId, wakeAt: pending?.retry_at ?? null };
          // Needed again: a drain under way no longer leads anywhere.
          return lease.idleSince === null && lease.drain === undefined
            ? keep(busy)
            : {
                events: [],
                machine: { ...lease, idleSince: null, drain: undefined },
                result: busy,
              };
        }
        const idleSince = lease.idleSince ?? now;
        // An open preview pushes the tail out to its last traffic.
        const tailFrom = Math.max(idleSince, (yield* previews.lastActiveAt) ?? 0);
        if (closing || now - tailFrom >= backend.idleTailMs) {
          const idle = `Idle for ${formatDuration(now - tailFrom)}.`;
          // The machine saves everything it wrote before its tokens go (#493).
          if (lease.drains !== true) {
            if (closing)
              return {
                events: [],
                machine: { ...lease, idleSince },
                result: { ...IDLE, wakeAt: now + DRAIN_TIMEOUT_MS },
              };
            return yield* release({ reason: "idle", detail: idle, idleSince: tailFrom });
          }
          if (lease.drain?._tag === "answered") {
            const unsaved = lease.drain.unsaved;
            if (closing && unsaved.length > 0) {
              const retryAt = lease.drain.id + DRAIN_TIMEOUT_MS;
              if (now < retryAt) return keep({ ...IDLE, wakeAt: retryAt });
              return {
                events: [],
                machine: { ...lease, idleSince, drain: { _tag: "asked", id: now } as const },
                result: {
                  ...IDLE,
                  drain: { generation: lease.generation, id: now },
                  wakeAt: now + DRAIN_TIMEOUT_MS,
                },
              };
            }
            return yield* release({
              reason: "idle",
              detail:
                unsaved.length === 0
                  ? idle
                  : `${idle} Not everything it wrote was saved: ${unsaved.map((reason) => `- ${reason}`).join("\n")}`,
              idleSince: tailFrom,
            });
          }
          if (lease.drain === undefined) {
            return {
              events: [],
              machine: { ...lease, idleSince, drain: { _tag: "asked", id: now } as const },
              result: {
                ...IDLE,
                drain: { generation: lease.generation, id: now },
                wakeAt: now + DRAIN_TIMEOUT_MS,
              },
            };
          }
          const deadline = lease.drain.id + DRAIN_TIMEOUT_MS;
          if (now < deadline) return keep({ ...IDLE, wakeAt: deadline });
          if (closing) {
            return {
              events: [],
              machine: { ...lease, drain: { _tag: "asked", id: now } as const },
              result: {
                ...IDLE,
                drain: { generation: lease.generation, id: now },
                wakeAt: now + DRAIN_TIMEOUT_MS,
              },
            };
          }
          return yield* release({
            reason: "idle",
            detail: `${idle} It didn't confirm its last saves within ${DRAIN_TIMEOUT_MS / 1000} s, so anything it wrote after its last save may be lost.`,
            idleSince: tailFrom,
          });
        }
        // Preview traffic pushed the tail out: a drain asked for before is over.
        return {
          events: [],
          ...(lease.idleSince === null || lease.drain !== undefined
            ? { machine: { ...lease, idleSince, drain: undefined } }
            : {}),
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
    previewDrive,
    accountMoved,
    authorizeModel,
    authorizeDrive,
    authorizeSession,
    authorizeRemote,
    commitAuthor,
    freshSessionText: freshSessionTextOf,
    secretsToken,
  });
});

export const layer = Layer.effect(ThreadRunner, make);
