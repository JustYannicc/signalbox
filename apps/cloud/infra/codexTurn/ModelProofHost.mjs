import { DurableObject, WorkerEntrypoint, exports as hostExports } from "cloudflare:workers";
import probe, { ProbeSession as BaseProbeSession } from "../isolateProbe/generated/worker.js";
import { createMockResponses } from "./MockResponses.mjs";
import { createMockResponsesCpu } from "./MockResponsesCpu.mjs";
import { createMockResponsesWebSocket } from "./MockResponsesWebSocket.mjs";
import { nativeTimingBinding } from "./ModelProofTiming.mjs";

export { NativeTiming, NativeTimingStore } from "./ModelProofTiming.mjs";

function modelRequest(request, env) {
  const url = new URL(request.url);
  const match = /^\/models\/([a-f0-9]{32})(\/.*)$/.exec(url.pathname);
  if (!match) return new Response("Unknown proof model", { status: 403 });
  url.pathname = match[2];
  return env.MODELS.get(env.MODELS.idFromName(match[1])).fetch(new Request(url, request));
}

export class ModelProofEgress extends WorkerEntrypoint {
  fetch(request) {
    return modelRequest(request, this.env);
  }
}

function proofLoader(env, classes) {
  return {
    get(id, configure) {
      const worker = env.LOADER.get(id, async () => ({
        ...(await configure()),
        ...(env.MODEL_PROOF_MOCK_EGRESS === "true"
          ? { globalOutbound: hostExports.ModelProofEgress({}) }
          : {}),
        tails: [nativeTimingBinding("facet", id.replace(/^staged:/, "").slice(0, 16))],
      }));
      return {
        getDurableObjectClass(name) {
          const facetClass = worker.getDurableObjectClass(name, {
            limits: { cpuMs: Number(env.DYNAMIC_FACET_CPU_MS ?? "300000") },
          });
          classes.set(id.replace(/^staged:/, ""), facetClass);
          return facetClass;
        },
        getEntrypoint: (name) => worker.getEntrypoint(name),
      };
    },
  };
}

export class ProbeSession extends BaseProbeSession {
  constructor(ctx, env) {
    const classes = new Map();
    super(ctx, { ...env, LOADER: proofLoader(env, classes) });
    this.proofClasses = classes;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/facet-records") {
      const id = url.searchParams.get("id");
      const facetClass = this.proofClasses.get(id);
      if (!facetClass) return new Response("Unknown proof facet", { status: 404 });
      const facet = this.ctx.facets.get(id, () => ({ class: facetClass }));
      return facet.fetch("https://proof.invalid/model-proof-records");
    }
    if (url.pathname === "/abort") {
      const id = url.searchParams.get("id");
      if (!id || !/^[a-zA-Z0-9-]{1,100}$/.test(id))
        return new Response("Invalid facet", { status: 400 });
      this.ctx.facets.abort(id, new Error("Injected native engine facet eviction"));
      return Response.json({ aborted: id, recovery: "native-recovery-unqualified" });
    }
    return super.fetch(request);
  }
}

export class MockModel extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.mock = createMockResponses();
    this.httpRequests = 0;
    this.peerReady = new Promise((resolve) => {
      this.resolvePeer = resolve;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/hold") {
      await this.peerReady;
      return Response.json(await this.peer.waitForHold());
    }
    if (url.pathname === "/release") {
      await this.peerReady;
      return Response.json({ released: this.peer.releaseHeld() });
    }
    if (url.pathname === "/status")
      return Response.json({
        phase: this.mock.phase,
        requests: this.mock.requests,
        metrics: this.peer?.metrics ?? { opens: 0 },
        httpRequests: this.httpRequests,
      });
    if (url.pathname !== "/v1/responses") return new Response("Not found", { status: 404 });
    if (request.method === "POST") {
      this.httpRequests++;
      return new Response(this.mock.respond(await request.json()), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (!this.peer) {
      if (
        request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
        url.searchParams.get("cpu") === "only"
      ) {
        this.mock = createMockResponsesCpu();
      }
      this.peer = createMockResponsesWebSocket({
        mock: this.mock,
        faults: {
          closeBeforeCompletedOnce: url.searchParams.get("disconnect") === "once",
          closeBeforeOutputOnce: url.searchParams.get("disconnect") === "early",
          holdBeforeOutputOnce: url.searchParams.get("hold") === "once",
          paceFrames: url.searchParams.get("pace") === "true",
        },
      });
    }
    this.resolvePeer();
    const result = this.peer.route({ request });
    return new Response(result.body ?? null, {
      status: result.status,
      headers: result.headers,
      ...(result.webSocket ? { webSocket: result.webSocket } : {}),
    });
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ready")
      return new Response(
        request.headers.get("authorization") === `Bearer ${env.PROBE_SECRET}`
          ? "ready"
          : "unauthorized",
        {
          status: request.headers.get("authorization") === `Bearer ${env.PROBE_SECRET}` ? 200 : 401,
        },
      );
    if (url.pathname.startsWith("/models/")) return modelRequest(request, env);
    if (url.pathname === "/native-timings") {
      if (request.headers.get("authorization") !== `Bearer ${env.PROBE_SECRET}`)
        return new Response("unauthorized", { status: 401 });
      url.pathname = "/model-proof-records";
      return env.TIMINGS.get(env.TIMINGS.idFromName("model-proof-native-timings")).fetch(
        new Request(url, request),
      );
    }
    if (url.pathname === "/abort" || url.pathname === "/facet-records") {
      if (request.headers.get("authorization") !== `Bearer ${env.PROBE_SECRET}`)
        return new Response("unauthorized", { status: 401 });
      const session = url.searchParams.get("session");
      if (!session) return new Response("Missing session", { status: 400 });
      return env.PROBE.get(env.PROBE.idFromName(session)).fetch(request);
    }
    return probe.fetch(request, env);
  },
};
