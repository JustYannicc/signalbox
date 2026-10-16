import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
  EnvironmentId,
} from "@t3tools/contracts";
import { SIGNALBOX_FOLDERS_WS_METHODS } from "@t3tools/contracts/signalboxFolders";
import {
  SIGN_IN_EVERYWHERE,
  SIGNALBOX_SIGN_IN_WS_METHODS,
  type SignInGrants,
} from "@t3tools/contracts/signalboxSignIn";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import { makeMemoryCloud } from "../testing.ts";
import * as CloudRpc from "../user/rpc.ts";
import { MAX_GRANTS } from "./SignInGrants.ts";

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const userId = "user_1";
const person = { _tag: "person" } as const;

const connect = (
  scopes: ReadonlyArray<AuthEnvironmentScope> = [
    AuthOrchestrationReadScope,
    AuthOrchestrationOperateScope,
    AuthSettingsWriteScope,
  ],
) =>
  Effect.gen(function* () {
    const cloud = makeMemoryCloud();
    yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
    const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
      Effect.provide(
        Layer.mergeAll(
          CloudRpc.layerHandlers({ identity, userId, sid: "test-session" }),
          CloudRpc.layerScopeAuthorization(scopes),
        ).pipe(Layer.provide(cloud.layerFor(userId))),
      ),
    );
    return { cloud, rpc, user: cloud.userDirectory.forUser(userId) };
  });

const sites = (list: SignInGrants) => list.grants.map((grant) => grant.site);
const failureMessage = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? String((exit.cause as { toString(): string }).toString()) : "succeeded";

describe("sign-in grants", () => {
  it.effect("ask per site until the person grants a site or everywhere, and stop on revoke", () =>
    Effect.gen(function* () {
      const { rpc } = yield* connect();
      const check = (origin: string) =>
        rpc[SIGNALBOX_SIGN_IN_WS_METHODS.check]({ source: person, origin });

      // No grants: every site asks, offering the address its accounts share.
      expect(yield* check("https://accounts.example.com/login")).toEqual({
        _tag: "ask",
        site: "example.com",
      });

      const afterSite = yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.grant]({
        source: person,
        site: "https://www.example.com/",
      });
      expect(sites(afterSite)).toEqual(["example.com"]);
      const [siteGrant] = afterSite.grants;
      expect(siteGrant).toMatchObject({ source: person, site: "example.com", grantedBy: userId });

      const allowed = yield* check("https://accounts.example.com/login");
      expect(allowed).toEqual({ _tag: "allowed", grant: siteGrant });
      expect(yield* check("https://booking.com")).toEqual({ _tag: "ask", site: "booking.com" });
      // A lookalike is another site.
      expect(yield* check("https://example.com.evil.test")).toEqual({
        _tag: "ask",
        site: "evil.test",
      });

      // Granting what's already granted changes nothing.
      expect(
        yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.grant]({ source: person, site: "example.com" }),
      ).toEqual(afterSite);

      const afterEverywhere = yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.grant]({
        source: person,
        site: SIGN_IN_EVERYWHERE,
      });
      expect(sites(afterEverywhere)).toEqual([SIGN_IN_EVERYWHERE, "example.com"]);
      const everywhere = afterEverywhere.grants[0];
      expect(yield* check("https://booking.com")).toEqual({ _tag: "allowed", grant: everywhere });
      // The narrowest grant answers, so it's clear which one to revoke.
      expect(yield* check("https://example.com")).toEqual({ _tag: "allowed", grant: siteGrant });

      // Switching everywhere off leaves the per-site grants.
      const afterOff = yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.revoke]({ id: everywhere!.id });
      expect(sites(afterOff)).toEqual(["example.com"]);
      expect(yield* check("https://booking.com")).toEqual({ _tag: "ask", site: "booking.com" });
      expect(yield* check("https://example.com")).toEqual({ _tag: "allowed", grant: siteGrant });

      expect(sites(yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.revoke]({ id: siteGrant!.id }))).toEqual(
        [],
      );
      expect(yield* check("https://example.com")).toEqual({ _tag: "ask", site: "example.com" });

      // Revoking twice, or a made-up id, changes nothing.
      expect(sites(yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.revoke]({ id: siteGrant!.id }))).toEqual(
        [],
      );
      expect(sites(yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.revoke]({ id: "nope" }))).toEqual([]);

      // Granting again after a revoke is a new grant.
      const again = yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.grant]({
        source: person,
        site: "example.com",
      });
      expect(again.grants[0]?.id).not.toBe(siteGrant!.id);
    }),
  );

  it.effect("refuse sites that aren't one site, and origins that can't sign in", () =>
    Effect.gen(function* () {
      const { rpc } = yield* connect();
      for (const site of ["", "com", "github.io", "localhost", "*.example.com"]) {
        const exit = yield* Effect.exit(
          rpc[SIGNALBOX_SIGN_IN_WS_METHODS.grant]({ source: person, site }),
        );
        expect(failureMessage(exit), site).toContain("like example.com");
      }
      for (const origin of ["about:blank", "http://localhost:3000"]) {
        const exit = yield* Effect.exit(
          rpc[SIGNALBOX_SIGN_IN_WS_METHODS.check]({ source: person, origin }),
        );
        expect(failureMessage(exit), origin).toContain("like example.com");
      }
    }),
  );

  it.effect("keep a folder's grants to that folder, and only for folders in your tree", () =>
    Effect.gen(function* () {
      const { rpc } = yield* connect();
      const tree = yield* rpc[SIGNALBOX_FOLDERS_WS_METHODS.create]({
        name: "Acme",
        parentId: null,
      });
      const folderId = tree.folders[0]!.id;
      const folder = { _tag: "folder", folderId } as const;

      yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.grant]({ source: folder, site: SIGN_IN_EVERYWHERE });
      expect(
        yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.check]({
          source: folder,
          origin: "https://booking.com",
        }),
      ).toMatchObject({ _tag: "allowed", grant: { source: folder, site: SIGN_IN_EVERYWHERE } });
      // The folder's grant is never the person's.
      expect(
        yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.check]({
          source: person,
          origin: "https://booking.com",
        }),
      ).toEqual({ _tag: "ask", site: "booking.com" });

      const unknown = yield* Effect.exit(
        rpc[SIGNALBOX_SIGN_IN_WS_METHODS.grant]({
          source: { _tag: "folder", folderId: "folder-elsewhere" as typeof folderId },
          site: "example.com",
        }),
      );
      expect(failureMessage(unknown)).toContain("folder");
    }),
  );

  it.effect("serve the login service: the person's grants only for turns they requested", () =>
    Effect.gen(function* () {
      const { rpc, user } = yield* connect();
      yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.grant]({ source: person, site: SIGN_IN_EVERYWHERE });

      expect(
        yield* user.checkSignIn({ requester: userId, source: person, origin: "https://x.test" }),
      ).toMatchObject({ _tag: "allowed", grant: { site: SIGN_IN_EVERYWHERE } });
      // Another member's turn in a shared thread never signs in as this person.
      expect(
        yield* user.checkSignIn({
          requester: "user_2",
          source: person,
          origin: "https://x.test",
        }),
      ).toEqual({ _tag: "not-owner" });
      expect(
        yield* user.checkSignIn({ requester: userId, source: person, origin: "about:blank" }),
      ).toMatchObject({ _tag: "refused" });

      // A folder's grants decide for its turns whoever is talking.
      const tree = yield* rpc[SIGNALBOX_FOLDERS_WS_METHODS.create]({
        name: "Acme",
        parentId: null,
      });
      const folder = { _tag: "folder", folderId: tree.folders[0]!.id } as const;
      expect(
        yield* user.checkSignIn({ requester: "user_2", source: folder, origin: "https://x.test" }),
      ).toEqual({ _tag: "ask", site: "x.test" });
      yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.grant]({ source: folder, site: "x.test" });
      for (const requester of [userId, "user_2"]) {
        expect(
          yield* user.checkSignIn({ requester, source: folder, origin: "https://x.test" }),
        ).toMatchObject({ _tag: "allowed", grant: { site: "x.test" } });
      }
    }),
  );

  it.effect("show every device the grants as they change", () =>
    Effect.gen(function* () {
      const { rpc } = yield* connect();
      const seen = yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.subscribe]({}).pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      const granted = yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.grant]({
        source: person,
        site: "example.com",
      });
      yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.revoke]({ id: granted.grants[0]!.id });
      const lists = yield* Fiber.join(seen);
      expect(lists.map(sites)).toEqual([[], ["example.com"], []]);
    }),
  );

  it.effect("cap how many grants one person keeps", () =>
    Effect.gen(function* () {
      const { rpc } = yield* connect();
      for (let index = 0; index < MAX_GRANTS; index += 1) {
        yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.grant]({
          source: person,
          site: `site-${index}.test`,
        });
      }
      const exit = yield* Effect.exit(
        rpc[SIGNALBOX_SIGN_IN_WS_METHODS.grant]({ source: person, site: "one-more.test" }),
      );
      expect(failureMessage(exit)).toContain("Revoke");
    }),
  );

  it.effect("need the settings scope to grant or revoke, and only reading to check", () =>
    Effect.gen(function* () {
      const { rpc } = yield* connect([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
      const exit = yield* Effect.exit(
        rpc[SIGNALBOX_SIGN_IN_WS_METHODS.grant]({ source: person, site: SIGN_IN_EVERYWHERE }),
      );
      expect(failureMessage(exit)).toContain(AuthSettingsWriteScope);
      expect(
        yield* rpc[SIGNALBOX_SIGN_IN_WS_METHODS.check]({
          source: person,
          origin: "https://example.com",
        }),
      ).toEqual({ _tag: "ask", site: "example.com" });
    }),
  );
});
