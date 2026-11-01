import { describe, expect, it } from "@effect/vitest";
import {
  HARNESS_C_PRODUCT_CAPABILITY_KEYS,
  HarnessCProductCapabilityError,
  narrowHarnessCProductCapabilities,
  productReleaseBindings,
  productModelTransport,
} from "../HarnessCProductCapabilities.ts";

const completeCapabilities = () =>
  Object.fromEntries([
    [
      HARNESS_C_PRODUCT_CAPABILITY_KEYS.release,
      { getArtifact() {}, loaderConfig() {}, readArtifact() {}, readArtifactChunk() {} },
    ],
    [HARNESS_C_PRODUCT_CAPABILITY_KEYS.nativeCheckpoint, { read() {} }],
    [
      HARNESS_C_PRODUCT_CAPABILITY_KEYS.access,
      { resolveInitialAccess() {}, resolveTurnAccess() {} },
    ],
    [HARNESS_C_PRODUCT_CAPABILITY_KEYS.programs, { catalog() {}, read() {} }],
    [HARNESS_C_PRODUCT_CAPABILITY_KEYS.machine, { inventory() {} }],
    [HARNESS_C_PRODUCT_CAPABILITY_KEYS.model, { fetch() {} }],
    [HARNESS_C_PRODUCT_CAPABILITY_KEYS.executor, { forward() {} }],
  ]) as unknown as Readonly<Record<string, Fetcher>>;

describe("product bootstrap capabilities", () => {
  it("routes bounded artifact reads through the release chunk RPC", async () => {
    const calls: unknown[][] = [];
    const service = {
      async getArtifact() {
        return null;
      },
      async loaderConfig() {
        return {
          trustedComputer: { sourceIdentity: "source", manifestSha256: "0".repeat(64) },
          maxPreparedModuleBytes: 128_000_000,
        };
      },
      async readArtifact() {
        throw new Error("Full artifact read was used.");
      },
      async readArtifactChunk(...args: unknown[]) {
        calls.push(args);
        return new Uint8Array([1, 2, 3]);
      },
    };
    const bindings = await productReleaseBindings("codex", service);
    const options = await bindings.loadOptions();
    const range = options.source.readRange;
    if (range === undefined) throw new Error("Release source did not expose range reads.");

    expect(await range("sha256:artifact", "codex/engine.wasm", 0, 3)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(calls).toEqual([["sha256:artifact", "codex/engine.wasm", 0, 3]]);
  });

  it("requires the constructor-owned Worker binding map and every named RPC", () => {
    expect(() => narrowHarnessCProductCapabilities(undefined)).toThrow(
      HarnessCProductCapabilityError,
    );

    const valid = narrowHarnessCProductCapabilities(completeCapabilities());
    expect(typeof valid.release.getArtifact).toBe("function");
    expect(typeof valid.machine.inventory).toBe("function");

    const missingMachine = { ...completeCapabilities() };
    delete (missingMachine as Record<string, unknown>)[HARNESS_C_PRODUCT_CAPABILITY_KEYS.machine];
    expect(() => narrowHarnessCProductCapabilities(missingMachine)).toThrow(
      HarnessCProductCapabilityError,
    );
  });
});

it("releases release metadata RPC results before returning detached loader data", async () => {
  let pins = 0;
  const service = {
    async getArtifact() {
      return null;
    },
    async loaderConfig() {
      pins++;
      return {
        trustedComputer: { sourceIdentity: "source", manifestSha256: "0".repeat(64) },
        maxPreparedModuleBytes: 128_000_000,
        [Symbol.dispose]() {
          pins--;
        },
      };
    },
    async readArtifact() {
      return new Uint8Array();
    },
    async readArtifactChunk() {
      return new Uint8Array();
    },
  };
  const bindings = await productReleaseBindings("claude-code", service);
  const options = await bindings.loadOptions();
  expect(pins).toBe(0);
  expect(options.trustedComputer.sourceIdentity).toBe("source");
});

it("retains streamed model RPC results until EOF or cancellation and closes failed reads", async () => {
  let pins = 0;
  let releases = 0;
  const source = (failure = false) => {
    pins++;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (failure) controller.error(new Error("stream failed"));
          else {
            controller.enqueue(new TextEncoder().encode("model"));
            controller.close();
          }
        },
      }),
    );
    Object.defineProperty(response, Symbol.dispose, {
      value() {
        pins--;
        releases++;
      },
    });
    return response;
  };
  const request = () => new Request("https://model.invalid/v1/messages");
  const transport = productModelTransport({ fetch: async () => source() });
  const consumed = await transport(request());
  expect(pins).toBe(1);
  expect(await consumed.text()).toBe("model");
  expect(pins).toBe(0);
  const cancelled = await transport(request());
  expect(pins).toBe(1);
  await cancelled.body!.cancel();
  expect(pins).toBe(0);
  const failed = await productModelTransport({ fetch: async () => source(true) })(request());
  await expect(failed.text()).rejects.toThrow("stream failed");
  expect(pins).toBe(0);
  expect(releases).toBe(3);
});

it("releases an unread model RPC body when its caller aborts", async () => {
  let released = false;
  const closed = Promise.withResolvers<void>();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        closed.resolve();
      },
    }),
  );
  Object.defineProperty(response, Symbol.dispose, {
    value() {
      released = true;
    },
  });
  const controller = new AbortController();
  const forwarded = await productModelTransport({ fetch: async () => response })(
    new Request("https://model.invalid/v1/messages", { signal: controller.signal }),
  );
  expect(released).toBe(false);
  controller.abort();
  await closed.promise;
  await forwarded.body!.cancel();
  expect(released).toBe(true);
});

it("preserves model WebSocket upgrades and owns their RPC result through close or abort", async () => {
  for (const abort of [false, true]) {
    let pins = 1;
    let closes = 0;
    class Socket extends EventTarget {
      close() {
        closes++;
        this.dispatchEvent(new Event("close"));
      }
    }
    const socket = new Socket();
    const response = new Response(null);
    Object.defineProperties(response, {
      status: { value: 101 },
      webSocket: { value: socket },
      [Symbol.dispose]: { value: () => pins-- },
    });
    const controller = new AbortController();
    const forwarded = await productModelTransport({ fetch: async () => response })(
      new Request("https://model.invalid/v1/responses", { signal: controller.signal }),
    );
    expect(forwarded.status).toBe(101);
    expect(forwarded.webSocket).toBe(socket);
    expect(pins).toBe(1);
    if (abort) controller.abort();
    else socket.close();
    expect(closes).toBe(1);
    expect(pins).toBe(0);
    socket.dispatchEvent(new Event("error"));
    expect(pins).toBe(0);
  }
});
