import { describe, expect, it } from "vite-plus/test";

import { resolveCapabilitiesKnown, resolveEnvironmentUiState } from "./environmentCapabilities";

const cloud = { otherEnvironments: false };

describe("resolveEnvironmentUiState", () => {
  it("hides environments on Signalbox Cloud once it reports", () => {
    expect(resolveEnvironmentUiState({ gateway: false, hasPrimary: true, reported: [cloud] })).toBe(
      "hidden",
    );
  });

  it("waits, hidden, while the serving environment's config loads", () => {
    expect(resolveEnvironmentUiState({ gateway: false, hasPrimary: true, reported: [] })).toBe(
      "unknown",
    );
  });

  it("keeps everything for self-hosted servers and clients with no environment of their own", () => {
    expect(resolveEnvironmentUiState({ gateway: false, hasPrimary: true, reported: [{}] })).toBe(
      "shown",
    );
    expect(resolveEnvironmentUiState({ gateway: false, hasPrimary: false, reported: [] })).toBe(
      "shown",
    );
  });

  it("hides them on the desktop gateway before anything connects", () => {
    expect(resolveEnvironmentUiState({ gateway: true, hasPrimary: false, reported: [] })).toBe(
      "hidden",
    );
  });
});

describe("resolveCapabilitiesKnown", () => {
  it("waits on the desktop gateway until the cloud reports, even though environments are hidden", () => {
    expect(resolveCapabilitiesKnown({ gateway: true, hasPrimary: false, reportedCount: 0 })).toBe(
      false,
    );
    expect(resolveCapabilitiesKnown({ gateway: true, hasPrimary: false, reportedCount: 1 })).toBe(
      true,
    );
  });

  it("waits for the serving environment and not for a client with none", () => {
    expect(resolveCapabilitiesKnown({ gateway: false, hasPrimary: true, reportedCount: 0 })).toBe(
      false,
    );
    expect(resolveCapabilitiesKnown({ gateway: false, hasPrimary: false, reportedCount: 0 })).toBe(
      true,
    );
  });
});
