import { describe, expect, it } from "vite-plus/test";

import { waitListens } from "@signalbox/automations/events/runWaits";
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
    expect(
      result.ok ? waitListens(result.workflow.graph.nodes).patterns : result.diagnostics,
    ).toEqual(["pr.merged", "pr.checks.*"]);
  });

  it("accepts a computed event, checked when the step starts", () => {
    expect(messages(`await w.waitFor("Wait", { on: input.event });`)).toEqual([]);
  });

  it("rejects unknown events, with the closest names", () => {
    expect(messages(`await w.waitFor("Wait", { on: "pr.merge" });`)[0]).toContain(
      'w.waitFor waits for an unknown event "pr.merge". Did you mean "pr.merged"',
    );
    expect(messages(`await w.waitFor("Wait", { timeout: { days: 1 } });`)[0]).toContain(
      "w.waitFor needs the event to wait for",
    );
  });
});

describe("run inbox cursors", () => {
  it("captures a cursor and accepts it as a wait boundary", () => {
    const result = compile(`
const after = await w.eventCursor("Before the pull request read");
const news = await w.waitFor("Wait for fresh pull request events", {
  on: ["pr.checks.failed", "pr.conflicted", "pr.merged", "pr.closed"],
  after,
});
return news;`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.graph.nodes.map((node) => node.type === "step" && node.verb)).toEqual([
      "eventCursor",
      "waitFor",
    ]);
    expect(result.workflow.script).toContain('w.eventCursor("s1", "Before the pull request read")');
  });

  it("rejects a cursor on named events that don't use the run inbox", () => {
    expect(
      messages(`
const after = await w.eventCursor("Capture boundary");
await w.waitFor("Wait for the reply", { event: "reply", after });`)[0],
    ).toContain("w.waitFor `after` only works with `on` or `watch` events");
  });

  it("requires the wait's event pattern to be known before the cursor capture", () => {
    expect(
      messages(`
const after = await w.eventCursor("Capture boundary");
await w.waitFor("Wait for the event", { on: input.event, after });`)[0],
    ).toContain("w.waitFor `after` needs a literal `on`");
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
