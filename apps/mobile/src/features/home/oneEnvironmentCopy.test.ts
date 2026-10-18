import { describe, expect, it } from "@effect/vitest";

import { oneEnvironmentCopy } from "./oneEnvironmentCopy";

describe("environment copy with only Signalbox Cloud", () => {
  it("rewords whole upstream strings", () => {
    expect(oneEnvironmentCopy("Connect an environment")).toBe("No pull requests");
    expect(oneEnvironmentCopy("Try another search or environment.")).toBe("Try another search.");
    expect(oneEnvironmentCopy("Connect an environment to see its automations.")).toBe(
      "Automations aren't available in Signalbox yet.",
    );
  });

  it("rewords phrases inside templated notices", () => {
    expect(oneEnvironmentCopy("The terminal will load as soon as the environment is ready.")).toBe(
      "The terminal will load as soon as Signalbox is ready.",
    );
    expect(oneEnvironmentCopy("Reconnect this environment to load the conversation.")).toBe(
      "Reconnect to Signalbox to load the conversation.",
    );
  });

  it("rewords relay errors and keeps the cause they carry", () => {
    expect(oneEnvironmentCopy("Could not configure environment relay access: 403 Forbidden")).toBe(
      "Could not set up activity updates: 403 Forbidden",
    );
  });

  it("calls the cloud Signalbox wherever its environment label shows", () => {
    expect(oneEnvironmentCopy("Reconnecting to Signalbox Cloud...")).toBe(
      "Reconnecting to Signalbox...",
    );
    expect(oneEnvironmentCopy("Signalbox Cloud (PR #685) is disconnected")).toBe(
      "Signalbox is disconnected",
    );
  });

  it("rewords connection errors that name the environment", () => {
    expect(oneEnvironmentCopy("The environment credential is invalid.")).toBe(
      "Your Signalbox sign-in expired. Sign in again.",
    );
    expect(oneEnvironmentCopy("Could not synchronize environment data.")).toBe(
      "Couldn't sync your threads.",
    );
  });

  it("rewords the relay's hinted invalid-credential error", () => {
    expect(
      oneEnvironmentCopy("The environment credential is invalid. Check this device's clock."),
    ).toBe("Signalbox couldn't verify your sign-in. Check this device's clock.");
    expect(
      oneEnvironmentCopy("Your cloud sign-in changed. Sign in again to authorize the environment."),
    ).toBe("Your sign-in changed. Sign in again.");
  });

  it("says a feature the cloud lacks isn't available yet", () => {
    expect(oneEnvironmentCopy("This server does not support file attachments.")).toBe(
      "File attachments aren't available in Signalbox yet.",
    );
    expect(
      oneEnvironmentCopy(
        "This environment's server does not support reordering these threads. Update the server to arrange them.",
      ),
    ).toBe("Moving threads isn't available in Signalbox yet.");
    expect(
      oneEnvironmentCopy("'report.pdf' was skipped because this server does not support files."),
    ).toBe("'report.pdf' was skipped because Signalbox doesn't support files yet.");
  });

  it("leaves text it doesn't know as upstream wrote it", () => {
    expect(oneEnvironmentCopy("Couldn't load pull requests")).toBe("Couldn't load pull requests");
  });
});
