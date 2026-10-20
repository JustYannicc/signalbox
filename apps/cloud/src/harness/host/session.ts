import { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HarnessError, type HarnessOpenInput, type HarnessSession } from "../Harness.ts";
import { checkpointThreadLoad, nativeTurnThreadLoad } from "../HarnessThreadLoad.ts";
import { threadMatches } from "../adapter/checkpoint.ts";
import type {
  HarnessHostSession,
  NativeHostBinding,
  NativeMcpConfiguration,
  TurnAccess,
} from "./contracts.ts";
import type { McpRoutes } from "./mcp.ts";
import { mcpAborted } from "./mcp.ts";
import { fingerprint } from "./seed.ts";

const turnCodec = Schema.fromJsonString(Schema.toCodecJson(RunnerTurn));
const encodeTurn = Schema.encodeEffect(turnCodec);
const decodeTurn = Schema.decodeEffect(turnCodec);
const sameConnections = Schema.toEquivalence(
  Schema.Struct({
    servers: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        directTools: Schema.Array(Schema.String),
      }),
    ),
  }),
);

export const snapshotAccess = <G>(access: TurnAccess<G>): TurnAccess<G> => ({
  grant: access.grant,
  signal: access.signal,
  connections: {
    servers: access.connections.servers.map((server) => ({
      ...server,
      directTools: [...server.directTools],
    })),
  },
});

export const sameAccess = <G>(a: TurnAccess<G> | undefined, b: TurnAccess<G> | undefined) =>
  a === undefined || b === undefined
    ? a === b
    : Object.is(a.grant, b.grant) &&
      a.signal === b.signal &&
      sameConnections(a.connections, b.connections);

export const createHostSession = <G>(mcp: ReturnType<McpRoutes<G>["session"]>) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    let closed = false;
    let highestOrdinal = 0;
    let providerThreadId: string | undefined;
    let initial:
      | { readonly access: TurnAccess<G>; readonly configuration: NativeMcpConfiguration }
      | undefined;
    let active:
      | {
          turn: RunnerTurn;
          epoch: number;
          nativeId?: string;
          nativeOrdinal: number;
          finishing: boolean;
          drained: Deferred.Deferred<void>;
        }
      | undefined;
    const accessIds = new WeakMap<TurnAccess<G>, number>();
    let nextAccessId = 0;
    const recent = new Map<
      string,
      {
        hash: string;
        accessId: number;
        access: TurnAccess<G>;
        result: Deferred.Deferred<void, HarnessError>;
      }
    >();
    const stop = () => {
      closed = true;
      initial = undefined;
      if (active !== undefined) Deferred.doneUnsafe(active.drained, Effect.void);
      mcp.close();
    };
    const observe = (events: ProviderAdapterV2SessionRuntime["events"]) =>
      Stream.transformPull(Stream.rechunk(events, 1), (pull) => {
        let finishing: typeof active;
        return Effect.succeed(
          Effect.suspend(() => {
            if (finishing !== undefined) {
              if (active === finishing) active = undefined;
              Deferred.doneUnsafe(finishing.drained, Effect.void);
              finishing = undefined;
            }
            return pull.pipe(
              Effect.tap((chunk) =>
                Effect.sync(() => {
                  const event = chunk[0];
                  const current = active;
                  if (current === undefined || event.driver !== current.turn.providerThread.driver)
                    return;
                  if (
                    event.type === "provider_turn.updated" &&
                    event.providerTurn.providerThreadId === current.turn.providerThread.id &&
                    event.providerTurn.runAttemptId === current.turn.attemptId &&
                    event.providerTurn.nodeId === current.turn.rootNodeId &&
                    (event.providerTurn.ordinal > current.nativeOrdinal ||
                      (event.providerTurn.ordinal === current.nativeOrdinal &&
                        event.providerTurn.id === current.nativeId))
                  ) {
                    current.nativeId = event.providerTurn.id;
                    current.nativeOrdinal = event.providerTurn.ordinal;
                  }
                  if (matchesTerminal(event, current)) {
                    mcp.retire(current.epoch);
                    current.finishing = true;
                    finishing = current;
                  }
                }),
              ),
            );
          }),
        );
      }).pipe(Stream.ensuring(Effect.sync(stop)));
    const decorate = (
      runtime: ProviderAdapterV2SessionRuntime,
    ): ProviderAdapterV2SessionRuntime => ({
      ...runtime,
      get providerSession() {
        return runtime.providerSession;
      },
      events: observe(runtime.events),
      ...(runtime.subscribeEvents === undefined
        ? {}
        : {
            subscribeEvents: runtime.subscribeEvents.pipe(
              Effect.map((subscription) => ({
                ...subscription,
                events: observe(subscription.events),
              })),
            ),
          }),
    });
    return {
      decorate,
      stop,
      prepareInitial(
        native: NativeHostBinding,
        input: HarnessOpenInput,
        access: TurnAccess<G>,
        signal: AbortSignal,
      ) {
        return lock.withPermits(1)(
          Effect.gen(function* () {
            const checkpoint = input.checkpoint;
            if (
              closed ||
              signal.aborted ||
              access.signal.aborted ||
              initial !== undefined ||
              checkpoint === undefined
            )
              return yield* Effect.fail(
                new HarnessError({
                  operation: "open",
                  message: "Checkpoint access is unavailable.",
                }),
              );
            const configuration = yield* Effect.try({
              try: () => mcp.activate(access),
              catch: () =>
                new HarnessError({ operation: "open", message: "Checkpoint MCP binding failed." }),
            });
            initial = { access, configuration };
            // Native setup belongs to the session and access, beyond this open operation's fiber.
            const setupSignal = AbortSignal.any([signal, access.signal]);
            yield* Effect.suspend(() =>
              native.configureMcp(
                configuration,
                setupSignal,
                checkpointThreadLoad(checkpoint, input.session),
              ),
            ).pipe(
              Effect.raceFirst(mcpAborted(setupSignal)),
              Effect.andThen(
                Effect.suspend(() =>
                  setupSignal.aborted
                    ? Effect.fail(
                        new HarnessError({
                          operation: "open",
                          message: "Checkpoint access ended.",
                        }),
                      )
                    : Effect.void,
                ),
              ),
              Effect.onExit((exit) => (Exit.isFailure(exit) ? Effect.sync(stop) : Effect.void)),
            );
          }),
        );
      },
      wrap(
        raw: HarnessSession,
        native: NativeHostBinding,
        input: HarnessOpenInput,
        signal: AbortSignal,
        onClosed: (ok: boolean) => void,
      ): HarnessHostSession<G> {
        providerThreadId = input.checkpoint?.snapshot.providerThread.id;
        const dispose = Effect.suspend(() => {
          stop();
          return raw.dispose.pipe(
            Effect.onExit((exit) => Effect.sync(() => onClosed(Exit.isSuccess(exit)))),
            Effect.catchCause(() =>
              Effect.fail(
                new HarnessError({
                  operation: "dispose",
                  message: "Harness session cleanup failed.",
                }),
              ),
            ),
          );
        });
        return {
          ...raw,
          get providerSession() {
            return raw.providerSession;
          },
          dispose,
          turn: ({ turn: supplied, access }) =>
            Effect.gen(function* () {
              const authorized = snapshotAccess(access);
              const encoded = yield* encodeTurn(supplied).pipe(
                Effect.mapError(
                  () =>
                    new HarnessError({
                      operation: "turn",
                      message: "Invalid turn input.",
                    }),
                ),
              );
              const turn = yield* decodeTurn(encoded).pipe(
                Effect.mapError(
                  () =>
                    new HarnessError({
                      operation: "turn",
                      message: "Invalid turn snapshot.",
                    }),
                ),
              );
              const hash = yield* Effect.tryPromise({
                try: () => fingerprint(encoded),
                catch: () =>
                  new HarnessError({
                    operation: "turn",
                    message: "Turn fingerprint failed.",
                  }),
              });
              const result = yield* lock.withPermits(1)(
                Effect.uninterruptibleMask((restore) =>
                  Effect.gen(function* () {
                    if (closed || signal.aborted)
                      return yield* Effect.fail(
                        new HarnessError({
                          operation: "turn",
                          message: "Harness host session is closed.",
                        }),
                      );
                    const previous = recent.get(turn.runId);
                    const accessId = accessIds.get(access);
                    if (previous !== undefined) {
                      if (
                        previous.hash !== hash ||
                        previous.accessId !== accessId ||
                        !Object.is(previous.access.grant, authorized.grant) ||
                        previous.access.signal !== authorized.signal ||
                        !sameConnections(previous.access.connections, authorized.connections)
                      )
                        return yield* Effect.fail(
                          new HarnessError({
                            operation: "turn",
                            message: "Duplicate turn conflicts with its accepted binding.",
                          }),
                        );
                      return previous.result;
                    }
                    if (active?.finishing) yield* restore(Deferred.await(active.drained));
                    if (
                      active !== undefined ||
                      turn.runOrdinal <= highestOrdinal ||
                      turn.threadId !== input.session.threadId ||
                      turn.appThread.id !== turn.threadId ||
                      turn.modelSelection.instanceId !== raw.providerSession.providerInstanceId ||
                      !threadMatches(turn.providerThread, input) ||
                      turn.providerThread.driver !== raw.providerSession.driver ||
                      (providerThreadId !== undefined &&
                        providerThreadId !== turn.providerThread.id)
                    )
                      return yield* Effect.fail(
                        new HarnessError({
                          operation: "turn",
                          message: "Turn is stale, active, or belongs to another session.",
                        }),
                      );
                    const prepared = initial;
                    if (prepared !== undefined && !sameAccess(prepared.access, authorized))
                      return yield* Effect.fail(
                        new HarnessError({
                          operation: "turn",
                          message: "Turn access conflicts with checkpoint access.",
                        }),
                      );
                    const config =
                      prepared === undefined
                        ? yield* Effect.try({
                            try: () => mcp.activate(authorized),
                            catch: () =>
                              new HarnessError({
                                operation: "turn",
                                message: "MCP turn binding failed.",
                              }),
                          })
                        : prepared.configuration;
                    const acceptedAccessId = accessId ?? ++nextAccessId;
                    accessIds.set(access, acceptedAccessId);
                    const result = yield* Deferred.make<void, HarnessError>();
                    recent.set(turn.runId, {
                      hash,
                      accessId: acceptedAccessId,
                      access: authorized,
                      result,
                    });
                    if (recent.size > 128) recent.delete(recent.keys().next().value!);
                    highestOrdinal = turn.runOrdinal;
                    providerThreadId = turn.providerThread.id;
                    active = {
                      turn,
                      epoch: config.epoch,
                      nativeOrdinal: -1,
                      finishing: false,
                      drained: yield* Deferred.make<void>(),
                    };
                    initial = undefined;
                    const accessSignal = AbortSignal.any([signal, authorized.signal]);
                    const load = nativeTurnThreadLoad(turn, input.session, raw.providerSession.id);
                    const started = yield* restore(
                      (prepared === undefined
                        ? Effect.suspend(() => native.configureMcp(config, accessSignal, load))
                        : Effect.void
                      ).pipe(
                        Effect.raceFirst(mcpAborted(accessSignal)),
                        Effect.andThen(
                          Effect.suspend(() =>
                            accessSignal.aborted
                              ? Effect.fail(
                                  new HarnessError({
                                    operation: "turn",
                                    message: "Turn access ended.",
                                  }),
                                )
                              : raw.turn(turn),
                          ),
                        ),
                      ),
                    ).pipe(Effect.exit);
                    if (Exit.isFailure(started)) {
                      mcp.retire(config.epoch);
                      yield* dispose.pipe(Effect.ignore);
                      yield* Deferred.fail(
                        result,
                        new HarnessError({
                          operation: "turn",
                          message: "Native MCP configuration or turn start failed.",
                        }),
                      );
                    } else yield* Deferred.succeed(result, undefined);
                    return result;
                  }),
                ),
              );
              yield* Deferred.await(result);
            }),
        };
      },
    };
  });

function matchesTerminal(
  event: ProviderAdapterV2Event,
  current: { turn: RunnerTurn; nativeId?: string },
) {
  return (
    event.type === "turn.terminal" &&
    event.providerThreadId === current.turn.providerThread.id &&
    event.providerTurnId === current.nativeId &&
    event.runOrdinal === current.turn.runOrdinal
  );
}
