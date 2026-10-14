import { describe, expect, it } from "vite-plus/test";

import { resolveAddProjectAvailability } from "./signalboxAddProject.ts";

describe("resolveAddProjectAvailability", () => {
  it("is ready once any environment is connected", () => {
    expect(
      resolveAddProjectAvailability({ catalogReady: true, phases: ["error", "connected"] }),
    ).toBe("ready");
  });

  it("waits while the catalog loads or an environment is connecting", () => {
    expect(resolveAddProjectAvailability({ catalogReady: false, phases: [] })).toBe("connecting");
    expect(resolveAddProjectAvailability({ catalogReady: true, phases: ["connecting"] })).toBe(
      "connecting",
    );
    expect(
      resolveAddProjectAvailability({ catalogReady: true, phases: ["offline", "reconnecting"] }),
    ).toBe("connecting");
  });

  it("asks for a connection only when nothing is on its way", () => {
    expect(resolveAddProjectAvailability({ catalogReady: true, phases: [] })).toBe("unavailable");
    expect(
      resolveAddProjectAvailability({ catalogReady: true, phases: ["offline", "error"] }),
    ).toBe("unavailable");
  });
});
