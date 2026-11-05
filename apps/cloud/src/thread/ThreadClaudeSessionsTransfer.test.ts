import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";
import { captureClaudeTranscriptFiles } from "../harness/ClaudeTranscriptFiles.ts";
import { KERNEL_FILE_TRANSFER_BYTES } from "../kernel/KernelFileTransfer.ts";
import { createThreadClaudeSessions } from "./ThreadClaudeSessions.ts";
import { MAX_APPEND_BYTES } from "@signalbox/runner-protocol/SessionProtocol";
import { SessionRows } from "./ThreadSessionRows.ts";
import { fixture, layer, thread, main, first, second } from "./tests/claudeSessions.fixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("Claude transcript transfer", () => {
  it.effect(
    "streams files larger than an append batch and validates saved pages before appending",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionRows;
        const row = JSON.stringify({ type: "assistant", message: `${"x".repeat(4096)}雪😀` });
        const encoded = new TextEncoder().encode(`${row}\n`);
        const streams = [
          { stream: "claude/native-session", path: main },
          { stream: "claude/native-session/subagents/large.jsonl", path: `${main}/sidecar` },
        ];
        let count = 2200;
        let closed = 0;
        const readEnds = new Map<string, number>();
        const appended = new Map<string, number>();
        const batches: { bytes: number; rows: number }[] = [];
        let firstAppendEnd: number | undefined;
        const observed = SessionRows.of({
          ...sessions,
          append: (input) =>
            sessions.append(input).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  firstAppendEnd ??= readEnds.get(input.stream);
                  appended.set(input.stream, input.offset + input.rows.length);
                  batches.push({
                    rows: input.rows.length,
                    bytes: input.rows.reduce(
                      (sum, value) => sum + new TextEncoder().encode(value).length,
                      0,
                    ),
                  });
                }),
              ),
            ),
        });
        const persistence = yield* createThreadClaudeSessions({
          capture: async () => ({
            streams,
            manifest: streams.map(({ path }) => ({
              path,
              mode: 0o644,
              bytes: encoded.length * count,
            })),
            source: {
              async read(path, offset, length) {
                const file = streams.find((entry) => entry.path === path)!;
                expect(length).toBeLessThanOrEqual(KERNEL_FILE_TRANSFER_BYTES);
                if (path !== main) expect(appended.get("claude/native-session")).toBe(count);
                const frame = new Uint8Array(length);
                for (let index = 0; index < length; index++)
                  frame[index] = encoded[(offset + index) % encoded.length]!;
                readEnds.set(file.stream, offset + length);
                return frame;
              },
              async close() {
                closed++;
              },
            },
          }),
        }).pipe(Effect.provideService(SessionRows, observed));
        yield* persistence.persist(thread);
        expect(firstAppendEnd).toBeLessThan(encoded.length * count);
        expect(batches).toHaveLength(4);
        expect(batches.every((batch) => batch.bytes <= MAX_APPEND_BYTES)).toBe(true);
        count += 2;
        yield* persistence.persist(thread);
        expect(batches.slice(-2).map((batch) => batch.rows)).toEqual([2, 2]);
        expect(closed).toBe(2);
        for (const file of streams) {
          let offset = 0;
          let pages = 0;
          for (;;) {
            const page = yield* sessions.rows(file.stream, offset);
            expect(page.rows.every((value) => value === row)).toBe(true);
            offset += page.rows.length;
            pages++;
            if (!page.more) break;
          }
          expect(offset).toBe(count);
          expect(pages).toBeGreaterThan(1);
        }
      }).pipe(Effect.provide(layer)),
  );

  it.effect("captures metadata without eagerly copying main or sidecar payloads", () =>
    Effect.gen(function* () {
      const { files, fs } = yield* fixture;
      const bytes = new TextEncoder().encode(`${first}\n`.repeat(3000));
      fs.writeFileSync(main, bytes);
      fs.writeFileSync(`${main.slice(0, -6)}/subagents/agent-one.jsonl`, bytes);
      const baseline = [...files.descriptors.entries()].length;
      const synchronousRead = vi.spyOn(files, "read");
      const asynchronousRead = vi.spyOn(files, "readAsync");
      const capture = yield* Effect.promise((signal) =>
        captureClaudeTranscriptFiles(files, "/home/.claude", "native-session", signal),
      );
      try {
        expect(synchronousRead).not.toHaveBeenCalled();
        expect(asynchronousRead).not.toHaveBeenCalled();
        expect(capture.manifest.map((file) => file.bytes)).toEqual([bytes.length, bytes.length]);
        const frame = yield* Effect.promise(() =>
          capture.source.read(main, 0, KERNEL_FILE_TRANSFER_BYTES),
        );
        expect(frame).toEqual(bytes.slice(0, KERNEL_FILE_TRANSFER_BYTES));
        expect(asynchronousRead).toHaveBeenCalled();
        expect(
          asynchronousRead.mock.calls.every((call) => call[1].length <= KERNEL_FILE_TRANSFER_BYTES),
        ).toBe(true);
      } finally {
        yield* Effect.promise(() => capture.source.close());
        expect([...files.descriptors.entries()]).toHaveLength(baseline);
      }
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "persists each file before reading the next, preserving split UTF-8 and appended rows",
    () =>
      Effect.gen(function* () {
        const { files, fs, sessions } = yield* fixture;
        const prefix = '{"type":"user","message":"';
        const row = `${prefix}${"a".repeat(KERNEL_FILE_TRANSFER_BYTES - prefix.length - 1)}雪😀"}`;
        const sidecar = `${main.slice(0, -6)}/subagents/agent-one.jsonl`;
        fs.writeFileSync(main, `${row}\n${second}\n`);
        fs.writeFileSync(sidecar, `${first}\n`);
        let checked = false;
        let committed: readonly string[] = [];
        const observed = SessionRows.of({
          ...sessions,
          append: (input) =>
            sessions.append(input).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (input.stream === "claude/native-session")
                    committed = [...committed, ...input.rows];
                }),
              ),
            ),
        });
        const persistence = yield* createThreadClaudeSessions({
          capture: async (nativeId, signal) => {
            const capture = await captureClaudeTranscriptFiles(
              files,
              "/home/.claude",
              nativeId,
              signal,
            );
            return {
              ...capture,
              source: {
                async read(path, offset, length) {
                  if (path === sidecar) {
                    expect(committed).toEqual([row, second]);
                    checked = true;
                  }
                  return await capture.source.read(
                    path,
                    offset,
                    Math.min(length, KERNEL_FILE_TRANSFER_BYTES),
                  );
                },
                close: () => capture.source.close(),
              },
            };
          },
        }).pipe(Effect.provideService(SessionRows, observed));
        yield* persistence.persist(thread);
        expect(checked).toBe(true);
        fs.appendFileSync(main, `${first}\n`);
        // The next capture still validates its complete saved prefix before appending the tail.
        const ordinary = yield* createThreadClaudeSessions({
          capture: (nativeId, signal) =>
            captureClaudeTranscriptFiles(files, "/home/.claude", nativeId, signal),
        });
        yield* ordinary.persist(thread);
        expect((yield* sessions.rows("claude/native-session", 0)).rows).toEqual([
          row,
          second,
          first,
        ]);
        expect(
          (yield* sessions.rows("claude/native-session/subagents/agent-one.jsonl", 0)).rows,
        ).toEqual([first]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("closes an in-flight transfer on interruption without committing partial JSONL", () =>
    Effect.gen(function* () {
      const { files, sessions } = yield* fixture;
      const started = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<Uint8Array>();
      let closed = false;
      const persistence = yield* createThreadClaudeSessions({
        capture: async (nativeId, signal) => {
          const capture = await captureClaudeTranscriptFiles(
            files,
            "/home/.claude",
            nativeId,
            signal,
          );
          return {
            ...capture,
            source: {
              read: () => {
                started.resolve();
                return pending.promise;
              },
              async close() {
                closed = true;
                pending.reject(new Error("Transfer closed"));
                await capture.source.close();
              },
            },
          };
        },
      });
      const running = yield* persistence.persist(thread).pipe(Effect.forkChild);
      try {
        yield* Effect.promise(() => started.promise);
        yield* Fiber.interrupt(running);
        expect(closed).toBe(true);
        expect(yield* sessions.streams("claude/")).toEqual([]);
      } finally {
        pending.reject(new Error("Test cleanup"));
      }
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("releases a kernel descriptor after a failed transcript read", () =>
    Effect.gen(function* () {
      const { files } = yield* fixture;
      const baseline = [...files.descriptors.entries()].length;
      const capture = yield* Effect.promise((signal) =>
        captureClaudeTranscriptFiles(files, "/home/.claude", "native-session", signal),
      );
      const failed = new Error("Transcript storage read failed");
      vi.spyOn(files, "readAsync").mockRejectedValueOnce(failed);
      try {
        yield* Effect.promise(() => expect(capture.source.read(main, 0, 1)).rejects.toBe(failed));
      } finally {
        yield* Effect.promise(() => capture.source.close());
      }
      expect([...files.descriptors.entries()]).toHaveLength(baseline);
      yield* Effect.promise(() =>
        expect(capture.source.read(main, 0, 1)).rejects.toMatchObject({ code: "EBADF" }),
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
