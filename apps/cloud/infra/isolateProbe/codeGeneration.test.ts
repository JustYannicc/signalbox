// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - exercise native loopback bindings and nested workers in real workerd.
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { createTestHarness } from "wrangler";
import { prepare } from "./prepare.ts";
import { encodeModuleTransport, MODULE_TRANSPORT_CONTENT_TYPE } from "./moduleTransport.ts";

let harness: ReturnType<typeof createTestHarness> | undefined;
let endpoint: string;
let outboundUrl: string;
let outboundRequests = 0;
const server = NodeHttp.createServer((_request, response) => {
  outboundRequests++;
  response.end("network reached");
});

beforeAll(async () => {
  await prepare();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP port");
  outboundUrl = `http://127.0.0.1:${address.port}/generated`;
  harness = createTestHarness({
    workers: [{ configPath: NodePath.join(import.meta.dirname, "wrangler.jsonc") }],
  });
  endpoint = (await harness.listen()).url.toString();
}, 15000);

afterAll(async () => {
  try {
    await harness?.close();
  } finally {
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }
});

const source = `import { DurableObject } from "cloudflare:workers";
async function run(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/bindings") return Response.json({keys:Object.keys(env)});
  const response = await env.CODE_GENERATION.fetch("https://code-generation.invalid" + (url.searchParams.get("route") ?? "/invoke"), {
    method:url.searchParams.get("method") ?? "POST",
    headers:{"content-type":url.searchParams.get("type") ?? "application/json"},
    body:url.searchParams.get("method") === "GET" ? undefined : url.searchParams.get("body"),
  });
  const body = await response.text();
  return Response.json({status:response.status,statusText:response.statusText,ok:response.ok,
    headers:Object.fromEntries(response.headers),body,...(response.ok ? {value:JSON.parse(body)} : {})});
}
export default {fetch:run};
export class ProbeFacet extends DurableObject {fetch(request){return run(request,this.env)}}`;

type Options = {
  session?: string;
  fixture?: string;
  mode?: "worker" | "facet";
  framed?: boolean;
  allowGeneratedCode?: unknown;
  allowOutbound?: boolean;
  route?: string;
  method?: string;
  type?: string;
};

async function run(body: unknown, options: Options = {}) {
  const params = new URLSearchParams({
    body: typeof body === "string" ? body : (JSON.stringify(body) ?? "null"),
  });
  for (const key of ["route", "method", "type"] as const) {
    const value = options[key];
    if (value) params.set(key, value);
  }
  const input = {
    id: options.fixture ?? "fixture",
    mode: options.mode ?? "worker",
    path: body === undefined ? "/bindings" : `/invoke?${params}`,
    allowGeneratedCode: options.allowGeneratedCode,
    allowOutbound: options.allowOutbound,
  };
  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers: {
      authorization: "Bearer local-probe-only",
      "content-type": options.framed ? MODULE_TRANSPORT_CONTENT_TYPE : "application/json",
    },
    body: options.framed
      ? encodeModuleTransport(input, [
          { name: "main.js", type: "js", bytes: new TextEncoder().encode(source) },
        ])
      : JSON.stringify({ ...input, modules: { "main.js": source } }),
    ...(options.framed ? { duplex: "half" } : {}),
  };
  const response = await fetch(
    new URL(`/run?session=${options.session ?? "code-generation"}`, endpoint),
    init,
  );
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).not.toHaveProperty("error");
  expect(result).toMatchObject({ status: 200 });
  if (!result || typeof result !== "object" || !("result" in result)) {
    throw new Error("Missing fixture result");
  }
  return result.result;
}

const invocation = (main: string, input: unknown = { answer: 42 }) => ({
  id: "caller-label",
  mainModule: "main.js",
  modules: { "main.js": main },
  input,
});

describe("opt-in native CODE_GENERATION", () => {
  it("only grants a real Fetcher for exact true on legacy and framed workers and facets", async () => {
    for (const framed of [false, true]) {
      for (const mode of ["worker", "facet"] as const) {
        // Reuse the label to prove enabling a cached fixture cannot leak its binding on opt-out.
        for (const allowGeneratedCode of [true, undefined, false, "true", 1]) {
          const result = await run(undefined, {
            framed,
            mode,
            allowGeneratedCode,
            session: `bindings-${framed}-${mode}`,
          });
          expect(result).toEqual({ keys: allowGeneratedCode === true ? ["CODE_GENERATION"] : [] });
        }
        const result = await run(
          invocation(
            `export default {async fetch(request,env){return Response.json({input:await request.json(),keys:Object.keys(env)})}}`,
          ),
          { framed, mode, allowGeneratedCode: true, session: `bindings-${framed}-${mode}` },
        );
        expect(result).toMatchObject({
          status: 200,
          ok: true,
          value: { input: { answer: 42 }, keys: [] },
        });
      }
    }
  });

  it("passes the native status, headers and body through, including unsuccessful responses", async () => {
    const options = { allowGeneratedCode: true, session: "responses" };
    const result = await run(
      invocation(
        `export default {fetch(){return new Response("native body 🌍",{status:418,statusText:"Generated teapot",headers:{"x-generated":"yes","content-type":"text/plain"}})}}`,
      ),
      options,
    );
    expect(result).toMatchObject({
      status: 418,
      statusText: "Generated teapot",
      ok: false,
      body: "native body 🌍",
      headers: { "x-generated": "yes", "content-type": "text/plain" },
    });
    const success = await run(
      invocation(
        `export default {fetch(){return Response.json({answer:42},{status:203,headers:{"x-generated":"json"}})}}`,
      ),
      options,
    );
    expect(success).toMatchObject({
      status: 203,
      ok: true,
      value: { answer: 42 },
      headers: { "x-generated": "json" },
    });
  });

  it("caches canonical same-source modules, ignores labels and input for identity, and replaces changed code", async () => {
    const options = { allowGeneratedCode: true, session: "caching" };
    const main = `import {value} from "./value.js"; let count=0; export default {async fetch(request){return Response.json({count:++count,value,input:await request.json()})}}`;
    const first = {
      id: "same-label",
      mainModule: "main.js",
      modules: { "main.js": main, "value.js": "export const value = 1;" },
      input: 1,
    };
    expect(await run(first, options)).toMatchObject({ value: { count: 1, value: 1, input: 1 } });
    expect(
      await run(
        {
          ...first,
          id: "different-label",
          modules: { "value.js": first.modules["value.js"], "main.js": main },
          input: 2,
        },
        options,
      ),
    ).toMatchObject({ value: { count: 2, value: 1, input: 2 } });
    expect(
      await run(
        { ...first, modules: { ...first.modules, "value.js": "export const value = 2;" } },
        options,
      ),
    ).toMatchObject({ value: { count: 1, value: 2 } });
    expect(await run(first, options)).toMatchObject({ value: { count: 3, value: 1 } });
    const alternate = `let count=0; export default {fetch(){return Response.json({count:++count})}}`;
    const multi = { ...first, modules: { "main.js": alternate, "other.js": alternate } };
    expect(await run(multi, options)).toMatchObject({ value: { count: 1 } });
    expect(await run({ ...multi, mainModule: "other.js" }, options)).toMatchObject({
      value: { count: 1 },
    });
  });

  it("isolates identical generated modules between sessions, fixtures, and worker/facet callers", async () => {
    const body = invocation(
      `let count=0; export default {fetch(){return Response.json({count:++count})}}`,
    );
    for (const session of ["caller-a", "caller-b"]) {
      for (const fixture of ["facet-a", "facet-b"]) {
        for (const mode of ["worker", "facet"] as const) {
          const options = { allowGeneratedCode: true, session, fixture, mode };
          expect(await run(body, options)).toMatchObject({ value: { count: 1 } });
          expect(await run(body, options)).toMatchObject({ value: { count: 2 } });
        }
      }
    }
  });

  it("denies generated outbound even when the fixture has outbound access", async () => {
    const result = await run(
      invocation(
        `export default {async fetch(request,env){try {await fetch(${JSON.stringify(outboundUrl)});return Response.json({allowed:true})} catch {return Response.json({allowed:false,keys:Object.keys(env)})}}}`,
      ),
      { allowGeneratedCode: true, allowOutbound: true, session: "outbound" },
    );
    expect(result).toMatchObject({ status: 200, value: { allowed: false, keys: [] } });
    expect(outboundRequests).toBe(0);
  });

  it("rejects malformed envelopes and unsupported HTTP requests explicitly", async () => {
    const options = { allowGeneratedCode: true, session: "invalid" };
    const valid = invocation("export default {};");
    for (const body of [
      "{",
      null,
      [],
      {},
      { ...valid, id: "bad/id" },
      { ...valid, id: "a".repeat(101) },
      { ...valid, mainModule: "missing.js" },
      { ...valid, modules: { "main.js": 42 } },
      { ...valid, modules: { "main.js": "export default {};", "": "" } },
      { ...valid, budget: 10 },
    ]) {
      expect(await run(body, options)).toMatchObject({
        status: 400,
        ok: false,
        body: expect.stringContaining("CODE_GENERATION: invalid invocation"),
      });
    }
    expect(await run(valid, { ...options, method: "GET" })).toMatchObject({
      status: 405,
      headers: { allow: "POST" },
    });
    expect(await run(valid, { ...options, route: "/other" })).toMatchObject({ status: 404 });
    expect(await run(valid, { ...options, type: "text/plain" })).toMatchObject({ status: 415 });
  });

  it("reports native compilation and execution errors without interpreter fallback", async () => {
    for (const main of [
      "export !!!",
      `export default {fetch(){throw new Error("generated boom")}}`,
    ]) {
      expect(
        await run(invocation(main), { allowGeneratedCode: true, session: "native-errors" }),
      ).toMatchObject({
        status: 500,
        ok: false,
        body: expect.stringContaining("CODE_GENERATION: native execution failed"),
      });
    }
  });
});
