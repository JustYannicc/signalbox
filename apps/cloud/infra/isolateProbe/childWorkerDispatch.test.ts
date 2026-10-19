import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { createTestHarness } from "wrangler";
import { prepare } from "./prepare.ts";
import { JSPI_WASM } from "./wasmFixture.ts";

let harness: ReturnType<typeof createTestHarness> | undefined;
let endpoint: string;

beforeAll(async () => {
  await prepare();
  harness = createTestHarness({
    workers: [{ configPath: NodePath.join(import.meta.dirname, "wrangler.jsonc") }],
  });
  endpoint = (await harness.listen()).url.toString();
}, 15000);

afterAll(async () => {
  await harness?.close();
});

const childSource = `import {WorkerEntrypoint} from "cloudflare:workers";
import module from "./suspend.wasm";
export class Child extends WorkerEntrypoint {
  async run(command, host) {
    const response = await host.increment(40, {bytes:new Uint8Array([0,255,128]),offset:9007199254740993n});
    if (!(response.bytes instanceof Uint8Array) || response.bytes[1] !== 255 || response.offset !== 9007199254740993n) throw new Error("RPC return bytes or bigint changed");
    const value = response.value;
    const instance = new WebAssembly.Instance(module, {env:{suspend:n => n + 1}});
    const exitCode = instance.exports.run(value);
    let networkBlocked = false;
    try { await fetch("https://example.com/"); } catch { networkBlocked = true; }
    await host.observe(command, networkBlocked);
    return {exitCode,signal:0,coreDumped:false};
  }
}`;

const source = `import {DurableObject,RpcTarget} from "cloudflare:workers";
const child = ${JSON.stringify(childSource)};
class Host extends RpcTarget {
  constructor(storage) { super(); this.storage = storage; }
  increment(n, payload) {
    if (!(payload.bytes instanceof Uint8Array) || payload.bytes[1] !== 255 || payload.offset !== 9007199254740993n) throw new Error("RPC request bytes or bigint changed");
    this.storage.sql.exec("CREATE TABLE IF NOT EXISTS counts (n INTEGER)");
    this.storage.sql.exec("INSERT INTO counts VALUES (?)", n);
    return {value:n,...payload};
  }
  observe(command, networkBlocked) { this.observed = {command,networkBlocked}; }
}
export class ProbeFacet extends DurableObject {
  async fetch() {
    if (!this.env.CHILD_WORKERS) return Response.json({keys:Object.keys(this.env)});
    const command = {executable:"/bin/probe",argv:["different-argv0","binary"],cwd:"/work",env:{EXACT:"value"}};
    const host = new Host(this.ctx.storage);
    try {
      const exit = await this.env.CHILD_WORKERS.run({
        mainModule:"child.js",entrypoint:"Child",command,
        modules:{"child.js":child,"suspend.wasm":{wasm:new Uint8Array(${JSON.stringify([...JSPI_WASM])}).buffer}},
      },host);
      const count = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM counts").toArray()[0].n;
      return Response.json({exit,count,...host.observed});
    } catch(error) { return Response.json({error:String(error)},{status:500}); }
  }
}`;

async function run(allowChildWorkers: unknown, id: string) {
  const response = await fetch(new URL(`/run?session=${id}`, endpoint), {
    method: "POST",
    headers: { authorization: "Bearer local-probe-only", "content-type": "application/json" },
    body: JSON.stringify({
      id,
      allowChildWorkers,
      mainModule: "main.js",
      modules: { "main.js": source },
    }),
  });
  return response.json();
}

describe("child Worker proof dispatch", () => {
  it("requires an explicit true and keeps warm opt-in state separate", async () => {
    for (const [index, value] of [undefined, false, "true", 1].entries()) {
      expect(await run(value, `child-denied-${index}`)).toMatchObject({
        status: 200,
        result: { keys: [] },
      });
    }
    const enabled = await run(true, "child-warm-opt-in");
    expect(enabled).toMatchObject({ status: 200, result: { count: 1 } });
    expect(await run(false, "child-warm-opt-in")).toMatchObject({
      status: 200,
      result: { keys: [] },
    });
  });

  it("loads WASM in a child, calls the facet over RPC and blocks network", async () => {
    for (const count of [1, 2]) {
      const result = await run(true, "child-wasm-rpc");
      expect(result).toMatchObject({
        status: 200,
        result: {
          exit: { exitCode: 42, signal: 0, coreDumped: false },
          count,
          command: {
            executable: "/bin/probe",
            argv: ["different-argv0", "binary"],
            cwd: "/work",
            env: { EXACT: "value" },
          },
          networkBlocked: true,
        },
      });
    }
  });
});
