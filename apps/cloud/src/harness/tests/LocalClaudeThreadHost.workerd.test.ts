// @effect-diagnostics nodeBuiltinImport:off - Wrangler needs a filesystem entry point.
import * as NodeURL from "node:url";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

const makeHarness = () =>
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
          durable_objects: {
            bindings: [
              { name: "USERS", class_name: "LocalUser" },
              { name: "POOLS", class_name: "LocalPool" },
              { name: "THREADS", class_name: "LocalThread" },
            ],
          },
          migrations: [
            { tag: "v1", new_sqlite_classes: ["LocalUser", "LocalPool", "LocalThread"] },
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
