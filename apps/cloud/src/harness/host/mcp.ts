import type {
  ExecutorMcpPort,
  ExecutorTarget,
  HarnessMcpTurnGrantSource,
  NativeMcpConfiguration,
  ResolvedConnections,
  TurnAccess,
} from "./contracts.ts";
import { HarnessError } from "../Harness.ts";
import * as Effect from "effect/Effect";

const denied = () =>
  new HarnessError({
    operation: "turn",
    message: "Harness MCP request is unavailable.",
  });

export const validateConnections = (connections: ResolvedConnections) => {
  const names = new Set<string>(["executor"]);
  const ids = new Set<string>();
  for (const server of connections.servers) {
    if (
      !server.id ||
      !server.name ||
      names.has(server.name) ||
      ids.has(server.id) ||
      server.directTools.some((tool) => !tool)
    )
      throw new HarnessError({
        operation: "turn",
        message: "Resolved MCP server identities conflict.",
      });
    names.add(server.name);
    ids.add(server.id);
  }
};

const waitForTurnGrant = <G>(
  source: HarnessMcpTurnGrantSource<G>,
  input: Parameters<HarnessMcpTurnGrantSource<G>["issue"]>[0],
): Promise<Awaited<ReturnType<HarnessMcpTurnGrantSource<G>["issue"]>>> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", abort);
      complete();
    };
    const abort = () => finish(() => reject(denied()));
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) {
      abort();
      return;
    }
    void Promise.resolve()
      .then(() => source.issue(input))
      .then(
        (grant) => finish(() => resolve(grant)),
        () => finish(() => reject(denied())),
      );
  });

const gatewayEndpoint = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.hash.length === 0
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
};

export const mcpAborted = (signal: AbortSignal) =>
  Effect.callback<never, HarnessError>((resume) => {
    const abort = () => resume(Effect.fail(denied()));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });

async function forwardResponse(operation: Promise<Response>, signal: AbortSignal) {
  const response = await new Promise<Response>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(denied());
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          void value.body?.cancel().catch(() => undefined);
          reject(denied());
        } else resolve(value);
      },
      () => {
        signal.removeEventListener("abort", abort);
        reject(denied());
      },
    );
  });
  if (signal.aborted) {
    await response.body?.cancel();
    throw denied();
  }
  if (response.body === null) return response;
  const reader = response.body.getReader();
  let ended = false;
  const finish = () => {
    ended = true;
    signal.removeEventListener("abort", abort);
  };
  const abort = () => {
    finish();
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (signal.aborted) {
          controller.error(denied());
          return;
        }
        try {
          const item = await reader.read();
          if (signal.aborted) controller.error(denied());
          else if (item.done) {
            finish();
            controller.close();
          } else controller.enqueue(item.value);
        } catch {
          finish();
          controller.error(denied());
        }
      },
      async cancel() {
        if (!ended) {
          finish();
          try {
            await reader.cancel();
          } catch {
            throw denied();
          }
        }
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createMcpRoutes<G>(
  executor: ExecutorMcpPort<G>,
  ownerSignal: AbortSignal,
  now: () => number,
  turnGrantSource?: HarnessMcpTurnGrantSource<G>,
) {
  const origin = "https://harness-mcp.invalid";
  // This distinguishes stale native sessions; it grants no access by itself.
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  let generation = 0;
  const routes = new Map<
    string,
    {
      readonly target: ExecutorTarget;
      readonly grant: G;
      readonly gatewayEndpoint?: string;
      readonly expiresAtMs?: number;
      readonly signal: AbortSignal;
    }
  >();
  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = url.origin === origin ? routes.get(url.pathname) : undefined;
    if (
      route === undefined ||
      route.signal.aborted ||
      request.signal.aborted ||
      (route.expiresAtMs !== undefined && route.expiresAtMs <= now())
    )
      throw denied();
    const signal = AbortSignal.any([request.signal, route.signal]);
    try {
      const forwarded = new Request(request, { signal });
      return await forwardResponse(
        Promise.resolve().then(() => {
          if (signal.aborted) throw denied();
          return executor.forward({
            target: route.target,
            grant: route.grant,
            ...(route.gatewayEndpoint === undefined
              ? {}
              : { gatewayEndpoint: route.gatewayEndpoint }),
            request: forwarded,
            signal,
          });
        }),
        signal,
      );
    } catch {
      throw denied();
    }
  };
  return {
    origin,
    fetch,
    session(sessionSignal: AbortSignal) {
      const base = `/${nonce}/${++generation}`;
      let nextEpoch = 0;
      let closed = false;
      const endpointPaths = new Map<string, string>();
      let current:
        | { epoch: number; controller: AbortController; paths: string[]; unlisten: () => void }
        | undefined;
      const retire = (epoch: number) => {
        if (current?.epoch !== epoch) return;
        const prior = current;
        current = undefined;
        for (const path of prior.paths) routes.delete(path);
        prior.unlisten();
        prior.controller.abort();
      };
      const close = () => {
        closed = true;
        if (current !== undefined) retire(current.epoch);
      };
      return {
        hasTurnGrantSource: turnGrantSource !== undefined,
        retire,
        close,
        async activate(access: TurnAccess<G>, runId?: string): Promise<NativeMcpConfiguration> {
          if (closed || ownerSignal.aborted || sessionSignal.aborted || access.signal.aborted)
            throw denied();
          validateConnections(access.connections);
          if (current !== undefined) retire(current.epoch);
          const epoch = ++nextEpoch;
          const controller = new AbortController();
          const signal = AbortSignal.any([
            ownerSignal,
            sessionSignal,
            access.signal,
            controller.signal,
          ]);
          const paths: string[] = [];
          const abort = () => retire(epoch);
          current = {
            epoch,
            controller,
            paths,
            unlisten: () => signal.removeEventListener("abort", abort),
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) {
            retire(epoch);
            throw denied();
          }
          let grant = access.grant;
          let endpoint: string | undefined;
          let expiresAtMs: number | undefined;
          if (runId !== undefined && turnGrantSource !== undefined) {
            const publisher = access.publisher;
            if (
              publisher === undefined ||
              !Number.isSafeInteger(publisher.generation) ||
              publisher.generation < 1 ||
              publisher.facetNonce.length === 0
            ) {
              controller.abort();
              throw denied();
            }
            try {
              const issued = await waitForTurnGrant(turnGrantSource, {
                runId,
                nativeTurnEpoch: epoch,
                publisher: {
                  generation: publisher.generation,
                  facetNonce: publisher.facetNonce,
                },
                signal,
              });
              const resolvedEndpoint = gatewayEndpoint(issued?.endpoint);
              if (
                issued === null ||
                issued === undefined ||
                issued.grant === null ||
                issued.grant === undefined ||
                resolvedEndpoint === undefined ||
                (issued.expiresAtMs !== undefined &&
                  (!Number.isFinite(issued.expiresAtMs) || issued.expiresAtMs <= now())) ||
                signal.aborted
              )
                throw denied();
              grant = issued.grant;
              endpoint = resolvedEndpoint;
              expiresAtMs = issued.expiresAtMs;
            } catch {
              controller.abort();
              throw denied();
            }
          }
          if (ownerSignal.aborted || sessionSignal.aborted || access.signal.aborted) {
            retire(epoch);
            throw denied();
          }
          if (current?.epoch !== epoch || signal.aborted) throw denied();
          const targets = new Map<string, ExecutorTarget>([["executor", { type: "executor" }]]);
          for (const server of access.connections.servers) {
            if (server.directTools.length > 0)
              targets.set(server.name, {
                type: "direct",
                serverId: server.id,
                tools: Object.freeze([...new Set(server.directTools)]),
              });
          }
          const servers: Record<string, { readonly url: string }> = {};
          for (const [name, target] of targets) {
            // CLI tool closures outlive turns. Resolve their stable endpoint against the current grant.
            const identity = JSON.stringify([
              name,
              target.type,
              target.type === "direct" ? target.serverId : null,
            ]);
            let path = endpointPaths.get(identity);
            if (path === undefined) {
              path = `${base}/${endpointPaths.size}`;
              endpointPaths.set(identity, path);
            }
            paths.push(path);
            routes.set(path, {
              target,
              grant,
              ...(endpoint === undefined ? {} : { gatewayEndpoint: endpoint }),
              ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
              signal,
            });
            Object.defineProperty(servers, name, {
              value: Object.freeze({ url: `${origin}${path}` }),
              enumerable: true,
            });
          }
          if (signal.aborted) retire(epoch);
          return Object.freeze({ epoch, servers: Object.freeze(servers) });
        },
      };
    },
  };
}
export type McpRoutes<G> = ReturnType<typeof createMcpRoutes<G>>;
