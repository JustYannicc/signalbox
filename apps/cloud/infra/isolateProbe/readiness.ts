// @effect-diagnostics globalFetch:off globalTimers:off - The Node CLI probes its Worker outside an Effect runtime.
const READINESS_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const RETRY_INTERVAL_MS = 500;

type FetchRequest = (request: Request) => Promise<Response>;
type Wait = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export interface ProbeRouterReadinessOptions {
  signal?: AbortSignal;
  fetch?: FetchRequest;
  wait?: Wait;
  now?: () => number;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  retryIntervalMs?: number;
  onPending?: (reason: "route-not-found" | "durable-object-handler-missing") => void;
}

const interrupted = () => new Error("Probe router readiness interrupted.");
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(interrupted());
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(interrupted());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function positiveDuration(name: string, value: number) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive.`);
  return value;
}

export async function waitForProbeRouter(
  url: string,
  secret: string,
  options: ProbeRouterReadinessOptions = {},
): Promise<void> {
  const timeoutMs = positiveDuration(
    "Probe router readiness timeout",
    options.timeoutMs ?? READINESS_TIMEOUT_MS,
  );
  const requestTimeoutMs = positiveDuration(
    "Probe router request timeout",
    options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
  );
  const retryIntervalMs = positiveDuration(
    "Probe router retry interval",
    options.retryIntervalMs ?? RETRY_INTERVAL_MS,
  );
  const fetchRequest = options.fetch ?? ((request) => fetch(request));
  const pause = options.wait ?? wait;
  const now = options.now ?? (() => performance.now());
  const deadline = now() + timeoutMs;
  const canary = new URL("/root/status", url);
  canary.searchParams.set("session", "readiness");
  let routerReady = false;
  const unavailable = () =>
    new Error(
      routerReady
        ? `Probe Durable Object handler remained unavailable for ${timeoutMs} ms.`
        : `Probe router remained on Cloudflare's HTML 404 for ${timeoutMs} ms.`,
    );

  while (true) {
    if (options.signal?.aborted) throw interrupted();
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw unavailable();
    }

    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    const requestMs = Math.min(requestTimeoutMs, remainingMs);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestMs);

    let retry = false;
    try {
      const request = new Request(routerReady ? canary : url, {
        method: "GET",
        headers: { authorization: `Bearer ${secret}` },
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
      const response = await fetchRequest(request);
      const body = await response.text();
      if (options.signal?.aborted || timedOut) throw interrupted();
      const mediaType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();

      if (
        !routerReady &&
        response.status === 400 &&
        mediaType === "text/plain" &&
        body === "Invalid session"
      ) {
        // The outer router can be live while the namespace still serves Alchemy's empty precreate class.
        routerReady = true;
        continue;
      }
      if (routerReady && mediaType === "application/json") {
        let result: Record<string, unknown> | undefined;
        try {
          const value: unknown = JSON.parse(body);
          if (record(value)) result = value;
        } catch {
          // Invalid JSON remains an unexpected response below.
        }
        if (response.status === 200) {
          if (
            typeof result?.retainedBytes === "number" &&
            Number.isFinite(result.retainedBytes) &&
            result.retainedBytes >= 0 &&
            record(result.memoryUsage) &&
            record(result.heapStatistics)
          )
            return;
          throw new Error("Probe router returned an unexpected DO canary response.");
        }
        if (
          response.status === 500 &&
          result?.error === "Error: Handler does not export a fetch() function."
        ) {
          options.onPending?.("durable-object-handler-missing");
          retry = true;
        }
      }
      if (!retry)
        retry =
          response.status === 404 && mediaType === "text/html" && body.includes("Page not found");
      if (response.status === 404 && retry) options.onPending?.("route-not-found");
      if (!retry) {
        throw new Error(`Probe router returned an unexpected HTTP ${response.status} response.`);
      }
    } catch (error) {
      if (options.signal?.aborted) throw interrupted();
      if (timedOut) {
        if (now() >= deadline) {
          throw new Error(`Probe router readiness timed out after ${timeoutMs} ms.`, {
            cause: error,
          });
        }
        throw new Error(`Probe router readiness request timed out after ${requestMs} ms.`, {
          cause: error,
        });
      }
      throw error instanceof Error && error.message.startsWith("Probe router returned")
        ? error
        : new Error("Probe router readiness request failed.", { cause: error });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }

    const delayMs = Math.min(retryIntervalMs, deadline - now());
    if (delayMs <= 0) {
      throw unavailable();
    }
    await pause(delayMs, options.signal);
  }
}
