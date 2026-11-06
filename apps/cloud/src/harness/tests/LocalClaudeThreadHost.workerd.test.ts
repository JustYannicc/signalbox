// @effect-diagnostics nodeBuiltinImport:off - Wrangler needs a filesystem entry point.
import * as NodeURL from "node:url";
import * as NodeProcess from "node:process";
import { afterEach, beforeAll, beforeEach, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";
import { build } from "esbuild";

let ownerSources: Record<string, string> = {};
beforeAll(async () => {
  for (const [role, entry] of [
    ["Cli", new URL("./productHost/ordinaryCli.workerd.fixture.ts", import.meta.url)],
    ["Kernel", new URL("./productHost/ordinaryKernel.workerd.fixture.ts", import.meta.url)],
    ["Computer", new URL("./productHost/ordinaryComputer.workerd.fixture.ts", import.meta.url)],
    ["Sdk", new URL("./productHost/ordinarySdk.workerd.fixture.ts", import.meta.url)],
  ] as const) {
    const bundled = await build({
      entryPoints: [NodeURL.fileURLToPath(entry)],
      bundle: true,
      minify: true,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["workerd", "worker", "browser"],
      target: "esnext",
      external: ["cloudflare:workers", "node:*"],
      write: false,
    });
    const source = bundled.outputFiles[0]?.text;
    if (source === undefined) throw new Error(`No ${role} owner bundle`);
    ownerSources[`${role.toUpperCase()}_SOURCE`] = source;
  }
}, 60_000);

const makeHarness = (realOwners = false, failedMetadata = false) =>
  createTestHarness({
    workers: [
      {
        config: {
          name: "local-claude-domain-proof",
          main: NodeURL.fileURLToPath(
            new URL("./productHost/localDomainWorkerd.fixture.ts", import.meta.url),
          ),
          compatibility_date: "2026-10-01",
          compatibility_flags: ["nodejs_compat"],
          worker_loaders: [{ binding: "LOADER" }],
          vars: { ...ownerSources, REAL_OWNERS: realOwners, FAILED_METADATA: failedMetadata },
          durable_objects: {
            bindings: [
              { name: "USERS", class_name: "LocalUser" },
              { name: "POOLS", class_name: "LocalPool" },
              { name: "THREADS", class_name: "LocalThread" },
              { name: "OBSERVATIONS", class_name: "OrdinaryObservations" },
            ],
          },
          migrations: [
            {
              tag: "v1",
              new_sqlite_classes: ["LocalUser", "LocalPool", "LocalThread", "OrdinaryObservations"],
            },
          ],
        },
      },
    ],
  });

let harness: ReturnType<typeof makeHarness>;
beforeEach(() => {
  harness = makeHarness();
  return harness.listen();
}, 60_000);
afterEach(() => harness.close());

it("completes one checked Opus 5.5 xhigh turn through separate user, pool and thread objects", async () => {
  const response = await harness.fetch("http://proof/");
  const text = await response.text();
  expect(response.status, text).toBe(200);
  expect(JSON.parse(text)).toMatchObject({
    ok: true,
    runs: 1,
    status: "completed",
    querySelections: [{ model: "claude-opus-5-5", effort: "xhigh" }],
    modelRequests: ["/v1/messages?fixture=root", "/v1/messages?fixture=child"],
    userGrants: expect.arrayContaining(["gid", "kind", "challenge"]),
    poolGrants: expect.arrayContaining(["user_id", "role", "granted_at"]),
    indexedCompletedRuns: 1,
  });
});

it("interrupts a model stream across both RPC hops and stops the pool and upstream request", async () => {
  const response = await harness.fetch("http://proof/interrupt");
  const text = await response.text();
  expect(response.status, text).toBe(200);
  expect(JSON.parse(text)).toEqual({ ok: true, poolStopped: true, upstreamStopped: true });
});

it("provisions distinct SDK, CLI and Computer isolates from ordinary thread startup and dispatches commands over their real RPC ports", async () => {
  await harness.close();
  harness = makeHarness(true);
  await harness.listen();
  const response = await harness.fetch("http://proof/");
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const result = JSON.parse(text);
  expect(result).toMatchObject({ ok: true, runs: 1, status: "completed" });
  const events: { readonly kind: string; readonly realm: string; readonly detail?: string }[] =
    result.owners;
  const realm = (kind: string) => events.find((event) => event.kind === kind)?.realm;
  const cli = realm("cli-launch");
  const sdk = realm("sdk-query");
  const computer = realm("/bin/sed");
  expect(cli).toBeTypeOf("string");
  expect(sdk).toBeTypeOf("string");
  expect(computer).toBeTypeOf("string");
  expect(new Set([cli, sdk, computer]).size).toBe(3);
  expect(realm("kernel")).toBeTypeOf("string");
  expect(new Set([cli, sdk, computer, realm("kernel")]).size).toBe(4);
  expect(realm("/usr/bin/git")).toBe(computer);
  // A hook-like child reads its input through the real CLI-to-Computer stdin bridge.
  expect(realm("/bin/cat")).toBe(computer);
  expect(events.filter((event) => event.kind.startsWith("cli-child-error:"))).toEqual([]);
  expect(events.filter((event) => event.kind === "cli-launch")).toHaveLength(1);
  expect(events.filter((event) => event.kind === "sdk-query")).toHaveLength(1);
  const latency = events.find((event) => event.kind === "kernel-rpc-latency");
  expect(latency?.detail).toBeTypeOf("string");
  NodeProcess.stdout.write(`[product-cli-rpc-latency] ${latency!.detail}\n`);
});

it("cancels a model request and joins separate CLI and Computer owners", async () => {
  await harness.close();
  harness = makeHarness(true);
  await harness.listen();
  const response = await harness.fetch("http://proof/interrupt");
  const text = await response.text();
  expect(response.status, text).toBe(200);
  expect(JSON.parse(text)).toEqual({ ok: true, poolStopped: true, upstreamStopped: true });
});

it("joins real product owners cleanly when CLI metadata acquisition fails", async () => {
  await harness.close();
  harness = makeHarness(true, true);
  await harness.listen();
  const response = await harness.fetch("http://proof/");
  const result = JSON.parse(await response.text()) as {
    error: string;
    observations: { kind: string; detail?: string }[];
  };
  expect(response.status).toBe(500);
  expect(result.error).toMatch(/metadata|E2BIG|limit/i);
  expect(result.error).not.toMatch(/failed-start cleanup failed|owners could not close/);
  expect(result.observations.filter((event) => event.kind === "kernel-closed")).toHaveLength(1);
  expect(result.observations.filter((event) => event.kind === "kernel-close-error")).toEqual([]);
});
