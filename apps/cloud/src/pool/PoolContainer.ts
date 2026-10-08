// @effect-diagnostics globalTimers:off globalDate:off - the container lifecycle is promise code on the Durable Object's own clock.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CLI_PROXY_API_PORT } from "./cliProxyApi.ts";
import { POOL_STORE_BUCKET } from "./poolStore.ts";

/**
 * A managed pool's CLIProxyAPI: a Cloudflare Container bound to the pool's
 * object (`containers` in `wrangler.jsonc`). It starts on the first request,
 * stops once no request has reached it for `IDLE_TIMEOUT_MS` (the object's
 * alarm calls `sleepIfIdle`), and starts with a fresh disk every time; its credentials live in the object's store, which
 * the container reaches as `STORE_HOST`. That host is intercepted to this
 * pool's own object, so a container can only ever reach its own pool's
 * credentials.
 *
 * Tests use `makeFake`; vitest cannot run containers.
 */

/** Where the container's CLIProxyAPI answers, as the pool object addresses it. */
export const CONTAINER_ORIGIN = "http://cliproxyapi";

/** The made-up host the container's object store calls go to. */
export const STORE_HOST = "store.pool.internal";

/** How long the container outlives the last request the pool sent it. */
export const IDLE_TIMEOUT_MS = 2 * 60_000;

/**
 * How long Cloudflare keeps the container after the object itself goes
 * inactive: a backstop for an object that is gone before its alarm stops it.
 */
const BACKSTOP_TIMEOUT_MS = IDLE_TIMEOUT_MS + 60_000;

/** How long a cold start may take before a request fails. */
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 100;

/** The store credentials the container is configured with. */
export interface StoreCredentials {
  readonly accessKey: string;
  readonly secretKey: string;
}

export class PoolContainer extends Context.Service<
  PoolContainer,
  {
    /** Sends a request to the CLIProxyAPI, starting the container first if it sleeps. */
    readonly fetch: (request: Request, store: StoreCredentials) => Promise<Response>;
    readonly running: Effect.Effect<boolean>;
    readonly stop: Effect.Effect<void>;
    /**
     * Stops the container once it has been idle for `IDLE_TIMEOUT_MS`.
     * Returns when to look again, or null when it is not running.
     */
    readonly sleepIfIdle: (now: number) => Effect.Effect<number | null>;
  }
>()("@signalbox/cloud/pool/PoolContainer") {}

/** The container's environment: CLIProxyAPI's object-store backend, pointed at the pool's store. */
export const containerEnv = (store: StoreCredentials): Record<string, string> => ({
  OBJECTSTORE_ENDPOINT: `http://${STORE_HOST}`,
  OBJECTSTORE_BUCKET: POOL_STORE_BUCKET,
  OBJECTSTORE_ACCESS_KEY: store.accessKey,
  OBJECTSTORE_SECRET_KEY: store.secretKey,
  OBJECTSTORE_LOCAL_PATH: "/tmp/cliproxyapi",
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Requests in flight and when the last one ended, in this object's memory.
 * Only requests the pool sends count: the container's own store writes (token
 * refreshes) never keep it awake. A streamed response counts until its body
 * ends. An object only goes away with nothing in flight, so one that has seen
 * no request since it started has nothing to wait for: the alarm that woke it
 * was set for when the container became idle long enough.
 */
const makeActivity = (onIdleFrom: (at: number) => void) => {
  let inFlight = 0;
  let lastEnded: number | null = null;
  const end = () => {
    inFlight -= 1;
    lastEnded = Date.now();
    if (inFlight === 0) onIdleFrom(lastEnded);
  };
  return {
    track: async (send: () => Promise<Response>) => {
      inFlight += 1;
      let response: Response;
      try {
        response = await send();
      } catch (error) {
        end();
        throw error;
      }
      if (response.body === null) {
        end();
        return response;
      }
      let ended = false;
      const once = () => {
        if (!ended) {
          ended = true;
          end();
        }
      };
      const body = response.body.pipeThrough(new TransformStream({ flush: once }));
      return new Response(body, response);
    },
    /** When the container may sleep, given nothing new arrives; null while a request is open. */
    sleepAt: () => (inFlight > 0 ? null : lastEnded === null ? 0 : lastEnded + IDLE_TIMEOUT_MS),
  };
};

/**
 * The real container, through the Durable Object's `ctx.container`.
 * `storeGateway` routes the container's store calls back to this object.
 */
export const layerCloudflare = (input: {
  readonly container: Container;
  readonly storeGateway: Fetcher;
  /** Sets the object's alarm, which calls `sleepIfIdle`, to `at`. */
  readonly wakeAt: (at: number) => void;
  readonly log: (event: string, fields: Record<string, unknown>) => void;
}) => {
  const { container, storeGateway, wakeAt, log } = input;
  let starting: Promise<void> | undefined;
  const activity = makeActivity((at) => wakeAt(at + IDLE_TIMEOUT_MS));

  const waitUntilReady = async (startedAt: number) => {
    const port = container.getTcpPort(CLI_PROXY_API_PORT);
    while (performance.now() - startedAt < READY_TIMEOUT_MS) {
      if (!container.running) throw new Error("The pool's container exited while starting.");
      try {
        // Any answer means CLIProxyAPI pulled its store and is listening.
        const response = await port.fetch(`${CONTAINER_ORIGIN}/`);
        await response.body?.cancel();
        return;
      } catch {
        await sleep(READY_POLL_MS);
      }
    }
    throw new Error("The pool's container did not start in time.");
  };

  const start = async (store: StoreCredentials) => {
    const startedAt = performance.now();
    // Intercepts last until the container stops, so every start sets them again.
    await container.interceptOutboundHttp(STORE_HOST, storeGateway);
    container.start({ enableInternet: true, env: containerEnv(store) });
    await container.setInactivityTimeout(BACKSTOP_TIMEOUT_MS);
    await waitUntilReady(startedAt);
    log("pool.container.started", { readyMs: Math.round(performance.now() - startedAt) });
  };

  const ensure = (store: StoreCredentials) => {
    if (starting) return starting;
    if (container.running) return Promise.resolve();
    starting = start(store).finally(() => {
      starting = undefined;
    });
    return starting;
  };

  // A container that outlived its object's restart has lost its timeout.
  if (container.running) void container.setInactivityTimeout(BACKSTOP_TIMEOUT_MS);

  return Layer.succeed(
    PoolContainer,
    PoolContainer.of({
      fetch: (request, store) =>
        activity.track(async () => {
          await ensure(store);
          return container.getTcpPort(CLI_PROXY_API_PORT).fetch(request);
        }),
      running: Effect.sync(() => container.running),
      stop: Effect.promise(async () => {
        if (container.running) await container.destroy().catch(() => {});
      }),
      sleepIfIdle: (now) =>
        Effect.promise(async () => {
          if (starting) return now + READY_TIMEOUT_MS;
          if (!container.running) return null;
          const at = activity.sleepAt();
          if (at === null) return now + IDLE_TIMEOUT_MS;
          if (at > now) return at;
          // CLIProxyAPI has written every change to the store already. Destroying
          // rejects with the container's exit, which is the point.
          await container.destroy().catch(() => {});
          log("pool.container.slept", {});
          return null;
        }),
    }),
  );
};

/**
 * A container that is never there: what a pool object gets where containers
 * are not available. Managed pools then fail to reach their CLIProxyAPI with
 * a clear message; external ones work.
 */
export const layerUnavailable = Layer.succeed(
  PoolContainer,
  PoolContainer.of({
    fetch: () => Promise.reject(new Error("Pool containers are not available here.")),
    running: Effect.succeed(false),
    stop: Effect.void,
    sleepIfIdle: () => Effect.succeed(null),
  }),
);

/**
 * A container that runs `serve` in place of CLIProxyAPI, for tests. `starts`
 * counts cold starts; `stop` puts it to sleep like an idle timeout would.
 */
export const makeFake = (
  serve: (request: Request, store: StoreCredentials) => Promise<Response>,
) => {
  let running = false;
  const state = { starts: 0 };
  const layer = Layer.succeed(
    PoolContainer,
    PoolContainer.of({
      fetch: (request, store) => {
        if (!running) {
          running = true;
          state.starts += 1;
        }
        return serve(request, store);
      },
      running: Effect.sync(() => running),
      stop: Effect.sync(() => {
        running = false;
      }),
      sleepIfIdle: () => Effect.succeed(null),
    }),
  );
  return { layer, state };
};
