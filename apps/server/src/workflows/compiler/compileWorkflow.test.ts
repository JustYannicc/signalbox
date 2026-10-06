import type { WorkflowNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { compileWorkflow, type CompiledWorkflow } from "./compileWorkflow.ts";

const META = `export const meta = { name: "Test", triggers: [{ cron: "0 * * * *" }] } as const;\n`;

function compile(body: string, prelude = "") {
  return compileWorkflow(
    `${prelude}${META}export default workflow(async (w, input: any) => {\n${body}\n});\n`,
  );
}

function compiled(body: string, prelude = ""): CompiledWorkflow {
  const result = compile(body, prelude);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics, null, 2));
  return result.workflow;
}

function errors(body: string, prelude = "") {
  const result = compile(body, prelude);
  if (result.ok) throw new Error("expected compile errors");
  return result.diagnostics.map((diagnostic) => diagnostic.message);
}

/** A compact outline of the graph: one line per node, indented by depth. */
function outline(nodes: ReadonlyArray<WorkflowNode>, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  const arms = (list: ReadonlyArray<{ label: string; body: ReadonlyArray<WorkflowNode> }>) =>
    list.flatMap((arm) => [`${pad}  [${arm.label}]`, ...outline(arm.body, depth + 2)]);
  return nodes.flatMap((node): string[] => {
    switch (node.type) {
      case "step":
        return [`${pad}${node.verb}${node.service ? `(${node.service})` : ""} ${node.label.text}`];
      case "end":
        return [`${pad}end ${node.exit}${node.done ? " done" : ""}`];
      case "loop":
        return [`${pad}${node.verb} ${node.label.text}`, ...outline(node.body, depth + 1)];
      case "branch":
        return [`${pad}? ${node.label.text}`, ...arms(node.arms)];
      case "parallel":
        return [`${pad}parallel ${node.label.text}`, ...arms(node.branches)];
      case "try":
        return [
          `${pad}try ${node.label.text}`,
          ...outline(node.body, depth + 1),
          `${pad}  [failed]`,
          ...outline(node.failure, depth + 2),
        ];
    }
  });
}

const SENTRY = `
import { workflow } from "@signalbox/automations";

export const meta = {
  name: "Fix new Sentry issues",
  description: "Every hour, triage new web errors and fix the clear ones.",
  triggers: [{ cron: "0 * * * *", timezone: "Europe/Zurich" }],
} as const;

interface Issue { id: string; title: string }

export default workflow(async (w) => {
  const issues: Issue[] = await w.call("Fetch new issues", "sentry.issues.list", { query: "is:unresolved firstSeen:-1h" });
  if (!w.when("Any new issues?", issues.length > 0)) return;
  await w.each("Each issue", issues, { concurrency: 2 }, async (w, issue) => {
    const kind = await w.judge("Real bug or noise?", { input: issue, outcomes: ["bug", "noise"] });
    if (kind === "noise") return;
    await w.agent(\`Fix \${issue.id}\`, { provider: "codex", prompt: \`Fix \${issue.title} and open a draft PR.\` });
  });
  await w.notify("Tell me what happened", \`Handled \${issues.length} issues\`);
});
`;

describe("compileWorkflow", () => {
  it("derives a top-to-bottom graph from the code", () => {
    const result = compileWorkflow(SENTRY);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const { meta, graph, script, runModule } = result.workflow;
    expect(meta.name).toBe("Fix new Sentry issues");
    expect(meta.triggers).toEqual([{ cron: "0 * * * *", timezone: "Europe/Zurich" }]);
    expect(outline(graph.nodes)).toEqual([
      "call(sentry) Fetch new issues",
      "? Any new issues?",
      "  [Yes]",
      "  [No]",
      "    end workflow",
      "each Each issue",
      "  judge Real bug or noise?",
      "  ? Real bug or noise?",
      "    [noise]",
      "      end callback",
      "    [bug]",
      "  agent(codex) Fix …",
      "notify Tell me what happened",
    ]);
    expect(graph.nodes[2]).toMatchObject({ type: "loop", concurrency: 2 });
    expect(graph.nodes[0]).toMatchObject({
      line: 13,
      detail: { operation: { literal: "sentry.issues.list" } },
    });
    expect(script).not.toContain("@signalbox/automations");
    expect(script).not.toContain("interface Issue");
    expect(runModule).toBeNull();
  });

  it("draws every option of an if / else if / else chain", () => {
    const { graph } = compiled(`
      // How urgent is it?
      if (input.level === "fatal") {
        await w.notify("Page me", "fatal");
      } else if (input.level === "error") {
        await w.agent("Investigate", { prompt: "look" });
      } else if (input.level === "warning") {
        // nothing yet
      } else {
        return;
      }
      await w.notify("Done", "ok");
    `);
    expect(outline(graph.nodes)).toEqual([
      "? How urgent is it?",
      '  [input.level === "fatal"]',
      "    notify Page me",
      '  [input.level === "error"]',
      "    agent Investigate",
      '  [input.level === "warning"]',
      "  [Otherwise]",
      "    end workflow",
      "notify Done",
    ]);
  });

  it("branches on a judge or ask answer with one arm per outcome", () => {
    const { graph } = compiled(`
      const kind = await w.judge("What is it?", { input, outcomes: ["bug", "question", "spam"] });
      if (kind === "bug") await w.agent("Fix it", { prompt: "fix" });
      else if (kind === "question") await w.agent("Answer it", { prompt: "answer" });
      const choice = await w.ask("Send the reply?", { options: ["send", "edit", "skip"] });
      switch (choice) {
        case "send":
          await w.call("Send it", "gmail.users.messages.send", {});
          break;
        case "edit":
          await w.agent("Rework it", { prompt: "edit" });
          break;
      }
    `);
    expect(outline(graph.nodes)).toEqual([
      "judge What is it?",
      "? What is it?",
      "  [bug]",
      "    agent Fix it",
      "  [question]",
      "    agent Answer it",
      "  [spam]",
      "ask Send the reply?",
      "? Send the reply?",
      "  [send]",
      "    call(gmail) Send it",
      "  [edit]",
      "    agent Rework it",
      "  [skip]",
    ]);
    const decision = graph.nodes[1];
    expect(decision).toMatchObject({
      type: "branch",
      source: "outcome",
      decidedBy: graph.nodes[0]!.id,
    });
  });

  it("labels a plain ask's outcomes with the answers the engine accepts", () => {
    const { graph } = compiled(`
      const ok = await w.ask("Ship it?", { timeout: { days: 1 }, onTimeout: "reject" });
      if (ok === "approve") await w.notify("Shipping", "go");
    `);
    expect(graph.nodes[0]).toMatchObject({ outcomes: ["approve", "reject"] });
    expect(outline(graph.nodes)).toEqual([
      "ask Ship it?",
      "? Ship it?",
      "  [approve]",
      "    notify Shipping",
      "  [reject]",
    ]);
    expect(errors(`const ok = await w.ask("Ship it?", { onTimeout: "rejected" });`)).toEqual([
      'onTimeout must be "fail" or one of the options: approve, reject.',
    ]);
  });

  it("branches on the choice of an ask with fields, and checks literal field specs", () => {
    const { graph } = compiled(`
      const draft = "hi";
      const answer = await w.ask("Send this reply?", {
        fields: { reply: { type: "longText", default: draft }, cc: { type: "boolean" } },
        options: ["send", "skip"],
      });
      if (answer.choice === "send") await w.notify("Sent", answer.values.reply);
      const { choice } = await w.ask("Which tone?", {
        fields: { note: { type: "text" } },
        options: ["warm", "short"],
      });
      switch (choice) {
        case "warm":
          await w.notify("Warm", "w");
          break;
        case "short":
          await w.notify("Short", "s");
          break;
      }
      await w.ask("Anything else?", { fields: { note: { type: "text", required: true } } });
    `);
    expect(outline(graph.nodes)).toEqual([
      "ask Send this reply?",
      "? Send this reply?",
      "  [send]",
      "    notify Sent",
      "  [skip]",
      "ask Which tone?",
      "? Which tone?",
      "  [warm]",
      "    notify Warm",
      "  [short]",
      "    notify Short",
      "ask Anything else?",
    ]);
    expect(graph.nodes.at(-1)).toMatchObject({ outcomes: ["submit"] });

    expect(
      errors(`
        const answer = await w.ask("Send?", {
          fields: { reply: { type: "essay" }, when: { type: "number", default: "soon" }, pick: { type: "choice" } },
          options: ["send", "skip"],
        });
      `),
    ).toEqual([
      'Field "reply" needs a type: text, longText, number, boolean, choice.',
      'Field "when"\'s default must be a number.',
      'Choice field "pick" needs options, a list of strings.',
    ]);
    expect(
      errors(`
        const answer = await w.ask("Send?", { fields: { reply: { type: "text" } }, options: ["send", "skip"] });
        if (answer === "send") await w.notify("Sent", "x");
      `),
    ).toEqual([
      '"answer" is { choice, values } because this ask has fields; compare answer.choice.',
    ]);
  });

  it("draws computed and multi-select asks without outcome arms", () => {
    const { graph } = compiled(`
      const dates = input.dates as { title: string }[];
      const picked = await w.ask("Which date?", { options: dates.map((d) => d.title) });
      if (picked === "Monday") await w.notify("Monday", "m");
      const many = await w.ask("Which ones?", { options: ["a", "b", "c"], multi: true });
    `);
    expect(graph.nodes[0]).toMatchObject({ outcomes: ["one of dates.map((d) => d.title)"] });
    expect(graph.nodes[1]).toMatchObject({ type: "branch", source: "condition" });
    expect(graph.nodes[2]).toMatchObject({ outcomes: ["a", "b", "c"] });
    expect(errors(`await w.ask("Pick", { multi: true });`)).toEqual([
      "multi needs options to pick from.",
    ]);
  });

  it("draws plain loops, try/catch, ternaries and Promise.all", () => {
    const { graph } = compiled(`
      const pages = await w.http("List pages", "https://api.notion.com/v1/search");
      for (const page of pages.results) {
        await w.agent(\`Summarize \${page.id}\`, { prompt: "summarize" });
      }
      let ready = false;
      // Retry until the export is ready
      while (!ready) {
        ready = (await w.http("Check the export", { url: \`https://api.example.com/exports/\${input.id}\` })).ready;
        if (!ready) await w.sleep("Wait a minute", { minutes: 1 });
      }
      try {
        await w.call("Post to Slack", "slack.chat.postMessage", {});
      } catch {
        await w.notify("Slack failed", "posting failed");
      }
      const summary = input.short ? await w.llm("Short summary", { prompt: "short" }) : null;
      await Promise.all([w.remember("Save cursor", "cursor", 1), w.notify("Ping", "done")]);
    `);
    expect(outline(graph.nodes)).toEqual([
      "http(api.notion.com) List pages",
      "for For each page in pages.results",
      "  agent Summarize …",
      "while Retry until the export is ready",
      "  http(api.example.com) Check the export",
      "  ? !ready",
      "    [Yes]",
      "      sleep Wait a minute",
      "    [No]",
      "try If something fails",
      "  call(slack) Post to Slack",
      "  [failed]",
      "    notify Slack failed",
      "? input.short",
      "  [Yes]",
      "    llm Short summary",
      "  [No]",
      "parallel At the same time",
      "  [Save cursor]",
      "    remember Save cursor",
      "  [Ping]",
      "    notify Ping",
    ]);
  });

  it("lets plain code run between steps without showing it", () => {
    const { graph } = compiled(`
      const items = [3, 1, 2].sort();
      let total = 0;
      for (const item of items) total += item;
      if (total > 5) total = 5;
      const stamp = new Date().toISOString() + Math.random();
      await w.notify("Report", \`Total \${total} \${stamp}\`);
    `);
    expect(outline(graph.nodes)).toEqual(["notify Report"]);
  });

  it("splits w.run functions and their packages out of the sandboxed script", () => {
    const result = compileWorkflow(`import { PDFDocument } from "pdf-lib";
${META}
async function pageCount(url: string) {
  const bytes = await fetch(url).then((response) => response.arrayBuffer());
  return (await PDFDocument.load(bytes)).getPageCount();
}

export default workflow(async (w, input: { url: string }) => {
  const pages = await w.run("Count the pages", pageCount, input.url);
  await w.notify("Pages", \`\${pages} pages\`);
});
`);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const { graph, script, runModule } = result.workflow;
    expect(graph.nodes[0]).toMatchObject({
      verb: "run",
      detail: { function: { literal: "pageCount" } },
    });
    expect(script).not.toContain("pdf-lib");
    expect(script).not.toContain("PDFDocument");
    expect(script).toContain('w.run("s1", "Count the pages", "pageCount", input.url)');
    expect(runModule).toContain('import { PDFDocument } from "pdf-lib"');
    expect(runModule).toContain("export { pageCount };");
    expect(runModule).not.toContain("export default workflow");
  });

  it("lets helpers that only w.run functions use share packages, outside the sandbox", () => {
    const result = compileWorkflow(`import { execFileSync } from "node:child_process";
export const meta = { name: "Shared helper" } as const;
const gh = (args: string[]) => execFileSync("gh", args, { encoding: "utf8" });
const REPO = "acme/app";
function issues() { return JSON.parse(gh(["issue", "list", "-R", REPO, "--json", "number"])); }
function pulls() { return JSON.parse(gh(["pr", "list", "-R", REPO, "--json", "number"])); }
export default workflow(async (w) => {
  const open = await w.run("List issues", issues);
  const prs = await w.run("List pull requests", pulls);
  await w.notify("Counts", \`\${REPO}: \${open.length} issues, \${prs.length} pull requests\`);
});
`);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const { script, runModule } = result.workflow;
    expect(script).not.toContain("execFileSync");
    expect(script).toContain('const REPO = "acme/app"');
    expect(runModule).toContain("const gh = (args) =>");
    expect(runModule).toContain("export { issues, pulls };");
  });

  it("draws try/finally without a catch as plain steps", () => {
    const result = compiled(`try {
    await w.notify("First", "a");
  } finally {
    await w.notify("Always", "b");
  }`);
    expect(outline(result.graph.nodes)).toEqual(["notify First", "notify Always"]);
  });

  it("inserts a helper's decision marks once, however often it's called", () => {
    const result = compiled(
      `await fix(w, "a");
  await fix(w, "b");
  await fix(w, "c");`,
      `async function fix(w, problem: string) {
  if (problem === "a") {
    return await w.agent("Fix it here", { prompt: problem });
  }
  return await w.agent("Fix it there", { prompt: problem });
}
`,
    );
    expect(result.script.match(/\$arm\("s\d+", 1\)/g)).toHaveLength(1);
    expect(outline(result.graph.nodes).filter((line) => line.includes("Fix it here"))).toHaveLength(
      3,
    );
  });

  it.each([
    [
      "steps in an array callback",
      `await Promise.all([1].map(async () => w.agent("A", { prompt: "a" })));`,
      "Steps can't run inside a callback",
    ],
    [
      "the receiver passed around",
      `const v = w; await v.agent("A", { prompt: "a" });`,
      "can only call steps",
    ],
    [
      "a step on the outer receiver",
      `await w.each("E", [1], async (inner, x) => { await w.agent("A", { prompt: "a" }); });`,
      "Use inner, the receiver this callback gets",
    ],
    [
      "a computed label",
      `const name = "A"; await w.agent(name, { prompt: "a" });`,
      "The first argument must be a label",
    ],
    [
      "fetch in automation code",
      `await fetch("https://example.com");`,
      "fetch isn't available in automation code",
    ],
    [
      "Intl in automation code",
      `await w.notify("N", new Intl.DateTimeFormat("en").format(new Date()));`,
      "Intl isn't available in automation code",
    ],
    [
      "URL in automation code",
      `const host = new URL(input.link).host; await w.notify("N", host);`,
      "URL isn't available in automation code",
    ],
    [
      "Buffer in automation code",
      `await w.notify("N", Buffer.from("hi").toString("base64"));`,
      "Buffer isn't available in automation code",
    ],
    ["an unknown verb", `await w.email("E", {});`, "w.email isn't a step"],
    [
      "an outcome typo",
      `const k = await w.judge("J", { input, outcomes: ["a", "b"] }); if (k === "c") await w.notify("N", "m");`,
      `"c" isn't one of the possible answers`,
    ],
    [
      "a repeat without max",
      `await w.repeat("R", {}, async (w) => w.done());`,
      "w.repeat needs a max",
    ],
    ["a judge without outcomes", `await w.judge("J", { input });`, "w.judge needs outcomes"],
    [
      "an operation that isn't a literal",
      `const op = "a.b"; await w.call("C", op, {});`,
      "w.call needs the operation",
    ],
    [
      "w.run with an inline function",
      `await w.run("R", async () => 1);`,
      "w.run needs a function declared at the top level",
    ],
  ])("rejects %s", (_name, body, message) => {
    expect(errors(body).some((error) => error.includes(message))).toBe(true);
  });

  it("hints at a replacement for globals the sandbox lacks", () => {
    const result = compile(`await w.notify("N", String(performance.now()));`);
    expect(!result.ok && result.diagnostics[0]).toMatchObject({
      message: "performance isn't available in automation code.",
      hint: "Use Date.now().",
    });
  });

  it("allows the web globals the sandbox provides", () => {
    compiled(`
      console.log(structuredClone({ a: 1 }), new TextEncoder().encode("x"), atob(btoa("x")));
      await w.notify("N", new URLSearchParams({ q: "x" }).toString());
    `);
  });

  it("rejects packages used outside w.run", () => {
    const messages = errors(
      `await w.notify("N", dayjs().format());`,
      `import dayjs from "dayjs";\n`,
    );
    expect(messages.some((message) => message.includes("dayjs is an imported package"))).toBe(true);
  });

  it("rejects a missing or computed meta", () => {
    const result = compileWorkflow(
      `const name = "x";\nexport const meta = { name };\nexport default workflow(async (w) => {});`,
    );
    expect(
      !result.ok &&
        result.diagnostics.some((diagnostic) =>
          diagnostic.message.includes("meta has to be a plain literal"),
        ),
    ).toBe(true);
    const bare = compileWorkflow(`export default workflow(async (w) => {});`);
    expect(
      !bare.ok &&
        bare.diagnostics.some((diagnostic) =>
          diagnostic.message.includes("Export the automation's meta"),
        ),
    ).toBe(true);
  });

  it("rejects an invalid cron", () => {
    const result = compileWorkflow(
      `export const meta = { name: "x", triggers: [{ cron: "every day" }] };\nexport default workflow(async (w) => {});`,
    );
    expect(!result.ok && result.diagnostics[0]?.message).toContain("invalid cron");
  });

  it("points diagnostics at the offending line", () => {
    const result = compile(`\n\nawait w.agent(42, { prompt: "a" });`);
    expect(!result.ok && result.diagnostics[0]).toMatchObject({ line: 5 });
  });
});
