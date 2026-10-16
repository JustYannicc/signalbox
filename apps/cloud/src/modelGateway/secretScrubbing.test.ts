// @effect-diagnostics cryptoRandomUUID:off - fake secrets are generated per run, so no test ever holds a real one.
import { type SecretValue, secretPlaceholder } from "@signalbox/runner-protocol/SecretScrubber";
import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import type { ModelForwardReply, PoolObjectNamespace } from "../pool/PoolDirectory.ts";
import type { ThreadObjectNamespace } from "../thread/ThreadDirectory.ts";
import type { ModelAuthorization } from "../thread/runner/ThreadRunner.ts";
import { serveModel } from "../thread/runner/modelGrants.ts";
import type { UserObjectNamespace } from "../user/UserDirectory.ts";
import { handleModelRequest } from "./modelGateway.ts";

/**
 * #591: what the provider gets when a turn's tool printed a folder secret.
 * The gateway and the cloud's side of it run for real; the thread grants the
 * turn with its registered secrets, and the pool records the exact body it
 * was handed. Every secret here is generated per run.
 */

/** A model token for thread `thread-a` (`modelToken.ts`). */
const TOKEN = "sbm1.dGhyZWFkLWE.live";

const fake = (label: string) => `${label}-${crypto.randomUUID()}`;

const byName = <A>(get: (name: string) => A) => ({
  idFromName: (name: string) => name as unknown as DurableObjectId,
  jurisdiction: () => ({ idFromName: (name: string) => name as unknown as DurableObjectId }),
  get: (id: DurableObjectId) => get(id as unknown as string),
});

interface Forwarded {
  readonly body: string;
  readonly headers: Headers;
}

const runId = RunId.make("run-1");
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

/** A gateway for a turn the thread grants with `secrets`, or answers `authorization`. */
const makeGateway = (secrets: ReadonlyArray<SecretValue>, authorization?: ModelAuthorization) => {
  const forwarded: Array<Forwarded> = [];
  const threads = byName(() => ({
    authorizeModel: async (): Promise<ModelAuthorization> =>
      authorization ?? {
        _tag: "granted",
        runId,
        traceId,
        pool: { objectName: "user_1:personal", userId: "user_1" },
        secrets,
      },
  })) as unknown as ThreadObjectNamespace;
  const pools = byName(() => ({
    forwardModel: async (_actor: unknown, _path: string, request: Request) => {
      forwarded.push({ body: await request.text(), headers: request.headers });
      return {
        _tag: "forwarded",
        response: new Response("ok"),
        upstreamMs: 1,
      } satisfies ModelForwardReply;
    },
  })) as unknown as PoolObjectNamespace;
  const send = (request: Request) =>
    handleModelRequest(request, {
      serve: (token, provider, served, request) =>
        serveModel(
          {
            threads,
            users: byName(() => ({})) as unknown as UserObjectNamespace,
            pools,
            verifyLocalKey: async () => null,
            token,
            provider,
            path: served,
            request,
          },
          { localWorkerd: true },
        ),
      now: () => 0,
      log: () => undefined,
    });
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
};

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
  it("forwards `echo $KEY` from Claude Code with only the placeholder", async () => {
    const value = fake("sk-fake");
    const gateway = makeGateway([{ name: "FAKE_SECRET", value }]);

    const response = await gateway.call("/anthropic/v1/messages", claudeEcho(`${value}\n`));

    expect(response.status).toBe(200);
    expect(gateway.forwarded.map(({ body }) => body)).toEqual([claudeEcho(`${FAKE}\n`)]);
  });

  it("forwards `cat .env` from Codex with only the placeholders", async () => {
    const value = fake("sk-fake");
    const password = fake("pw");
    const gateway = makeGateway([
      { name: "FAKE_SECRET", value },
      { name: "DATABASE_PASSWORD", value: password },
    ]);
    const env = (key: string, pass: string) =>
      `FAKE_SECRET=${key}\nDATABASE_URL=postgres://app:${pass}@db.internal/app\nPORT=3000\n`;

    await gateway.call("/openai/v1/responses", codexCat(env(value, password)));

    expect(gateway.forwarded.map(({ body }) => body)).toEqual([codexCat(env(FAKE, DB))]);
  });

  it("forwards the encoded forms masked too", async () => {
    const value = `quote"and\\slash-${crypto.randomUUID()}`;
    const gateway = makeGateway([{ name: "FAKE_SECRET", value }]);
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

    await gateway.call("/anthropic/v1/messages", claudeEcho(printed));

    const [sent] = gateway.forwarded;
    expect(sent?.body.split(FAKE).length).toBe(6);
    for (const form of printed.split("\n")) {
      expect(sent?.body.includes(JSON.stringify(form).slice(1, -1))).toBe(false);
    }
  });

  it("catches a value split across the body's chunks, wherever it splits", async () => {
    const value = fake("split");
    const gateway = makeGateway([{ name: "FAKE_SECRET", value }]);
    const body = claudeEcho(`${value}\n`);
    const at = body.indexOf(value);

    for (let cut = at - 1; cut <= at + value.length + 1; cut += 1) {
      await gateway.call("/anthropic/v1/messages", chunked(body, [cut]));
    }
    await gateway.call(
      "/anthropic/v1/messages",
      chunked(
        body,
        Array.from({ length: body.length }, (_, index) => index),
      ),
    );

    expect(new Set(gateway.forwarded.map(({ body: sent }) => sent))).toEqual(
      new Set([claudeEcho(`${FAKE}\n`)]),
    );
  });

  it("reads a compressed body and forwards it scrubbed and plain", async () => {
    const value = fake("gz");
    const gateway = makeGateway([{ name: "FAKE_SECRET", value }]);

    await gateway.call("/openai/v1/responses", await gzip(codexCat(`${value}\n`)), {
      "content-encoding": "gzip",
    });

    const [sent] = gateway.forwarded;
    expect(sent?.body).toBe(codexCat(`${FAKE}\n`));
    expect(sent?.headers.has("content-encoding")).toBe(false);
  });

  it("refuses a body it can't read rather than forward it unscrubbed", async () => {
    const gateway = makeGateway([{ name: "FAKE_SECRET", value: fake("zstd") }]);

    const response = await gateway.call("/openai/v1/responses", "(µ/ý", {
      "content-encoding": "zstd",
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("zstd-encoded");
    expect(gateway.forwarded).toEqual([]);
  });

  it("refuses a turn whose secrets aren't registered as the turn's, not as a bad key", async () => {
    const reason = "This machine hasn't registered the folder's secrets to hide them yet.";
    const gateway = makeGateway([], { _tag: "unregistered", runId, traceId, reason });

    const response = await gateway.call("/anthropic/v1/messages", claudeEcho("anything"));

    // 403: a 401 would send the harness to sign in again.
    expect(response.status).toBe(403);
    expect(await response.text()).toContain(reason);
    expect(gateway.forwarded).toEqual([]);
  });

  it("refuses a body that isn't JSON or text", async () => {
    const gateway = makeGateway([{ name: "FAKE_SECRET", value: fake("bin") }]);

    const response = await gateway.call("/anthropic/v1/messages", new Uint8Array([255, 0]), {
      "content-type": "application/octet-stream",
    });

    expect(response.status).toBe(403);
    expect(gateway.forwarded).toEqual([]);
  });

  it("refuses a WebSocket, whose messages it would never see", async () => {
    const gateway = makeGateway([{ name: "FAKE_SECRET", value: fake("ws") }]);

    const response = await gateway.upgrade();

    expect(response.status).toBe(403);
    expect(gateway.forwarded).toEqual([]);
  });

  it("forwards a turn without secrets exactly as it came", async () => {
    const gateway = makeGateway([]);
    const body = await gzip(codexCat("nothing secret\n"));

    await gateway.call("/openai/v1/responses", body, { "content-encoding": "gzip" });

    const [sent] = gateway.forwarded;
    expect(sent?.headers.get("content-encoding")).toBe("gzip");
    expect(new TextEncoder().encode(sent?.body ?? "").length).toBeGreaterThan(0);
  });
});
