import { operations } from "@signalbox/api/catalog";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { callOperation } from "../api/apiCall.ts";
import { uploadPack } from "../drive/DriveUploads.ts";
import {
  CWD,
  DRIVE,
  identity,
  publicationFixture,
  scopes,
  USER,
} from "./githubPublicationTesting.ts";

describe("cloud repository publication", () => {
  it.effect("publishes both parents of a committed merge with their historical bytes", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture();
      f.source.git(["checkout", "-q", "-b", "alternate", f.first]);
      f.source.write("alternate.txt", "second-parent bytes\n");
      const alternate = f.source.commit("alternate history");
      f.source.git(["checkout", "-q", "-b", "merged-main", f.main]);
      f.source.git(["merge", "-q", "--no-ff", "--no-edit", "alternate"]);
      const merged = f.source.git(["rev-parse", "HEAD"]);
      expect(
        (yield* uploadPack({
          driveId: DRIVE,
          threadId: "existing-thread",
          ...f.source.pack([merged], [f.main]),
        }).pipe(Effect.provide(f.cloud.drives.layer)))._tag,
      ).toBe("ok");
      expect(
        (yield* f.drive.replaceMain(USER, { expectedMain: f.main, newMain: merged }))._tag,
      ).toBe("ok");
      expect((yield* f.publish()).status).toBe("pushed");
      expect(f.github.head("main")).toBe(merged);
      expect(new Set(f.git(["rev-list", "main"]).toString().trim().split("\n"))).toEqual(
        new Set([merged, f.main, alternate, f.first]),
      );
      expect(f.git(["show", `${alternate}:alternate.txt`]).toString()).toBe(
        "second-parent bytes\n",
      );
      expect(f.git(["show", `${f.first}:old.txt`]).toString()).toBe("original bytes\n");
      expect(f.git(["fsck", "--full", "--no-reflogs"]).toString()).toBe("");
    }),
  );

  it.effect.each([
    { owner: "octo", visibility: "private" as const },
    { owner: "octo", visibility: "public" as const },
    { owner: "signalbox-team", visibility: "private" as const },
    { owner: "signalbox-team", visibility: "public" as const },
  ])(
    "publishes full main history to a new $visibility $owner repository without a runner",
    ({ owner, visibility }) =>
      Effect.gen(function* () {
        const f = yield* publicationFixture({ repository: `${owner}/new-project` });
        const before = yield* f.drive.refs("existing-thread");
        const result = yield* f.publish({ visibility, protocol: "ssh" });
        expect(result).toMatchObject({
          repository: { nameWithOwner: `${owner}/new-project` },
          remoteName: "origin",
          remoteUrl: `git@github.test:${owner}/new-project.git`,
          branch: "main",
          upstreamBranch: "origin/main",
          status: "pushed",
        });
        expect(f.creations).toEqual([
          {
            path: owner === "octo" ? "/user/repos" : `/orgs/${owner}/repos`,
            input: {
              name: "new-project",
              private: visibility === "private",
              description: expect.stringMatching(/^Signalbox publication [0-9a-f-]{36}$/),
              auto_init: false,
            },
          },
        ]);
        expect(f.github.head("main")).toBe(f.main);
        expect(f.git(["rev-list", "main"]).toString().trim().split("\n")).toEqual([
          f.main,
          f.first,
        ]);
        expect(f.git(["show", `${f.first}:old.txt`]).toString()).toBe("original bytes\n");
        expect(f.git(["show", "main:README.md"]).toString()).toBe("current main bytes\n");
        expect(f.git(["ls-tree", "--name-only", "main"]).toString().trim()).toBe("README.md");
        expect(
          f
            .git(["cat-file", "--batch-check"], new TextEncoder().encode(`${f.thread}\n${f.wip}\n`))
            .toString(),
        ).toBe(`${f.thread} missing\n${f.wip} missing\n`);
        expect(f.git(["fsck", "--full", "--no-reflogs"]).toString()).toBe("");
        expect(yield* f.drive.refs("existing-thread")).toEqual({
          ...before,
          remote: {
            provider: "github",
            repository: `${owner}/new-project`,
            defaultBranch: "main",
          },
        });
        expect(f.repositories.get(`${owner}/new-project`)?.description).toBeNull();
        expect(yield* f.publish({ visibility, protocol: "ssh" })).toEqual(result);
        expect(f.creations).toHaveLength(1);
        expect(f.receiveCalls()).toHaveLength(1);
      }),
  );

  it.effect("requires the requesting user's GitHub connection before creating or binding", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture({ connected: false });
      expect((yield* f.publish().pipe(Effect.flip)).message).toContain("Connect GitHub");
      expect(yield* f.drive.remote()).toBeNull();
      expect(f.creations).toHaveLength(0);
      expect(f.receiveCalls()).toHaveLength(0);
      yield* f.connect;
      expect((yield* f.publish()).status).toBe("pushed");
    }),
  );

  it.effect("publishes an empty folder as an empty remote without inventing a commit", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture({ history: false });
      const result = yield* f.publish();
      expect(result.status).toBe("remote_added");
      expect(result.upstreamBranch).toBeUndefined();
      expect(f.github.head("main")).toBeNull();
      expect(f.receiveCalls()).toHaveLength(0);
      expect(yield* f.drive.remote()).toMatchObject({ repository: "octo/new-project" });
      expect(yield* f.publish()).toEqual(result);
      expect(f.creations).toHaveLength(1);
    }),
  );

  it.effect("lets a folder manager publish", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture({ role: "manager" });
      expect((yield* f.publish()).status).toBe("pushed");
    }),
  );

  it.effect.each([null, "viewer", "editor"] as const)(
    "refuses role %s before any GitHub side effect",
    (role) =>
      Effect.gen(function* () {
        const f = yield* publicationFixture({ role, history: false });
        expect((yield* f.publish().pipe(Effect.flip)).message).toContain("manager");
        expect(f.creations).toHaveLength(0);
        expect(f.receiveCalls()).toHaveLength(0);
        expect(yield* f.drive.remote()).toBeNull();
      }),
  );

  it.effect("refuses inherited, nested, forged and another person's roots", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture();
      for (const cwd of [
        "/scratch",
        "/drives/my/personal/user_1",
        `${CWD}/nested`,
        `${CWD}/threads/existing-thread`,
        "/drives/folder/personal/unknown",
        "/drives/my/personal/someone-else",
        "/tmp",
        "/drives/folder/personal/../publication",
      ]) {
        expect((yield* f.publish({ cwd }).pipe(Effect.result))._tag).toBe("Failure");
      }
      expect(f.creations).toHaveLength(0);
      expect(f.receiveCalls()).toHaveLength(0);
      expect(yield* f.drive.remote()).toBeNull();
    }),
  );

  it.effect("serves API person and agent calls, requiring source-control write scope", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture();
      const operation = operations.find(
        (candidate) => candidate.name === "sourceControl.publishRepository",
      );
      if (operation === undefined) throw new Error("Publication missing from public API");
      const call = (kind: "person" | "agent", allowed = scopes) =>
        callOperation({
          operation,
          body: f.input,
          follow: false,
          identity,
          caller: { userId: USER, kind, scopes: allowed, credentialId: "publication-key" },
        }).pipe(Effect.provide(f.cloud.layerFor(USER)));
      expect(yield* call("agent", [AuthOrchestrationReadScope])).toMatchObject({
        _tag: "json",
        status: 403,
      });
      expect(f.creations).toHaveLength(0);
      expect(yield* call("person")).toMatchObject({
        _tag: "json",
        status: 200,
        body: { status: "pushed" },
      });
      expect(yield* call("agent")).toMatchObject({
        _tag: "json",
        status: 200,
        body: { status: "pushed" },
      });
      expect(f.github.head("main")).toBe(f.main);
      expect(f.creations).toHaveLength(1);
      expect(f.receiveCalls()).toHaveLength(1);
    }),
  );
});
