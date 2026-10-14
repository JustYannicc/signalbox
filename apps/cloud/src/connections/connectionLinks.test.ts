import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CloudTokens from "../auth/CloudTokens.ts";
import { makeRepo } from "../drive/driveTesting.ts";
import { makeFakeGitHub } from "../github/githubTesting.ts";
import { layerConfig, makeMemoryCloud } from "../testing.ts";
import { MAX_LINKS, signLinkToken, verifyLinkToken } from "./ConnectionLinks.ts";

const userId = "user_1";
const layerTokens = CloudTokens.layer.pipe(Layer.provide(layerConfig()));

const makeCloud = () => {
  const upstream = makeRepo();
  upstream.write("README.md", "hello\n");
  upstream.commit("first");
  const github = makeFakeGitHub({
    bare: upstream.dir,
    repository: "owner/repo",
    defaultBranch: "main",
  });
  return { upstream, github, cloud: makeMemoryCloud({ github: github.layer }) };
};

const created = (link: { readonly _tag: string; readonly secret?: string }) => {
  if (link._tag !== "created" || link.secret === undefined) throw new Error("no link created");
  return link.secret;
};

describe("connection links", () => {
  it.effect("let a tool use the user's GitHub until they revoke the link", () => {
    const { upstream, github, cloud } = makeCloud();
    return Effect.gen(function* () {
      const user = cloud.userDirectory.forUser(userId);
      yield* user.recordSignIn({ id: userId, email: "a@b.c" });
      const secret = created(yield* user.createConnectionLink("executor.example"));

      // The token names the user, and only this cloud's signature makes it one.
      const token = yield* signLinkToken(userId, secret);
      expect(yield* verifyLinkToken(token)).toEqual({ userId, secret });
      expect(yield* verifyLinkToken(`${token.slice(0, -2)}xx`)).toBeNull();
      expect(yield* verifyLinkToken(`sbcl_${btoa(userId)}.${secret}`)).toBeNull();
      expect(yield* verifyLinkToken(secret)).toBeNull();

      // Nothing connected yet: the link works, but there's no token to give.
      expect(yield* user.linkedConnections(secret)).toEqual({
        _tag: "connections",
        connections: [],
      });
      expect(yield* user.linkedToken({ secret, provider: "github" })).toEqual({
        _tag: "not_connected",
      });

      yield* user.beginGitHubConnect({ grantId: "g", returnTo: "https://cloud.test/cb" });
      github.authorize(userId);
      yield* user.completeGitHubConnect("g");
      expect(yield* user.linkedConnections(secret)).toEqual({
        _tag: "connections",
        connections: [{ provider: "github", account: "octo" }],
      });
      expect(yield* user.linkedToken({ secret, provider: "github" })).toEqual({
        _tag: "token",
        token: `gho_${userId}`,
        expiresAt: null,
      });
      expect(yield* user.linkedToken({ secret: "guess", provider: "github" })).toEqual({
        _tag: "invalid_link",
      });

      const [listed] = yield* user.connectionLinks();
      expect(listed).toMatchObject({ label: "executor.example" });
      expect(listed?.lastUsedAt).not.toBeNull();

      // A malformed id revokes nothing, rather than matching every link.
      yield* user.revokeConnectionLink("");
      yield* user.revokeConnectionLink("%");
      expect(yield* user.connectionLinks()).toHaveLength(1);

      yield* user.revokeConnectionLink(listed!.id);
      expect(yield* user.linkedConnections(secret)).toEqual({ _tag: "invalid_link" });
      expect(yield* user.linkedToken({ secret, provider: "github" })).toEqual({
        _tag: "invalid_link",
      });
    }).pipe(Effect.provide(layerTokens), Effect.ensuring(Effect.sync(upstream.cleanup)));
  });

  it.effect("stop at a handful of links per user", () => {
    const { upstream, cloud } = makeCloud();
    return Effect.gen(function* () {
      const user = cloud.userDirectory.forUser(userId);
      yield* user.recordSignIn({ id: userId, email: "a@b.c" });
      for (let i = 0; i < MAX_LINKS; i++) created(yield* user.createConnectionLink(""));
      expect(yield* user.createConnectionLink("one more")).toEqual({ _tag: "limit" });
      const [first] = yield* user.connectionLinks();
      expect(first?.label).toBe("Executor");
      yield* user.revokeConnectionLink(first!.id);
      created(yield* user.createConnectionLink("one more"));
    }).pipe(Effect.ensuring(Effect.sync(upstream.cleanup)));
  });
});
