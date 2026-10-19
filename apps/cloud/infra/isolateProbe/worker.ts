// @effect-diagnostics globalDate:off - measure the workerd wall clock without adding runtime overhead.
import { DurableObject } from "cloudflare:workers";
import { codeGenerationBinding } from "./codeGeneration.ts";
import { childWorkerDispatchBinding } from "./childWorkerDispatch.ts";
import { FACET_SOURCE } from "./facetSource.ts";
import { JSPI_WASM } from "./wasmFixture.ts";
import { probe } from "./generated/runtime.js";
import {
  MODULE_TRANSPORT_CONTENT_TYPE,
  DEFAULT_MODULE_TRANSPORT_LIMITS,
} from "./moduleTransport.ts";
import { ModuleUploadStore } from "./moduleUpload.ts";

export { CodeGeneration } from "./codeGeneration.ts";
export { ChildWorkerDispatch } from "./childWorkerDispatch.ts";

interface ProbeInput {
  id: string;
  path?: string;
  method?: string;
  contentType?: string;
  mode?: "facet" | "worker";
  mainModule?: string;
  entrypoint?: string;
  count?: number;
  generatedValue?: number;
  allowOutbound?: unknown;
  allowGeneratedCode?: boolean;
  allowChildWorkers?: boolean;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const probeInput = (value: unknown): value is ProbeInput =>
  record(value) &&
  typeof value.id === "string" &&
  /^[a-zA-Z0-9-]{1,100}$/.test(value.id) &&
  (value.path === undefined || typeof value.path === "string") &&
  (value.method === undefined ||
    (typeof value.method === "string" &&
      /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value.method) &&
      !["CONNECT", "TRACE", "TRACK"].includes(value.method.toUpperCase()))) &&
  (value.contentType === undefined ||
    (typeof value.contentType === "string" && !/[\r\n\0]/.test(value.contentType))) &&
  (value.mode === undefined || value.mode === "facet" || value.mode === "worker") &&
  (value.mainModule === undefined || typeof value.mainModule === "string") &&
  (value.entrypoint === undefined || typeof value.entrypoint === "string") &&
  (value.count === undefined || typeof value.count === "number") &&
  (value.generatedValue === undefined || typeof value.generatedValue === "number");

type LegacyModule = WorkerLoaderModule | string | { wasmBase64: string };
const legacyModules = (value: unknown): value is Record<string, LegacyModule> =>
  record(value) &&
  Object.values(value).every((module) => {
    if (typeof module === "string") return true;
    if (!record(module)) return false;
    if ("wasmBase64" in module) return typeof module.wasmBase64 === "string";
    return (
      ["js", "cjs", "text", "py"].every(
        (key) => module[key] === undefined || typeof module[key] === "string",
      ) &&
      ["wasm", "data"].every(
        (key) => module[key] === undefined || module[key] instanceof ArrayBuffer,
      )
    );
  });

interface Env {
  PROBE: DurableObjectNamespace<ProbeSession>;
  LOADER: WorkerLoader;
  PROBE_SECRET: string;
  DYNAMIC_WORKER_CPU_MS?: string;
}

async function rejectedUpload(request: Request, error: unknown) {
  // Unread bytes can abort a forwarded fetch's response. Drain a bounded tail without decoding it.
  const body = request.body;
  if (body && !body.locked) {
    const reader = body.getReader();
    try {
      let remaining =
        DEFAULT_MODULE_TRANSPORT_LIMITS.maxMetadataBytes +
        DEFAULT_MODULE_TRANSPORT_LIMITS.maxBodyBytes +
        4;
      while (remaining >= 0) {
        const next = await reader.read();
        if (next.done) break;
        remaining -= next.value.byteLength;
      }
    } catch {
      // A failed source must not replace the original validation failure.
    } finally {
      reader.releaseLock();
    }
  }
  return new Response(String(error), { status: 400 });
}

export class ProbeSession extends DurableObject<Env> {
  private uploads: ModuleUploadStore | undefined;

  override async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/root/")) {
      url.pathname = url.pathname.slice("/root".length);
      return probe(new Request(url, request), this.ctx);
    }
    const started = Date.now();
    let upload: Awaited<ReturnType<ModuleUploadStore["stage"]>> | undefined;
    try {
      let input: ProbeInput;
      let suppliedModules: Record<string, LegacyModule> | undefined;
      try {
        if (
          request.headers.get("content-type")?.split(";")[0]?.trim() ===
          MODULE_TRANSPORT_CONTENT_TYPE
        ) {
          if (!request.body) return new Response("Missing module transport body", { status: 400 });
          this.uploads ??= new ModuleUploadStore(this.ctx.storage.sql);
          upload = await this.uploads.stage(request.body);
          if (!probeInput(upload.input)) {
            return new Response("Invalid probe input", { status: 400 });
          }
          input = upload.input;
        } else {
          const value: unknown = await request.json();
          if (!probeInput(value) || !record(value))
            return new Response("Invalid probe input", { status: 400 });
          if (value.modules !== undefined && !legacyModules(value.modules)) {
            return new Response("Invalid modules", { status: 400 });
          }
          input = value;
          suppliedModules = value.modules;
        }
      } catch (error) {
        return rejectedUpload(request, error);
      }
      const method = input.method ?? "GET";
      if (
        upload &&
        (method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD") &&
        upload.hasPayload
      )
        return new Response("Request body requires a non-GET/HEAD method", { status: 400 });
      try {
        if (input.count !== undefined) {
          if (!Number.isInteger(input.count) || input.count < 1 || input.count > 20) {
            return new Response("Invalid worker count", { status: 400 });
          }
          const handles = Array.from({ length: input.count }, (_, i) =>
            this.env.LOADER.get(`${input.id}-${i}`, () => ({
              compatibilityDate: "2026-10-18",
              mainModule: "main.js",
              modules: { "main.js": "export default {fetch(){return Response.json({ok:true})}}" },
              globalOutbound: null,
            })),
          );
          const results = await Promise.allSettled(
            handles.map(async (worker) => {
              const response = await worker.getEntrypoint().fetch("https://probe.invalid/status");
              return response.json();
            }),
          );
          return Response.json({
            id: input.id,
            count: input.count,
            wallMs: Date.now() - started,
            results: results.map((r) =>
              r.status === "fulfilled"
                ? { ok: true, value: r.value }
                : { ok: false, error: String(r.reason) },
            ),
          });
        }
        if (input.generatedValue !== undefined && !Number.isSafeInteger(input.generatedValue)) {
          return new Response("Invalid generated value", { status: 400 });
        }
        const generatedCode = input.allowGeneratedCode === true;
        const childWorkers = input.allowChildWorkers === true;
        const namespace = JSON.stringify([
          this.ctx.id.toString(),
          input.id,
          input.mode ?? "facet",
          input.entrypoint ?? null,
        ]);
        const fixtureId = generatedCode
          ? `code-generation-fixture:${JSON.stringify([namespace, childWorkers])}`
          : childWorkers
            ? `child-workers-fixture:${namespace}`
            : input.id;
        const worker = this.env.LOADER.get(upload ? `staged:${fixtureId}` : fixtureId, async () => {
          const modules =
            input.generatedValue !== undefined
              ? {
                  "main.js": `export default {fetch(){return Response.json({value:${input.generatedValue},generated:true})}}`,
                }
              : upload
                ? await upload.readModules()
                : (suppliedModules ?? {
                    "main.js": FACET_SOURCE,
                    "esm.js": "export const answer = 42;",
                    "suspend.wasm": { wasm: new Uint8Array(JSPI_WASM).buffer },
                  });
          const decodedModules = Object.fromEntries(
            Object.entries(modules).map(([name, module]) => [
              name,
              typeof module === "object" && "wasmBase64" in module
                ? {
                    wasm: Uint8Array.from(atob(module.wasmBase64), (c) => c.charCodeAt(0)).buffer,
                  }
                : module,
            ]),
          );
          return {
            compatibilityDate: "2026-10-18",
            compatibilityFlags: ["nodejs_compat"],
            mainModule: input.mainModule ?? "main.js",
            modules: decodedModules,
            ...(Number(this.env.DYNAMIC_WORKER_CPU_MS) > 0
              ? { limits: { cpuMs: Number(this.env.DYNAMIC_WORKER_CPU_MS) } }
              : {}),
            ...(generatedCode || childWorkers
              ? {
                  env: {
                    ...(generatedCode ? { CODE_GENERATION: codeGenerationBinding(namespace) } : {}),
                    ...(childWorkers ? { CHILD_WORKERS: childWorkerDispatchBinding() } : {}),
                  },
                }
              : {}),
            ...(input.allowOutbound === true ? {} : { globalOutbound: null }),
          };
        });
        const invoke = async () => {
          const probeRequest = new Request(`https://probe.invalid${input.path ?? "/status"}`, {
            method,
            headers: input.contentType === undefined ? {} : { "content-type": input.contentType },
            body: upload?.readPayload() ?? null,
          });
          const stub =
            input.mode === "worker"
              ? worker.getEntrypoint(input.entrypoint)
              : this.ctx.facets.get(fixtureId, () => ({
                  class: worker.getDurableObjectClass(input.entrypoint ?? "ProbeFacet"),
                }));
          const response = await stub.fetch(probeRequest);
          return Response.json({
            id: input.id,
            target: input.mode ?? "facet",
            wallMs: Date.now() - started,
            status: response.status,
            result: await response.json(),
          });
        };
        return await invoke();
      } catch (error) {
        return Response.json({
          id: input.id,
          target: input.mode ?? "facet",
          wallMs: Date.now() - started,
          error: String(error),
        });
      }
    } finally {
      upload?.dispose();
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    if (
      !env.PROBE_SECRET ||
      request.headers.get("authorization") !== `Bearer ${env.PROBE_SECRET}`
    ) {
      return new Response("Unauthorized", { status: 401 });
    }
    const url = new URL(request.url);
    const session = url.searchParams.get("session");
    if (!session || !/^[a-zA-Z0-9-]{1,100}$/.test(session)) {
      return new Response("Invalid session", { status: 400 });
    }
    try {
      return await env.PROBE.get(env.PROBE.idFromName(session)).fetch(request);
    } catch (error) {
      // Keep native DO failures in the proof evidence instead of an opaque HTML error page.
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
