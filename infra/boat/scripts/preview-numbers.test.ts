// @effect-diagnostics nodeBuiltinImport:off - Exercises the standalone CI script.
import { describe, expect, it } from "vite-plus/test";

import { previewNumbers } from "./preview-numbers.mjs";

describe("Boat preview cleanup", () => {
  it("finds leftover previews without selecting production or another application's resources", () => {
    expect(
      previewNumbers([
        "signalbox-cloud-runner",
        "signalbox-cloud-pr-99-runner",
        "signalbox-cloud-pr-7-runner",
        "signalbox-cloud-pr-7-runner",
        "signalbox-cloud-pr-0-runner",
        "signalbox-cloud-pr-01-runner",
        "signalbox-cloud-pr-7-runner-backup",
        "other-cloud-pr-8-runner",
      ]),
    ).toEqual([7, 99]);
  });
});
