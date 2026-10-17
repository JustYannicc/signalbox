import { describe, expect, it } from "vite-plus/test";

import { oneEnvironmentCopy } from "./oneEnvironmentCopy";

describe("connection copy with only Signalbox Cloud", () => {
  it("calls the cloud Signalbox wherever its environment label shows", () => {
    expect(oneEnvironmentCopy("Signalbox Cloud is reconnecting")).toBe("Signalbox is reconnecting");
    expect(oneEnvironmentCopy("Reconnect Signalbox Cloud (PR #685) to change its settings.")).toBe(
      "Reconnect Signalbox to change its settings.",
    );
  });

  it("rewords whole upstream strings that name the environment", () => {
    expect(oneEnvironmentCopy("The environment is not connected.")).toBe(
      "Signalbox isn't connected. Try again in a moment.",
    );
    expect(oneEnvironmentCopy("Environment disconnected")).toBe("Not connected");
  });

  it("rewords phrases inside composed text", () => {
    expect(oneEnvironmentCopy("Reconnect to the environment and try again.")).toBe(
      "Reconnect to Signalbox and try again.",
    );
  });

  it("leaves text it doesn't know as upstream wrote it", () => {
    expect(oneEnvironmentCopy("Page unavailable")).toBe("Page unavailable");
  });
});
