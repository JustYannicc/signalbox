import { type RpcTarget, WorkerEntrypoint, exports as hostExports } from "cloudflare:workers";
import {
  type ChildWorkerLimits,
  type ResolvedChildWorkerLimits,
  resolveChildWorkerLimits,
} from "../../src/computer/ChildWorkerLimits.ts";
import type { NodeGeneratedCodeInvocation } from "../../src/isolate/NodeGeneratedCode.ts";
import { MANAGED_INVOCATION_VERSION, managedInvocationModules } from "./managedInvocation.ts";
import { DEFAULT_MODULE_TRANSPORT_LIMITS } from "./moduleTransport.ts";

interface Props {
  namespace: string;
  limits?: ChildWorkerLimits;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function invocation(value: unknown) {
  if (
    !record(value) ||
    Object.keys(value).length !== 4 ||
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(value.id) ||
    typeof value.mainModule !== "string" ||
    !record(value.modules) ||
    !Object.hasOwn(value.modules, value.mainModule) ||
    !Object.hasOwn(value, "input")
  ) {
    throw new Error("Expected {id,mainModule,modules,input}");
  }
  const modules: Record<string, string> = {};
  const encoder = new TextEncoder();
  for (const [name, source] of Object.entries(value.modules)) {
    if (!name || typeof source !== "string") throw new Error("Expected named JavaScript sources");
    Object.defineProperty(modules, name, { value: source, enumerable: true });
  }
  const metadata = JSON.stringify({
    id: value.id,
    mainModule: value.mainModule,
    modules: Object.keys(modules),
    input: value.input,
  });
  if (encoder.encode(metadata).byteLength > DEFAULT_MODULE_TRANSPORT_LIMITS.maxMetadataBytes) {
    throw new Error("Metadata budget exceeded");
  }
  return { mainModule: value.mainModule, modules, input: value.input };
}

async function codeIdentity(input: ReturnType<typeof invocation>) {
  // Loader IDs are immutable code identities, not caller-supplied labels. Keep module globals
  // within this parent session/facet and canonicalize map order before hashing.
  const canonical = JSON.stringify([
    input.mainModule,
    Object.keys(input.modules)
      .sort()
      .map((name) => [name, input.modules[name]]),
  ]);
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
  );
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function invokeNative(
  loader: WorkerLoader,
  namespace: string,
  input: ReturnType<typeof invocation>,
  signal: AbortSignal,
  limits: ResolvedChildWorkerLimits,
) {
  const digest = await codeIdentity(input);
  const worker = loader.get(JSON.stringify(["generated", namespace, digest, limits.cpuMs]), () => ({
    compatibilityDate: "2026-10-18",
    mainModule: input.mainModule,
    modules: input.modules,
    globalOutbound: null,
    limits,
  }));
  return await worker
    .getEntrypoint(undefined, { limits })
    .fetch("https://generated.invalid/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.input),
      signal,
    });
}

interface ManagedEntrypoint extends WorkerEntrypoint {
  open(input: unknown): RpcTarget & Omit<NodeGeneratedCodeInvocation, typeof Symbol.dispose>;
}

export class CodeGeneration extends WorkerEntrypoint<{ LOADER: WorkerLoader }, Props> {
  async open(envelope: string) {
    const limits = resolveChildWorkerLimits(this.ctx.props.limits);
    const input = invocation(JSON.parse(envelope));
    const digest = await codeIdentity(input);
    const worker = this.env.LOADER.get(
      JSON.stringify([
        "generated",
        this.ctx.props.namespace,
        MANAGED_INVOCATION_VERSION,
        digest,
        limits.cpuMs,
      ]),
      () => ({
        compatibilityDate: "2026-10-18",
        ...managedInvocationModules(input.mainModule, input.modules),
        globalOutbound: null,
        env: {},
        limits,
      }),
    );
    return await worker
      .getEntrypoint<ManagedEntrypoint>("ManagedInvocation", { limits })
      .open(input.input);
  }

  override async fetch(request: Request) {
    const limits = resolveChildWorkerLimits(this.ctx.props.limits);
    if (new URL(request.url).pathname !== "/invoke") {
      return new Response("CODE_GENERATION: use /invoke", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("CODE_GENERATION: use POST", {
        status: 405,
        headers: { allow: "POST" },
      });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
      return new Response("CODE_GENERATION: expected application/json", { status: 415 });
    }
    let input: ReturnType<typeof invocation>;
    try {
      input = invocation(await request.json());
    } catch (error) {
      if (request.signal.aborted) throw error;
      return new Response(`CODE_GENERATION: invalid invocation: ${String(error)}`, { status: 400 });
    }
    try {
      return await invokeNative(
        this.env.LOADER,
        this.ctx.props.namespace,
        input,
        request.signal,
        limits,
      );
    } catch (error) {
      if (request.signal.aborted) throw error;
      return new Response(`CODE_GENERATION: native execution failed: ${String(error)}`, {
        status: 500,
      });
    }
  }
}

export function codeGenerationBinding(namespace: string, limits?: ChildWorkerLimits) {
  const resolved = resolveChildWorkerLimits(limits);
  // This is a native loopback Service Binding, serialized by WorkerLoader. Props stay in the host.
  // https://developers.cloudflare.com/dynamic-workers/usage/bindings/
  const entrypoints = hostExports as { CodeGeneration: LoopbackServiceStub<CodeGeneration> };
  return entrypoints.CodeGeneration({ props: { namespace, limits: resolved } });
}
