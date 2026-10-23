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
  it.each([
    ["absent receiver in optional call", "process.report.getReport?.()"],
    [
      "absent receiver in feature test",
      'typeof process.report.getReport === "function" && process.report.getReport()',
    ],
    [
      "captured alias differs from tested property",
      'process.report={}; const get=process.report.getReport; process.report.getReport=()=>{}; if(typeof process.report.getReport === "function") get();',
    ],
    [
      "stale guard on second loop iteration",
      'process.report={getReport:()=>{}}; if(typeof process.report.getReport === "function") {for(let i=0;i<2;i++){process.report.getReport(); delete process.report.getReport;}}',
    ],
    [
      "default property is a different receiver",
      'process.report={default:{getReport:()=>{}}}; typeof process.report.default?.getReport === "function" && process.report.getReport()',
    ],
    [
      "instance field executes after guarded class definition",
      'process.report={getReport:()=>{}}; let C; if(typeof process.report.getReport === "function") { C=class { field=process.report.getReport() }; } delete process.report.getReport; new C()',
    ],
  ])("rejects review regression: %s", async (_name, source) => {
    await expect(check(source)).rejects.toThrow("missing-functions=process.report.getReport");
  });

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
    '"function" === typeof process.report?.getReport ? process.report.getReport() : null',
    'typeof process.report?.getReport !== "undefined" ? process.report.getReport() : null',
    'typeof process.report?.getReport != "undefined" && process.report.getReport()',
    "process.report?.getReport != null ? process.report.getReport() : null",
    "null != process.report?.getReport && process.report.getReport()",
    'typeof process.report?.getReport === "function" && process.report.getReport()',
    '((typeof ((process.report)?.getReport) === "function")) && ((process.report.getReport)())',
    'typeof process.report?.["getReport"] === "function" && process.report["getReport"]()',
    'typeof globalThis.process.report?.getReport === "function" && globalThis.process.report.getReport()',
    "process.report?.getReport?.()",
    'globalThis.process.report?.["getReport"]?.()',
    "global.process?.report?.getReport?.()",
    "process.report?.header?.getReport?.()",
  ])("accepts immediate feature detection with safe receivers: %s", async (source) => {
    const report = await check(source, {
      ...inventory,
      functions: [
        ...inventory.functions,
        {
          ...inventory.functions[0]!,
          memberPath: ["report", "header", "getReport"],
        },
      ],
    });
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
    "process.report?.getReport !== null && process.report.getReport()",
    'typeof process.report?.getReport === "function"; process.report.getReport()',
    'if (typeof process.report?.getReport === "function") {} process.report.getReport()',
    'if (typeof process.report?.getReport === "function" || ready) { process.report.getReport(); }',
    'if (typeof process.report?.getReport === "function") { function later() { process.report.getReport(); } }',
    "process.report?.getReport()",
    "process.report.getReport.call?.(process.report)",
    "process.report?.getReport?.call?.(process.report)",
    '"function" === typeof process.report.getReport ? process.report?.getReport() : null',
    'typeof process.report.getReport != "undefined" && process.report.getReport()',
    "null != process.report.getReport && process.report.getReport()",
    'typeof process.report?.getReport === "function" && ready && process.report.getReport()',
    'typeof process.report?.getReport === "function" && (ready && process.report.getReport())',
    'if (typeof process.report?.getReport === "function") { process.report.getReport(); }',
    'if (typeof process.report?.getReport !== "undefined") { process.report.getReport(); }',
    "if (process.report?.getReport != null) { process.report.getReport(); }",
    'if ((typeof (process.report?.getReport) === "function") && ready) { process.report.getReport(); }',
    'const p = process; typeof p.report?.getReport === "function" && p.report.getReport()',
    'const {getReport: get} = process.report; typeof get === "function" && get()',
    'const get = process.report?.getReport; typeof process.report?.getReport === "function" && get()',
    'typeof process.report?.default?.getReport === "function" && process.report.getReport()',
    'typeof process.report?.["getReport"] === "function" && process.report.getReport()',
    'typeof process.report?.getReport === "function" && (delete process.report.getReport, process.report.getReport())',
    'typeof process.report?.getReport === "function" && (process.report.getReport = undefined, process.report.getReport())',
    'typeof process.report?.getReport === "function" && class { field = process.report.getReport() }',
    'typeof process.report?.getReport === "function" && (() => process.report.getReport())',
  ])("keeps calls outside the narrow accepted shapes blocking: %s", async (source) => {
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
        "process.report?.getReport?.()",
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
      check('import process from "node:process"; process.report?.getReport?.()', {
        ...inventory,
        modules: [],
      }),
    ).rejects.toThrow("missing=process");
  });

  it("applies to other builtin modules without alias matching", async () => {
    const runtime = {
      ...inventory,
      modules: ["os"],
      functions: [
        {
          specifier: "os",
          memberPath: ["release"],
          status: "missing" as const,
          evidence: "os.release is absent",
        },
      ],
    };
    const report = await check(
      'import os from "node:os"; typeof os.release === "function" && os.release()',
      runtime,
    );
    expect(report.requiredFunctions[0]).toMatchObject({ specifier: "os", status: "guarded" });
    await expect(
      check(
        'import { release as getRelease } from "node:os"; typeof getRelease === "function" && getRelease()',
        runtime,
      ),
    ).rejects.toThrow("missing-functions=os.release");
  });
});
