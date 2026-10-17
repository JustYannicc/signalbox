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

test("shutdown cancellation tolerates the native server's completed watch-update status", () => {
  const captured = [
    "failed to register file watcher: context canceled",
    "Error publishing diagnostics: context canceled",
    "Updated watches in 22.870353ms",
    "context canceled",
    "Command exited with non-zero status 1",
    "LSP_PEAK_RSS_KIB=319324",
  ].join("\n");
  expect(isShutdownCancellation(captured)).toBe(true);
  expect(isShutdownCancellation(captured.replaceAll("\n", "\r\n"))).toBe(true);
  expect(isShutdownCancellation(`context canceled\nUpdated watches in 3µs\n`)).toBe(true);
});

test("watch status alone never establishes cancellation", () => {
  expect(isShutdownCancellation("Updated watches in 22.870353ms\n")).toBe(false);
  expect(
    isShutdownCancellation(
      "Updated watches in 22.870353ms\nCommand exited with non-zero status 1\nLSP_PEAK_RSS_KIB=319324\n",
    ),
  ).toBe(false);
});

test.each([
  "Updated watches in failed",
  "Updated watches in 22.870353ms: unrelated failure",
  "Updated watches in 22.870353ms\nfatal: unrelated failure",
  "Updated watches in 22.870353ms\npanic: runtime error: invalid memory address",
  "fatal: unrelated failure\nUpdated watches in 22.870353ms",
])("shutdown rejects cancellation accompanied by a real error: %s", (stderr) => {
  expect(isShutdownCancellation(`${stderr}\ncontext canceled\n`)).toBe(false);
});
