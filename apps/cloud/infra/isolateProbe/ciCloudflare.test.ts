// @effect-diagnostics nodeBuiltinImport:off - exercise standalone Node CI tooling with isolated temporary files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it, vi } from "@effect/vitest";
import { Cloudflare, cleanupAll } from "./ciCloudflare.ts";
import { json } from "./ciArchive.ts";

const script = `sb-isolate-probe-${"a".repeat(24)}`;
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await NodeFSP.rm(dir, { recursive: true, force: true });
});
const temporary = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "probe-ci-cloudflare-"));
  directories.push(root);
  return root;
};
const ok = (result: unknown) => Response.json({ success: true, result });

it.each([400, 500])(
  "preserves frozen upload bytes and gates cold startup on router HTTP %i",
  async (routerStatus) => {
    const root = await temporary();
    await NodeFSP.mkdir(NodePath.join(root, "host/generated"), { recursive: true });
    const modules = [];
    for (let i = 0; i < 8; i++) {
      const name = `${i}.js`;
      await NodeFSP.writeFile(NodePath.join(root, "host/generated", name), `frozen module ${i}`);
      modules.push({ name, type: "esm" });
    }
    let readinessRequests = 0;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (url instanceof Request) {
        readinessRequests++;
        expect(url.url).toBe(`https://${script}.private.workers.dev/`);
        expect(url.method).toBe("GET");
        expect(url.headers.get("authorization")).toBe("Bearer fake-probe-secret");
        expect(new URL(url.url).search).toBe("");
        return new Response(routerStatus === 400 ? "Invalid session" : "Worker failed", {
          status: routerStatus,
        });
      }
      if (init?.method === "PUT") {
        expect(init.body).toBeInstanceOf(FormData);
        if (!(init.body instanceof FormData)) throw new Error("Expected multipart body");
        const metadata = init.body.get("metadata");
        if (!(metadata instanceof Blob)) throw new Error("Expected metadata blob");
        expect(JSON.parse(await metadata.text())).toMatchObject({
          main_module: "worker.js",
          compatibility_date: "2026-10-18",
          compatibility_flags: ["nodejs_compat"],
          limits: { cpu_ms: 30_000 },
          migrations: { new_tag: "pristine-r4", new_sqlite_classes: ["ProbeSession"] },
          bindings: [
            { type: "durable_object_namespace", name: "PROBE", class_name: "ProbeSession" },
            { type: "worker_loader", name: "LOADER" },
            { type: "secret_text", name: "PROBE_SECRET", text: "fake-probe-secret" },
          ],
        });
        for (let i = 0; i < 8; i++) {
          const module = init.body.get(`${i}.js`);
          if (!(module instanceof Blob)) throw new Error("Missing module");
          expect(await module.text()).toBe(`frozen module ${i}`);
        }
        return ok({});
      }
      if (String(url).endsWith("/settings"))
        return ok({
          bindings: [
            { name: "PROBE", namespace_id: "namespace" },
            { name: "PROBE_SECRET", text: "do-not-persist" },
          ],
        });
      if (String(url).endsWith("/deployments"))
        return ok({ deployments: [{ versions: [{ version_id: "version", percentage: 100 }] }] });
      if (String(url).endsWith("/workers/subdomain")) return ok({ subdomain: "private" });
      return ok({});
    });
    const owner = { script };
    const cloud = new Cloudflare("a".repeat(32), "fake-ci-token", fetcher);
    const deployment = cloud.deploy(owner, root, modules, "fake-probe-secret");
    if (routerStatus === 400) {
      expect(await deployment).toBe(`https://${script}.private.workers.dev`);
    } else {
      await expect(deployment).rejects.toThrow("unexpected HTTP 500");
    }
    expect(readinessRequests).toBe(1);
    expect(owner).toEqual({ script, namespace: "namespace", version: "version" });
  },
);

it("cleans a partially uploaded owned script and its namespaces using documented force deletion", async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
    init?.method === "DELETE" ? ok(null) : new Response("", { status: 404 }),
  );
  const cloud = new Cloudflare("a".repeat(32), "fake-ci-token", fetcher);
  const owner = { script };
  await cloud.cleanup(owner);
  expect(String(fetcher.mock.calls[0]?.[0]).endsWith(`/workers/scripts/${script}?force=true`)).toBe(
    true,
  );
  expect(owner).toMatchObject({ deleted: true });
  await expect(cloud.cleanup({ script: "production" })).rejects.toThrow(
    "outside owned random names",
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("continues cleanup after one failure and leaves its exact owner in the recovery ledger", async () => {
  const dir = await temporary();
  const second = `sb-isolate-probe-${"b".repeat(24)}`;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).includes(script)) return new Response("", { status: 503 });
    return init?.method === "DELETE" ? ok(null) : new Response("", { status: 404 });
  });
  const cloud = new Cloudflare("a".repeat(32), "fake-ci-token", fetcher);
  const ledger = NodePath.join(dir, "ledger.json");
  await expect(cleanupAll(cloud, [{ script }, { script: second }], ledger)).rejects.toThrow(script);
  expect(await json(ledger)).toEqual([{ script }, { script: second, deleted: true }]);
});
