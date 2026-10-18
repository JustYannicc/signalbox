import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DriveContentScanState, scanDriveContents } from "./DriveContentScan.ts";
import * as DriveDirectory from "./DriveDirectory.ts";
import { makeDriveReader } from "./DriveReader.ts";
import { uploadPack } from "./DriveUploads.ts";
import { makeMemoryDrives, makeRepo } from "./driveTesting.ts";

const DRIVE = "folder/personal/metadata-scan";
const codec = Schema.fromJsonString(DriveContentScanState);
const encode = Schema.encodeSync(codec);
const decode = Schema.decodeUnknownSync(codec);
const repos: Array<ReturnType<typeof makeRepo>> = [];

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

describe("durable metadata content search", () => {
  it.effect("hydrates real Git packs and resumes runner-free search with cold readers", () => {
    const drives = makeMemoryDrives();
    return Effect.gen(function* () {
      const repo = makeRepo();
      repos.push(repo);
      repo.write(".gitignore", `${"# harmless padding\n".repeat(5000)}blocked/\n`);
      repo.write("keep.txt", "first needle\n");
      repo.write("nested/.ignore", "skip.txt\n");
      repo.write("nested/keep.txt", "second needle\n");
      repo.write("nested/skip.txt", "needle\n");
      repo.write("blocked/secret.txt", "needle\n");
      repo.git(["add", "--force", "."]);
      const head = repo.commit("search fixture");
      const packed = repo.pack([head]);
      expect(
        yield* uploadPack({
          driveId: DRIVE,
          threadId: "fixture",
          idx: packed.idx,
          pack: packed.pack,
        }),
      ).toMatchObject({ _tag: "ok" });
      const tree = repo.git(["rev-parse", `${head}^{tree}`]);
      const ignore = repo.git(["rev-parse", `${head}:.gitignore`]);
      const handle = (yield* DriveDirectory.DriveDirectory).forDrive(DRIVE);
      expect(yield* handle.metadataStatus(tree)).toBeNull();
      expect(yield* handle.metadataStatus(ignore)).toBeNull();
      let state: DriveContentScanState | null = null;
      const paths: string[] = [];
      let incompleteHydration = false;
      let complete = false;
      let emptyPages = 0;
      for (let page = 0; page < 256; page++) {
        const reader = yield* makeDriveReader(DRIVE);
        const result = yield* scanDriveContents(
          reader,
          head,
          { query: "needle", limit: 1, caseSensitive: true, wholeWord: false, useRegex: false },
          state,
          { entries: 2, bytes: 256 * 1024 },
        );
        if (result.matches.length === 0) emptyPages++;
        paths.push(...result.matches.map((match) => match.path));
        const hydration = yield* handle.metadataStatus(ignore);
        incompleteHydration ||= hydration !== null && !hydration.complete;
        if (result.nextState === undefined) {
          expect(result.truncated).toBe(false);
          complete = true;
          break;
        }
        expect(result.nextState.commit).toBe(head);
        expect(encode(result.nextState).length).toBeLessThan(16 * 1024);
        state = decode(encode(result.nextState));
      }
      expect(complete).toBe(true);
      expect(paths).toEqual(["keep.txt", "nested/keep.txt"]);
      expect(emptyPages).toBeGreaterThan(1);
      expect(incompleteHydration).toBe(true);
      expect(yield* handle.metadataStatus(tree)).toMatchObject({ complete: true });
      expect(yield* handle.metadataStatus(ignore)).toMatchObject({
        bytesWritten: new TextEncoder().encode(`${"# harmless padding\n".repeat(5000)}blocked/\n`)
          .length,
        complete: true,
      });
    }).pipe(Effect.provide(drives.layer));
  });
});
