// @effect-diagnostics nodeBuiltinImport:off - compiles the Worker's wasm file the way workerd gets it.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";

import { describe, expect, it } from "@effect/vitest";

import type { JournalResult, ReplayInput } from "@signalbox/automations/sandbox/replayWorkflow";
import { makeCloudReplay } from "./sandbox.ts";

// The Worker imports this file as a CompiledWasm module (quickJs.ts); Node compiles the same bytes.
const wasmPath = NodeModule.createRequire(import.meta.url).resolve(
  "@jitl/quickjs-wasmfile-release-sync/wasm",
);
const replayWorkflow = makeCloudReplay(new WebAssembly.Module(NodeFS.readFileSync(wasmPath)));

const STARTED_AT = Date.UTC(2026, 9, 5, 9, 0);

/** What the compiler emits for an automation: steps carry their key first. */
const compiled = (body: string) =>
  `export const meta = { name: "Test" };\nexport default workflow(async (w, input) => {\n${body}\n});\n`;

const replay = (
  script: string,
  journal: ReadonlyMap<string, JournalResult>,
  extra: Partial<ReplayInput> = {},
) =>
  replayWorkflow({
    script,
    input: {},
    startedAt: STARTED_AT,
    seed: "run-1",
    result: ({ key }) => journal.get(key),
    ...extra,
  });

const RAN_TOO_LONG = "The automation's code ran too long between steps.";

describe("cloud automation sandbox", () => {
  it("suspends on a pending step and completes from the journal", async () => {
    const script = compiled(
      `const found = await w.agent("s1", "Fetch", { prompt: "list" });\nreturn { found };`,
    );
    const first = await replay(script, new Map());
    expect(first).toMatchObject({
      type: "suspended",
      requests: [{ key: "s1", verb: "agent", label: "Fetch", args: [{ prompt: "list" }] }],
    });

    const journal = new Map([["s1", { ok: true, value: ["a"], at: STARTED_AT + 60_000 } as const]]);
    expect(await replay(script, journal)).toMatchObject({
      type: "completed",
      output: { found: ["a"] },
    });
  });

  it("stops runaway code between steps, and the next replay gets a fresh budget", async () => {
    const runaway = await replay(compiled(`while (true) {}`), new Map(), { timeLimitMs: 100 });
    expect(runaway).toMatchObject({ type: "failed", error: RAN_TOO_LONG });

    expect(await replay(compiled(`return 1;`), new Map(), { timeLimitMs: 100 })).toMatchObject({
      type: "completed",
      output: 1,
    });
  });

  it("lets code that stays inside its budget run to the end", async () => {
    // A million passes is about 100 interrupt calls; 100 ms of budget allows 500.
    const outcome = await replay(
      compiled(`let n = 0; for (let i = 0; i < 1000000; i++) n += 1; return n;`),
      new Map(),
      { timeLimitMs: 100 },
    );
    expect(outcome).toMatchObject({ type: "completed", output: 1000000 });
  });
});
