/**
 * WebSocket handlers for Signalbox's own RPCs: product analytics, account
 * pools, automations, sections, and contexts and previews (Signalbox Cloud only). They stay in `WsRpcGroup`, so clients and the auth
 * and instrumentation middleware see one group, but ws.ts implements only
 * upstream's share. One handler layer for every RPC is too deep for tsc.
 *
 * @module signalbox/wsRpc
 */
import { RpcScopeAuthorization, SIGNALBOX_WS_RPCS, WS_METHODS } from "@t3tools/contracts";
import { AccountHubRpcError } from "@t3tools/contracts/accountHub";
import * as Effect from "effect/Effect";
import * as RpcGroup from "effect/rpc/RpcGroup";

import * as AccountPools from "../accountHub/AccountPools.ts";
import type { AccountHubError } from "../accountHub/accountHubManagement.ts";
import * as PoolAccess from "../accountHub/poolAccess.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import { makeSectionsWsHandlers } from "../sections/rpc.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import { automationRpcHandlers } from "../workflows/rpcHandlers.ts";
import * as WorkflowEngine from "../workflows/WorkflowEngine.ts";
import { makeSignalboxAnalyticsWsHandlers } from "./analytics/rpc.ts";
import { signalboxContextsWsHandlers } from "./contexts/rpc.ts";
import { signalboxPreviewsWsHandlers } from "./previews/rpc.ts";

/**
 * Signalbox's RPCs. The middleware only shapes handler types like ws.ts's
 * group; at runtime the server applies the middleware `WsRpcGroup` declares.
 */
const SignalboxWsRpcGroup = RpcGroup.make(...SIGNALBOX_WS_RPCS)
  .middleware(RpcScopeAuthorization)
  .middleware(RpcInstrumentation);

/** The tags ws.ts leaves to {@link layer}. */
export const SIGNALBOX_WS_RPC_TAGS = SIGNALBOX_WS_RPCS.map((rpc) => rpc._tag);

/** Hub errors mapped for the wire. */
const hubFailure = (error: AccountHubError) => new AccountHubRpcError({ detail: error.detail });

/** Handlers for one connection; `clientAnalyticsProps` are its client dimensions. */
export const layer = (clientAnalyticsProps: Readonly<Record<string, unknown>>) =>
  SignalboxWsRpcGroup.toLayer(
    Effect.gen(function* () {
      const analytics = yield* makeSignalboxAnalyticsWsHandlers(clientAnalyticsProps);
      const automations = yield* WorkflowEngine.WorkflowEngine;
      const usageLimitSources = yield* UsageLimitSources.UsageLimitSources;
      const pools = yield* AccountPools.AccountPools;
      const sections = yield* makeSectionsWsHandlers;
      return SignalboxWsRpcGroup.of({
        ...analytics,
        ...automationRpcHandlers(automations),
        ...sections,
        ...signalboxContextsWsHandlers,
        ...signalboxPreviewsWsHandlers,
        [WS_METHODS.accountPoolSubscribe]: () => pools.changes,
        [WS_METHODS.accountPoolSubscribeViews]: () => PoolAccess.poolViews,
        [WS_METHODS.accountPoolCreate]: (input) =>
          pools.create(input).pipe(Effect.mapError(hubFailure)),
        [WS_METHODS.accountPoolRename]: (input) =>
          pools.rename(input).pipe(Effect.mapError(hubFailure)),
        [WS_METHODS.accountPoolDelete]: (input) =>
          pools.remove(input.poolId).pipe(Effect.mapError(hubFailure)),
        [WS_METHODS.accountPoolSetBacking]: (input) =>
          pools.setBacking(input).pipe(Effect.mapError(hubFailure)),
        [WS_METHODS.accountPoolImportAccounts]: (input) =>
          pools.importAccounts(input).pipe(Effect.mapError(hubFailure)),
        [WS_METHODS.accountPoolAddApiKey]: (input) =>
          pools.addApiKey(input).pipe(Effect.mapError(hubFailure)),
        [WS_METHODS.accountPoolSetOpenCode]: (input) =>
          pools.setOpenCode(input).pipe(Effect.mapError(hubFailure)),
        [WS_METHODS.accountPoolMoveNativeLogins]: (input) =>
          pools.moveNativeLogins(input).pipe(Effect.mapError(hubFailure)),
        [WS_METHODS.usageLimitSourceUpdateAccount]: (input) =>
          usageLimitSources.updateAccount(input),
      });
    }),
  );
