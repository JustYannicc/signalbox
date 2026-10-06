import { describe, expect, it } from "vite-plus/test";

import { compactJson, hiddenPassesLabel } from "./labels.ts";
import { morePressingStatus, runDisplayStatus, stepDisplayStatus } from "./status.ts";

describe("display status", () => {
  it("only says a run or step needs you when it waits on an answer", () => {
    expect(runDisplayStatus({ status: "running", waitingOnYou: true })).toBe("needsYou");
    expect(runDisplayStatus({ status: "running", waitingOnYou: false })).toBe("working");
    expect(runDisplayStatus({ status: "succeeded", waitingOnYou: false })).toBe("done");
    expect(runDisplayStatus({ status: "failed", waitingOnYou: true })).toBe("failed");
    expect(stepDisplayStatus({ status: "waiting", verb: "ask" })).toBe("needsYou");
    expect(stepDisplayStatus({ status: "waiting", verb: "sleep" })).toBe("waiting");
  });

  it("ranks waiting over failed over running", () => {
    expect(morePressingStatus("running", "failed")).toBe("failed");
    expect(morePressingStatus("failed", "waiting")).toBe("waiting");
    expect(morePressingStatus("succeeded", "running")).toBe("running");
  });
});

describe("labels", () => {
  it("prints values compactly and cuts long ones", () => {
    expect(compactJson({ ok: true })).toBe('{\n  "ok": true\n}');
    expect(compactJson("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
    expect(compactJson(undefined)).toBe("undefined");
  });

  it("counts hidden passes", () => {
    expect(hiddenPassesLabel(1)).toBe("1 earlier pass not shown");
    expect(hiddenPassesLabel(3)).toBe("3 earlier passes not shown");
  });
});
