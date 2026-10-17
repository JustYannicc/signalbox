import * as NodeEvents from "node:events";

import { describe, expect, it } from "@effect/vitest";

import {
  formatConnectionDiagnostics,
  probeWebSocketUpgrade,
  safeSocketErrorKind,
  safeUpgradeErrorCode,
  upgradeUrl,
} from "./diagnostics.ts";

class FakeRequest extends NodeEvents.EventEmitter {
  ended = false;
  destroyed = false;
  onEnd: (() => void) | undefined;

  end() {
    this.ended = true;
    this.onEnd?.();
    return this;
  }

  destroy() {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

class FakeResponse extends NodeEvents.EventEmitter {
  resumed = false;
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;

  constructor(statusCode: number, headers: Record<string, string | string[] | undefined> = {}) {
    super();
    this.statusCode = statusCode;
    this.headers = headers;
  }

  resume() {
    this.resumed = true;
    queueMicrotask(() => this.emit("end"));
    return this;
  }
}

class FakeSocket extends NodeEvents.EventEmitter {
  destroyed = false;

  destroy() {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

type FakeRequestFactory = NonNullable<Parameters<typeof probeWebSocketUpgrade>[4]>;

const fakeRequestFactory = (request: FakeRequest): FakeRequestFactory =>
  (() => request) as unknown as FakeRequestFactory;

const endpoint = "wss://probe.invalid/_lunora/ws";

describe("sync probe connection diagnostics", () => {
  it("keeps useful WebSocket error details while dropping messages and credentials", () => {
    const error = Object.assign(new Error("wss://worker.invalid/?token=secret"), {
      cause: Object.assign(new Error("token=secret"), { statusCode: 403 }),
      code: "ERR_SOCKET_CLOSED",
    });

    expect(safeSocketErrorKind({ error })).toBe("HTTP_403:ERR_SOCKET_CLOSED");
    expect(safeSocketErrorKind(new Error("token=secret"))).toBe("Error");
  });

  it("summarizes opens, closes, ready states and frame counts without close reasons", () => {
    const summary = formatConnectionDiagnostics([
      {
        levelId: "top:test",
        opens: 0,
        closes: 1,
        closeEvents: [{ code: 1006, count: 1, wasClean: false }],
        socketErrors: [{ kind: "HTTP_403", count: 1 }],
        readyStates: [3],
        incomingFrames: 0,
        incomingBytes: 0,
        outgoingFrames: 0,
        outgoingBytes: 0,
      },
    ]);

    expect(summary).toContain("open=0,close=1[1006x1 unclean]");
    expect(summary).toContain("ready=closed,error=[HTTP_403x1],frames=0/0,bytes=0/0");
    expect(summary).not.toContain("token");
  });

  it("builds Lunora's shard-then-token query without exposing it in the diagnostic", () => {
    const url = upgradeUrl("wss://probe.invalid/_lunora/ws", "top:test", "synthetic-token");

    expect(url.pathname).toBe("/_lunora/ws");
    expect([...url.searchParams]).toEqual([
      ["shard", "top:test"],
      ["token", "synthetic-token"],
    ]);
  });

  it("keeps only allowlisted Cloudflare response codes", () => {
    expect(safeUpgradeErrorCode({ statusCode: 403, headers: { "cf-error-code": "1003" } })).toBe(
      "CF_1003",
    );
    expect(
      safeUpgradeErrorCode({
        statusCode: 403,
        headers: { "x-lunora-error-code": "FORBIDDEN_SHARD" },
      }),
    ).toBeUndefined();
    expect(
      safeUpgradeErrorCode({ statusCode: 403, headers: { "cf-error-code": "999999" } }),
    ).toBeUndefined();
    expect(
      safeUpgradeErrorCode({ statusCode: 403, headers: { "cf-mitigated": "challenge" } }),
    ).toBe("CF_CHALLENGE");
  });

  it("destroys the socket after a successful upgrade", async () => {
    const request = new FakeRequest();
    const response = new FakeResponse(101, { "cf-error-code": "1020" });
    const socket = new FakeSocket();
    request.onEnd = () => queueMicrotask(() => request.emit("upgrade", response, socket));

    const result = await probeWebSocketUpgrade(
      endpoint,
      "top:test",
      "secret-token",
      100,
      fakeRequestFactory(request),
    );

    expect(request.ended).toBe(true);
    expect(socket.destroyed).toBe(true);
    expect(result).toEqual({ status: 101, kind: "upgrade", errorCode: "CF_1020" });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("drains a rejected HTTP response and reports only its status and safe code", async () => {
    const request = new FakeRequest();
    const response = new FakeResponse(403, { "cf-error-code": "1020" });
    request.onEnd = () =>
      queueMicrotask(() => {
        request.emit("response", response);
      });

    const result = await probeWebSocketUpgrade(
      endpoint,
      "top:test",
      "secret-token",
      100,
      fakeRequestFactory(request),
    );

    expect(response.resumed).toBe(true);
    expect(result).toEqual({ status: 403, kind: "http-response", errorCode: "CF_1020" });
  });

  it("settles network errors and early closes without exposing error text", async () => {
    const failed = new FakeRequest();
    failed.onEnd = () => queueMicrotask(() => failed.emit("error", new Error("secret-token")));
    await expect(
      probeWebSocketUpgrade(endpoint, "top:test", "secret-token", 100, fakeRequestFactory(failed)),
    ).resolves.toEqual({ status: null, kind: "network-error" });

    const closed = new FakeRequest();
    closed.onEnd = () => queueMicrotask(() => closed.emit("close"));
    await expect(
      probeWebSocketUpgrade(endpoint, "top:test", "secret-token", 100, fakeRequestFactory(closed)),
    ).resolves.toEqual({ status: null, kind: "connection-closed" });
  });

  it("destroys a request when the handshake deadline expires", async () => {
    const request = new FakeRequest();

    await expect(
      probeWebSocketUpgrade(endpoint, "top:test", "secret-token", 5, fakeRequestFactory(request)),
    ).resolves.toEqual({ status: null, kind: "timeout" });
    expect(request.destroyed).toBe(true);
  });
});
