import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2ThreadLaunchError,
  RpcScopeAuthorization,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import {
  SIGNALBOX_CONTEXTS_REQUIRED_SCOPES,
  SIGNALBOX_CONTEXTS_WS_METHODS,
} from "@t3tools/contracts/signalboxContexts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import * as Environment from "../environment.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserShell from "./UserShell.ts";

/**
 * The slice of the environment RPC protocol a user's object serves: enough
 * for a client to connect, render the user's sidebar with its contexts and
 * sections (see `UserContexts`), and work in threads. The
 * group is `WsRpcGroup` itself with everything else omitted, so every payload
 * and stream item is the contract's own schema. A client calling anything
 * else gets a per-request "unknown request tag" failure rather than a dropped
 * connection.
 */

const SERVED = [
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.serverGetConfig,
  WS_METHODS.serverProbe,
  WS_METHODS.serverReportClientActivity,
  WS_METHODS.subscribeServerLifecycle,
  ORCHESTRATION_V2_WS_METHODS.subscribeShell,
  ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
  ORCHESTRATION_V2_WS_METHODS.launchThread,
  ORCHESTRATION_V2_WS_METHODS.subscribeThread,
  ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
  WS_METHODS.projectsEnsureScratch,
  ...Object.values(SIGNALBOX_CONTEXTS_WS_METHODS),
] as const;
type ServedTag = (typeof SERVED)[number];
type WsRpcs = RpcGroup.Rpcs<typeof WsRpcGroup>;
type CloudRpcs = Extract<WsRpcs, { readonly _tag: ServedTag }>;

const servedTags: ReadonlySet<string> = new Set(SERVED);

// `omit` takes the unserved tags, which only exist at runtime; the result is
// exactly the served RPCs.
export const CloudRpcGroup = WsRpcGroup.omit(
  ...([...WsRpcGroup.requests.keys()].filter((tag) => !servedTags.has(tag)) as Array<
    WsRpcs["_tag"]
  >),
) as unknown as RpcGroup.RpcGroup<CloudRpcs>;

/** Same scopes the self-hosted server requires for these RPCs. */
const REQUIRED_SCOPES = {
  [WS_METHODS.subscribeServerConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.serverProbe]: AuthOrchestrationReadScope,
  [WS_METHODS.serverReportClientActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerLifecycle]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.launchThread]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsEnsureScratch]: AuthOrchestrationOperateScope,
  ...SIGNALBOX_CONTEXTS_REQUIRED_SCOPES,
} as const satisfies Record<ServedTag, AuthEnvironmentScope>;

/** Authorizes every RPC on one connection against that connection's session scopes. */
export const layerScopeAuthorization = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Layer.succeed(RpcScopeAuthorization)((effect, { rpc }) => {
    const requiredScope = REQUIRED_SCOPES[rpc._tag as ServedTag];
    return scopes.includes(requiredScope)
      ? effect
      : Effect.fail(
          new EnvironmentAuthorizationError({
            message: `The authenticated token is missing required scope: ${requiredScope}.`,
            requiredScope,
          }),
        );
  });

/** Live streams that have nothing more to say stay open: ending one tells the client to reconnect. */
const thenHold = <A>(items: ReadonlyArray<A>) =>
  Stream.concat(Stream.fromIterable(items), Stream.never);

/** The message a client shows when a thread call fails. */
const failureMessage = (error: CloudThreadService.CloudThreadError) => {
  switch (error._tag) {
    case "ThreadNotFoundError":
      return "Thread not found.";
    case "ThreadCommandRejectedError":
      return error.reason;
    case "ThreadObjectError":
      return "The thread is unavailable right now. Try again.";
  }
};

const logUnavailable = (error: CloudThreadService.CloudThreadError) =>
  error._tag === "ThreadObjectError"
    ? Effect.logError("cloud thread call failed", { cause: error })
    : Effect.void;

/** A thread call as an RPC answers it: unavailable objects logged, errors in the contract's shape. */
const threadCall = <A, E>(
  effect: Effect.Effect<A, CloudThreadService.CloudThreadError>,
  toError: (message: string) => E,
) =>
  effect.pipe(
    Effect.tapError(logUnavailable),
    Effect.mapError((error) => toError(failureMessage(error))),
  );

/**
 * Handlers for one connection, acting for `actor`. Every thread RPC is one
 * `CloudThreadService` call with its errors mapped to the contract's; the
 * sidebar comes from the user's own `UserShell`, and contexts from their
 * `UserContexts`, so every connection sees every other connection's changes.
 * Storage failures are bugs, not answers a client can act on.
 */
export const layerHandlers = (input: {
  readonly identity: Environment.CloudEnvironmentIdentity;
  readonly actor: Actor;
}) =>
  CloudRpcGroup.toLayer(
    Effect.gen(function* () {
      const shell = yield* UserShell.UserShell;
      const threads = yield* CloudThreadService.CloudThreadService;
      const contexts = yield* UserContexts.UserContexts;
      const { actor, identity } = input;
      const config = Effect.map(Clock.currentTimeMillis, (now) =>
        Environment.serverConfig(identity, DateTime.formatIso(DateTime.makeUnsafe(now))),
      );
      return {
        [WS_METHODS.subscribeServerConfig]: () =>
          Stream.unwrap(
            Effect.map(config, (current) =>
              thenHold([{ version: 1, type: "snapshot", config: current } as const]),
            ),
          ),
        [WS_METHODS.serverGetConfig]: () => config,
        [WS_METHODS.serverProbe]: () => Effect.succeed({}),
        [WS_METHODS.serverReportClientActivity]: () => Effect.void,
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
              return thenHold([
                {
                  version: 1,
                  sequence: 0,
                  type: "welcome",
                  payload: Environment.welcome(identity),
                } as const,
                {
                  version: 1,
                  sequence: 1,
                  type: "ready",
                  payload: { at, environment: Environment.descriptor(identity) },
                } as const,
              ]);
            }),
          ),
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (request) =>
          Stream.unwrap(
            shell.subscribe(request).pipe(
              Effect.map((stream) => Stream.concat(stream, Stream.never)),
              Effect.mapError(
                (cause) =>
                  new OrchestrationV2GetShellSnapshotError({
                    message: "The sidebar is unavailable right now.",
                    cause,
                  }),
              ),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command) =>
          threadCall(
            threads.dispatchCommand(actor, command),
            (message) =>
              new OrchestrationV2DispatchCommandError({
                commandId: command.commandId,
                commandType: command.type,
                message,
              }),
          ),
        [ORCHESTRATION_V2_WS_METHODS.launchThread]: (request) =>
          threadCall(
            threads.launchThread(actor, request),
            (message) =>
              new OrchestrationV2ThreadLaunchError({
                commandId: request.commandId,
                projectId: request.projectId,
                message,
              }),
          ),
        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (request) =>
          threads.subscribeThread(actor, request).pipe(
            Stream.flattenIterable,
            Stream.tapError(logUnavailable),
            Stream.mapError(
              (error) =>
                new OrchestrationV2GetThreadProjectionError({
                  threadId: request.threadId,
                  message: failureMessage(error),
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (request) =>
          threadCall(
            Effect.map(
              threads.threadSnapshot(actor, request.threadId),
              (snapshot) => snapshot.projection,
            ),
            (message) =>
              new OrchestrationV2GetThreadProjectionError({ threadId: request.threadId, message }),
          ),
        // Scratch is the Personal context's project, always in the shell.
        [WS_METHODS.projectsEnsureScratch]: () =>
          Effect.succeed({ projectId: Environment.SCRATCH_PROJECT_ID }),
        [SIGNALBOX_CONTEXTS_WS_METHODS.subscribe]: () => Stream.orDie(contexts.changes),
        [SIGNALBOX_CONTEXTS_WS_METHODS.createSection]: (request) =>
          contexts.createSection(request).pipe(Effect.catchTags({ SqlError: Effect.die })),
        [SIGNALBOX_CONTEXTS_WS_METHODS.renameSection]: (request) =>
          contexts.renameSection(request).pipe(Effect.catchTags({ SqlError: Effect.die })),
        [SIGNALBOX_CONTEXTS_WS_METHODS.moveSection]: (request) =>
          contexts.moveSection(request).pipe(Effect.catchTags({ SqlError: Effect.die })),
        [SIGNALBOX_CONTEXTS_WS_METHODS.deleteSection]: (request) =>
          contexts.deleteSection(request).pipe(Effect.catchTags({ SqlError: Effect.die })),
      };
    }),
  );
