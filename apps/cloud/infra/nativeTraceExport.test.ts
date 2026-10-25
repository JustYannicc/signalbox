import { describe, expect, it } from "@effect/vitest";

import { cloudStage } from "./stage.ts";
import { traceExportUrl } from "./nativeTraceExport.ts";

describe("traceExportUrl", () => {
  it("keeps production on the trace receiver domain", () => {
    expect(traceExportUrl(cloudStage("production"), "https://traces-app.signalbox.run")).toBe(
      "https://traces-app.signalbox.run/v1/traces",
    );
  });

  it("routes previews to the app origin even when the receiver has no domain URL", () => {
    expect(traceExportUrl(cloudStage("pr-298"), undefined)).toBe(
      "https://preview-298.signalbox.run/v1/traces",
    );
  });
});
