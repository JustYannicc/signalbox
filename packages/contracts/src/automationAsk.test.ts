import { describe, expect, it } from "vite-plus/test";

import { parseAutomationAsk } from "./index.ts";

describe("automation ask importance", () => {
  it("keeps existing asks interrupting by default and allows low priority", () => {
    expect(parseAutomationAsk({}).ask.importance).toBe("high");
    expect(parseAutomationAsk({ importance: "low" }).ask.importance).toBe("low");
  });

  it("rejects unsupported importance values", () => {
    expect(parseAutomationAsk({ importance: "normal" }).problems).toContain(
      'importance must be "low" or "high".',
    );
  });
});
