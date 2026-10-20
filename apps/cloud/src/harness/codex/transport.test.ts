import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CodexHarnessProcess } from "../CodexHarnessProcess.ts";
import { makeCodexProcessClient, observeCodexReady, createCodexInput } from "../CodexTransport.ts";
import { deferred } from "./tests/fixture.ts";
import { READY_LINE, echoEngine } from "./tests/wasm.ts";
import { fixture } from "./tests/fixture.ts";

const encoder = new TextEncoder();
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Union([Schema.String, Schema.Number]),
      method: Schema.String,
      params: Schema.Unknown,
    }),
  ),
);
const encode = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

describe("Codex typed stdio", () => {
  it.effect(
    "starts consuming ready before waiting, keeps bootstrap first, and decodes a typed response",
    () =>
      Effect.gen(function* () {
        const context = fixture(echoEngine());
        const output = deferred<ReadableStreamDefaultController<Uint8Array>>();
        const raw = new ReadableStream<Uint8Array>({
          start(controller) {
            output.resolve(controller);
          },
        });
        const controller = yield* Effect.promise(() => output.promise);
        const observed = observeCodexReady(raw);
        const writes: string[] = [];
        const failed: unknown[] = [];
        const hostInput = new WritableStream<Uint8Array>({
          write(bytes) {
            const text = new TextDecoder().decode(bytes);
            writes.push(text);
            if (writes.length === 1) return;
            const request = decodeRequest(text);
            expect(request.method).toBe("account/read");
            controller.enqueue(
              encoder.encode(
                encode({
                  id: request.id,
                  result: {
                    account: null,
                    requiresOpenaiAuth: false,
                  },
                }) + "\n",
              ),
            );
          },
        });
        const input = createCodexInput(
          { ...context.options, stdio: { ...context.stdio, stdin: hostInput } },
          (error) => failed.push(error),
        );
        const ended = deferred<{ exitCode: number; signal: number; coreDumped: boolean }>();
        const process: CodexHarnessProcess = {
          stdin: input.stdin,
          stdout: observed.stdout,
          stderr: new ReadableStream({
            start(output) {
              output.close();
            },
          }),
          ready: observed.ready,
          exited: ended.promise,
          async abort() {
            ended.resolve({ exitCode: 0, signal: 15, coreDumped: false });
          },
          async dispose() {},
        };
        controller.enqueue(encoder.encode(READY_LINE.slice(0, 9)));
        controller.enqueue(encoder.encode(READY_LINE.slice(9)));
        try {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const client = yield* makeCodexProcessClient(process);
              yield* Effect.promise(() => process.ready);
              const response = yield* client.request("account/read", {});
              expect(response.account).toBeNull();
              expect(response.requiresOpenaiAuth).toBe(false);
            }),
          );
          expect(writes[0]).toBe(encode(context.options.bootstrap) + "\n");
          expect(writes).toHaveLength(2);
          expect(failed).toEqual([]);
        } finally {
          yield* Effect.promise(async () => {
            await input.dispose();
            await process.abort();
            await context.close();
          });
        }
      }),
  );

  it("rejects readiness at EOF and passes non-ready frames through unchanged", async () => {
    const line = '{"method":"other","params":"signalbox/ready"}\n';
    const observed = observeCodexReady(
      new ReadableStream({
        start(output) {
          output.enqueue(encoder.encode(line));
          output.close();
        },
      }),
    );
    const ready = expect(observed.ready).rejects.toThrow("ended before signalbox/ready");
    let text = "";
    for await (const bytes of observed.stdout) text += new TextDecoder().decode(bytes);
    await ready;
    expect(text).toBe(line);
  });
});
