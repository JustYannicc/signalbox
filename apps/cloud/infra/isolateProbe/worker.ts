// @effect-diagnostics globalDate:off - measure the workerd wall clock without adding runtime overhead.
import { DurableObject } from "cloudflare:workers";
import { FACET_SOURCE } from "./facetSource.ts";
import { JSPI_WASM } from "./wasmFixture.ts";
import { probe } from "./generated/runtime.js";

interface Env {
  PROBE: DurableObjectNamespace<ProbeSession>;
  LOADER: WorkerLoader;
  PROBE_SECRET: string;
}

export class ProbeSession extends DurableObject<Env> {
  override async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/root/")) {
      url.pathname = url.pathname.slice("/root".length);
      return probe(new Request(url, request), this.ctx);
    }
    const input: {
      id: string;
      path?: string;
      mode?: "facet" | "worker";
      modules?: Record<string, WorkerLoaderModule | string | { wasmBase64: string }>;
      mainModule?: string;
      entrypoint?: string;
      count?: number;
      generatedValue?: number;
      allowOutbound?: boolean;
    } = await request.json();
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(input.id)) return new Response("Invalid id", { status: 400 });
    const started = Date.now();
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
      const modules =
        input.generatedValue !== undefined
          ? {
              "main.js": `export default {fetch(){return Response.json({value:${input.generatedValue},generated:true})}}`,
            }
          : (input.modules ?? {
              "main.js": FACET_SOURCE,
              "esm.js": "export const answer = 42;",
              "suspend.wasm": { wasm: new Uint8Array(JSPI_WASM).buffer },
            });
      const decodedModules = Object.fromEntries(
        Object.entries(modules).map(([name, module]) => [
          name,
          typeof module === "object" && "wasmBase64" in module
            ? { wasm: Uint8Array.from(atob(module.wasmBase64), (c) => c.charCodeAt(0)).buffer }
            : module,
        ]),
      );
      const worker = this.env.LOADER.get(input.id, () => ({
        compatibilityDate: "2026-10-18",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: input.mainModule ?? "main.js",
        modules: decodedModules,
        globalOutbound: input.allowOutbound === true ? undefined : null,
      }));
      const probeRequest = new Request(`https://probe.invalid${input.path ?? "/status"}`);
      const stub =
        input.mode === "worker"
          ? worker.getEntrypoint(input.entrypoint)
          : this.ctx.facets.get(input.id, () => ({
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
    } catch (error) {
      return Response.json({
        id: input.id,
        target: input.mode ?? "facet",
        wallMs: Date.now() - started,
        error: String(error),
      });
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
