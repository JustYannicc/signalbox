import { describe, expect, it } from "vite-plus/test";

import { isPreviewPortAllowed } from "@t3tools/shared/previewPorts";

describe("preview ports", () => {
  it("rejects invalid TCP ports and Signalbox control-plane ports", () => {
    for (const port of [0, -1, 65_536, 5173.5, Number.NaN, 8787, 8788, 8790]) {
      expect(isPreviewPortAllowed(port)).toBe(false);
    }
  });

  it("allows ordinary dev-server ports, including 3000", () => {
    for (const port of [1, 3000, 4173, 5173, 65_535]) {
      expect(isPreviewPortAllowed(port)).toBe(true);
    }
  });
});
