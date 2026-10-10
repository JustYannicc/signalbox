import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as PoolContainer from "./PoolContainer.ts";

/** `ctx.container` as far as the pool uses it, serving `respond` once started. */
const fakeContainer = (respond: () => Promise<Response>) => {
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
      fetch: (input: RequestInfo) =>
        new URL(typeof input === "string" ? input : input.url).pathname === "/"
          ? Promise.resolve(new Response(null, { status: 404 }))
          : respond(),
    }),
  } as unknown as Container;
  return { container, calls };
};

const store = { accessKey: "a", secretKey: "s" };
const T0 = Date.UTC(2026, 9, 8, 9, 0, 0);
const IDLE = PoolContainer.IDLE_TIMEOUT_MS;

const makePool = (respond: () => Promise<Response>, running = false) => {
  const fake = fakeContainer(respond);
  if (running) fake.container.start({ enableInternet: true });
  const wakes: Array<number> = [];
  const layer = PoolContainer.layerCloudflare({
    container: fake.container,
    storeGateway: {} as Fetcher,
    wakeAt: (at) => wakes.push(at),
    log: () => {},
  });
  return { ...fake, wakes, layer };
};

const send = (path: string) =>
  PoolContainer.PoolContainer.use((container) =>
    Effect.promise(() => container.fetch(new Request(`http://cliproxyapi${path}`), store)),
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

  it.effect("sleeps once nothing has reached it for the idle timeout, never mid-request", () => {
    let release: (response: Response) => void = () => {};
    const pool = makePool(() => new Promise((resolve) => (release = resolve)));
    return Effect.gen(function* () {
      const pending = yield* Effect.forkChild(send("/v1/messages"));
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(pool.calls).toContain(`start http://${PoolContainer.STORE_HOST}`)),
      );

      // A request is still open long after the timeout: stay up.
      const later = T0 + 10 * IDLE;
      vi.setSystemTime(later);
      expect(yield* sleepIfIdle(later)).toBe(later + IDLE);

      // The streamed body ends: the idle clock starts then.
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

  it.effect("sleeps a container its object found running after a restart, at the alarm", () => {
    // The object restarted: nothing in flight, nothing seen since.
    const pool = makePool(async () => new Response("ok"), true);
    return Effect.gen(function* () {
      expect(yield* sleepIfIdle(T0)).toBeNull();
      expect(pool.calls).toContain("destroy");
    }).pipe(Effect.provide(pool.layer));
  });
});
