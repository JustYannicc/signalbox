import {
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ShellSnapshot,
  RpcScopeAuthorization,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import * as Environment from "../environment.ts";

/**
 * The slice of the environment RPC protocol a user's object serves: enough
 * for a client to connect, become ready and render the user's sidebar. The
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

/**
 * Handlers for one connection. `shellSnapshot` reads the user's shell from
 * their object, so the sidebar always comes from the same place over HTTP and
 * the socket.
 */
export const layerHandlers = (input: {
  readonly identity: Environment.CloudEnvironmentIdentity;
  readonly shellSnapshot: Effect.Effect<OrchestrationV2ShellSnapshot>;
}) =>
  CloudRpcGroup.toLayer({
    [WS_METHODS.subscribeServerConfig]: () =>
      thenHold([
        { version: 1, type: "snapshot", config: Environment.serverConfig(input.identity) } as const,
      ]),
    [WS_METHODS.serverGetConfig]: () => Effect.succeed(Environment.serverConfig(input.identity)),
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
              payload: Environment.welcome(input.identity),
            } as const,
            {
              version: 1,
              sequence: 1,
              type: "ready",
              payload: { at, environment: Environment.descriptor(input.identity) },
            } as const,
          ]);
        }),
      ),
    [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (request) =>
      Stream.unwrap(
        Effect.map(input.shellSnapshot, (snapshot) => {
          // There is no event log yet, so only a client already at the current
          // sequence can skip the snapshot.
          const resumed = request.afterSequence === snapshot.snapshotSequence;
          return thenHold([
            ...(resumed ? [] : [{ kind: "snapshot", snapshot } as const]),
            ...(request.requestCompletionMarker ? [{ kind: "synchronized" } as const] : []),
          ]);
        }),
      ),
  });
