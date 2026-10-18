import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as GitHub from "../github/GitHub.ts";
import { makeGitHubApi } from "../github/GitHubApi.ts";
import { DriveContentScanState, scanDriveContents } from "./DriveContentScan.ts";
import * as DriveDirectory from "./DriveDirectory.ts";
import { uploadPack } from "./DriveUploads.ts";
import { makeMemoryDrives, makeRepo } from "./driveTesting.ts";
import { remoteDriveReader } from "./remoteFiles.ts";

const repository = "acme/metadata-source";
const token = "github-range-integration-canary";
const encoder = new TextEncoder();
const input = {
  query: "needle",
  limit: 50,
  caseSensitive: true,
  wholeWord: false,
  useRegex: false,
};
const codec = Schema.fromJsonString(DriveContentScanState);
const encode = Schema.encodeSync(codec);
const decode = Schema.decodeUnknownSync(codec);
const repos: Array<ReturnType<typeof makeRepo>> = [];
let fixtureNumber = 0;

afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

type Fault = "wrong-size" | "wrong-hash" | "missing-token" | "missing-total";

const remoteFixture = (files: Record<string, string>, fault?: Fault) => {
  const driveId = `folder/personal/remote-metadata-${++fixtureNumber}`;
  const drives = makeMemoryDrives();
  const contents = new Map<string, Uint8Array<ArrayBuffer>>();
  const requests: Array<{ repository: string; oid: string; offset: number; length: number }> = [];
  let fullRequests = 0;
  const client = HttpClient.make((request) => {
    if (request.headers.range === undefined) {
      fullRequests++;
      return Effect.die("Metadata search attempted a whole-blob HTTP request.");
    }
    const path = /\/repos\/([^/]+\/[^/]+)\/git\/blobs\/([0-9a-f]{40})$/.exec(request.url)!;
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range)!;
    const offset = Number(range[1]);
    const length = Number(range[2]) - offset + 1;
    expect(length).toBeGreaterThan(0);
    expect(length).toBeLessThanOrEqual(64 * 1024);
    expect(request.headers.accept).toBe("application/vnd.github.raw+json");
    expect(request.headers.authorization).toBe(`Bearer ${token}`);
    requests.push({ repository: path[1]!, oid: path[2]!, offset, length });
    const original = contents.get(path[2]!)!;
    const bytes = original.slice(offset, offset + length);
    if (fault === "wrong-hash" && offset === 0) bytes[0] = bytes[0]! ^ 1;
    const total =
      fault === "missing-total" ? "*" : String(original.length + (fault === "wrong-size" ? 1 : 0));
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(bytes, {
          status: 206,
          headers: { "content-range": `bytes ${offset}-${offset + bytes.length - 1}/${total}` },
        }),
      ),
    );
  });
  const layer = Layer.mergeAll(
    drives.layer,
    Layer.succeed(GitHub.GitHub, {
      api: makeGitHubApi(client),
      pipesForUser: () => Effect.succeed(null),
    }),
  );
  const seed = Effect.gen(function* () {
    const repo = makeRepo();
    repos.push(repo);
    for (const [path, text] of Object.entries(files)) repo.write(path, text);
    repo.git(["add", "--force", "."]);
    const head = repo.commit("remote metadata fixture");
    const ids = new Map(
      Object.keys(files).map((path) => [path, repo.git(["rev-parse", `${head}:${path}`])]),
    );
    for (const [path, oid] of ids) contents.set(oid, encoder.encode(files[path]!));
    const sizes = new Map(
      [...ids].flatMap(([path, oid]) =>
        path === ".gitignore" || fault === "wrong-size"
          ? [[oid, contents.get(oid)!.length] as const]
          : [],
      ),
    );
    const handle = (yield* DriveDirectory.DriveDirectory).forDrive(driveId);
    yield* handle.setRemote({ provider: "github", repository, defaultBranch: "main" });
    expect(
      yield* uploadPack({
        driveId,
        threadId: "remote-fixture",
        ...repo.pack([head], [], "blob:none"),
        remoteHead: head,
        promisedSizes: Effect.succeed(sizes),
      }),
    ).toMatchObject({ _tag: "ok" });
    expect(yield* handle.locate([...ids.values()])).toEqual([]);
    return { head, ids, handle };
  });
  return { driveId, layer, seed, requests, fullRequests: () => fullRequests };
};

describe("GitHub metadata ranges through content search", () => {
  it.effect(
    "hydrates promised ignore and unknown-size content through raw ranges and freezes its source",
    () => {
      const ignoreText = `#${"z".repeat(3 * 64 * 1024)}\nblocked.txt\n`;
      const content = `needle survives remote hydration\n${"padding\n".repeat(10_000)}`;
      const test = remoteFixture({
        ".gitignore": ignoreText,
        "blocked.txt": "needle blocked\n",
        "keep.txt": content,
      });
      return Effect.gen(function* () {
        const { head, ids, handle } = yield* test.seed;
        const ignore = ids.get(".gitignore")!;
        const keep = ids.get("keep.txt")!;
        expect(
          new Map((yield* handle.promised([ignore, keep])).map((file) => [file.oid, file.size])),
        ).toEqual(
          new Map<string, number | null>([
            [ignore, encoder.encode(ignoreText).length],
            [keep, null],
          ]),
        );
        let state: DriveContentScanState | null = null;
        const paths: string[] = [];
        let checkedSourceChange = false;
        let complete = false;
        for (let page = 0; page < 256; page++) {
          const reader = yield* remoteDriveReader(test.driveId, Effect.succeed(token));
          const result = yield* scanDriveContents(reader, head, input, state, {
            entries: 2,
            bytes: 512 * 1024,
          });
          paths.push(...result.matches.map((match) => match.path));
          if (result.nextState === undefined) {
            complete = true;
            break;
          }
          state = decode(encode(result.nextState));
          const partial = yield* handle.metadataStatus(ignore);
          if (
            !checkedSourceChange &&
            partial !== null &&
            !partial.complete &&
            partial.bytesWritten > 0
          ) {
            checkedSourceChange = true;
            yield* handle.setRemote({
              provider: "github",
              repository: "changed/source",
              defaultBranch: "main",
            });
            const count = test.requests.length;
            const changed = yield* remoteDriveReader(test.driveId, Effect.succeed(token));
            const error = yield* scanDriveContents(changed, head, input, state).pipe(Effect.flip);
            expect(error).toMatchObject({
              _tag: "DriveReadError",
              cause: {
                _tag: "DriveHydrationError",
                reason: "range",
                cause: {
                  _tag: "HydrationRemoteError",
                  cause: { message: "The drive's remote source has changed." },
                },
              },
            });
            expect(test.requests).toHaveLength(count);
            expect(yield* handle.metadataStatus(ignore)).toEqual(partial);
            yield* handle.setRemote({ provider: "github", repository, defaultBranch: "main" });
          }
        }
        expect(complete).toBe(true);
        expect(checkedSourceChange).toBe(true);
        expect(paths).toEqual(["keep.txt"]);
        expect(test.requests.every((request) => request.repository === repository)).toBe(true);
        expect(test.requests.some((request) => request.oid === ignore && request.offset > 0)).toBe(
          true,
        );
        expect(test.requests.some((request) => request.oid === keep && request.offset > 0)).toBe(
          true,
        );
        expect(test.requests.some((request) => request.oid === ids.get("blocked.txt"))).toBe(false);
        expect(test.fullRequests()).toBe(0);
        expect(yield* handle.metadataStatus(keep)).toMatchObject({
          complete: true,
          bytesWritten: encoder.encode(content).length,
          source: { kind: "remote", repository, size: null },
        });
      }).pipe(Effect.provide(test.layer));
    },
  );

  it.effect(
    "returns explicit range, hash, and missing-token failures before exposing snippets",
    () =>
      Effect.gen(function* () {
        for (const fault of [
          "wrong-size",
          "wrong-hash",
          "missing-token",
          "missing-total",
        ] as const) {
          const test = remoteFixture(
            { "keep.txt": `needle must stay hidden\n${"padding\n".repeat(10_000)}` },
            fault,
          );
          yield* Effect.gen(function* () {
            const { head, ids, handle } = yield* test.seed;
            let state: DriveContentScanState | null = null;
            const matches = [];
            let failed = false;
            for (let page = 0; page < 100; page++) {
              const reader = yield* remoteDriveReader(
                test.driveId,
                Effect.succeed(fault === "missing-token" ? null : token),
              );
              const result = yield* scanDriveContents(reader, head, input, state, {
                entries: 2,
                bytes: 256 * 1024,
              }).pipe(
                Effect.match({
                  onFailure: (error) => ({ _tag: "failed" as const, error }),
                  onSuccess: (page) => ({ _tag: "page" as const, page }),
                }),
              );
              if (result._tag === "failed") {
                failed = true;
                expect(result.error).toMatchObject({
                  _tag: "DriveReadError",
                  cause: {
                    _tag: "DriveHydrationError",
                    reason: fault === "wrong-hash" ? "hash" : "range",
                  },
                });
                if (fault === "missing-token" || fault === "missing-total")
                  expect(result.error).toMatchObject({
                    cause: {
                      cause: {
                        _tag: "HydrationRemoteError",
                        cause: {
                          message:
                            fault === "missing-token"
                              ? "Connect GitHub to read this file."
                              : "GitHub did not identify the file's size.",
                        },
                      },
                    },
                  });
                break;
              }
              matches.push(...result.page.matches);
              if (result.page.nextState === undefined) break;
              state = decode(encode(result.page.nextState));
            }
            expect(failed).toBe(true);
            expect(matches).toEqual([]);
            expect((yield* handle.metadataStatus(ids.get("keep.txt")!))?.complete).toBe(false);
            expect(test.fullRequests()).toBe(0);
            if (fault === "missing-token") expect(test.requests).toEqual([]);
          }).pipe(Effect.provide(test.layer));
        }
      }),
  );
});
