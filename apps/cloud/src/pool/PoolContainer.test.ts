import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as PoolContainer from "./PoolContainer.ts";
import * as PoolContainerCloudflare from "./adapters/PoolContainerCloudflare.ts";

/**
 * `ctx.container` as far as the pool uses it, serving `respond` once started.
 * `models` answers CLIProxyAPI's `/v1/models` when a test needs it.
 */
const fakeContainer = (
  respond: (request: Request) => Promise<Response>,
  models?: (request: Request) => Promise<Response>,
  ready: (request: Request) => Promise<Response> = () =>
    Promise.resolve(new Response(null, { status: 404 })),
) => {
  const calls: Array<string> = [];
  let running = false;
  const container = {
    get running() {
      return running;
    },
    start: (options?: ContainerStartupOptions) => {
      calls.push(`start ${options?.env?.OBJECTSTORE_ENDPOINT}`);
      running = true;
    },
    destroy: async () => {
      calls.push("destroy");
      running = false;
    },
    interceptOutboundHttp: async (host: string) => {
      calls.push(`intercept ${host}`);
    },
    setInactivityTimeout: async () => {},
    // The readiness probe asks for `/`; everything else is a request the pool sent.
    getTcpPort: () => ({
      fetch: (input: RequestInfo) => {
        const request = typeof input === "string" ? new Request(input) : input;
        const { pathname } = new URL(request.url);
        if (pathname === "/") return ready(request);
        return pathname === "/v1/models" && models !== undefined
          ? models(request)
          : respond(request);
      },
    }),
  } as unknown as Container;
  return { container, calls };
};

const store = { accessKey: "a", secretKey: "s" };
const T0 = Date.UTC(2026, 9, 8, 9, 0, 0);
const IDLE = PoolContainer.IDLE_TIMEOUT_MS;

const makePool = (respond: (request: Request) => Promise<Response>, running = false) => {
  const fake = fakeContainer(respond);
  if (running) fake.container.start({ enableInternet: true });
  const wakes: Array<number> = [];
  const events: Array<{ readonly action: string; readonly fields: Record<string, unknown> }> = [];
  const layer = PoolContainerCloudflare.layerCloudflare({
    container: fake.container,
    storeGateway: {} as Fetcher,
    wakeAt: (at) => wakes.push(at),
    log: (action, fields) => events.push({ action, fields }),
  });
  return { ...fake, wakes, events, layer };
};

const send = (path: string) =>
  PoolContainer.PoolContainer.use((container) =>
    container.fetch(new Request(`http://cliproxyapi${path}`), { store }),
  );

const sleepIfIdle = (now: number) =>
  PoolContainer.PoolContainer.use((container) => container.sleepIfIdle(now));

describe("PoolContainer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.effect("starts on the first request, pointed at the pool's own store", () => {
    const pool = makePool(async () => new Response("ok"));
    return Effect.gen(function* () {
      const response = yield* send("/x");
      expect(yield* Effect.promise(() => response.text())).toBe("ok");
      yield* send("/y");
      expect(pool.calls).toEqual([
        `intercept ${PoolContainer.STORE_HOST}`,
        `start http://${PoolContainer.STORE_HOST}`,
      ]);
    }).pipe(Effect.provide(pool.layer));
  });

  it.effect("returns a tagged error when CLIProxyAPI never becomes ready", () => {
    let probes = 0;
    const fake = fakeContainer(
      async () => new Response("unused"),
      undefined,
      async () => {
        probes += 1;
        throw new Error("not listening");
      },
    );
    fake.container.start({ enableInternet: true });
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(PoolContainer.waitUntilReady(fake.container));
      yield* TestClock.adjust(PoolContainer.READY_TIMEOUT_MS);
      const error = yield* Effect.flip(Fiber.join(fiber));
      expect(error._tag).toBe("PoolContainerReadinessTimeoutError");
      expect(probes).toBeGreaterThan(1);
    });
  });

  it.effect("uses only the readiness budget left after startup setup", () => {
    let probes = 0;
    const fake = fakeContainer(
      async () => new Response("unused"),
      undefined,
      async () => {
        probes += 1;
        throw new Error("not listening");
      },
    );
    fake.container.start({ enableInternet: true });
    const setupMs = 20_000;
    return Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      yield* TestClock.adjust(setupMs);
      const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
      const remainingMs = Math.max(0, PoolContainer.READY_TIMEOUT_MS - elapsedMs);
      const fiber = yield* Effect.forkChild(
        PoolContainer.waitUntilReady(fake.container, remainingMs),
      );
      yield* TestClock.adjust(remainingMs);
      const error = yield* Effect.flip(Fiber.join(fiber));
      expect(error._tag).toBe("PoolContainerReadinessTimeoutError");
      expect(probes).toBeGreaterThan(1);
    });
  });

  it.effect("does not probe when startup setup has exhausted the readiness budget", () => {
    let probes = 0;
    const fake = fakeContainer(
      async () => new Response("unused"),
      undefined,
      async () => {
        probes += 1;
        throw new Error("not listening");
      },
    );
    fake.container.start({ enableInternet: true });
    return Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      yield* TestClock.adjust(PoolContainer.READY_TIMEOUT_MS);
      const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
      const remainingMs = Math.max(0, PoolContainer.READY_TIMEOUT_MS - elapsedMs);
      const error = yield* Effect.flip(PoolContainer.waitUntilReady(fake.container, remainingMs));
      expect(error._tag).toBe("PoolContainerReadinessTimeoutError");
      expect(probes).toBe(0);
    });
  });

  it.effect("counts intercept and inactivity setup against the original readiness deadline", () => {
    let probes = 0;
    const fake = fakeContainer(
      async () => new Response("unused"),
      undefined,
      async () => {
        probes += 1;
        return new Response(null, { status: 404 });
      },
    );
    const interceptEntered = Promise.withResolvers<void>();
    const finishIntercept = Promise.withResolvers<void>();
    const inactivityEntered = Promise.withResolvers<void>();
    const finishInactivity = Promise.withResolvers<void>();
    fake.container.interceptOutboundHttp = async () => {
      fake.calls.push(`intercept ${PoolContainer.STORE_HOST}`);
      interceptEntered.resolve();
      await finishIntercept.promise;
    };
    fake.container.setInactivityTimeout = async () => {
      inactivityEntered.resolve();
      await finishInactivity.promise;
    };
    const pool = {
      ...fake,
      layer: PoolContainerCloudflare.layerCloudflare({
        container: fake.container,
        storeGateway: {} as Fetcher,
        wakeAt: () => {},
        log: () => {},
      }),
    };
    return Effect.gen(function* () {
      const request = yield* Effect.forkChild(send("/x"));
      yield* Effect.promise(() => interceptEntered.promise);
      yield* TestClock.adjust(20_000);
      finishIntercept.resolve();
      yield* Effect.promise(() => inactivityEntered.promise);
      yield* TestClock.adjust(10_000);
      finishInactivity.resolve();

      const error = yield* Effect.flip(Fiber.join(request));
      expect(error._tag).toBe("PoolContainerReadinessTimeoutError");
      expect(pool.calls).toContain(`start http://${PoolContainer.STORE_HOST}`);
      expect(probes).toBe(0);
    }).pipe(Effect.provide(pool.layer));
  });

  it.effect("coalesces concurrent cold requests into one container start", () => {
    const pool = makePool(async () => new Response("ok"));
    const interceptEntered = Promise.withResolvers<void>();
    const finishIntercept = Promise.withResolvers<void>();
    pool.container.interceptOutboundHttp = async () => {
      pool.calls.push(`intercept ${PoolContainer.STORE_HOST}`);
      interceptEntered.resolve();
      await finishIntercept.promise;
    };
    return Effect.gen(function* () {
      const first = yield* Effect.forkChild(send("/first"));
      const second = yield* Effect.forkChild(send("/second"));
      yield* Effect.promise(() => interceptEntered.promise);
      expect(pool.calls.filter((call) => call.startsWith("start "))).toHaveLength(0);
      finishIntercept.resolve();
      const [firstResponse, secondResponse] = yield* Effect.all([
        Fiber.join(first),
        Fiber.join(second),
      ]);
      expect(yield* Effect.promise(() => firstResponse.text())).toBe("ok");
      expect(yield* Effect.promise(() => secondResponse.text())).toBe("ok");
      expect(pool.calls.filter((call) => call.startsWith("start "))).toHaveLength(1);
    }).pipe(Effect.provide(pool.layer));
  });

  it.effect("coalesces concurrent stop requests into one container destroy", () => {
    const pool = makePool(async () => new Response("ok"), true);
    const destroyEntered = Promise.withResolvers<void>();
    const finishDestroy = Promise.withResolvers<void>();
    const destroy = pool.container.destroy;
    let destroys = 0;
    pool.container.destroy = async () => {
      destroys += 1;
      destroyEntered.resolve();
      await finishDestroy.promise;
      await destroy();
    };
    const stop = PoolContainer.PoolContainer.use((container) => container.stop);
    return Effect.gen(function* () {
      const first = yield* Effect.forkChild(stop);
      const second = yield* Effect.forkChild(stop);
      yield* Effect.promise(() => destroyEntered.promise);
      expect(destroys).toBe(1);
      finishDestroy.resolve();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(destroys).toBe(1);
    }).pipe(Effect.provide(pool.layer));
  });

  it.effect("sleeps once nothing has reached it for the idle timeout, never mid-request", () => {
    let release: (response: Response) => void = () => {};
    const pool = makePool(() => new Promise((resolve) => (release = resolve)));
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const pending = yield* Effect.forkChild(send("/v1/messages"));
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(pool.calls).toContain(`start http://${PoolContainer.STORE_HOST}`)),
      );

      // A request is still open long after the timeout: stay up.
      const later = T0 + 10 * IDLE;
      vi.setSystemTime(later);
      expect(yield* sleepIfIdle(later)).toBe(later + IDLE);

      // The streamed body ends: the idle clock starts then.
      yield* TestClock.setTime(later);
      release(new Response("streamed"));
      const response = yield* Fiber.join(pending);
      yield* Effect.promise(() => response.text());
      expect(pool.wakes).toEqual([later + IDLE]);
      expect(yield* sleepIfIdle(later + 1_000)).toBe(later + IDLE);
      expect(pool.calls).not.toContain("destroy");

      expect(yield* sleepIfIdle(later + IDLE)).toBeNull();
      expect(pool.calls).toContain("destroy");
    }).pipe(Effect.provide(pool.layer));
  });

  it.effect("holds a model request after a cold start until CLIProxyAPI serves the models", () => {
    // CLIProxyAPI listens before it has loaded its accounts: no models for its first answers.
    let listed = 0;
    const order: Array<string> = [];
    const fake = fakeContainer(
      async () => {
        order.push("request");
        return new Response("ok");
      },
      async (request) => {
        listed += 1;
        order.push(`models ${request.headers.get("authorization")}`);
        return Response.json({ data: listed < 3 ? [] : [{ id: "m" }] });
      },
    );
    const layer = PoolContainerCloudflare.layerCloudflare({
      container: fake.container,
      storeGateway: {} as Fetcher,
      wakeAt: () => {},
      log: () => {},
    });
    const model = (path: string) =>
      PoolContainer.PoolContainer.use((container) =>
        container.fetch(new Request(`http://cliproxyapi${path}`), {
          store,
          models: { clientKey: "client" },
        }),
      );
    const advanceUntilListed = (count: number): Effect.Effect<void> =>
      Effect.suspend(() =>
        listed >= count
          ? Effect.void
          : TestClock.adjust(100).pipe(
              Effect.andThen(Effect.yieldNow),
              Effect.andThen(advanceUntilListed(count)),
            ),
      );
    return Effect.gen(function* () {
      const pending = yield* Effect.forkChild(model("/v1/messages"));
      yield* advanceUntilListed(3);
      yield* Fiber.join(pending);
      expect(order).toEqual([
        "models Bearer client",
        "models Bearer client",
        "models Bearer client",
        "request",
      ]);
      // Once it served them, later requests go straight in.
      yield* model("/v1/messages");
      expect(order.at(-1)).toBe("request");
      expect(listed).toBe(3);
    }).pipe(Effect.provide(layer));
  });

  it.effect("gives model discovery at most ten seconds before sending the request", () => {
    let listed = 0;
    const firstProbe = Promise.withResolvers<void>();
    const fake = fakeContainer(
      async () => new Response("sent"),
      async () => {
        listed += 1;
        firstProbe.resolve();
        return Response.json({ data: [] });
      },
    );
    const layer = PoolContainerCloudflare.layerCloudflare({
      container: fake.container,
      storeGateway: {} as Fetcher,
      wakeAt: () => {},
      log: () => {},
    });
    const request = PoolContainer.PoolContainer.use((container) =>
      container.fetch(new Request("http://cliproxyapi/v1/messages"), {
        store,
        models: { clientKey: "client" },
      }),
    );
    return Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const pending = yield* Effect.forkChild(request);
      yield* Effect.promise(() => firstProbe.promise);
      yield* TestClock.adjust(PoolContainer.MODELS_READY_MS);
      const response = yield* Fiber.join(pending);
      const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
      expect(elapsed).toBeLessThanOrEqual(PoolContainer.MODELS_READY_MS);
      expect(yield* Effect.promise(() => response.text())).toBe("sent");
      expect(listed).toBeGreaterThan(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("cancels model discovery when the container is stopped", () => {
    let aborted = false;
    const probeStarted = Promise.withResolvers<void>();
    const fake = fakeContainer(
      async () => new Response("sent"),
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(request.signal.reason);
            },
            { once: true },
          );
          probeStarted.resolve();
        }),
    );
    const layer = PoolContainerCloudflare.layerCloudflare({
      container: fake.container,
      storeGateway: {} as Fetcher,
      wakeAt: () => {},
      log: () => {},
    });
    const request = PoolContainer.PoolContainer.use((container) =>
      container.fetch(new Request("http://cliproxyapi/v1/messages"), {
        store,
        models: { clientKey: "client" },
      }),
    );
    return Effect.gen(function* () {
      const pending = yield* Effect.forkChild(request);
      yield* Effect.promise(() => probeStarted.promise);
      yield* PoolContainer.PoolContainer.use((container) => container.stop);
      const error = yield* Effect.flip(Fiber.join(pending));
      expect(aborted).toBe(true);
      expect(error._tag).toBe("PoolContainerStoppedError");
    }).pipe(Effect.provide(layer));
  });

  it.effect("peek fails without starting a sleeping container", () => {
    const pool = makePool(async () => new Response("unused"));
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        PoolContainer.PoolContainer.use((container) =>
          container.peek(new Request("http://cliproxyapi/v1/models")),
        ),
      );
      expect(error._tag).toBe("PoolContainerAsleepError");
      expect(pool.calls).toEqual([]);
    }).pipe(Effect.provide(pool.layer));
  });

  it.effect("sleeps a container its object found running after a restart, at the alarm", () => {
    // The object restarted: nothing in flight, nothing seen since.
    const pool = makePool(async () => new Response("ok"), true);
    return Effect.gen(function* () {
      expect(yield* sleepIfIdle(T0)).toBeNull();
      expect(pool.calls).toContain("destroy");
    }).pipe(Effect.provide(pool.layer));
  });

  it.effect(
    "identifies a surviving container only from management replies, even refused ones",
    () => {
      let metadata = true;
      const pool = makePool(
        async () =>
          new Response("unread body", {
            status: 403,
            headers: metadata ? { "x-cpa-version": "8.0.31" } : {},
          }),
        true,
      );
      return PoolContainer.PoolContainer.use((container) =>
        Effect.gen(function* () {
          expect(container.release().source).toBe("unknown");
          const model = yield* send("/v1/messages");
          expect(container.release().source).toBe("unknown");
          yield* Effect.promise(() => model.text());
          const management = yield* send("/v8/management/config");
          expect(container.release()).toMatchObject({
            source: "management-headers",
            version: "8.0.31",
          });
          expect(yield* Effect.promise(() => management.text())).toBe("unread body");
          expect(pool.events).toContainEqual({
            action: "pool.container.release_observed",
            fields: { cliProxyApi: container.release() },
          });
          metadata = false;
          const unsupported = yield* send("/v8/management/config");
          yield* Effect.promise(() => unsupported.text());
          expect(container.release().source).toBe("unknown");
          metadata = true;
          const identified = yield* send("/v8/management/config");
          yield* Effect.promise(() => identified.text());
          yield* sleepIfIdle(T0 + IDLE);
          expect(container.release().source).toBe("unknown");
          expect(pool.events.at(-1)).toMatchObject({
            action: "pool.container.slept",
            fields: { cliProxyApi: { version: "8.0.31" } },
          });
        }),
      ).pipe(Effect.provide(pool.layer));
    },
  );

  it.effect("does not revive evidence from a management reply that outlived its container", () => {
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<Response>();
    let late = false;
    const pool = makePool(async (request) => {
      if (new URL(request.url).pathname.startsWith("/v8/management/")) {
        if (late) {
          entered.resolve();
          return pending.promise;
        }
        return new Response(null, { headers: { "x-cpa-version": "8.0.31" } });
      }
      return new Response(null);
    });
    return PoolContainer.PoolContainer.use((container) =>
      Effect.gen(function* () {
        yield* send("/v8/management/config");
        expect(container.release().version).toBe("8.0.31");
        late = true;
        const old = yield* Effect.forkChild(send("/v8/management/credentials"));
        yield* Effect.promise(() => entered.promise);
        yield* container.stop;
        yield* send("/v1/messages");
        expect(container.release().source).toBe("unknown");
        pending.resolve(new Response(null, { headers: { "x-cpa-version": "8.0.31" } }));
        yield* Fiber.join(old);
        expect(container.release().source).toBe("unknown");
        const starts = pool.events.filter((event) => event.action === "pool.container.started");
        expect(starts).toHaveLength(2);
        for (const event of starts) {
          expect(event.fields.cliProxyApi).toMatchObject({ source: "unknown", version: null });
        }
        late = false;
        yield* send("/v8/management/config");
        yield* Effect.promise(() => pool.container.destroy());
        expect(container.release().source).toBe("unknown");
        yield* send("/v1/messages");
        expect(container.release().source).toBe("unknown");
      }),
    ).pipe(Effect.provide(pool.layer));
  });
});
