import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  RpcScopeAuthorization,
} from "@t3tools/contracts";
import {
  SIGNALBOX_PERSON_BROWSER_RPCS,
  SIGNALBOX_PERSON_BROWSER_WS_METHODS,
} from "@t3tools/contracts/signalboxPersonBrowser";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import { signalboxPersonBrowserWsHandlers } from "./rpc.ts";

const group = RpcGroup.make(...SIGNALBOX_PERSON_BROWSER_RPCS).middleware(RpcScopeAuthorization);
const handlers = group.toLayer(signalboxPersonBrowserWsHandlers);

it.effect("reports the cloud profile unavailable on self-hosted servers and refuses clearing", () =>
  Effect.gen(function* () {
    const rpc = yield* RpcTest.makeClient(group);
    expect(yield* rpc[SIGNALBOX_PERSON_BROWSER_WS_METHODS.profileStatus]({})).toEqual({
      available: false,
    });
    expect(
      yield* Effect.flip(rpc[SIGNALBOX_PERSON_BROWSER_WS_METHODS.clearProfile]({})),
    ).toMatchObject({
      _tag: "SignalboxPersonBrowserError",
      message: "The cloud browser profile is part of Signalbox Cloud.",
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        handlers,
        RpcAuthorization.layer([AuthOrchestrationReadScope, AuthPreviewOperateScope]),
      ),
    ),
  ),
);

it.effect("requires preview permission for the destructive RPC", () =>
  Effect.gen(function* () {
    const rpc = yield* RpcTest.makeClient(group);
    const failure = yield* Effect.flip(rpc[SIGNALBOX_PERSON_BROWSER_WS_METHODS.clearProfile]({}));
    expect(failure).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: AuthPreviewOperateScope,
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(handlers, RpcAuthorization.layer([AuthOrchestrationReadScope]))),
  ),
);
