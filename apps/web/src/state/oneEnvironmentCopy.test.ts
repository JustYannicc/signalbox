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

  it("says a feature the cloud lacks isn't available yet", () => {
    expect(oneEnvironmentCopy("Update your Signalbox servers to browse pull requests.")).toBe(
      "Pull requests aren't available in Signalbox yet.",
    );
    expect(oneEnvironmentCopy("Open provider setup to install Codex on this environment.")).toBe(
      "Open provider setup to install Codex.",
    );
  });

  it("says what the person can't do instead of naming the connection", () => {
    expect(oneEnvironmentCopy("This connection cannot change the thread's branch.")).toBe(
      "You can't change the thread's branch.",
    );
  });

  it("rewords sign-in errors, including the relay's hinted variant", () => {
    expect(oneEnvironmentCopy("The environment credential is invalid.")).toBe(
      "Your Signalbox sign-in expired. Sign in again.",
    );
    expect(
      oneEnvironmentCopy("The environment credential is invalid. Check this device's clock."),
    ).toBe("Signalbox couldn't verify your sign-in. Check this device's clock.");
    expect(
      oneEnvironmentCopy("Your cloud sign-in changed. Sign in again to authorize the environment."),
    ).toBe("Your sign-in changed. Sign in again.");
  });

  it("leaves text it doesn't know as upstream wrote it", () => {
    expect(oneEnvironmentCopy("Page unavailable")).toBe("Page unavailable");
  });
});
