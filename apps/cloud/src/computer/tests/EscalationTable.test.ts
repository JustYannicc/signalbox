import { describe, expect, it } from "@effect/vitest";
import type { KernelCommand } from "../../kernel/KernelCommandForwarder.ts";
import {
  ComputerEscalationEvidenceNotReadyError,
  ComputerEscalationTable,
  type ComputerEscalationRule,
  type ComputerEscalationPolicy,
} from "../EscalationTable.ts";
import { COMPUTER_ISOLATE_EXECUTABLES, COMPUTER_ISOLATE_POLICY } from "../EscalationPolicy.ts";

const command = (executable: string, argv: readonly string[] = ["argv0"]): KernelCommand => ({
  executable,
  argv,
  cwd: "/workspace",
  env: {},
});

describe("ComputerEscalationTable", () => {
  it("isolates every command when the table is empty", () => {
    const table = new ComputerEscalationTable();

    expect(table.decide(command("/bin/claude"))).toEqual({ kind: "isolate" });
    expect(table.decide(command("/bin/codex"))).toEqual({ kind: "isolate" });
    expect(table.decide(command("sed"))).toEqual({ kind: "isolate" });
    expect(Object.keys(table)).toEqual(["rules"]);
    expect(Object.isFrozen(table)).toBe(true);
    expect(Object.isFrozen(table.rules)).toBe(true);
  });

  it("matches an opted-in exact executable policy without normalizing spellings", () => {
    const table = new ComputerEscalationTable([], {
      isolateExecutables: ["sed"],
      default: "machine",
    });

    expect(table.decide(command("sed"))).toEqual({ kind: "isolate" });
    for (const executable of ["SED", "./sed", "/bin/sed", "sed "]) {
      expect(table.decide(command(executable))).toEqual({
        kind: "machine",
        reason: "unsupported-executable",
      });
    }
  });

  it("keeps explicit rules ahead of the exact executable policy", () => {
    const table = new ComputerEscalationTable(
      [{ id: "large-sed", executable: "sed", minimumWorkspaceBytes: 100 }],
      { isolateExecutables: ["sed"], default: "machine" },
    );

    expect(() => table.decide(command("sed"))).toThrow(ComputerEscalationEvidenceNotReadyError);
    expect(table.decide(command("sed"), { workspaceBytes: 99 })).toEqual({ kind: "isolate" });
    expect(table.decide(command("sed"), { workspaceBytes: 100 })).toEqual({
      kind: "machine",
      ruleId: "large-sed",
    });
  });

  it("exports the 34 exact policy spellings as opt-in frozen data", () => {
    expect(COMPUTER_ISOLATE_EXECUTABLES).toHaveLength(34);
    expect(COMPUTER_ISOLATE_EXECUTABLES).toEqual([
      "sed",
      "git",
      "head",
      "grep",
      "rg",
      "cat",
      "cd",
      "tail",
      "echo",
      "ls",
      "mkdir",
      "rm",
      "cp",
      "mv",
      "touch",
      "printf",
      "pwd",
      "bash",
      "sh",
      "/bin/bash",
      "/bin/sh",
      "/bin/cat",
      "/bin/rg",
      "/bin/echo",
      "/bin/printf",
      "/bin/ls",
      "/bin/mkdir",
      "/bin/rm",
      "/bin/cp",
      "/bin/mv",
      "/bin/pwd",
      "/bin/head",
      "/bin/tail",
      "/usr/bin/git",
    ]);
    expect(Object.isFrozen(COMPUTER_ISOLATE_EXECUTABLES)).toBe(true);
    expect(COMPUTER_ISOLATE_POLICY).toEqual({
      isolateExecutables: COMPUTER_ISOLATE_EXECUTABLES,
      default: "machine",
    });
    expect(Object.isFrozen(COMPUTER_ISOLATE_POLICY)).toBe(true);
  });

  it("uses exact executable identity and the argv tail, with the first matching rule winning", () => {
    const table = new ComputerEscalationTable([
      { id: "first", executable: "/bin/tool", argvPrefix: ["--run"] },
      { id: "second", executable: "/bin/tool", argvPrefix: ["--run", "build"] },
    ]);

    expect(table.decide(command("/bin/tool", ["different-argv0", "--run", "build"]))).toEqual({
      kind: "machine",
      ruleId: "first",
    });
    expect(table.decide(command("tool", ["/bin/tool", "--run", "build"]))).toEqual({
      kind: "isolate",
    });
  });

  it("uses an explicit workspace byte threshold and falls through when it is not met", () => {
    const table = new ComputerEscalationTable([
      {
        id: "large-build",
        executable: "/bin/tool",
        argvPrefix: ["build"],
        minimumWorkspaceBytes: 100,
      },
      { id: "build", executable: "/bin/tool", argvPrefix: ["build"] },
    ]);
    const build = command("/bin/tool", ["tool", "build"]);

    expect(table.decide(build, { workspaceBytes: 99 })).toEqual({
      kind: "machine",
      ruleId: "build",
    });
    expect(table.decide(build, { workspaceBytes: 100 })).toEqual({
      kind: "machine",
      ruleId: "large-build",
    });
  });

  it("throws a typed error when a matching threshold rule lacks byte evidence", () => {
    const table = new ComputerEscalationTable(
      [{ id: "measured", executable: "/bin/tool", minimumWorkspaceBytes: 0 }],
      {
        isolateExecutables: ["/bin/tool"],
        default: "machine",
      },
    );

    expect(() => table.decide(command("/bin/tool"))).toThrow(
      ComputerEscalationEvidenceNotReadyError,
    );
    expect(() => table.decide(command("/bin/other"))).not.toThrow();
  });

  it("copies and freezes rules and argv prefixes at construction", () => {
    const argvPrefix = ["--run"];
    const input: Array<{ id: string; executable: string; argvPrefix?: string[] }> = [
      { id: "original", executable: "/bin/tool", argvPrefix },
    ];
    const table = new ComputerEscalationTable(input);

    input[0]!.id = "changed";
    input[0]!.executable = "/bin/other";
    argvPrefix[0] = "--changed";
    input.push({ id: "added", executable: "/bin/other" });

    expect(table.decide(command("/bin/tool", ["tool", "--run"]))).toEqual({
      kind: "machine",
      ruleId: "original",
    });
    expect(table.rules).toHaveLength(1);
    expect(Object.isFrozen(table.rules[0])).toBe(true);
    expect(Object.isFrozen(table.rules[0]?.argvPrefix)).toBe(true);
  });

  it("copies and freezes the policy executable list at construction", () => {
    const isolateExecutables = ["sed"];
    const input = { isolateExecutables, default: "machine" };
    const table = new ComputerEscalationTable([], input as ComputerEscalationPolicy);

    isolateExecutables[0] = "git";
    isolateExecutables.push("/bin/sed");
    input.default = "isolate";

    expect(table.decide(command("sed"))).toEqual({ kind: "isolate" });
    expect(table.decide(command("git"))).toEqual({
      kind: "machine",
      reason: "unsupported-executable",
    });
    expect(Object.isFrozen(table)).toBe(true);
  });

  it("treats wildcard characters as literal argv values", () => {
    const table = new ComputerEscalationTable([
      { id: "literal-star", executable: "/bin/tool", argvPrefix: ["*"] },
    ]);

    expect(table.decide(command("/bin/tool", ["tool", "*"]))).toEqual({
      kind: "machine",
      ruleId: "literal-star",
    });
    expect(table.decide(command("/bin/tool", ["tool", "anything"]))).toEqual({
      kind: "isolate",
    });
  });

  it.each([
    ["empty ID", [{ id: "", executable: "/bin/tool" }]],
    ["empty executable", [{ id: "tool", executable: "" }]],
    [
      "duplicate IDs",
      [
        { id: "tool", executable: "/bin/tool" },
        { id: "tool", executable: "/bin/other" },
      ],
    ],
    ["negative threshold", [{ id: "tool", executable: "/bin/tool", minimumWorkspaceBytes: -1 }]],
    ["fractional threshold", [{ id: "tool", executable: "/bin/tool", minimumWorkspaceBytes: 1.5 }]],
    [
      "non-finite threshold",
      [{ id: "tool", executable: "/bin/tool", minimumWorkspaceBytes: Number.POSITIVE_INFINITY }],
    ],
    ["non-string argument", [{ id: "tool", executable: "/bin/tool", argvPrefix: ["ok", 1] }]],
    ["non-array argument prefix", [{ id: "tool", executable: "/bin/tool", argvPrefix: "--run" }]],
  ] as const)("rejects malformed rules with %s", (_label: string, rules: readonly unknown[]) => {
    expect(
      () => new ComputerEscalationTable(rules as unknown as ComputerEscalationRule[]),
    ).toThrow();
  });

  it.each([
    ["blank executable", { isolateExecutables: [" "], default: "machine" }],
    ["NUL executable", { isolateExecutables: ["sed\0"], default: "machine" }],
    ["duplicate executable", { isolateExecutables: ["sed", "sed"], default: "machine" }],
    ["non-string executable", { isolateExecutables: [1], default: "machine" }],
    ["non-array executable list", { isolateExecutables: "sed", default: "machine" }],
    ["non-machine default", { isolateExecutables: ["sed"], default: "isolate" }],
  ] as const)("rejects malformed policies with %s", (_label, policy) => {
    expect(
      () => new ComputerEscalationTable([], policy as unknown as ComputerEscalationPolicy),
    ).toThrow();
  });

  it.each([-1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects malformed workspace byte evidence: %s",
    (workspaceBytes: number) => {
      const table = new ComputerEscalationTable([
        { id: "tool", executable: "/bin/tool", minimumWorkspaceBytes: 0 },
      ]);

      expect(() => table.decide(command("/bin/tool"), { workspaceBytes })).toThrow(RangeError);
    },
  );
});
