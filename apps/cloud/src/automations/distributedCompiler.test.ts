import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";
import {
  AutomationCompiled,
  ProjectId,
  WorkflowDiagnostic,
  AUTOMATION_WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import { createTestHarness } from "wrangler";

import { prepareAutomationCompiler } from "../../infra/automationCompiler/prepare.ts";
import { makeMemoryCloud } from "../testing.ts";
import * as Environment from "../environment.ts";
import { CloudAutomations } from "./CloudAutomations.ts";
import { makeAutomationHandlers } from "./automationRpc.ts";

const decode = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), compiled: AutomationCompiled }),
    Schema.Struct({ ok: Schema.Literal(false), diagnostics: Schema.Array(WorkflowDiagnostic) }),
  ]),
);
const source = `import * as Schema from "effect/Schema";
export const meta = {
  name: "Distributed composition",
  input: Schema.Struct({ title: Schema.String, attempts: Schema.Array(Schema.Number) }),
  output: Schema.Struct({ complete: Schema.Boolean }),
} as const;
export default workflow(async (w, input) => {
  await w.start("Awaited child", input);
  await w.start("Detached child", input, { wait: false });
  return { complete: true };
});`;
const runSource = `export const meta = { name: "Third transform" } as const;
async function count(value: number) { return value + 1; }
export default workflow(async (w) => await w.run("Count", count, 1));`;
const invalid = [
  "export default 1;",
  "export const meta = { name: 'Broken' }; export default workflow(async (w) => {",
  `export const meta = { name: "Impure" } as const;
export default workflow(async () => Date.now());`,
];

let harness: ReturnType<typeof createTestHarness>;
const compile = async (text: string) => {
  const response = await harness.fetch("/", { method: "POST", body: text });
  expect(response.status).toBe(200);
  return decode(await response.json());
};

beforeAll(async () => {
  await prepareAutomationCompiler();
  harness = createTestHarness({
    workers: [
      {
        configPath: new URL("./tests/compilerHarness.jsonc", import.meta.url).pathname,
      },
    ],
  });
  await harness.listen();
}, 120_000);
afterAll(async () => {
  if (harness !== undefined) await harness.close();
});

describe("distributed compiler in real Workerd", () => {
  it("matches native artifacts and diagnostics across two cached, single-memory isolates", async () => {
    for (const text of [source, runSource, ...invalid, source]) {
      expect(await compile(text)).toEqual(compileForCloud(text));
    }
    const memory = (await (await harness.fetch("/memory")).json()) as {
      linearMemoryBytes: Record<string, number>;
      workers: string[];
      coldLoads: Record<string, number>;
      modules: Record<string, string[]>;
    };
    expect(memory.workers).toHaveLength(2);
    expect(memory.workers.some((id) => id.startsWith("automation-compiler/parser/"))).toBe(true);
    expect(memory.workers.some((id) => id.startsWith("automation-compiler/transformer/"))).toBe(
      true,
    );
    for (const count of Object.values(memory.coldLoads)) expect(count).toBe(1);
    for (const names of Object.values(memory.modules))
      expect(names.sort()).toEqual(["compiler.js", "oxc.wasm"]);
    // Each isolate has its own 128 MiB limit including its JS heap. No sum or dispose claim.
    for (const size of Object.values(memory.linearMemoryBytes)) {
      expect(size).toBeGreaterThanOrEqual(981 * 65536);
      expect(size).toBeLessThanOrEqual(64 * 1024 * 1024);
    }
  }, 120_000);

  it.effect("validates and saves source-only through the existing Cloud service and RPC", () =>
    Effect.gen(function* () {
      const userId = "compiler-proof";
      const cloud = makeMemoryCloud({ automationCompiler: compile });
      yield* cloud.userDirectory
        .forUser(userId)
        .recordSignIn({ id: userId, email: "compiler@example.com" });
      yield* cloud.inUser(
        userId,
        Effect.gen(function* () {
          const handlers = yield* makeAutomationHandlers({
            newThreadModel: () => Effect.succeed(null),
            personReviews: true,
          });
          const validation = yield* handlers[AUTOMATION_WS_METHODS.automationsValidate]({ source });
          expect(validation.ok).toBe(true);
          const saved = yield* handlers[AUTOMATION_WS_METHODS.automationsSave]({
            source,
            projectId: Environment.SCRATCH_PROJECT_ID,
          });
          if (!saved.ok) return expect.unreachable();
          const engine = yield* WorkflowEngine.WorkflowEngine;
          const read = yield* engine.get(saved.automation.id);
          expect(read.source).toBe(source);
          expect(read.graph).toEqual(validation.ok ? validation.graph : undefined);
          const service = yield* CloudAutomations;
          for (const text of invalid) {
            expect(yield* service.validate({ source: text })).toEqual(compileForCloud(text));
            expect(
              yield* handlers[AUTOMATION_WS_METHODS.automationsSave]({
                source: text,
                projectId: ProjectId.make(Environment.SCRATCH_PROJECT_ID),
              }),
            ).toEqual(compileForCloud(text));
          }
          const badArtifact = yield* handlers[AUTOMATION_WS_METHODS.automationsValidate]({
            source,
            compiled: { format: -1 },
          }).pipe(Effect.flip);
          expect(badArtifact._tag).toBe("AutomationError");
        }),
      );
    }),
  );
});
