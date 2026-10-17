// @effect-diagnostics nodeBuiltinImport:off - publication tests send real packs to a bare git repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  SourceControlProviderKind,
  WS_METHODS,
  type SourceControlPublishRepositoryInput,
} from "@t3tools/contracts";
import type { SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import { afterEach, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import { handleFor } from "../drive/DriveDirectory.ts";
import { machineRef, threadRef, wipRef } from "../drive/DriveStore.ts";
import { makeRepo } from "../drive/driveTesting.ts";
import { uploadPack } from "../drive/DriveUploads.ts";
import { makeMemoryCloud } from "../testing.ts";
import * as CloudRpc from "../user/rpc.ts";
import { makeFakeGitHub } from "./githubTesting.ts";

export const USER = "user_1";
export const DRIVE = "folder/personal/publication";
export const CWD = `/drives/${DRIVE}`;
export const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
export const scopes = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const unavailable = () => json({ message: "Reply lost" }, 503);

export const publicationFixture = (
  options: {
    readonly repository?: string;
    readonly role?: SignalboxDriveRole | null;
    readonly history?: boolean;
    readonly connected?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const repository = options.repository ?? "octo/new-project";
    const bare = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "publication-bare-"));
    cleanups.push(() => NodeFS.rmSync(bare, { recursive: true, force: true }));
    const git = (args: ReadonlyArray<string>, input?: Uint8Array) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd: bare,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        input,
      });
    git(["init", "--bare", "-q", "--initial-branch=main"]);
    const source = makeRepo();
    cleanups.push(source.cleanup);
    source.write("old.txt", "original bytes\n");
    const first = source.commit("first main commit");
    source.git(["rm", "old.txt"]);
    source.write("README.md", "current main bytes\n");
    const main = source.commit("second main commit");
    source.write("thread.txt", "thread-only committed work\n");
    const thread = source.commit("thread commit");
    source.write("draft.txt", "private unfinished work\n");
    const wip = source.commit("autosave");

    const repositories = new Map<
      string,
      {
        id: number;
        full_name: string;
        name: string;
        private: boolean;
        description: string | null;
        default_branch: string;
        html_url: string;
        clone_url: string;
        ssh_url: string;
      }
    >();
    const creations: Array<{ path: string; input: Record<string, unknown> }> = [];
    const settings = {
      accountId: 1,
      accountLogin: "octo",
      loseCreateReply: false,
      losePushReply: false,
      loseRecoveryHead: false,
      failPush: false,
      failCleanup: false,
      failRepositoryReads: false,
      failBranchReads: false,
      branchConflict: null as string | null,
    };
    const repositoryJson = (name: string, isPrivate = true, description: string | null = null) => ({
      id: 42,
      full_name: name,
      name: name.split("/")[1]!,
      private: isPrivate,
      description,
      default_branch: "main",
      html_url: `https://github.test/${name}`,
      clone_url: `https://github.test/${name}.git`,
      ssh_url: `git@github.test:${name}.git`,
    });
    const github = makeFakeGitHub({
      bare,
      repository,
      defaultBranch: "main",
      more: (method, url, body) => {
        if (url.origin === "https://api.github.test") {
          if (method === "GET" && url.pathname === "/user") {
            return json({ id: settings.accountId, login: settings.accountLogin, name: "Octo Cat" });
          }
          if (
            method === "POST" &&
            (url.pathname === "/user/repos" || /^\/orgs\/[^/]+\/repos$/.test(url.pathname))
          ) {
            const input = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
            creations.push({ path: url.pathname, input });
            const owner =
              url.pathname === "/user/repos" ? settings.accountLogin : url.pathname.split("/")[2]!;
            const name = `${owner}/${input.name}`;
            if (repositories.has(name)) return json({ message: "name already exists" }, 422);
            const created = repositoryJson(name, input.private === true, String(input.description));
            repositories.set(name, created);
            return settings.loseCreateReply ? unavailable() : json(created, 201);
          }
          const name = url.pathname.slice("/repos/".length);
          if (url.pathname.startsWith("/repos/") && name.split("/").length === 2) {
            if (method === "GET") {
              if (settings.failRepositoryReads && repositories.has(name)) return unavailable();
              return repositories.has(name)
                ? json(repositories.get(name))
                : json({ message: "Not Found" }, 404);
            }
            if (method === "PATCH") {
              if (settings.failCleanup) return unavailable();
              const stored = repositories.get(name);
              if (stored === undefined) return json({ message: "Not Found" }, 404);
              const input = JSON.parse(new TextDecoder().decode(body)) as { description: null };
              stored.description = input.description;
              return json(stored);
            }
          }
          if (settings.failBranchReads && url.pathname.includes("/git/ref/heads/"))
            return unavailable();
          if (
            settings.branchConflict !== null &&
            url.pathname.includes("/git/ref/heads/") &&
            github.head("main") === null
          ) {
            return json({ message: settings.branchConflict }, 409);
          }
        }
        if (method === "POST" && url.pathname.endsWith("/git-receive-pack")) {
          if (settings.failPush) return unavailable();
          if (settings.losePushReply) {
            git(["receive-pack", "--stateless-rpc", "."], body);
            settings.failBranchReads = settings.loseRecoveryHead;
            return unavailable();
          }
        }
        return null;
      },
    });
    const cloud = makeMemoryCloud({ github: github.layer });
    const user = cloud.userDirectory.forUser(USER);
    yield* user.recordSignIn({ id: USER, email: "octo@example.invalid" });
    const connect = Effect.gen(function* () {
      expect(
        (yield* user.beginGitHubConnect({
          grantId: "publication-connect",
          returnTo: "https://cloud.test/callback",
        }))._tag,
      ).toBe("started");
      github.authorize(USER);
      expect((yield* user.completeGitHubConnect("publication-connect"))._tag).toBe("connected");
    });
    if (options.connected !== false) yield* connect;
    const drive = handleFor(cloud.drives.apiFor(DRIVE));
    const role = options.role === undefined ? "owner" : options.role;
    yield* drive.setup({
      name: "Publication",
      members:
        role === null ? [] : [{ userId: USER, email: "octo@example.invalid", name: "Octo", role }],
    });
    if (options.history !== false) {
      expect(
        (yield* uploadPack({
          driveId: DRIVE,
          threadId: "existing-thread",
          ...source.pack([wip]),
        }).pipe(Effect.provide(cloud.drives.layer)))._tag,
      ).toBe("ok");
      expect((yield* drive.replaceMain(USER, { expectedMain: null, newMain: main }))._tag).toBe(
        "ok",
      );
      const writer = {
        userId: USER,
        threadId: "existing-thread",
        generation: 1,
        live: true,
        packsAfter: 0,
      };
      expect((yield* drive.open(writer))._tag).toBe("ok");
      expect(
        (yield* drive.updateRefs(writer, [
          { name: threadRef(writer.threadId), old: main, new: thread },
          { name: wipRef(writer.threadId), old: null, new: wip },
          { name: machineRef(writer.threadId), old: null, new: wip },
        ]))._tag,
      ).toBe("ok");
    }
    const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
      Effect.provide(
        Layer.mergeAll(
          CloudRpc.layerHandlers({ identity, userId: USER, sid: "publication-test" }),
          CloudRpc.layerScopeAuthorization(scopes),
        ).pipe(Layer.provide(cloud.layerFor(USER))),
      ),
    );
    const input: SourceControlPublishRepositoryInput = {
      cwd: CWD,
      provider: SourceControlProviderKind.make("github"),
      repository,
      visibility: "private",
      protocol: "https",
      remoteName: "origin",
    };
    const publish = (overrides: Partial<SourceControlPublishRepositoryInput> = {}) =>
      rpc[WS_METHODS.sourceControlPublishRepository]({ ...input, ...overrides });
    const receiveCalls = () => github.calls.filter((call) => call.includes("git-receive-pack"));
    return {
      cloud,
      drive,
      github,
      git,
      source,
      first,
      main,
      thread,
      wip,
      input,
      publish,
      settings,
      creations,
      repositories,
      repositoryJson,
      receiveCalls,
      connect,
    };
  });
