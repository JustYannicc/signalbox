// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - inspect the actual loader callback in an isolated workerd host.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { createTestHarness } from "wrangler";
import { prepare } from "./prepare.ts";

let harness: ReturnType<typeof createTestHarness> | undefined;
let directory: string;
let endpoint: string;

beforeAll(async () => {
  await prepare();
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "probe-cpu-"));
  await NodeFSP.cp(NodePath.join(import.meta.dirname, "generated"), directory, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(directory, "entry.js"),
    `import handler, { ProbeSession as Base } from "./worker.js";
export { CodeGeneration, ChildWorkerDispatch } from "./worker.js";
export class ProbeSession extends Base {
  constructor(ctx, env) {
    super(ctx, {...env, LOADER: {
      get(id, build) {
        return {getEntrypoint() {return {async fetch() {
          const code = await build();
          return Response.json({limits: code.limits ?? null});
        }}}};
      }
    }});
  }
}
export default handler;`,
  );
  await NodeFSP.writeFile(
    NodePath.join(directory, "wrangler.json"),
    JSON.stringify({
      name: "probe-cpu-test",
      main: "entry.js",
      no_bundle: true,
      find_additional_modules: true,
      base_dir: ".",
      rules: [{ type: "ESModule", globs: ["**/*.js"], fallthrough: true }],
      compatibility_date: "2026-10-18",
      compatibility_flags: ["nodejs_compat"],
      durable_objects: { bindings: [{ name: "PROBE", class_name: "ProbeSession" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["ProbeSession"] }],
      vars: { PROBE_SECRET: "local-probe-only", DYNAMIC_WORKER_CPU_MS: "300000" },
    }),
  );
  harness = createTestHarness({
    workers: [{ configPath: NodePath.join(directory, "wrangler.json") }],
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

describe("application WorkerCode CPU configuration", () => {
  it("sets the loader code limit from the host binding", async () => {
    const response = await fetch(new URL("/run?session=cpu-binding", endpoint), {
      method: "POST",
      headers: { authorization: "Bearer local-probe-only", "content-type": "application/json" },
      body: JSON.stringify({
        id: "fixture",
        mode: "worker",
        modules: { "main.js": "export default {}" },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 200,
      result: { limits: { cpuMs: 300000 } },
    });
  });
});
