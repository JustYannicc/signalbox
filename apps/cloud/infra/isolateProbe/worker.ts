// @effect-diagnostics globalDate:off - measure the workerd wall clock without adding runtime overhead.
import { DurableObject } from "cloudflare:workers";
import { FACET_SOURCE } from "./facetSource.ts";
import { JSPI_WASM } from "./wasmFixture.ts";
import { probe } from "./generated/runtime.js";
import {
  openModuleTransport,
  MODULE_TRANSPORT_CONTENT_TYPE,
  type ModuleTransport,
  DEFAULT_MODULE_TRANSPORT_LIMITS,
} from "./moduleTransport.ts";
import { preflightWrapper, withPreflight } from "./preflight.ts";

interface ProbeInput {
  id: string;
  path?: string;
  mode?: "facet" | "worker";
  mainModule?: string;
  entrypoint?: string;
  count?: number;
  generatedValue?: number;
  allowOutbound?: unknown;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const probeInput = (value: unknown): value is ProbeInput =>
  record(value) &&
  typeof value.id === "string" &&
  /^[a-zA-Z0-9-]{1,100}$/.test(value.id) &&
  (value.path === undefined || typeof value.path === "string") &&
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
  override async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/root/")) {
      url.pathname = url.pathname.slice("/root".length);
      return probe(new Request(url, request), this.ctx);
    }
    let transport: ModuleTransport | undefined;
    try {
      let input: ProbeInput;
      let suppliedModules: Record<string, LegacyModule> | undefined;
      try {
        if (
          request.headers.get("content-type")?.split(";")[0]?.trim() ===
          MODULE_TRANSPORT_CONTENT_TYPE
        ) {
          if (!request.body) return new Response("Missing module transport body", { status: 400 });
          transport = await openModuleTransport(request.body);
          if (!probeInput(transport.input)) {
            // Cancelling a forwarded body can abort the HTTP response instead of returning a 400.
            await transport.discard();
            return new Response("Invalid probe input", { status: 400 });
          }
          input = transport.input;
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
      const finishUpload = async () => {
        try {
          await transport?.discard();
        } catch (error) {
          return rejectedUpload(request, error);
        }
      };
      const started = Date.now();
      try {
        if (input.count !== undefined) {
          if (!Number.isInteger(input.count) || input.count < 1 || input.count > 20) {
            await transport?.discard();
            return new Response("Invalid worker count", { status: 400 });
          }
          const uploadError = await finishUpload();
          if (uploadError) return uploadError;
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
          await transport?.discard();
          return new Response("Invalid generated value", { status: 400 });
        }
        const wrapper = transport
          ? preflightWrapper(
              transport.moduleNames,
              input.mainModule ?? "main.js",
              input.entrypoint ?? (input.mode === "worker" ? "default" : "ProbeFacet"),
            )
          : undefined;
        // Legacy ids cannot contain ':', so they can never substitute a fixture for our preflight.
        const worker = this.env.LOADER.get(
          transport ? `framed:${input.id}` : input.id,
          async () => {
            const modules =
              input.generatedValue !== undefined
                ? {
                    "main.js": `export default {fetch(){return Response.json({value:${input.generatedValue},generated:true})}}`,
                  }
                : transport
                  ? await transport.readModules()
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
            if (wrapper) decodedModules[wrapper.moduleName] = { js: wrapper.source };
            return {
              compatibilityDate: "2026-10-18",
              compatibilityFlags: ["nodejs_compat"],
              mainModule: wrapper?.moduleName ?? input.mainModule ?? "main.js",
              modules: decodedModules,
              ...(input.allowOutbound === true ? {} : { globalOutbound: null }),
            };
          },
        );
        const invoke = async () => {
          const probeRequest = new Request(`https://probe.invalid${input.path ?? "/status"}`);
          const stub =
            input.mode === "worker"
              ? worker.getEntrypoint(wrapper?.fixtureExport ?? input.entrypoint)
              : this.ctx.facets.get(input.id, () => ({
                  class: worker.getDurableObjectClass(
                    wrapper?.fixtureExport ?? input.entrypoint ?? "ProbeFacet",
                  ),
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
        if (wrapper && transport) {
          const upload = transport;
          return await withPreflight(
            (request) => worker.getEntrypoint(wrapper.entrypoint).fetch(request),
            () => upload.discard(),
            invoke,
            wrapper.identity,
          );
        }
        return await invoke();
      } catch (error) {
        const uploadError = await finishUpload();
        if (uploadError) return uploadError;
        return Response.json({
          id: input.id,
          target: input.mode ?? "facet",
          wallMs: Date.now() - started,
          error: String(error),
        });
      }
    } finally {
      await transport?.cancel();
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
    return env.PROBE.get(env.PROBE.idFromName(session)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
