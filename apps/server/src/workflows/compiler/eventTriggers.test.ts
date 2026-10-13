import { describe, expect, it } from "vite-plus/test";

import { compileWorkflow } from "./compileWorkflow.ts";

const file = (triggers: string) =>
  `export const meta = { name: "Events", triggers: ${triggers} } as const;
export default workflow(async (w, input) => {});`;

const diagnostics = (triggers: string) => {
  const result = compileWorkflow(file(triggers));
  return result.ok ? [] : result.diagnostics;
};

describe("event triggers", () => {
  it("accepts names, lists, wildcards, raw events and filters", () => {
    const result = compileWorkflow(
      file(`[
        { on: "turn.finished", where: { status: ["failed", "cancelled"] } },
        { on: ["message.sent", "thread.created"], from: "anyone", scope: "all" },
        { on: "automation.*", maxRunsPerMinute: 5 },
        { on: "orchestration.node.updated", includeAutomationThreads: true },
        { on: "*" },
      ]`),
    );
    expect(result.ok ? result.workflow.meta.triggers : result.diagnostics).toHaveLength(5);
  });

  it("suggests the closest names for a typo and lists the rest", () => {
    const [problem] = diagnostics(`[{ on: "turn.finish" }]`);
    expect(problem?.message).toContain('unknown event "turn.finish". Did you mean "turn.finished"');
    expect(problem?.hint).toContain("message.sent");
    expect(diagnostics(`[{ on: "nothing.*" }]`)[0]?.message).toContain('unknown event "nothing.*"');
  });

  it("rejects a trigger that is several kinds at once, or an empty on", () => {
    expect(diagnostics(`[{ cron: "0 * * * *", on: "turn.finished" }]`)[0]?.message).toContain(
      "not several at once",
    );
    expect(diagnostics(`[{ on: [] }]`)[0]?.message).toContain("takes an event name");
    expect(diagnostics(`[{ on: "turn.finished", scope: "everywhere" }]`)[0]?.message).toContain(
      "meta is invalid",
    );
  });
});
