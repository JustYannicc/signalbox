import { expect, it } from "vite-plus/test";

import { threadKindWithCapabilityFallback } from "./signalboxThreadKinds.ts";

it("uses the task default only when the server says it does not support thread kinds", () => {
  expect(threadKindWithCapabilityFallback(false, null)).toBe("task");
  expect(threadKindWithCapabilityFallback(true, null)).toBeNull();
  expect(threadKindWithCapabilityFallback(undefined, null)).toBeNull();
  expect(threadKindWithCapabilityFallback(false, "chat")).toBe("chat");
});
