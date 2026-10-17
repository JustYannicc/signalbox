// @effect-diagnostics cryptoRandomUUID:off - fake secrets are generated per run, so no test ever holds a real one.
import { type SecretValue, secretPlaceholder } from "@signalbox/runner-protocol/SecretScrubber";
import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeModelAccess } from "../models/testing.ts";
import type {
  ModelAuthorization,
  ModelForwardReply,
  ModelPoolRoute,
} from "../models/ModelProtocol.ts";
import { handleModelRequest } from "./modelGateway.ts";

/**
 * #591: what the provider gets when a turn's tool printed a folder secret.
 * The gateway and the cloud's side of it run for real; the thread grants the
 * turn with its registered secrets, and the pool records the exact body it
 * was handed. Every secret here is generated per run.
 */

/** A model token for thread `thread-a` (`thread/ModelTokens.ts`). */
const TOKEN = "sbm1.dGhyZWFkLWE.live";

const fake = (label: string) => `${label}-${crypto.randomUUID()}`;

interface Forwarded {
  readonly body: string;
  readonly headers: Headers;
}

const runId = RunId.make("run-1");
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

/** A gateway for a turn the thread grants with `secrets`, or answers `authorization`. */
const makeGateway = (secrets: ReadonlyArray<SecretValue>, authorization?: ModelAuthorization) =>
  Effect.gen(function* () {
    const forwarded: Array<Forwarded> = [];
    const pool: ModelPoolRoute = { objectName: "user_1:personal", userId: "user_1" };
    const access = yield* makeModelAccess({
      authorizeThread: async (): Promise<ModelAuthorization> =>
        authorization ?? {
          _tag: "granted",
          runId,
          traceId,
          pool,
          secrets,
        },
      authorizeLocal: async () => ({ _tag: "denied", reason: "not used" }),
      forward: async (_pool, _path, request) => {
        forwarded.push({ body: await request.text(), headers: request.headers });
        return {
          _tag: "forwarded",
          response: new Response("ok"),
          upstreamMs: 1,
        } satisfies ModelForwardReply;
      },
      recordThread: async () => undefined,
      recordLocal: async () => undefined,
    });
    const send = (request: Request) =>
      Effect.promise(() =>
        handleModelRequest(request, {
          serve: (token, provider, served, request) =>
            access.serve({ token, provider, path: served, request }),
          now: () => 0,
          log: () => undefined,
        }),
      );
    const call = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
      send(
        new Request(`http://gateway.test${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, ...headers },
          body,
          duplex: "half",
        } as RequestInit),
      );
    /** Codex opening the Responses API over a WebSocket. */
    const upgrade = () =>
      send(
        new Request("http://gateway.test/openai/v1/responses", {
          headers: { authorization: `Bearer ${TOKEN}`, upgrade: "websocket" },
        }),
      );
    return { call, upgrade, forwarded };
  });

/** `text` as a body that arrives in the pieces `cuts` makes. */
const chunked = (text: string, cuts: ReadonlyArray<number>) => {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let from = 0;
      for (const cut of [...cuts, bytes.length]) {
        controller.enqueue(bytes.slice(from, cut));
        from = cut;
      }
      controller.close();
    },
  });
};

const gzip = (text: string) =>
  new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();

/** Claude Code's request after `echo $FAKE_SECRET`, with the tool's output as `output`. */
const claudeEcho = (output: string) =>
  JSON.stringify({
    model: "claude-fable-5-1",
    max_tokens: 1024,
    stream: true,
    messages: [
      { role: "user", content: "Print the key." },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "echo $FAKE_SECRET" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: output }],
      },
    ],
  });

/** Codex's request after `cat .env`, with the file as `output`. */
const codexCat = (output: string) =>
  JSON.stringify({
    model: "gpt-6-luna",
    stream: true,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Show .env" }] },
      {
        type: "function_call",
        name: "shell",
        call_id: "call_1",
        arguments: JSON.stringify({ command: ["bash", "-lc", "cat .env"] }),
      },
      { type: "function_call_output", call_id: "call_1", output },
    ],
  });

const FAKE = secretPlaceholder("FAKE_SECRET");
const DB = secretPlaceholder("DATABASE_PASSWORD");

describe("the ModelGateway with a turn's secrets", () => {
  it.effect("forwards `echo $KEY` from Claude Code with only the placeholder", () =>
    Effect.gen(function* () {
      const value = fake("sk-fake");
      const gateway = yield* makeGateway([{ name: "FAKE_SECRET", value }]);

      const response = yield* gateway.call("/anthropic/v1/messages", claudeEcho(`${value}\n`));

      expect(response.status).toBe(200);
      expect(gateway.forwarded.map(({ body }) => body)).toEqual([claudeEcho(`${FAKE}\n`)]);
    }),
  );

  it.effect("forwards `cat .env` from Codex with only the placeholders", () =>
    Effect.gen(function* () {
      const value = fake("sk-fake");
      const password = fake("pw");
      const gateway = yield* makeGateway([
        { name: "FAKE_SECRET", value },
        { name: "DATABASE_PASSWORD", value: password },
      ]);
      const env = (key: string, pass: string) =>
        `FAKE_SECRET=${key}\nDATABASE_URL=postgres://app:${pass}@db.internal/app\nPORT=3000\n`;

      yield* gateway.call("/openai/v1/responses", codexCat(env(value, password)));

      expect(gateway.forwarded.map(({ body }) => body)).toEqual([codexCat(env(FAKE, DB))]);
    }),
  );

  it.effect("forwards the encoded forms masked too", () =>
    Effect.gen(function* () {
      const value = fake('quote"and\\slash');
      const gateway = yield* makeGateway([{ name: "FAKE_SECRET", value }]);
      const bytes = new TextEncoder().encode(`FAKE_SECRET=${value}\n`);
      const printed = [
        btoa(String.fromCharCode(...bytes)),
        encodeURIComponent(value),
        JSON.stringify({ key: value }),
        Array.from(new TextEncoder().encode(value), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
        `'${value}'`,
      ].join("\n");

      yield* gateway.call("/anthropic/v1/messages", claudeEcho(printed));

      const [sent] = gateway.forwarded;
      expect(sent?.body.split(FAKE).length).toBe(6);
      for (const form of printed.split("\n")) {
        expect(sent?.body.includes(JSON.stringify(form).slice(1, -1))).toBe(false);
      }
    }),
  );

  it.effect("catches a value split across the body's chunks, wherever it splits", () =>
    Effect.gen(function* () {
      const value = fake("split");
      const gateway = yield* makeGateway([{ name: "FAKE_SECRET", value }]);
      const body = claudeEcho(`${value}\n`);
      const at = body.indexOf(value);

      for (let cut = at - 1; cut <= at + value.length + 1; cut += 1) {
        yield* gateway.call("/anthropic/v1/messages", chunked(body, [cut]));
      }
      yield* gateway.call(
        "/anthropic/v1/messages",
        chunked(
          body,
          Array.from({ length: body.length }, (_, index) => index),
        ),
      );

      expect(new Set(gateway.forwarded.map(({ body: sent }) => sent))).toEqual(
        new Set([claudeEcho(`${FAKE}\n`)]),
      );
    }),
  );

  it.effect("reads a compressed body and forwards it scrubbed and plain", () =>
    Effect.gen(function* () {
      const value = fake("gz");
      const gateway = yield* makeGateway([{ name: "FAKE_SECRET", value }]);
      const body = yield* Effect.promise(() => gzip(codexCat(`${value}\n`)));

      yield* gateway.call("/openai/v1/responses", body, { "content-encoding": "gzip" });

      const [sent] = gateway.forwarded;
      expect(sent?.body).toBe(codexCat(`${FAKE}\n`));
      expect(sent?.headers.has("content-encoding")).toBe(false);
    }),
  );

  it.effect("refuses a body it can't read rather than forward it unscrubbed", () =>
    Effect.gen(function* () {
      const gateway = yield* makeGateway([{ name: "FAKE_SECRET", value: fake("zstd") }]);

      const response = yield* gateway.call("/openai/v1/responses", "(µ/ý", {
        "content-encoding": "zstd",
      });

      expect(response.status).toBe(403);
      expect(yield* Effect.promise(() => response.text())).toContain("zstd-encoded");
      expect(gateway.forwarded).toEqual([]);
    }),
  );

  it.effect("refuses a turn whose secrets aren't registered as the turn's, not as a bad key", () =>
    Effect.gen(function* () {
      const reason = "This machine hasn't registered the folder's secrets to hide them yet.";
      const gateway = yield* makeGateway([], { _tag: "unregistered", runId, traceId, reason });

      const response = yield* gateway.call("/anthropic/v1/messages", claudeEcho("anything"));

      // 403: a 401 would send the harness to sign in again.
      expect(response.status).toBe(403);
      expect(yield* Effect.promise(() => response.text())).toContain(reason);
      expect(gateway.forwarded).toEqual([]);
    }),
  );

  it.effect("refuses a body that isn't JSON or text", () =>
    Effect.gen(function* () {
      const gateway = yield* makeGateway([{ name: "FAKE_SECRET", value: fake("bin") }]);

      const response = yield* gateway.call("/anthropic/v1/messages", new Uint8Array([255, 0]), {
        "content-type": "application/octet-stream",
      });

      expect(response.status).toBe(403);
      expect(gateway.forwarded).toEqual([]);
    }),
  );

  it.effect("refuses a WebSocket, whose messages it would never see", () =>
    Effect.gen(function* () {
      const gateway = yield* makeGateway([{ name: "FAKE_SECRET", value: fake("ws") }]);

      const response = yield* gateway.upgrade();

      expect(response.status).toBe(403);
      expect(gateway.forwarded).toEqual([]);
    }),
  );

  it.effect("forwards a turn without secrets exactly as it came", () =>
    Effect.gen(function* () {
      const gateway = yield* makeGateway([]);
      const body = yield* Effect.promise(() => gzip(codexCat("nothing secret\n")));

      yield* gateway.call("/openai/v1/responses", body, { "content-encoding": "gzip" });

      const [sent] = gateway.forwarded;
      expect(sent?.headers.get("content-encoding")).toBe("gzip");
      expect(new TextEncoder().encode(sent?.body ?? "").length).toBeGreaterThan(0);
    }),
  );
});
