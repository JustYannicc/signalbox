import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  SectionsWsRpcGroup,
  WS_METHODS,
} from "@t3tools/contracts";
import type { SectionsSnapshot } from "@t3tools/contracts/sections";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Sections from "./Sections.ts";
import * as SectionsStore from "./SectionsStore.ts";
import * as SectionsRpc from "./rpc.ts";

const group = SectionsWsRpcGroup;

const layerState = Sections.layer.pipe(
  Layer.provide(SectionsStore.layer),
  Layer.provide(ProjectStore.layer),
  Layer.provide(Sqlite.layerMemory),
  Layer.provide(NodeCrypto.layer),
);
const layerHandlers = group
  .toLayer(SectionsRpc.makeSectionsWsHandlers)
  .pipe(Layer.provide(layerState));

it.effect("pushes a committed section change to two independent RPC clients", () =>
  Effect.gen(function* () {
    const first = yield* RpcTest.makeClient(group);
    const second = yield* RpcTest.makeClient(group);
    const firstUpdates = yield* Queue.unbounded<SectionsSnapshot>();
    const secondUpdates = yield* Queue.unbounded<SectionsSnapshot>();
    yield* first[WS_METHODS.sectionsSubscribe]({}).pipe(
      Stream.runForEach((snapshot) => Queue.offer(firstUpdates, snapshot)),
      Effect.forkChild,
    );
    yield* second[WS_METHODS.sectionsSubscribe]({}).pipe(
      Stream.runForEach((snapshot) => Queue.offer(secondUpdates, snapshot)),
      Effect.forkChild,
    );
    expect((yield* Queue.take(firstUpdates)).sections).toEqual([]);
    expect((yield* Queue.take(secondUpdates)).sections).toEqual([]);

    const created = yield* first[WS_METHODS.sectionsCreate]({ name: "Work", parentId: null });
    expect(yield* Queue.take(firstUpdates)).toEqual(created);
    expect(yield* Queue.take(secondUpdates)).toEqual(created);

    const renamed = yield* second[WS_METHODS.sectionsUpdate]({
      id: created.sections[0]!.id,
      name: "Personal",
    });
    expect(yield* Queue.take(firstUpdates)).toEqual(renamed);
    expect(yield* Queue.take(secondUpdates)).toEqual(renamed);
    expect(renamed.sections[0]?.name).toBe("Personal");
    expect(renamed.revision).toBeGreaterThan(created.revision);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        layerHandlers,
        RpcAuthorization.layer([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
      ),
    ),
  ),
);

it.effect("allows reading sections without granting organization changes", () =>
  Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(group);
    const initial = yield* client[WS_METHODS.sectionsSubscribe]({}).pipe(Stream.runHead);
    expect(initial).toMatchObject({ _tag: "Some", value: { sections: [] } });
    const denied = yield* client[WS_METHODS.sectionsCreate]({
      name: "Work",
      parentId: null,
    }).pipe(Effect.flip);
    expect(denied).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredScope: AuthOrchestrationOperateScope,
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(layerHandlers, RpcAuthorization.layer([AuthOrchestrationReadScope])),
    ),
  ),
);

it.effect("returns typed move errors without damaging the existing tree", () =>
  Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(group);
    const before = yield* client[WS_METHODS.sectionsCreate]({ name: "Work", parentId: null });
    const id = before.sections[0]!.id;
    const failure = yield* client[WS_METHODS.sectionsMove]({ id, parentId: id }).pipe(Effect.flip);
    expect(failure).toMatchObject({ _tag: "SectionsRpcError", code: "invalid-move" });
    const after = yield* client[WS_METHODS.sectionsSubscribe]({}).pipe(Stream.runHead);
    expect(after).toMatchObject({ _tag: "Some", value: before });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        layerHandlers,
        RpcAuthorization.layer([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
      ),
    ),
  ),
);
