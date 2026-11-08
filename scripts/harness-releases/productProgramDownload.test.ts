// @effect-diagnostics globalDate:off - Vitest's fake clock measures native download deadlines outside an Effect runtime.
import * as NodeCrypto from "node:crypto";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { fetchPinned } from "./productProgramAssets.ts";

const bytes = new TextEncoder().encode("verified program");
const pin = {
  url: "https://github.com/JustYannicc/signalbox/releases/download/pinned/engine.wasm",
  bytes: bytes.length,
  sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
};
const metadataUrl = "https://api.github.com/repos/JustYannicc/signalbox/releases/tags/pinned";
const assetUrl = "https://api.github.com/repos/JustYannicc/signalbox/releases/assets/123";
const metadata = () => Response.json({ assets: [{ name: "engine.wasm", url: assetUrl }] });

afterEach(() => vi.useRealTimers());

it.each([504, 429, "network"] as const)(
  "retries a transient %s before verifying bytes",
  async (failure) => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        if (failure === "network") throw new Error("connection reset");
        return new Response(null, { status: failure });
      })
      .mockImplementation(async () => new Response(bytes));
    const result = fetchPinned(fetcher, pin, "asset");
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual(bytes);
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

it("uses at most four asset attempts, falling back to the exact API asset anonymously", async () => {
  vi.useFakeTimers();
  const start = Date.now();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    if (String(url) === pin.url) return new Response(null, { status: 504 });
    if (String(url) === metadataUrl) return metadata();
    expect(String(url)).toBe(assetUrl);
    expect(new Headers(init?.headers).get("Accept")).toBe("application/octet-stream");
    return new Response(bytes);
  });
  const result = fetchPinned(fetcher, pin, "asset");
  await vi.runAllTimersAsync();
  await expect(result).resolves.toEqual(bytes);
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
    pin.url,
    pin.url,
    pin.url,
    metadataUrl,
    assetUrl,
  ]);
  expect(Date.now() - start).toBe(3_000);
});

it("fails closed when API fallback bytes have the right size but wrong hash", async () => {
  vi.useFakeTimers();
  const fetcher: typeof fetch = async (url) => {
    if (String(url) === pin.url) return new Response(null, { status: 504 });
    if (String(url) === metadataUrl) return metadata();
    return new Response(new Uint8Array(bytes.length));
  };
  const result = expect(fetchPinned(fetcher, pin, "asset")).rejects.toThrow(
    "PRODUCT_PROGRAM_HASH_MISMATCH:asset",
  );
  await vi.runAllTimersAsync();
  await result;
});

it("bounds the complete download, including a stalled API body, to 60 seconds", async () => {
  vi.useFakeTimers();
  const start = Date.now();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (String(url) === pin.url) return new Response(null, { status: 504 });
    if (String(url) === metadataUrl) return metadata();
    return new Response(new ReadableStream());
  });
  const result = expect(fetchPinned(fetcher, pin, "asset")).rejects.toThrow(
    "PRODUCT_PROGRAM_DOWNLOAD_FAILED:asset",
  );
  await vi.runAllTimersAsync();
  await result;
  expect(Date.now() - start).toBeLessThanOrEqual(60_000);
  expect(fetcher.mock.calls.filter(([url]) => String(url) === pin.url)).toHaveLength(3);
  expect(fetcher.mock.calls.filter(([url]) => String(url) === assetUrl)).toHaveLength(1);
});

it("stops four non-GitHub attempts after exponential backoff", async () => {
  vi.useFakeTimers();
  const start = Date.now();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(null, { status: 503 }));
  const result = expect(
    fetchPinned(fetcher, { ...pin, url: "https://programs.invalid/asset" }, "asset"),
  ).rejects.toThrow(":503");
  await vi.runAllTimersAsync();
  await result;
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(Date.now() - start).toBe(7_000);
});

it("ends hung direct and API requests within the shared deadline", async () => {
  vi.useFakeTimers();
  const start = Date.now();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(() => new Promise<Response>(() => undefined));
  const result = expect(fetchPinned(fetcher, pin, "asset")).rejects.toThrow(
    "PRODUCT_PROGRAM_DOWNLOAD_FAILED:asset",
  );
  await vi.runAllTimersAsync();
  await result;
  expect(Date.now() - start).toBeLessThanOrEqual(60_000);
  expect(fetcher.mock.calls.filter(([url]) => String(url) === pin.url).length).toBeLessThanOrEqual(
    3,
  );
});

it("sends an explicit token only to the GitHub API", async () => {
  const fetcher: typeof fetch = async (url, init) => {
    const authorization = new Headers(init?.headers).get("Authorization");
    if (String(url) === pin.url) {
      expect(authorization).toBeNull();
      return new Response(null, { status: 404 });
    }
    expect(authorization).toBe("Bearer explicit-test-token");
    return String(url) === metadataUrl ? metadata() : new Response(bytes);
  };
  await expect(fetchPinned(fetcher, pin, "asset", "explicit-test-token")).resolves.toEqual(bytes);
});

it("rejects a similarly named API asset", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) =>
      String(url) === pin.url
        ? new Response(null, { status: 404 })
        : Response.json({ assets: [{ name: "engine.wasm.sig", url: assetUrl }] }),
    );
  await expect(fetchPinned(fetcher, pin, "asset")).rejects.toThrow("API_ASSET_MISSING:engine.wasm");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("does not retry or fall back after a direct integrity failure", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(new Uint8Array(bytes.length)));
  await expect(fetchPinned(fetcher, pin, "asset")).rejects.toThrow(
    "PRODUCT_PROGRAM_HASH_MISMATCH:asset",
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});
