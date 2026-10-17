import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { GitHub } from "../github/GitHub.ts";
import { makeGitHubApi } from "../github/GitHubApi.ts";
import { GitHubConnection } from "../github/GitHubConnection.ts";
import { DriveDirectory } from "./DriveDirectory.ts";
import type { ReviewDiffFileContentsInput } from "@t3tools/contracts";

import * as DriveFiles from "./DriveFiles.ts";
import { makeMemoryDrives, makeRepo } from "./driveTesting.ts";
import { uploadPack } from "./DriveUploads.ts";

const DRIVE = "my/personal/user_1";
const repos: Array<ReturnType<typeof makeRepo>> = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

const fixture = Effect.gen(function* () {
  const drives = makeMemoryDrives();
  const git = makeRepo();
  repos.push(git);
  git.write("file.txt", "before\n");
  git.write("old.txt", "renamed\n");
  const baseRef = git.commit("before");
  git.write("file.txt", "after\n");
  git.git(["mv", "old.txt", "new.txt"]);
  git.write("binary.bin", "x".repeat(9000) + "\0");
  git.write("large.txt", "x".repeat(1024 * 1024 + 1));
  const headRef = git.commit("after");
  const uploaded = yield* uploadPack({
    driveId: DRIVE,
    threadId: "t1",
    ...git.pack([headRef]),
  }).pipe(Effect.provide(drives.layer));
  expect(uploaded._tag).toBe("ok");
  const files = yield* DriveFiles.DriveFiles.pipe(
    Effect.provide(DriveFiles.layer.pipe(Layer.provide(drives.layer))),
  );
  const input: ReviewDiffFileContentsInput = {
    cwd: `/drives/${DRIVE}`,
    sourceKind: "branch-range",
    changeType: "change",
    baseRef,
    headRef,
    oldPath: "file.txt",
    newPath: "file.txt",
  };
  return { files, input, git, drives };
});

describe("drive diff contents", () => {
  it.effect("reads both immutable sides even when the current file changes again", () =>
    Effect.gen(function* () {
      const { files, input, git } = yield* fixture;
      git.write("file.txt", "unrelated current work\n");
      expect(yield* files.diffFileContents(DRIVE, input)).toEqual({
        oldContents: "before\n",
        newContents: "after\n",
      });
      expect(
        yield* files.diffFileContents(DRIVE, {
          ...input,
          changeType: "rename-pure",
          oldPath: "old.txt",
          newPath: "new.txt",
        }),
      ).toEqual({ oldContents: "renamed\n", newContents: "renamed\n" });
    }),
  );

  it.effect("only omits the absent side for additions and deletions", () =>
    Effect.gen(function* () {
      const { files, input } = yield* fixture;
      expect(
        yield* files.diffFileContents(DRIVE, {
          ...input,
          changeType: "new",
          baseRef: null,
          oldPath: "absent",
          newPath: "new.txt",
        }),
      ).toEqual({ oldContents: "", newContents: "renamed\n" });
      expect(
        yield* files.diffFileContents(DRIVE, {
          ...input,
          changeType: "deleted",
          headRef: null,
          oldPath: "old.txt",
          newPath: "absent",
        }),
      ).toEqual({ oldContents: "renamed\n", newContents: "" });
      const error = yield* files
        .diffFileContents(DRIVE, { ...input, newPath: "absent" })
        .pipe(Effect.flip);
      expect(error.message).toContain("does not exist");
    }),
  );

  it.effect("refuses binary, oversized, escaping and mutable inputs", () =>
    Effect.gen(function* () {
      const { files, input } = yield* fixture;
      for (const [newPath, message] of [
        ["binary.bin", "binary"],
        ["large.txt", "1 MB"],
        ["../escape", "outside"],
      ]) {
        const error = yield* files
          .diffFileContents(DRIVE, { ...input, newPath: newPath! })
          .pipe(Effect.flip);
        expect(error.message).toContain(message);
      }
      const error = yield* files
        .diffFileContents(DRIVE, { ...input, headRef: "main" })
        .pipe(Effect.flip);
      expect(error.message).toContain("immutable commit ID");
    }),
  );

  it.effect("does not expose commits stored only in private machine packs", () =>
    Effect.gen(function* () {
      const { files, input, git, drives } = yield* fixture;
      git.write("private.txt", "machine-only\n");
      const privateHead = git.commit("machine state");
      yield* uploadPack({
        driveId: DRIVE,
        threadId: "other",
        private: true,
        ...git.pack([privateHead], [input.headRef!]),
      }).pipe(Effect.provide(drives.layer));
      const error = yield* files
        .diffFileContents(DRIVE, { ...input, headRef: privateHead, newPath: "private.txt" })
        .pipe(Effect.flip);
      expect(error.message).toContain("not available");
    }),
  );
});

it.effect("expands promised files through authenticated GitHub blobs and verifies their OIDs", () =>
  Effect.gen(function* () {
    const driveId = "my/personal/remote-review";
    const drives = makeMemoryDrives();
    const git = makeRepo();
    repos.push(git);
    git.write("remote.txt", "only on GitHub\n");
    const headRef = git.commit("remote");
    const blob = git.git(["rev-parse", `${headRef}:remote.txt`]);
    yield* DriveDirectory.use((directory) =>
      directory.forDrive(driveId).setRemote({
        provider: "github",
        repository: "owner/repo",
        defaultBranch: "main",
      }),
    ).pipe(Effect.provide(drives.layer));
    expect(
      (yield* uploadPack({
        driveId,
        threadId: "t1",
        ...git.pack([headRef], [], "blob:none"),
        remoteHead: headRef,
        promisedSizes: Effect.succeed(new Map([[blob, 15]])),
      }).pipe(Effect.provide(drives.layer)))._tag,
    ).toBe("ok");
    let bytes = "tampered\n";
    const requests: Array<string> = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.url);
        expect(request.headers.authorization).toBe("Bearer reader-token");
        return HttpClientResponse.fromWeb(request, new Response(bytes));
      }),
    );
    const services = Layer.mergeAll(
      drives.layer,
      Layer.succeed(GitHub, { pipes: null, api: makeGitHubApi(http) }),
      Layer.succeed(GitHubConnection, {
        configured: true,
        account: Effect.succeed(null),
        commitAuthor: Effect.succeed(null),
        begin: () => Effect.die("unused"),
        complete: () => Effect.die("unused"),
        abort: () => Effect.void,
        recorded: Effect.succeed(null),
        adopt: () => Effect.void,
        disconnect: Effect.void,
        accessToken: Effect.succeed("reader-token"),
      }),
    );
    const files = yield* DriveFiles.DriveFiles.pipe(
      Effect.provide(DriveFiles.layer.pipe(Layer.provide(services))),
    );
    const input: ReviewDiffFileContentsInput = {
      cwd: `/drives/${driveId}`,
      sourceKind: "branch-range",
      changeType: "new",
      baseRef: null,
      headRef,
      oldPath: "remote.txt",
      newPath: "remote.txt",
    };
    const error = yield* files.diffFileContents(driveId, input).pipe(Effect.flip);
    expect(error.message).toContain("doesn't match");
    bytes = "only on GitHub\n";
    expect(yield* files.diffFileContents(driveId, input)).toEqual({
      oldContents: "",
      newContents: bytes,
    });
    expect(requests).toEqual(
      Array(2).fill(`https://api.github.com/repos/owner/repo/git/blobs/${blob}`),
    );
  }),
);
