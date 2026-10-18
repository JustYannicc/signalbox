// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - exercise native Worker Loader network permissions through the standalone host.
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { createTestHarness } from "wrangler";
import { prepare } from "./prepare.ts";

let harness: ReturnType<typeof createTestHarness> | undefined;
let endpoint: string;
let outboundUrl: string;
let outboundRequests = 0;
const server = NodeHttp.createServer((_request, response) => {
  outboundRequests++;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ answer: 42 }));
});

beforeAll(async () => {
  await prepare();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Missing test port");
  outboundUrl = `http://127.0.0.1:${address.port}/fixture`;
  harness = createTestHarness({
    workers: [{ configPath: NodePath.join(import.meta.dirname, "wrangler.jsonc") }],
  });
  endpoint = (await harness.listen()).url.toString();
}, 15000);

afterAll(async () => {
  try {
    await harness?.close();
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
});

const run = async (id: string, allowOutbound?: unknown) => {
  const response = await fetch(new URL(`/run?session=${id}`, endpoint), {
    method: "POST",
    headers: { authorization: "Bearer local-probe-only", "content-type": "application/json" },
    body: JSON.stringify({
      id,
      allowOutbound,
      modules: {
        "main.js": {
          js: `import {DurableObject} from "cloudflare:workers";
          export class ProbeFacet extends DurableObject {
            async fetch() {
              try {
                const response = await fetch(${JSON.stringify(outboundUrl)});
                return Response.json({allowed:true,value:await response.json()});
              } catch { return Response.json({allowed:false}); }
            }
          }`,
        },
      },
    }),
  });
  return response.json();
};

describe("isolate fixture outbound access", () => {
  it("blocks network unless a fixture explicitly supplies true", async () => {
    for (const [index, value] of [undefined, false, "true"].entries()) {
      const result = await run(`outbound-denied-${index}`, value);
      expect(result).toMatchObject({ status: 200, result: { allowed: false } });
    }
    expect(outboundRequests).toBe(0);
    const result = await run("outbound-allowed", true);
    expect(result).toMatchObject({ status: 200, result: { allowed: true, value: { answer: 42 } } });
    expect(outboundRequests).toBe(1);
  });
});
