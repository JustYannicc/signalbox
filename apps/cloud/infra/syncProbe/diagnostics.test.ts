import { describe, expect, it } from "@effect/vitest";

import { formatConnectionDiagnostics, safeSocketErrorKind } from "./diagnostics.ts";

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
});
