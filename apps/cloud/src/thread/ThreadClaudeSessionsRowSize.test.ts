import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";
import { MAX_APPEND_BYTES } from "@signalbox/runner-protocol/SessionProtocol";
import { KERNEL_FILE_TRANSFER_BYTES } from "../kernel/KernelFileTransfer.ts";
import { createThreadClaudeSessions } from "./ThreadClaudeSessions.ts";
import { SessionRows } from "./ThreadSessionRows.ts";
import { layer, thread, main } from "./tests/claudeSessions.fixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

it.effect("preserves an existing oversized JSONL row without adding a transcript size cap", () =>
  Effect.gen(function* () {
    const row = JSON.stringify({ type: "assistant", message: "x".repeat(MAX_APPEND_BYTES) });
    const bytes = new TextEncoder().encode(row);
    let closed = false;
    const persistence = yield* createThreadClaudeSessions({
      capture: async () => ({
        streams: [{ stream: "claude/native-session", path: main }],
        manifest: [{ path: main, mode: 0o644, bytes: bytes.length }],
        source: {
          async read(_path, offset, length) {
            expect(length).toBeLessThanOrEqual(KERNEL_FILE_TRANSFER_BYTES);
            return bytes.slice(offset, offset + length);
          },
          async close() {
            closed = true;
          },
        },
      }),
    });
    yield* persistence.persist(thread);
    const sessions = yield* SessionRows;
    expect(yield* sessions.rows("claude/native-session", 0)).toEqual({ rows: [row], more: false });
    expect(closed).toBe(true);
    yield* persistence.persist(thread);
    expect((yield* sessions.rows("claude/native-session", 0)).rows).toEqual([row]);
  }).pipe(Effect.provide(layer)),
);
