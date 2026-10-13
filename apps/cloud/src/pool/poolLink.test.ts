import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import { POOL_LINK_PATH } from "@t3tools/contracts/accountHub";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as RpcTest from "effect/rpc/RpcTest";

import * as Platform from "../platform.ts";
import { makeMemoryCloud } from "../testing.ts";
import * as CloudRpc from "../user/rpc.ts";
import { decodeLinkToken } from "./poolLink.ts";
import * as PoolLinks from "./PoolLinks.ts";

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const userId = "user_1";

const client = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
  const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudRpc.layerHandlers({ identity, userId }),
        CloudRpc.layerScopeAuthorization([
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
          AuthProvidersManageScope,
        ]),
      ).pipe(Layer.provide(cloud.layerFor(userId))),
    ),
  );

  /** A request on a link, the way the Worker hands it to the pool's object. */
  const onLink = (token: string, path: string, init?: RequestInit) =>
    Effect.promise(async () => {
      const decoded = decodeLinkToken(token);
      if (decoded === null) throw new Error("Malformed link token");
      const response = await cloud.pools.objectFor(decoded.objectName).api.linkFetch(
        decoded.secret,
        new Request(`https://cloud.test${POOL_LINK_PATH}${path}`, {
          ...init,
          headers: { authorization: `Bearer ${token}`, ...init?.headers },
        }),
      );
      return { status: response.status, body: (await response.json()) as any };
    });
  return { cloud, rpc, onLink };
});

const credential = (type: string, email: string) => ({
  name: `${type}-${email}.json`,
  content: JSON.stringify({ type, email, refresh_token: "rt" }),
});

const moveIn = (accounts: ReadonlyArray<ReturnType<typeof credential>>) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ accounts }),
});

describe("pool link", () => {
  it.live("receives a moved pool and runs its model requests", () =>
    Effect.gen(function* () {
      const { rpc, onLink, cloud } = yield* client;
      const received = yield* rpc[WS_METHODS.accountPoolReceive]({
        name: "Work",
        personal: false,
      });
      expect(received.personal).toBe(false);
      const listed = yield* rpc[WS_METHODS.accountPoolSubscribe]({}).pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      expect(listed[0]?.map((pool) => pool.name)).toEqual(["Personal", "Work"]);

      expect(yield* onLink(received.token, "")).toEqual({
        status: 200,
        body: { name: "Work", accounts: [] },
      });
      const moved = yield* onLink(
        received.token,
        "/accounts",
        moveIn([credential("claude", "a@x.test"), credential("codex", "b@x.test")]),
      );
      expect(moved).toEqual({
        status: 200,
        body: { imported: ["claude-a@x.test.json", "codex-b@x.test.json"], skipped: [] },
      });
      const info = yield* onLink(received.token, "");
      expect(info.body.accounts).toEqual([
        { name: "claude-a@x.test.json", type: "claude", disabled: false, signedOut: false },
        { name: "codex-b@x.test.json", type: "codex", disabled: false, signedOut: false },
      ]);

      // Model requests reach the pool's CLIProxyAPI with the pool's own key, never the link's.
      const answer = yield* onLink(received.token, "/v1/messages?beta=true", {
        method: "POST",
        body: '{"model":"claude"}',
      });
      expect(answer.status).toBe(200);
      expect(answer.body.path).toBe("/v1/messages");
      expect(answer.body.body).toBe('{"model":"claude"}');
      expect(answer.body.authorization).toMatch(/^Bearer [0-9a-f]{64}$/u);
      expect(answer.body.authorization).not.toContain(received.token);

      const object = cloud.pools.objectFor(decodeLinkToken(received.token)!.objectName);
      expect([...object.cliProxyApi.accounts.keys()]).toEqual([
        "claude-a@x.test.json",
        "codex-b@x.test.json",
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("takes all of a move or none of it", () =>
    Effect.gen(function* () {
      const { rpc, onLink, cloud } = yield* client;
      const { token } = yield* rpc[WS_METHODS.accountPoolReceive]({
        name: "Work",
        personal: false,
      });
      const object = cloud.pools.objectFor(decodeLinkToken(token)!.objectName);

      const unsupported = yield* onLink(
        token,
        "/accounts",
        moveIn([credential("claude", "a@x.test"), credential("xai", "c@x.test")]),
      );
      expect(unsupported.status).toBe(403);
      expect(unsupported.body.error.message).toBe(
        "xai-c@x.test.json is an account Signalbox Cloud pools can't hold yet.",
      );

      const refused = yield* onLink(
        token,
        "/accounts",
        moveIn([credential("claude", "a@x.test"), credential("claude", "refused@example.test")]),
      );
      expect(refused.status).toBe(502);
      expect(object.cliProxyApi.accounts.size).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.live("joins a personal pool to Personal and keeps the account it already holds", () =>
    Effect.gen(function* () {
      const { rpc, onLink } = yield* client;
      const first = yield* rpc[WS_METHODS.accountPoolReceive]({
        name: "Personal",
        personal: true,
      });
      expect(first).toMatchObject({ poolId: "personal", personal: true });
      yield* onLink(first.token, "/accounts", moveIn([credential("claude", "a@x.test")]));

      const again = yield* rpc[WS_METHODS.accountPoolReceive]({ name: "Mine", personal: true });
      const moved = yield* onLink(
        again.token,
        "/accounts",
        moveIn([credential("claude", "a@x.test"), credential("codex", "b@x.test")]),
      );
      expect(moved.body).toEqual({
        imported: ["codex-b@x.test.json"],
        skipped: ["claude-a@x.test.json"],
      });
      const listed = yield* rpc[WS_METHODS.accountPoolSubscribe]({}).pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      expect(listed[0]?.map((pool) => pool.name)).toEqual(["Personal"]);
    }).pipe(Effect.scoped),
  );

  it.live("refuses a link it doesn't know", () =>
    Effect.gen(function* () {
      const { rpc, onLink } = yield* client;
      const { token } = yield* rpc[WS_METHODS.accountPoolReceive]({
        name: "Work",
        personal: false,
      });
      const forged = `${token.slice(0, token.lastIndexOf(".") + 1)}${"0".repeat(64)}`;
      const denied = yield* onLink(forged, "/v1/messages", { method: "POST", body: "{}" });
      expect(denied).toEqual({
        status: 401,
        body: {
          type: "error",
          error: { type: "authentication_error", message: "This pool link no longer works." },
        },
      });
      // Codex speaks OpenAI's API, so its errors come back in that shape.
      const codex = yield* onLink(forged, "/v1/responses", { method: "POST", body: "{}" });
      expect(codex.body.error).toMatchObject({
        message: "This pool link no longer works.",
        code: "invalid_api_key",
      });
      expect(decodeLinkToken("sk-not-a-link")).toBeNull();
    }).pipe(Effect.scoped),
  );
});

describe("PoolLinks", () => {
  it.effect("takes accounts only right after it is made, and lapses unless a move landed", () =>
    Effect.gen(function* () {
      const links = yield* PoolLinks.PoolLinks;
      const moved = yield* links.open(userId);
      const abandoned = yield* links.open(userId);
      expect(yield* links.resolve(moved)).toEqual({ userId, moveOpen: true });
      yield* links.claim(moved);
      yield* TestClock.adjust(PoolLinks.MOVE_WINDOW_MS);
      expect(yield* links.resolve(moved)).toEqual({ userId, moveOpen: false });
      expect(yield* links.resolve(abandoned)).toBeNull();
      expect(yield* links.resolve("unknown")).toBeNull();
    }).pipe(
      Effect.provide(
        Layer.effectDiscard(PoolLinks.createTables).pipe(
          Layer.provideMerge(PoolLinks.layer),
          Layer.provideMerge(
            Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), Platform.layerCrypto),
          ),
        ),
      ),
    ),
  );
});
