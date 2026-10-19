import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ProofLauncherFailure } from "./Deployment.ts";
import { waitForDevTunnel } from "./DevTunnelReadiness.ts";

const stage = "computer-boxd-12345678";
const evidence = {
  status: "pending",
  checks: {},
  cleanupConfirmed: false,
  vmNames: ["computer-sb-computer-boxd-12345678-source"],
};
const input = (signal = new AbortController().signal) => ({
  url: new URL("https://dev-tunnel.invalid"),
  token: "test-token",
  stage,
  signal,
});

describe("dev tunnel readiness", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits through unavailable DNS and HTTP until the same pending proof responds", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn<typeof import("./Deployment.ts").requestProofWorker>()
      .mockRejectedValueOnce(new ProofLauncherFailure("Worker /status failed (network error)."))
      .mockRejectedValueOnce(new ProofLauncherFailure("Worker /status failed (HTTP 502)."))
      .mockResolvedValue({ httpStatus: 200, body: evidence });
    let ready = false;
    const waiting = waitForDevTunnel(input(), request).then(() => {
      ready = true;
    });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(ready).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(ready).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each([
    { name: "connection reset", error: new TypeError("connection reset") },
    { name: "body timeout", error: new DOMException("body timed out", "TimeoutError") },
  ])("retries a $name after receiving response headers", async ({ error }) => {
    vi.useFakeTimers();
    const fetchWorker = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(error);
            },
          }),
          { status: 200 },
        ),
      )
      .mockImplementation(async () => new Response(JSON.stringify(evidence), { status: 200 }));
    vi.stubGlobal("fetch", fetchWorker);
    const waiting = waitForDevTunnel(input());
    const outcome = waiting.then(
      () => "ready",
      () => "failed",
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await outcome).toBe("ready");
    expect(fetchWorker).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "invalid JSON", response: () => new Response("{", { status: 200 }) },
    { name: "unauthorized response", response: () => new Response("", { status: 401 }) },
  ])("does not retry $name from the dev server", async ({ response }) => {
    const fetchWorker = vi.fn<typeof fetch>().mockImplementation(async () => response());
    vi.stubGlobal("fetch", fetchWorker);
    await expect(waitForDevTunnel(input())).rejects.toBeInstanceOf(ProofLauncherFailure);
    expect(fetchWorker).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "wrong proof",
      body: { ...evidence, vmNames: ["computer-sb-computer-boxd-other123-source"] },
    },
    { name: "already running", body: { ...evidence, status: "running" } },
  ])("refuses $name without treating it as propagation delay", async ({ body }) => {
    const request = vi
      .fn<typeof import("./Deployment.ts").requestProofWorker>()
      .mockResolvedValue({ httpStatus: 200, body });
    await expect(waitForDevTunnel(input(), request)).rejects.toBeInstanceOf(ProofLauncherFailure);
    expect(request).toHaveBeenCalledOnce();
  });

  it("stops when cancelled while waiting for DNS", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const request = vi
      .fn<typeof import("./Deployment.ts").requestProofWorker>()
      .mockRejectedValue(new ProofLauncherFailure("Worker /status failed (network error)."));
    const waiting = waitForDevTunnel(input(controller.signal), request);
    const failure = expect(waiting).rejects.toThrow("did not become reachable");
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await failure;
    expect(request).toHaveBeenCalledOnce();
  });
});
