import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";

import { createLocalPool } from "./LocalPool.ts";
import * as PoolDirectory from "./PoolDirectory.ts";
import { PoolBackendError } from "./cliProxyApi.ts";

const ownerId = "local:owner";
const owner = { userId: ownerId };
const personalObjectName = PoolDirectory.poolObjectName(ownerId, "personal");

describe("LocalPool", () => {
  it.effect(
    "creates the real personal pool and dispatches only registered local model requests",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sent: Array<{ readonly body: string; readonly header: string | null }> = [];
          const pool = yield* createLocalPool({
            sql: NodeSqliteClient.layer({ filename: ":memory:" }),
            ownerId,
            transport: {
              id: "local",
              models: [{ id: "claude-local-model", ownedBy: "anthropic", created: null }],
              fetch: async (request) => {
                sent.push({
                  body: await request.clone().text(),
                  header: request.headers.get("x-local-request"),
                });
                return new Response("local answer", { status: 201 });
              },
            },
          });
          const personal = pool.directory.forPool(personalObjectName);
          yield* personal.create(owner, { name: "Personal", personal: true });
          yield* pool.register;

          const models = yield* personal.models(owner);
          const accounts = yield* personal.accounts(owner);
          expect(accounts.accounts).toEqual([]);
          expect(models.models).toMatchObject([
            {
              id: "claude-local-model",
              ownedBy: "anthropic",
              registration: { kind: "local", transportId: "local" },
            },
          ]);

          const unserved = yield* Effect.flip(
            Effect.tryPromise({
              try: () =>
                pool.fetch(
                  new Request("https://pool.test/v1/messages", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ model: "not-registered", messages: [] }),
                  }),
                ),
              catch: (cause) => new PoolBackendError({ detail: String(cause), cause }),
            }),
          );
          expect(String(unserved)).toContain("does not serve model");
          expect(sent).toEqual([]);

          const body = JSON.stringify({
            model: "claude-local-model",
            messages: [{ role: "user" }],
          });
          const response = yield* Effect.promise(() =>
            pool.fetch(
              new Request("https://pool.test/v1/messages?beta=true", {
                method: "POST",
                headers: { "content-type": "application/json", "x-local-request": "kept" },
                body,
              }),
            ),
          );
          expect(response.status).toBe(201);
          expect(yield* Effect.promise(() => response.text())).toBe("local answer");
          expect(sent).toEqual([{ body, header: "kept" }]);

          const denied = yield* Effect.flip(personal.models({ userId: "another-local-user" }));
          expect(denied._tag).toBe("PoolRejectedError");
          const otherPool = yield* Effect.flip(
            pool.directory.forPool("some-other-pool").info(owner),
          );
          expect(otherPool._tag).toBe("PoolRejectedError");
        }),
      ),
  );
});
