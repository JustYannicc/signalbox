import { expect, test } from "vite-plus/test";
import { isShutdownCancellation } from "./lsp-smoke-client.ts";

test("acknowledged shutdown accepts only cancellation messages in its stderr tail", () => {
  expect(isShutdownCancellation("context canceled\n")).toBe(true);
  expect(isShutdownCancellation("context canceled\nfatal: unrelated failure\n")).toBe(false);
  expect(isShutdownCancellation("fatal: unrelated failure\ncontext canceled\n")).toBe(false);
  expect(isShutdownCancellation("")).toBe(false);
});

test("time measurements cannot masquerade as native shutdown errors", () => {
  expect(
    isShutdownCancellation(
      "context canceled\n  0.2 real 0.4 user 0.1 sys\n  123 maximum resident set size\n",
    ),
  ).toBe(true);
  expect(
    isShutdownCancellation(
      "context canceled\nCommand exited with non-zero status 1\nLSP_PEAK_RSS_KIB=123\n",
    ),
  ).toBe(true);
  expect(isShutdownCancellation("LSP_PEAK_RSS_KIB=123\n")).toBe(false);
});
