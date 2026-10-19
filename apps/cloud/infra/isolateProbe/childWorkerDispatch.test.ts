import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { createTestHarness } from "wrangler";
import { prepare } from "./prepare.ts";
import { JSPI_WASM } from "./wasmFixture.ts";

let harness: ReturnType<typeof createTestHarness> | undefined;
let directory: string | undefined;
let endpoint: string;

const jspiHash = "3c82c5088c45f5acae60187e020c7f3fce285c2bb032323b318d0372b9c6ed50";

beforeAll(async () => {
  expect(NodeCrypto.createHash("sha256").update(JSPI_WASM).digest("hex")).toBe(jspiHash);
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "probe-child-wasm-registry-"));
  const generatedDirectory = NodePath.join(directory, "generated");
  await prepare({
    generatedDirectory,
    programWasmArtifacts: [
      {
        name: "suspend.wasm",
        bytes: JSPI_WASM,
        byteLength: JSPI_WASM.byteLength,
        sha256: jspiHash,
      },
    ],
  });
  const configPath = NodePath.join(directory, "wrangler.jsonc");
  await NodeFSP.copyFile(new URL("./wrangler.jsonc", import.meta.url), configPath);
  harness = createTestHarness({
    workers: [{ configPath }],
  });
  endpoint = (await harness.listen()).url.toString();
}, 15000);

afterAll(async () => {
  try {
    await harness?.close();
  } finally {
    if (directory) await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

function source(reference: string) {
  const child = `import {WorkerEntrypoint} from "cloudflare:workers";
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
  return `import {DurableObject,RpcTarget} from "cloudflare:workers";
const child = ${JSON.stringify(child)};
class Host extends RpcTarget {
  constructor(storage) { super(); this.storage = storage; this.stoppedCount = 0; this.incrementCount = 0; }
  increment(n, payload) {
    this.incrementCount++;
    if (!(payload.bytes instanceof Uint8Array) || payload.bytes[1] !== 255 || payload.offset !== 9007199254740993n) throw new Error("RPC request bytes or bigint changed");
    this.storage.sql.exec("CREATE TABLE IF NOT EXISTS counts (n INTEGER)");
    this.storage.sql.exec("INSERT INTO counts VALUES (?)", n);
    return {value:n,...payload};
  }
  observe(command, networkBlocked) { this.observed = {command,networkBlocked}; }
  stopped() { this.stoppedCount++; }
}
export class ProbeFacet extends DurableObject {
  async fetch() {
    if (!this.env.CHILD_WORKERS) return Response.json({keys:Object.keys(this.env)});
    const command = {executable:"/bin/probe",argv:["different-argv0","binary"],cwd:"/work",env:{EXACT:"value"}};
    const host = new Host(this.ctx.storage);
    try {
      const exit = await this.env.CHILD_WORKERS.run({
        mainModule:"child.js",entrypoint:"Child",command,
        modules:{"child.js":child,"suspend.wasm":{wasmReference:${JSON.stringify(reference)}}},
      },host);
      const count = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM counts").toArray()[0].n;
      return Response.json({exit,count,...host.observed});
    } catch(error) { return Response.json({error:String(error),stopped:host.stoppedCount,incrementCount:host.incrementCount},{status:500}); }
  }
}`;
}

async function run(allowChildWorkers: unknown, id: string, reference = jspiHash) {
  const response = await fetch(new URL(`/run?session=${id}`, endpoint), {
    method: "POST",
    headers: { authorization: "Bearer local-probe-only", "content-type": "application/json" },
    body: JSON.stringify({
      id,
      allowChildWorkers,
      mainModule: "main.js",
      modules: { "main.js": source(reference) },
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

  it("rejects a missing public registry reference before starting the child", async () => {
    expect(await run(true, "child-unknown-wasm", "b".repeat(64))).toMatchObject({
      status: 200,
      result: {
        status: 500,
        error: "Error: Unknown child WASM reference",
        stopped: 1,
        incrementCount: 0,
      },
    });
  });
});
