import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentId,
  WS_METHODS,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { makeMemoryCloud } from "../testing.ts";
import * as CloudRpc from "./rpc.ts";
import * as UserKeybindings from "./UserKeybindings.ts";

const scopes = [AuthOrchestrationReadScope, AuthSettingsWriteScope];
const command = "commandPalette.toggle" as const;
const custom = { key: "mod+shift+k", command, when: "!terminalFocus" };
const connect = (
  cloud: ReturnType<typeof makeMemoryCloud>,
  userId: string,
  permissions: readonly AuthEnvironmentScope[] = scopes,
) =>
  Effect.gen(function* () {
    yield* cloud.userDirectory
      .forUser(userId)
      .recordSignIn({ id: userId, email: `${userId}@example.test` });
    return yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
      Effect.provide(
        Layer.mergeAll(
          CloudRpc.layerHandlers({
            identity: { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" },
            userId,
            sid: "keybindings-test",
          }),
          CloudRpc.layerScopeAuthorization(permissions),
        ).pipe(Layer.provide(cloud.layerFor(userId))),
      ),
    );
  });

describe("cloud keybinding RPC", () => {
  it.effect("saves and streams a person's replacement, then removing it restores the default", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      const writer = yield* connect(cloud, "alice");
      const reader = yield* connect(cloud, "alice");
      const ready = yield* Deferred.make<void>();
      const received = yield* reader[WS_METHODS.subscribeServerConfig]({}).pipe(
        Stream.tap((event) =>
          event.type === "snapshot" ? Deferred.succeed(ready, undefined) : Effect.void,
        ),
        Stream.filter((event) => event.type === "keybindingsUpdated"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(ready);
      const saved = yield* writer[WS_METHODS.serverUpsertKeybinding]({
        ...custom,
        replace: { key: "mod+k", command, when: "!terminalFocus" },
      });
      const palette = saved.keybindings.filter((binding) => binding.command === command);
      expect(palette).toHaveLength(1);
      expect(palette[0]?.shortcut).toMatchObject({ key: "k", modKey: true, shiftKey: true });
      const [update] = yield* Fiber.join(received);
      expect(update).toMatchObject({ type: "keybindingsUpdated", payload: saved });
      const reopened = yield* connect(cloud, "alice");
      expect((yield* reopened[WS_METHODS.serverGetConfig]({})).keybindings).toEqual(
        saved.keybindings,
      );
      const other = yield* connect(cloud, "bob");
      expect((yield* other[WS_METHODS.serverGetConfig]({})).keybindings).toEqual(
        DEFAULT_RESOLVED_KEYBINDINGS,
      );
      const removed = yield* reader[WS_METHODS.serverRemoveKeybinding](custom);
      expect(removed.keybindings).toEqual(DEFAULT_RESOLVED_KEYBINDINGS);
      expect((yield* writer[WS_METHODS.serverGetConfig]({})).keybindings).toEqual(
        DEFAULT_RESOLVED_KEYBINDINGS,
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps concurrent edits and exact replacements without duplicating a retried save",
    () =>
      Effect.gen(function* () {
        const cloud = makeMemoryCloud();
        const rpc = yield* connect(cloud, "alice");
        const second = { command: "sidebar.toggle", key: "mod+shift+b" } as const;
        yield* Effect.all(
          [
            rpc[WS_METHODS.serverUpsertKeybinding](custom),
            rpc[WS_METHODS.serverUpsertKeybinding](second),
          ],
          { concurrency: "unbounded" },
        );
        const replacement = { command, key: "mod+alt+k", when: custom.when };
        yield* rpc[WS_METHODS.serverUpsertKeybinding]({ ...replacement, replace: custom });
        yield* rpc[WS_METHODS.serverUpsertKeybinding]({ ...replacement, replace: custom });
        const { keybindings } = yield* rpc[WS_METHODS.serverGetConfig]({});
        expect(keybindings.filter((binding) => binding.command === command)).toMatchObject([
          { shortcut: { altKey: true, shiftKey: false } },
        ]);
        expect(keybindings.filter((binding) => binding.command === "sidebar.toggle")).toMatchObject(
          [{ shortcut: { shiftKey: true } }],
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses writes without settings permission and rejects invalid shortcuts or conditions",
    () =>
      Effect.gen(function* () {
        const cloud = makeMemoryCloud();
        const readonly = yield* connect(cloud, "alice", [AuthOrchestrationReadScope]);
        for (const method of [
          WS_METHODS.serverUpsertKeybinding,
          WS_METHODS.serverRemoveKeybinding,
        ]) {
          expect(yield* readonly[method](custom).pipe(Effect.flip)).toMatchObject({
            _tag: "EnvironmentAuthorizationError",
            requiredScope: AuthSettingsWriteScope,
          });
        }
        const writer = yield* connect(cloud, "alice");
        for (const invalid of [
          { ...custom, key: "ctrl+not-a-modifier+k" },
          { ...custom, when: "composerFocus &&" },
        ]) {
          expect(
            yield* writer[WS_METHODS.serverUpsertKeybinding](invalid).pipe(Effect.flip),
          ).toMatchObject({ _tag: "KeybindingsConfigParseError" });
        }
        expect((yield* writer[WS_METHODS.serverGetConfig]({})).keybindings).toEqual(
          DEFAULT_RESOLVED_KEYBINDINGS,
        );
      }).pipe(Effect.scoped),
  );

  it.effect("preserves opaque newer rules and fields when another binding is edited", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      const rpc = yield* connect(cloud, "alice");
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const future = { command: "future.command", key: "mod+j", future: true };
        const known = { command: "sidebar.toggle", key: "mod+b", future: "kept" };
        const value = JSON.stringify([future, known]);
        yield* sql`INSERT INTO user_keybindings (id, revision, value) VALUES (1, 7, ${value})`;
        yield* rpc[WS_METHODS.serverUpsertKeybinding](custom);
        const rows = yield* sql<{ value: string }>`SELECT value FROM user_keybindings WHERE id = 1`;
        expect(JSON.parse(rows[0]!.value)).toEqual([future, known, custom]);
        const service = yield* UserKeybindings.UserKeybindings;
        expect((yield* service.snapshot).revision).toBe(8);
      }).pipe(Effect.provide(cloud.userObject("alice")));
    }).pipe(Effect.scoped),
  );
});
