// @effect-diagnostics nodeBuiltinImport:off - this native adapter test creates and removes its own temporary filesystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { afterEach } from "vite-plus/test";

import {
  MACHINE_FILES_MAX_FRAME_BYTES,
  type MachineFilesRequest,
} from "@signalbox/runner-protocol/MachineFilesProtocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RunnerMachineFiles from "./RunnerMachineFiles.ts";
import * as RunnerNativeFileSystem from "./RunnerNativeFileSystem.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const native = <A>(tryOperation: () => Promise<A>) => Effect.promise(tryOperation);

const fixture = () =>
  Effect.gen(function* () {
    const root = yield* native(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "runner-machine-files-")),
    );
    roots.push(root);
    const bin = NodePath.join(root, "bin");
    yield* native(() => NodeFSP.mkdir(bin));
    const executable = NodePath.join(bin, "tool");
    yield* native(() => NodeFSP.writeFile(executable, "abcdef", { mode: 0o755 }));
    yield* native(() => NodeFSP.symlink("../bin/tool", NodePath.join(bin, "tool-link")));
    return { root, bin, executable };
  });

const lookup = (request: MachineFilesRequest) =>
  Effect.gen(function* () {
    const files = yield* RunnerMachineFiles.RunnerMachineFiles;
    return yield* files.lookup(request);
  });

const request = (operations: MachineFilesRequest["operations"]): MachineFilesRequest => ({
  type: "machine.files.request",
  generation: 3,
  requestId: "files-1",
  operations,
});

it.layer(RunnerMachineFiles.layer.pipe(Layer.provide(RunnerNativeFileSystem.layer)))(
  "Runner machine file lookup",
  (it) => {
    it.effect("lets the native filesystem walk symlinks before PATH parent segments", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const real = NodePath.join(f.root, "real");
        yield* native(() => NodeFSP.mkdir(NodePath.join(real, "nested"), { recursive: true }));
        yield* native(() =>
          NodeFSP.writeFile(NodePath.join(real, "late"), "native", { mode: 0o755 }),
        );
        yield* native(() =>
          NodeFSP.symlink(NodePath.join(real, "nested"), NodePath.join(f.root, "link")),
        );
        const path = `${f.root}/link/..`;
        const result = yield* lookup(
          request([{ id: "path", op: "searchPath", commands: ["late"], path, cwd: f.root }]),
        );
        expect(result.outcome).toMatchObject({
          status: "ok",
          results: [
            {
              id: "path",
              op: "searchPath",
              matches: [{ command: "late", status: "found", path: `${path}/late` }],
            },
          ],
        });
      }),
    );

    it.effect("keeps readdir child metadata on the native symlink and parent walk", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const a = NodePath.join(f.root, "a");
        const b = NodePath.join(f.root, "b");
        yield* native(() =>
          NodeFSP.mkdir(NodePath.join(a, "sub"), { recursive: true, mode: 0o700 }),
        );
        yield* native(() =>
          NodeFSP.mkdir(NodePath.join(b, "sub"), { recursive: true, mode: 0o755 }),
        );
        yield* native(() =>
          NodeFSP.writeFile(NodePath.join(a, "child"), "lexical child", { mode: 0o600 }),
        );
        yield* native(() =>
          NodeFSP.writeFile(NodePath.join(b, "child"), "native", { mode: 0o755 }),
        );
        yield* native(() => NodeFSP.symlink(NodePath.join(b, "sub"), NodePath.join(a, "link")));

        const path = `${a}/link/..`;
        const nativeChildStat = yield* native(() =>
          NodeFSP.lstat(`${path}/child`, { bigint: true }),
        );
        const result = yield* lookup(
          request([{ id: "entries", op: "readdir", path, withStat: true }]),
        );

        expect(result.outcome.status).toBe("ok");
        if (result.outcome.status !== "ok") return;
        expect(result.outcome.results).toMatchObject([
          {
            id: "entries",
            op: "readdir",
            entries: [
              {
                name: "child",
                type: "file",
                stat: {
                  mode: Number(nativeChildStat.mode),
                  type: "file",
                  size: nativeChildStat.size.toString(),
                  dev: nativeChildStat.dev.toString(),
                  ino: nativeChildStat.ino.toString(),
                  atimeNs: nativeChildStat.atimeNs.toString(),
                  mtimeNs: nativeChildStat.mtimeNs.toString(),
                  ctimeNs: nativeChildStat.ctimeNs.toString(),
                  birthtimeNs: nativeChildStat.birthtimeNs.toString(),
                },
              },
              { name: "sub", type: "directory" },
            ],
          },
        ]);
      }),
    );

    it.effect(
      "returns native stat metadata, original link bytes, directory details, and only requested ranges",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          const nativeStat = yield* native(() => NodeFSP.stat(f.executable, { bigint: true }));
          const result = yield* lookup(
            request([
              { id: "follow", op: "stat", path: NodePath.join(f.bin, "tool-link") },
              { id: "link", op: "lstat", path: NodePath.join(f.bin, "tool-link") },
              { id: "entries", op: "readdir", path: f.bin, withStat: true, limit: 8 },
              { id: "target", op: "readlink", path: NodePath.join(f.bin, "tool-link") },
            ]),
          );

          expect(result.outcome.status).toBe("ok");
          if (result.outcome.status !== "ok") return;
          expect(result.outcome.results).toMatchObject([
            {
              id: "follow",
              op: "stat",
              stat: {
                mode: Number(nativeStat.mode),
                type: "file",
                size: nativeStat.size.toString(),
                uid: Number(nativeStat.uid),
                gid: Number(nativeStat.gid),
                dev: nativeStat.dev.toString(),
                ino: nativeStat.ino.toString(),
                nlink: nativeStat.nlink.toString(),
                atimeNs: nativeStat.atimeNs.toString(),
                mtimeNs: nativeStat.mtimeNs.toString(),
                ctimeNs: nativeStat.ctimeNs.toString(),
                birthtimeNs: nativeStat.birthtimeNs.toString(),
              },
            },
            { id: "link", op: "lstat", stat: { type: "symlink" } },
            {
              id: "entries",
              op: "readdir",
              entries: [
                { name: "tool", type: "file" },
                { name: "tool-link", type: "symlink" },
              ],
            },
            {
              id: "target",
              op: "readlink",
              targetBase64: Buffer.from("../bin/tool").toString("base64"),
            },
          ]);

          const range = yield* lookup(
            request([{ id: "range", op: "readRange", path: f.executable, offset: 2, length: 2 }]),
          );
          expect(range.outcome).toMatchObject({
            status: "ok",
            results: [
              { id: "range", op: "readRange", offset: 2, bytesRead: 2, bytesBase64: "Y2Q=" },
            ],
          });
        }),
    );

    it.effect("batches PATH search and distinguishes permission denial from absence", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const denied = NodePath.join(f.bin, "denied");
        yield* native(() => NodeFSP.writeFile(denied, "no execute bit", { mode: 0o644 }));
        const result = yield* lookup(
          request([
            {
              id: "path",
              op: "searchPath",
              commands: ["tool", "denied", "missing"],
              path: f.bin,
              cwd: f.root,
            },
          ]),
        );

        expect(result.outcome.status).toBe("ok");
        if (result.outcome.status !== "ok") return;
        expect(result.outcome.results[0]).toMatchObject({
          id: "path",
          op: "searchPath",
          matches: [
            { command: "tool", status: "found", path: f.executable },
            { command: "denied", status: "permission_denied" },
            { command: "missing", status: "not_found" },
          ],
        });
      }),
    );

    it.effect(
      "returns a repeatable frame-too-large result instead of truncating a large directory batch",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* native(() => NodeFSP.rm(f.executable));
          for (let index = 0; index < 128; index += 1) {
            yield* native(() =>
              NodeFSP.writeFile(
                NodePath.join(f.bin, `${String(index).padStart(3, "0")}-${"x".repeat(180)}`),
                "x",
              ),
            );
          }
          const response = yield* lookup(
            request(
              Array.from({ length: 64 }, (_, index) => ({
                id: `dir-${index}`,
                op: "readdir" as const,
                path: f.bin,
                limit: 128,
              })),
            ),
          );
          expect(response.outcome).toMatchObject({ status: "error", code: "frame_too_large" });
          expect(JSON.stringify(response).length).toBeLessThan(MACHINE_FILES_MAX_FRAME_BYTES);
        }),
    );

    it.effect("keeps missing paths as per-operation errno results", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const result = yield* lookup(
          request([{ id: "missing", op: "stat", path: NodePath.join(f.root, "absent") }]),
        );
        expect(result.outcome).toMatchObject({
          status: "ok",
          results: [{ id: "missing", op: "stat", error: { code: "ENOENT" } }],
        });
      }),
    );

    it.effect("runs lookups through the canonical native service layer", () =>
      Effect.gen(function* () {
        const result = yield* lookup(request([{ id: "root", op: "stat", path: "/" }]));
        expect(result).toMatchObject({
          type: "machine.files.result",
          generation: 3,
          outcome: {
            status: "ok",
            results: [{ id: "root", op: "stat", stat: { type: "directory" } }],
          },
        });
      }),
    );
  },
);
