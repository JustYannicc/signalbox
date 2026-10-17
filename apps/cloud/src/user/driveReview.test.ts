import { afterEach, describe, expect, it } from "@effect/vitest";
import { operations } from "@signalbox/api/catalog";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { GitHub } from "../github/GitHub.ts";
import { makeGitHubApi } from "../github/GitHubApi.ts";
import { GitHubConnection } from "../github/GitHubConnection.ts";
import * as RpcTest from "effect/rpc/RpcTest";

import { callOperation, type ApiCaller } from "../api/apiCall.ts";
import { makeMemoryCloud } from "../testing.ts";
import { makeRepo } from "../drive/driveTesting.ts";
import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { uploadPack } from "../drive/DriveUploads.ts";
import * as CloudRpc from "./rpc.ts";

const userId = "user_1";
const driveId = "my/personal/user_1";
const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const repos: Array<ReturnType<typeof makeRepo>> = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

const setup = (github?: Layer.Layer<GitHub>) =>
  Effect.gen(function* () {
    const cloud = makeMemoryCloud(github === undefined ? {} : { github });
    yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
    yield* cloud.userDirectory
      .forUser("user_2")
      .recordSignIn({ id: "user_2", email: "other@example.test" });
    const git = makeRepo();
    repos.push(git);
    git.write("file.txt", "before\n");
    const baseRef = git.commit("before");
    git.write("file.txt", "after\n");
    const headRef = git.commit("after");
    expect(
      (yield* uploadPack({ driveId, threadId: "t1", ...git.pack([headRef]) }).pipe(
        Effect.provide(cloud.drives.layer),
      ))._tag,
    ).toBe("ok");
    const input = {
      cwd: `/drives/${driveId}`,
      sourceKind: "branch-range",
      changeType: "change",
      baseRef,
      headRef,
      oldPath: "file.txt",
      newPath: "file.txt",
    } as const;
    const client = (who: string, scopes = [AuthOrchestrationReadScope, AuthFilesystemReadScope]) =>
      RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
        Effect.provide(
          Layer.mergeAll(
            CloudRpc.layerHandlers({ identity, userId: who, sid: "test-session" }),
            CloudRpc.layerScopeAuthorization(scopes),
          ).pipe(Layer.provide(cloud.layerFor(who))),
        ),
      );
    const call = (who: string, name: string, body: unknown) => {
      const operation = operations.find((entry) => entry.name === name);
      if (operation === undefined) throw new Error(`Missing operation ${name}`);
      const caller: ApiCaller = {
        userId: who,
        kind: "person",
        scopes: [AuthOrchestrationReadScope, AuthFilesystemReadScope],
        credentialId: "key-1",
      };
      return callOperation({ operation, body, caller, identity, follow: false }).pipe(
        Effect.provide(cloud.layerFor(who)),
      );
    };
    return { cloud, input, client, call };
  });

describe("cloud review reads", () => {
  it.effect("serves the client RPC and generated API with the same immutable contents", () =>
    Effect.gen(function* () {
      const { input, client, call } = yield* setup();
      const rpc = yield* client(userId);
      const expected = { oldContents: "before\n", newContents: "after\n" };
      expect(yield* rpc[WS_METHODS.reviewGetDiffFileContents](input)).toEqual(expected);
      expect(yield* call(userId, "review.getDiffFileContents", input)).toMatchObject({
        _tag: "json",
        status: 200,
        body: expected,
      });
      expect(yield* rpc[WS_METHODS.vcsListRefs]({ cwd: "/arbitrary/host/path" })).toMatchObject({
        isRepo: false,
        refs: [],
      });
    }),
  );

  it.effect("enforces filesystem scope and drive access even for known commit IDs", () =>
    Effect.gen(function* () {
      const { input, client, call } = yield* setup();
      const unscoped = yield* client(userId, [AuthOrchestrationReadScope]);
      const scopeError = yield* unscoped[WS_METHODS.reviewGetDiffFileContents](input).pipe(
        Effect.flip,
      );
      expect(scopeError._tag).toBe("EnvironmentAuthorizationError");
      const outsider = yield* client("user_2");
      const error = yield* outsider[WS_METHODS.reviewGetDiffFileContents](input).pipe(Effect.flip);
      expect(error._tag).toBe("GitCommandError");
      expect(error.message).not.toContain("before");
      const answer = yield* call("user_2", "review.getDiffFileContents", input);
      expect(answer._tag === "json" && answer.status).not.toBe(200);
      const ownerClient = yield* client(userId);
      const hostError = yield* ownerClient[WS_METHODS.reviewGetDiffFileContents]({
        ...input,
        cwd: "/arbitrary/host/path",
      }).pipe(Effect.flip);
      expect(hostError._tag).toBe("GitCommandError");
    }),
  );
  it.effect("rechecks a shared drive grant after warming the immutable blob cache", () =>
    Effect.gen(function* () {
      const { input, client, cloud } = yield* setup();
      const shared = "shared/personal/review";
      const owner = { userId, email: "a@b.c", name: null };
      const drive = yield* DriveDirectory.use((directory) =>
        Effect.succeed(directory.forDrive(shared)),
      ).pipe(Effect.provide(cloud.drives.layer));
      yield* drive.setup({
        name: "Review",
        members: [
          { ...owner, role: "manager" },
          { userId: "user_2", email: "other@example.test", name: null, role: "viewer" },
        ],
      });
      const git = makeRepo();
      repos.push(git);
      git.write("file.txt", "shared\n");
      const headRef = git.commit("shared");
      yield* uploadPack({ driveId: shared, threadId: "shared-t1", ...git.pack([headRef]) }).pipe(
        Effect.provide(cloud.drives.layer),
      );
      const request = {
        ...input,
        cwd: `/drives/${shared}`,
        changeType: "new",
        baseRef: null,
        headRef,
      } as const;
      const rpc = yield* client("user_2");
      expect(yield* rpc[WS_METHODS.reviewGetDiffFileContents](request)).toEqual({
        oldContents: "",
        newContents: "shared\n",
      });
      expect((yield* drive.unshare(owner, "user_2"))._tag).toBe("ok");
      const error = yield* rpc[WS_METHODS.reviewGetDiffFileContents](request).pipe(Effect.flip);
      expect(error._tag).toBe("GitCommandError");
      expect(error._tag === "GitCommandError" && error.detail).toContain("access");
    }),
  );
  it.effect("rechecks GitHub repository access before returning a cached local blob", () =>
    Effect.gen(function* () {
      let allowed = true;
      let checked = 0;
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          checked++;
          expect(request.headers.authorization).toBe("Bearer reader-token");
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify(
                allowed
                  ? {
                      id: 1,
                      full_name: "owner/repo",
                      name: "repo",
                      default_branch: "main",
                      html_url: "https://github.com/owner/repo",
                      clone_url: "https://github.com/owner/repo.git",
                      ssh_url: "git@github.com:owner/repo.git",
                    }
                  : {},
              ),
              { status: allowed ? 200 : 404, headers: { "content-type": "application/json" } },
            ),
          );
        }),
      );
      const github = Layer.succeed(GitHub, {
        api: makeGitHubApi(http),
        pipes: {
          authorizeUrl: () => Effect.die("unused"),
          disconnect: () => Effect.void,
          accessToken: () =>
            Effect.succeed({
              _tag: "active",
              token: Redacted.make("reader-token"),
              expiresAt: null,
              missingScopes: [],
            }),
        },
      });
      const { cloud, input, client } = yield* setup(github);
      yield* GitHubConnection.use((connection) =>
        connection.adopt({ login: "reader", githubUserId: 1 }),
      ).pipe(Effect.provide(cloud.layerFor(userId)));
      yield* DriveDirectory.use((directory) =>
        directory
          .forDrive(driveId)
          .setRemote({ provider: "github", repository: "owner/repo", defaultBranch: "main" }),
      ).pipe(Effect.provide(cloud.drives.layer));
      const rpc = yield* client(userId);
      expect(yield* rpc[WS_METHODS.reviewGetDiffFileContents](input)).toEqual({
        oldContents: "before\n",
        newContents: "after\n",
      });
      allowed = false;
      const error = yield* rpc[WS_METHODS.reviewGetDiffFileContents](input).pipe(Effect.flip);
      expect(error._tag).toBe("GitCommandError");
      expect(error._tag === "GitCommandError" && error.detail).toContain("access");
      expect(checked).toBe(2);
    }),
  );
});
