import { describe, expect, it } from "vite-plus/test";
import { assertPackagedBuiltinCoverage } from "../nodeBuiltinGate.ts";
import type { RuntimeBuiltinInventory } from "../runtimeBuiltinInventory.ts";

const inventory: RuntimeBuiltinInventory = {
  modules: ["process"],
  functions: [
    {
      specifier: "process",
      memberPath: ["report", "getReport"],
      status: "missing",
      evidence: "process.report.getReport is absent from the constructed public Node personality",
    },
  ],
  profile: {
    systemIdentity: {},
    processIdentity: {},
    filesystem: { posixPolicy: true, setUmask: true },
    cpu: { execution: false, processAccounting: false },
  },
};

const check = (source: string, runtime = inventory) =>
  assertPackagedBuiltinCoverage([{ name: "sdk/sdk.mjs", source }], runtime);

describe("feature-tested builtin calls", () => {
  it("accepts the unchanged Claude SDK feature test when getReport is absent", async () => {
    const report = await assertPackagedBuiltinCoverage(
      [
        {
          name: "sdk/sdk.mjs",
          source: 'typeof process.report?.getReport==="function"?process.report.getReport():null',
        },
      ],
      inventory,
    );

    expect(report.status).toBe("pass");
    expect(report.requiredFunctions).toEqual([
      expect.objectContaining({
        specifier: "process",
        memberPath: ["report", "getReport"],
        module: "sdk/sdk.mjs",
        status: "guarded",
        evidence: expect.stringContaining("absent"),
      }),
    ]);
  });

  it.each([
    'typeof process.report?.getReport=="function"?process.report.getReport():null',
    '"function" === typeof process.report.getReport ? process.report?.getReport() : null',
    'typeof process.report?.getReport !== "undefined" ? process.report.getReport() : null',
    'typeof process.report.getReport != "undefined" && process.report.getReport()',
    "process.report?.getReport != null ? process.report.getReport() : null",
    "null != process.report.getReport && process.report.getReport()",
    'typeof process.report?.getReport === "function" && process.report.getReport()',
    'typeof process.report?.getReport === "function" && ready && process.report.getReport()',
    'if (typeof process.report?.getReport === "function") { process.report.getReport(); }',
    'if (typeof process.report.getReport !== "undefined") { process.report.getReport(); }',
    "if (process.report?.getReport != null) { process.report.getReport(); }",
    'if ((typeof (process.report?.getReport) === "function") && ready) { process.report.getReport(); }',
    "process.report.getReport?.()",
    "process.report?.getReport?.()",
    'globalThis.process.report?.["getReport"]?.()',
    'const p = process; typeof p.report?.getReport === "function" && p.report.getReport()',
    'const {getReport: get} = process.report; if (typeof get === "function") get();',
  ])("accepts exact-member feature detection: %s", async (source) => {
    const report = await check(source);
    expect(report.status).toBe("pass");
    expect(report.requiredFunctions).toHaveLength(1);
    expect(report.requiredFunctions[0]).toMatchObject({
      status: "guarded",
      guard: { kind: source.includes("?.()") ? "optional-call" : "feature-test" },
      evidence: expect.stringContaining("absent"),
    });
  });

  it.each([
    'typeof process.report?.other === "function" ? process.report.getReport() : null',
    'typeof process.report?.other === "function" && process.report.getReport()',
    'if (typeof process.report?.other === "function") { process.report.getReport(); }',
    'typeof process.report === "object" && process.report.getReport()',
    'typeof process.report?.getReport === "function" || process.report.getReport()',
    'typeof process.report?.getReport === "function" ? null : process.report.getReport()',
    'typeof process.report?.getReport === "undefined" && process.report.getReport()',
    "process.report.getReport !== null && process.report.getReport()",
    'typeof process.report?.getReport === "function"; process.report.getReport()',
    'if (typeof process.report?.getReport === "function") {} process.report.getReport()',
    'if (typeof process.report?.getReport === "function" || ready) { process.report.getReport(); }',
    'if (typeof process.report?.getReport === "function") { function later() { process.report.getReport(); } }',
    "process.report?.getReport()",
    "process.report.getReport.call?.(process.report)",
  ])("keeps calls without an exact dominating guard blocking: %s", async (source) => {
    await expect(check(source)).rejects.toThrow("missing-functions=process.report.getReport");
  });

  it("keeps an unguarded call to the same member blocking", async () => {
    await expect(
      check(
        'typeof process.report?.getReport === "function" && process.report.getReport(); process.report.getReport();',
      ),
    ).rejects.toThrow("missing-functions=process.report.getReport");
  });

  it.each(["unsupported", "conditional", "unknown"] as const)(
    "keeps %s capabilities blocking even when feature-tested",
    async (status) => {
      for (const source of [
        'typeof process.report?.getReport === "function" && process.report.getReport()',
        "process.report.getReport?.()",
      ]) {
        await expect(
          check(source, {
            ...inventory,
            functions: inventory.functions.map((capability) => ({ ...capability, status })),
          }),
        ).rejects.toThrow(`${status}-functions=process.report.getReport`);
      }
    },
  );

  it("does not excuse a missing module import with an optional call", async () => {
    await expect(
      check('import process from "node:process"; process.report.getReport?.()', {
        ...inventory,
        modules: [],
      }),
    ).rejects.toThrow("missing=process");
  });

  it("applies to other builtin modules and imported aliases", async () => {
    const report = await check(
      'import { release as getRelease } from "node:os"; typeof getRelease === "function" && getRelease()',
      {
        ...inventory,
        modules: ["os"],
        functions: [
          {
            specifier: "os",
            memberPath: ["release"],
            status: "missing",
            evidence: "os.release is absent",
          },
        ],
      },
    );
    expect(report.requiredFunctions[0]).toMatchObject({ specifier: "os", status: "guarded" });
  });
});
