import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { automationRoute, detailText } from "./automationFormat";

describe("automationRoute", () => {
  const target = { environmentId: "env" as EnvironmentId, automationId: "a1" };

  it("opens a run as its chat and leaves the default view out of the URL", () => {
    expect(automationRoute(target, "r1").search).toEqual({ run: "r1" });
    expect(automationRoute(target, "r1", "run").search).toEqual({ run: "r1" });
    expect(automationRoute(target, null, "diagram").search).toEqual({});
  });

  it("names any other view", () => {
    expect(automationRoute(target, "r1", "diagram").search).toEqual({ run: "r1", view: "diagram" });
    expect(automationRoute(target, null, "code").search).toEqual({ view: "code" });
  });
});

describe("detailText", () => {
  it("shows literals as values and expressions as code", () => {
    expect(
      detailText({ model: { literal: "gpt" }, prompt: { expression: "`Fix ${issue.id}`" } }),
    ).toBe("model: gpt\nprompt: `Fix ${issue.id}`");
    expect(detailText({})).toBeNull();
  });
});
