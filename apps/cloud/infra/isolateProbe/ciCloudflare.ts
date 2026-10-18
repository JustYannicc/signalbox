// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - standalone CI lifecycle tooling.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { record, textField, writeJson } from "./ciArchive.ts";

export interface OwnedWorker {
  script: string;
  namespace?: string;
  version?: string;
  actor?: string;
  deleted?: boolean;
}
export const ownedScript = (script: string) => /^sb-isolate-probe-[a-f0-9]{24}$/.test(script);

export class Cloudflare {
  readonly base: string;
  readonly token: string;
  readonly fetcher: typeof fetch;
  constructor(account: string, token: string, fetcher: typeof fetch = fetch) {
    if (!/^[a-f0-9]{32}$/.test(account) || !token)
      throw new Error("CI Cloudflare configuration is missing");
    this.base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
    this.token = token;
    this.fetcher = fetcher;
  }

  async request(path: string, init: RequestInit = {}, allowMissing = false): Promise<unknown> {
    const response = await this.fetcher(`${this.base}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(120_000),
    });
    if (allowMissing && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Cloudflare ${init.method ?? "GET"} HTTP ${response.status}`);
    const body = await response.text();
    if (!body && init.method === "DELETE") return null;
    const envelope = record(JSON.parse(body));
    if (envelope.success !== true) throw new Error("Cloudflare returned success=false");
    return envelope.result;
  }

  async deploy(
    owner: OwnedWorker,
    root: string,
    modules: Record<string, unknown>[],
    secret: string,
  ) {
    if (!ownedScript(owner.script)) throw new Error("Invalid owned script");
    // Namespace creation is in the upload transaction; the ledger already owns this random script name.
    const form = new FormData();
    form.set(
      "metadata",
      new Blob(
        [
          JSON.stringify({
            main_module: "worker.js",
            compatibility_date: "2026-10-18",
            compatibility_flags: ["nodejs_compat"],
            limits: { cpu_ms: 30_000 },
            observability: { enabled: true },
            bindings: [
              { type: "durable_object_namespace", name: "PROBE", class_name: "ProbeSession" },
              { type: "worker_loader", name: "LOADER" },
              { type: "secret_text", name: "PROBE_SECRET", text: secret },
            ],
            migrations: { new_tag: "pristine-r4", new_sqlite_classes: ["ProbeSession"] },
          }),
        ],
        { type: "application/json" },
      ),
    );
    for (const module of modules) {
      const name = textField(module, "name");
      const bytes = await NodeFSP.readFile(NodePath.join(root, "host/generated", name));
      form.set(
        name,
        new Blob([bytes], {
          type: module.type === "wasm" ? "application/wasm" : "application/javascript+module",
        }),
        name,
      );
    }
    await this.request(`/workers/scripts/${owner.script}`, { method: "PUT", body: form });
    await this.request(`/workers/scripts/${owner.script}/subdomain`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, previews_enabled: false }),
    });
    const settings = record(await this.request(`/workers/scripts/${owner.script}/settings`));
    const bindings = settings.bindings;
    if (!Array.isArray(bindings)) throw new Error("Missing deployed bindings");
    const binding = bindings.map(record).find((item) => item.name === "PROBE");
    owner.namespace = textField(binding, "namespace_id");
    const result = record(await this.request(`/workers/scripts/${owner.script}/deployments`));
    const deployments = result.deployments;
    if (!Array.isArray(deployments) || deployments.length !== 1)
      throw new Error("Expected one fresh deployment");
    const versions = record(deployments[0]).versions;
    if (!Array.isArray(versions) || versions.length !== 1 || record(versions[0]).percentage !== 100)
      throw new Error("Expected one active version");
    owner.version = textField(versions[0], "version_id");
    const subdomain = textField(await this.request("/workers/subdomain"), "subdomain");
    if (!/^[a-z0-9-]+$/.test(subdomain)) throw new Error("Invalid account subdomain");
    return `https://${owner.script}.${subdomain}.workers.dev`;
  }

  async actor(owner: OwnedWorker) {
    if (!owner.namespace) throw new Error("Namespace unavailable");
    const objects = await this.request(
      `/workers/durable_objects/namespaces/${owner.namespace}/objects?limit=10`,
    );
    if (!Array.isArray(objects)) throw new Error("Invalid object listing");
    if (objects.length > 1) throw new Error("Fresh namespace has multiple actors");
    if (!objects.length) return undefined;
    const actor = textField(objects[0], "id");
    if (!/^[a-f0-9]{64}$/.test(actor)) throw new Error("Invalid root actor ID");
    owner.actor = actor;
    return actor;
  }

  async cleanup(owner: OwnedWorker) {
    if (!ownedScript(owner.script)) throw new Error("Refusing cleanup outside owned random names");
    // The public Delete Worker contract says force also deletes its implemented DO namespaces.
    await this.request(`/workers/scripts/${owner.script}?force=true`, { method: "DELETE" }, true);
    if ((await this.request(`/workers/scripts/${owner.script}/settings`, {}, true)) !== undefined) {
      throw new Error("Owned Worker still exists after delete");
    }
    owner.deleted = true;
  }
}

export async function cleanupAll(cloud: Cloudflare, workers: OwnedWorker[], ledger: string) {
  const failures: string[] = [];
  for (const owner of workers) {
    if (owner.deleted) continue;
    try {
      await cloud.cleanup(owner);
    } catch {
      failures.push(owner.script);
    }
    await writeJson(ledger, workers);
  }
  if (failures.length) throw new Error(`Cleanup failed for ${failures.join(", ")}`);
}
