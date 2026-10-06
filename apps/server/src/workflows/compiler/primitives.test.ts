import { describe, expect, it } from "vite-plus/test";

import { waitPatterns } from "../events/runWaits.ts";
import { compileWorkflow } from "./compileWorkflow.ts";

const compile = (body: string) =>
  compileWorkflow(
    `export const meta = { name: "Test" } as const;\nexport default workflow(async (w, input: any) => {\n${body}\n});\n`,
  );
const messages = (body: string) => {
  const result = compile(body);
  return result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.message);
};

describe("w.waitFor({ on })", () => {
  it("takes literal catalog events and dynamic where values", () => {
    const result = compile(`
const news = await w.waitFor("Wait for news", { on: ["pr.merged", "pr.checks.*"], where: { number: input.number }, timeout: { minutes: 30 } });
const reply = await w.waitFor("Wait for the reply", { event: \`reply:\${input.id}\` });
return [news, reply];`);
    expect(result.ok ? waitPatterns(result.workflow.graph.nodes) : result.diagnostics).toEqual([
      "pr.merged",
      "pr.checks.*",
    ]);
  });

  it("rejects computed or unknown events, with the closest names", () => {
    expect(messages(`await w.waitFor("Wait", { on: input.event });`)[0]).toContain(
      "`on` must be a literal",
    );
    expect(messages(`await w.waitFor("Wait", { on: "pr.merge" });`)[0]).toContain(
      'w.waitFor waits for an unknown event "pr.merge". Did you mean "pr.merged"',
    );
    expect(messages(`await w.waitFor("Wait", { timeout: { days: 1 } });`)[0]).toContain(
      "w.waitFor needs the event to wait for",
    );
  });
});

describe("w.restart", () => {
  it("ends the workflow and shows in the diagram", () => {
    const result = compile(`
await w.sleep("Pause", { minutes: 1 });
if (input.pass < 3) return w.restart({ pass: input.pass + 1 });
return "done";`);
    expect(result.ok && JSON.stringify(result.workflow.graph)).toContain('"restart":true');
  });

  it("is only returned from the workflow itself", () => {
    expect(
      messages(`await w.repeat("Loop", { max: 2 }, async (w) => { return w.restart(input); });`)[0],
    ).toContain("return it from the workflow itself");
    expect(messages(`w.restart(input);`)[0]).toContain("Return w.restart() from the workflow");
  });
});

describe("signalbox.* calls", () => {
  it("compile like other calls, with Signalbox as the service", () => {
    const result = compile(
      `await w.call("Wake the agent", "signalbox.t3_thread_send", { threadId: input.threadId, message: "Go" });`,
    );
    expect(result.ok && result.workflow.graph.nodes[0]).toMatchObject({
      verb: "call",
      service: "signalbox",
    });
  });
});
