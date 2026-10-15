import { describe, expect, it } from "vite-plus/test";

import { compileWorkflow } from "./compileWorkflow.ts";

const META = `export const meta = { name: "Test", triggers: [{ cron: "0 * * * *" }] } as const;\n`;

function compile(body: string, prelude = "") {
  return compileWorkflow(
    `${prelude}${META}export default workflow(async (w, input: any, trigger: any) => {\n${body}\n});\n`,
  );
}

function diagnostics(body: string, prelude = "") {
  const result = compile(body, prelude);
  return result.ok ? [] : result.diagnostics;
}

function expectCompiles(body: string, prelude = "") {
  expect(diagnostics(body, prelude)).toEqual([]);
}

const TIME_HINT = "Use trigger.at (when the run started, an ISO string) or a time a step returned.";
const RANDOM_HINT =
  "Draw it inside a function passed to w.run, or derive it from the input or a step's result.";

describe("determinism outside steps", () => {
  it.each([
    ["Date.now()", "const t = Date.now();", "Date.now() changes", TIME_HINT],
    ["new Date()", "const t = new Date();", "new Date() changes", TIME_HINT],
    ["new Date without parentheses", "const t = new Date;", "new Date() changes", TIME_HINT],
    ["Date() as a function", "const t = Date();", "Date() changes", TIME_HINT],
    ["performance.now()", "const t = performance.now();", "performance.now() changes", TIME_HINT],
    ["Math.random()", "const r = Math.random();", "Math.random() changes", RANDOM_HINT],
    [
      "crypto.randomUUID()",
      "const id = crypto.randomUUID();",
      "crypto.randomUUID() changes",
      RANDOM_HINT,
    ],
    [
      "crypto.getRandomValues()",
      "const bytes = crypto.getRandomValues(new Uint8Array(4));",
      "crypto.getRandomValues() changes",
      RANDOM_HINT,
    ],
  ])("rejects %s in the workflow", (_name, code, message, hint) => {
    const found = diagnostics(`${code}\nawait w.notify("N", "m");`);
    expect(found).toEqual([
      expect.objectContaining({
        message: `${message} every time the code replays.`,
        hint,
        line: 3,
      }),
    ]);
  });

  it("rejects it in callbacks, helpers and top-level code the workflow runs", () => {
    const prelude = `const STARTED = Date.now();\nfunction stamp() { return new Date().toISOString(); }\nasync function tell(w: any) { await w.notify("Tell", String(Math.random())); }\n`;
    const messages = diagnostics(
      `const ids = [1, 2].map(() => crypto.randomUUID());\nawait tell(w);\nawait w.notify("N", stamp() + ids + STARTED);`,
      prelude,
    ).map((diagnostic) => diagnostic.message);
    expect(messages).toEqual([
      "Date.now() changes every time the code replays.",
      "new Date() changes every time the code replays.",
      "Math.random() changes every time the code replays.",
      "crypto.randomUUID() changes every time the code replays.",
    ]);
  });

  it("allows it inside w.run functions and the helpers only they call", () => {
    expectCompiles(
      `const id = await w.run("Make an id", makeId);\nawait w.notify("N", id);`,
      `function now() { return Date.now(); }\nasync function makeId() { return \`\${now()}-\${Math.random()}-\${crypto.randomUUID()}\`; }\n`,
    );
  });

  it("allows dates built from values, Date.parse and trigger.at", () => {
    expectCompiles(`
      const started = new Date(trigger.at);
      const since = Date.parse(trigger.at) - 3_600_000;
      const day = new Date(Date.UTC(2026, 0, 1)).toISOString();
      await w.notify("N", \`\${started.getTime()} \${since} \${day}\`);
    `);
  });

  it("leaves a Date the file declares itself alone", () => {
    expectCompiles(`await w.notify("N", String(Date.now()));`, `const Date = { now: () => 1 };\n`);
  });
});

describe("sleep loops", () => {
  const SLEEP_LOOP = "A loop that sleeps is a reminder loop, and every pass is billed as a step.";

  it.each([
    ["for", `for (let i = 0; i < 3; i++) { await w.sleep("Wait", { hours: 1 }); }`],
    ["for…of", `for (const day of [1, 2]) { await w.sleep("Wait", { days: day }); }`],
    ["for…in", `for (const key in input) { await w.sleep("Wait", { hours: 1 }); }`],
    ["while", `while (input.again) { await w.sleep("Wait", { hours: 1 }); }`],
    ["do…while", `do { await w.sleep("Wait", { hours: 1 }); } while (input.again);`],
    [
      "w.repeat",
      `await w.repeat("Poll", { max: 5 }, async (w) => { await w.sleep("Wait", { hours: 1 }); });`,
    ],
    [
      "a helper called in a loop",
      `for (const day of [1, 2]) { await pause(w); }`,
      `async function pause(w: any) { await w.sleep("Wait", { days: 1 }); }\n`,
    ],
    [
      "w.each inside a loop",
      `while (input.again) { await w.each("Each", [1], async (w) => { await w.sleep("Wait", { hours: 1 }); }); }`,
    ],
  ])("rejects w.sleep in %s", (_name, body, prelude = "") => {
    expect(diagnostics(body, prelude)).toEqual([
      expect.objectContaining({
        message: SLEEP_LOOP,
        hint: "Use a schedule trigger (triggers: [{ cron: … }]) for repeats, or w.waitFor with a timeout to wait on something.",
      }),
    ]);
  });

  it("allows a single sleep, a sleep per w.each item, and w.waitFor with a timeout in w.repeat", () => {
    expectCompiles(`
      await w.sleep("Give them a day", { days: 1 });
      await w.each("Each reminder", input.people, async (w, person) => {
        await w.sleep("Stagger", { minutes: 1 });
        await w.notify("Remind", person);
      });
      await w.repeat("Watch", { max: 10 }, async (w) => {
        const news = await w.waitFor("Wait for news", { on: "pr.merged", timeout: { minutes: 30 } });
        if (news) return w.done(news);
      });
      for (const item of input.items) await w.waitFor("Wait for it", { on: "pr.merged", where: { number: item } });
    `);
  });
});
