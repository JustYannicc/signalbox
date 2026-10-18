// @effect-diagnostics globalTimers:off globalDate:off - the container lifecycle is promise code on the Durable Object's own clock.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import { CLI_PROXY_API_PORT, listModels, type PoolEndpoint } from "./cliProxyApi.ts";
import {
  makeReleaseObserver,
  unknownRelease,
  type CliProxyApiRelease,
} from "./CliProxyApiRuntime.ts";
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

/**
 * How long a model request waits after a cold start for CLIProxyAPI to load
 * its accounts. It listens before it has: until then it answers
 * `unknown provider for model` (#563). After this the request goes in anyway.
 */
const MODELS_READY_MS = 10_000;

/** The store credentials the container is configured with. */
export interface StoreCredentials {
  readonly accessKey: string;
  readonly secretKey: string;
}

/**
 * What sending a request needs. `models`: the request runs a model on a pool
 * with accounts, so it waits until CLIProxyAPI serves them; `onSend` runs
 * once the container is up, as the request goes in.
 */
export interface SendOptions {
  readonly store: StoreCredentials;
  readonly models?: { readonly clientKey: string };
  readonly onSend?: () => void;
}

export class PoolContainer extends Context.Service<
  PoolContainer,
  {
    /** Sends a request to the CLIProxyAPI, starting the container first if it sleeps. */
    readonly fetch: (request: Request, options: SendOptions) => Promise<Response>;
    /**
     * Sends a request only if the container is already up, without keeping
     * it up: for reads that must never wake it or delay its sleep.
     */
    readonly peek: (request: Request) => Promise<Response>;
    /** Evidence from this running container, or unknown until a management reply identifies it. */
    readonly release: () => CliProxyApiRelease;
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
const containerEnv = (store: StoreCredentials): Record<string, string> => ({
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
      // Ends on the last chunk, an error, or a reader that gives up.
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>(
        {
          pull: async (controller) => {
            try {
              const { done, value } = await reader.read();
              if (done) {
                once();
                controller.close();
              } else {
                controller.enqueue(value);
              }
            } catch (error) {
              once();
              controller.error(error);
            }
          },
          cancel: (reason) => {
            once();
            return reader.cancel(reason);
          },
        },
        { highWaterMark: 0 },
      );
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
  let stopping: Promise<void> | undefined;
  const release = makeReleaseObserver((cliProxyApi) =>
    log("pool.container.release_observed", { cliProxyApi }),
  );
  const currentRelease = () =>
    container.running && !starting && !stopping ? release.current() : unknownRelease;
  const activity = makeActivity((at) => wakeAt(at + IDLE_TIMEOUT_MS));

  /**
   * Settles once this container's CLIProxyAPI lists models, or gave up
   * waiting. Reset by each start; a container already up when this object
   * started has long loaded its accounts.
   */
  let modelsReady: Promise<void> | undefined = container.running ? Promise.resolve() : undefined;

  /** Asks `/v1/models` until it lists any, for at most `MODELS_READY_MS`. */
  const waitForModels = async (clientKey: string) => {
    const port = container.getTcpPort(CLI_PROXY_API_PORT);
    const startedAt = performance.now();
    const left = () => MODELS_READY_MS - (performance.now() - startedAt);
    // Straight to the port: through `fetch` it would wait on itself.
    const endpoint: PoolEndpoint = {
      fetch: (request) =>
        port.fetch(
          new Request(request, { signal: AbortSignal.timeout(Math.max(Math.ceil(left()), 1)) }),
        ),
      baseUrl: CONTAINER_ORIGIN,
      managementKey: "",
      clientKey,
      link: false,
    };
    // `stopping` is set by `destroy` while this waits.
    // oxlint-disable-next-line no-unmodified-loop-condition
    while (left() > 0 && container.running && !stopping) {
      const listed = await Effect.runPromiseExit(listModels(endpoint));
      if (Exit.isSuccess(listed) && listed.value.length > 0) return;
      await sleep(READY_POLL_MS);
    }
    log("pool.container.models_not_ready", {
      cliProxyApi: currentRelease(),
      waitedMs: Math.round(performance.now() - startedAt),
      stopped: !container.running || stopping !== undefined,
    });
  };

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
    release.reset();
    // Intercepts last until the container stops, so every start sets them again.
    await container.interceptOutboundHttp(STORE_HOST, storeGateway);
    modelsReady = undefined;
    container.start({ enableInternet: true, env: containerEnv(store) });
    await container.setInactivityTimeout(BACKSTOP_TIMEOUT_MS);
    await waitUntilReady(startedAt);
    log("pool.container.started", {
      cliProxyApi: unknownRelease,
      readyMs: Math.round(performance.now() - startedAt),
    });
  };

  const ensure = async (store: StoreCredentials) => {
    // A container on its way down is not one to send requests to.
    if (stopping) await stopping;
    if (starting) return starting;
    if (container.running) return;
    starting = start(store).finally(() => {
      starting = undefined;
    });
    return starting;
  };

  /** Destroying rejects with the container's exit, which is the point. */
  const destroy = () => {
    release.reset();
    stopping ??= container
      .destroy()
      .catch(() => {})
      .finally(() => {
        stopping = undefined;
      });
    return stopping;
  };

  // A container that outlived its object's restart has lost its timeout.
  if (container.running) void container.setInactivityTimeout(BACKSTOP_TIMEOUT_MS);

  return Layer.succeed(
    PoolContainer,
    PoolContainer.of({
      fetch: (request, { store, models, onSend }) =>
        activity.track(async () => {
          await ensure(store);
          // Every call a model request makes waits, so pinning an account (`threadAccounts.ts`) finds it loaded.
          if (models !== undefined) {
            modelsReady ??= waitForModels(models.clientKey);
            await modelsReady;
          }
          onSend?.();
          return release.observe(request, () =>
            container.getTcpPort(CLI_PROXY_API_PORT).fetch(request),
          );
        }),
      peek: async (request) => {
        if (starting || stopping || !container.running) {
          throw new Error("The pool's container is asleep.");
        }
        return release.observe(request, () =>
          container.getTcpPort(CLI_PROXY_API_PORT).fetch(request),
        );
      },
      release: currentRelease,
      running: Effect.sync(() => container.running && !stopping),
      stop: Effect.promise(async () => {
        if (container.running) await destroy();
      }),
      sleepIfIdle: (now) =>
        Effect.promise(async () => {
          if (starting) return now + READY_TIMEOUT_MS;
          if (!container.running) return null;
          const at = activity.sleepAt();
          if (at === null) return now + IDLE_TIMEOUT_MS;
          if (at > now) return at;
          // CLIProxyAPI has written every change to the store already.
          const cliProxyApi = currentRelease();
          await destroy();
          log("pool.container.slept", { cliProxyApi });
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
    peek: () => Promise.reject(new Error("Pool containers are not available here.")),
    release: () => unknownRelease,
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
  const release = makeReleaseObserver();
  const state = { starts: 0 };
  const layer = Layer.succeed(
    PoolContainer,
    PoolContainer.of({
      fetch: (request, { store, onSend }) => {
        if (!running) {
          release.reset();
          running = true;
          state.starts += 1;
        }
        onSend?.();
        return release.observe(request, () => serve(request, store));
      },
      peek: (request) =>
        running
          ? release.observe(request, () => serve(request, { accessKey: "", secretKey: "" }))
          : Promise.reject(new Error("The pool's container is asleep.")),
      release: () => (running ? release.current() : unknownRelease),
      running: Effect.sync(() => running),
      stop: Effect.sync(() => {
        release.reset();
        running = false;
      }),
      sleepIfIdle: () => Effect.succeed(null),
    }),
  );
  return { layer, state };
};
