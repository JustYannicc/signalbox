import { describe, expect, it } from "vite-plus/test";

import { trackedEnvironment, registeredPorts } from "./agent-process-environment.ts";

describe("tracked process environment", () => {
  it("keeps the caller's Node options and propagates the same owner to descendants", () => {
    const environment = trackedEnvironment({
      environment: { NODE_OPTIONS: "--max-old-space-size=2048" },
      worktreePath: "/tmp/a checkout",
      sessionId: "session-1",
      ownerPid: 123,
      preloadUrl: "file:///tmp/a%20checkout/scripts/agent-process-preload.ts",
    });
    expect(environment.NODE_OPTIONS).toContain("--max-old-space-size=2048");
    expect(environment.NODE_OPTIONS).toContain("--import=");
    expect(environment.SIGNALBOX_PROCESS_WORKTREE).toBe("/tmp/a checkout");
    expect(environment.SIGNALBOX_PROCESS_SESSION_ID).toBe("session-1");
    expect(environment.SIGNALBOX_PROCESS_OWNER_PID).toBe("123");
  });

  it("records resolved dev ports and ignores malformed values", () => {
    expect(
      registeredPorts({ T3CODE_PORT: "13773", PORT: "5733", SIGNALBOX_PORT: "13773" }),
    ).toEqual([13773, 5733]);
    expect(registeredPorts({ PORT: "0", T3CODE_PORT: "NaN", SIGNALBOX_PORT: "65536" })).toEqual([]);
  });
});
