// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - exercise the deployed host's RPC failure boundary in workerd.
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
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "probe-forwarding-"));
  await NodeFSP.cp(NodePath.join(import.meta.dirname, "generated"), directory, {
    recursive: true,
  });
  await NodeFSP.writeFile(
    NodePath.join(directory, "entry.js"),
    `import handler from "./worker.js";
export { ProbeSession, CodeGeneration } from "./worker.js";
export default {fetch(request, env) {
  return handler.fetch(request, {...env, PROBE: {
    idFromName() { return "forced-startup-failure"; },
    get() { return {async fetch() { throw new Error("native startup failed"); }}; }
  }});
}};`,
  );
  await NodeFSP.writeFile(
    NodePath.join(directory, "wrangler.json"),
    JSON.stringify({
      name: "probe-forwarding-test",
      main: "entry.js",
      no_bundle: true,
      find_additional_modules: true,
      base_dir: ".",
      rules: [{ type: "ESModule", globs: ["**/*.js"], fallthrough: true }],
      compatibility_date: "2026-10-18",
      compatibility_flags: ["nodejs_compat"],
      worker_loaders: [{ binding: "LOADER" }],
      durable_objects: { bindings: [{ name: "PROBE", class_name: "ProbeSession" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["ProbeSession"] }],
      vars: { PROBE_SECRET: "local-probe-only" },
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

describe("probe Durable Object forwarding failures", () => {
  it("keeps a rejected native fetch as HTTP 500 and records its error in proof JSON", async () => {
    const response = await fetch(new URL("/root/status?session=cold-failure", endpoint), {
      headers: { authorization: "Bearer local-probe-only" },
    });
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Error: native startup failed" });
  });

  it("rejects authentication and missing sessions before touching the native stub", async () => {
    const unauthorized = await fetch(new URL("/root/status?session=cold-failure", endpoint));
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.text()).toBe("Unauthorized");
    const sessionless = await fetch(endpoint, {
      headers: { authorization: "Bearer local-probe-only" },
    });
    expect(sessionless.status).toBe(400);
    expect(await sessionless.text()).toBe("Invalid session");
  });
});
