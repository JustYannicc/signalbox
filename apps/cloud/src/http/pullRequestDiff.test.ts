import {
  AuthOrchestrationReadScope,
  type PullRequestDiffInput,
  type PullRequestDiffResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpRouter } from "effect/http";
import * as Layer from "effect/Layer";

import * as CloudSessions from "../auth/CloudSessions.ts";
import * as CloudTokens from "../auth/CloudTokens.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import * as Platform from "../platform.ts";
import { CLOUD_TEST_ENV, layerConfig, makeMemoryCloud } from "../testing.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import * as EnvironmentApi from "./environmentApi.ts";

const USER_ID = "user_pull_request_http";
const INPUT: PullRequestDiffInput = {
  projectId: "project_1" as PullRequestDiffInput["projectId"],
  host: "github.com",
  repository: "acme/widgets",
  number: 42,
  commit: "abc123",
};
const DIFF: PullRequestDiffResult = {
  patch: "diff --git a/src/a.ts b/src/a.ts\n",
  truncated: false,
  nextCursor: null,
};

const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  yield* cloud.userDirectory.forUser(USER_ID).recordSignIn({
    id: USER_ID,
    email: "pr@example.test",
  });

  let reply:
    | { readonly _tag: "success"; readonly value: PullRequestDiffResult }
    | { readonly _tag: "unavailable"; readonly reason: "provider-unsupported" } = {
    _tag: "success",
    value: DIFF,
  };
  const users = UserDirectory.UserDirectory.of({
    ...cloud.userDirectory,
    forUser: (userId) => {
      const handle = cloud.userDirectory.forUser(userId);
      return {
        ...handle,
        pullRequestDiff: () => Effect.succeed(reply),
      };
    },
  });
  const usersLayer = Layer.succeed(UserDirectory.UserDirectory, users);
  const tokensLayer = CloudTokens.layerSessionSecret.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: CLOUD_TEST_ENV }))),
    Layer.orDie,
  );
  const cloudContext = yield* Layer.build(cloud.userObject(USER_ID));
  const threadServiceLayer = Layer.succeed(
    CloudThreadService.CloudThreadService,
    Context.get(cloudContext, CloudThreadService.CloudThreadService),
  );
  const services = Layer.mergeAll(layerConfig(), threadServiceLayer).pipe(
    Layer.provideMerge(CloudSessions.layer),
    Layer.provideMerge(tokensLayer),
    Layer.provideMerge(usersLayer),
  );
  const context = yield* Layer.build(services);
  const sessions = Context.get(context, CloudSessions.CloudSessions);
  const { token } = yield* sessions.create({ userId: USER_ID, method: "bearer-access-token" });
  const unscopedRecord = yield* users.forUser(USER_ID).createSession({
    method: "bearer-access-token",
    scopes: [],
    ttlMs: 60_000,
  });
  const tokens = Context.get(context, CloudTokens.CloudTokens);
  const unscopedToken = yield* tokens.sign({
    _tag: "session",
    u: USER_ID,
    sid: unscopedRecord.sid,
    exp: unscopedRecord.expiresAt,
  });

  const routes = EnvironmentApi.layer.pipe(Layer.provide(services));
  const httpEffect = yield* HttpRouter.toHttpEffect(routes).pipe(
    Effect.provide(Platform.layerHttp),
  );
  const handler = HttpEffect.toWebHandler(httpEffect);
  const post = (authorization?: string) =>
    Effect.promise(() =>
      handler(
        new Request("https://cloud.test/api/pull-requests/diff", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authorization === undefined ? {} : { authorization }),
          },
          body: JSON.stringify(INPUT),
        }),
      ),
    );
  return {
    post,
    token,
    unscopedToken,
    setReply: (next: typeof reply) => {
      reply = next;
    },
  };
});

describe("cloud pull-request diff HTTP route", () => {
  it.effect("requires an authenticated session", () =>
    Effect.gen(function* () {
      const { post } = yield* setup;
      const response = yield* post();

      expect(response.status).toBe(401);
    }).pipe(Effect.scoped),
  );

  it.effect("requires orchestration read scope", () =>
    Effect.gen(function* () {
      const { post, unscopedToken } = yield* setup;
      const response = yield* post(`Bearer ${unscopedToken}`);

      expect(response.status).toBe(403);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        _tag: "EnvironmentScopeRequiredError",
        requiredScope: AuthOrchestrationReadScope,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("returns the requested diff from the user's object", () =>
    Effect.gen(function* () {
      const { post, token } = yield* setup;
      const response = yield* post(`Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual(DIFF);
    }).pipe(Effect.scoped),
  );

  it.effect("preserves a typed provider refusal", () =>
    Effect.gen(function* () {
      const { post, token, setReply } = yield* setup;
      setReply({ _tag: "unavailable", reason: "provider-unsupported" });
      const response = yield* post(`Bearer ${token}`);

      expect(response.status).toBe(503);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        _tag: "PullRequestUnavailableError",
        reason: "provider-unsupported",
      });
    }).pipe(Effect.scoped),
  );
});
