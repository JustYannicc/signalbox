import { describe, expect, it } from "@effect/vitest";
import type { KernelCommand } from "../../kernel/KernelCommandForwarder.ts";
import { qualifyGnuCommand, type GnuCommandQualification } from "../GnuCommandCompatibility.ts";

interface SyntheticComparisonCase {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly kind: GnuCommandQualification["kind"];
  readonly reason?: "incompatible-option" | "unqualified-option" | "unqualified-script";
}

// These synthetic comparison cases use GNU sed 4.10 (130563b48d1c) and GNU grep 3.12
// (55a38d46b1eb) as references. Their argv arrays omit argv0, so the fixtures add
// the exact executable spelling; they classify arguments without executing GNU.
const syntheticComparisonCases: readonly SyntheticComparisonCase[] = [
  {
    id: "sed-range",
    executable: "sed",
    args: ["-n", "2,3p", "nested/input"],
    kind: "qualified-isolate",
  },
  {
    id: "sed-edit",
    executable: "sed",
    args: ["-i", "s/needle/thread/g", "nested/input"],
    kind: "machine",
    reason: "unqualified-option",
  },
  {
    id: "sed-extended",
    executable: "sed",
    args: ["-E", "s/(needle) (one|two)/\\2/g", "nested/input"],
    kind: "qualified-isolate",
  },
  {
    id: "sed-gnu-sandbox",
    executable: "sed",
    args: ["--sandbox", "-n", "1p", "nested/input"],
    kind: "machine",
    reason: "incompatible-option",
  },
  {
    id: "sed-gnu-sandbox-after-option",
    executable: "sed",
    args: ["-n", "--sandbox", "1p", "nested/input"],
    kind: "machine",
    reason: "incompatible-option",
  },
  {
    id: "grep-number",
    executable: "grep",
    args: ["-n", "needle", "nested/input"],
    kind: "qualified-isolate",
  },
  {
    id: "grep-extended",
    executable: "grep",
    args: ["-En", "^(alpha|beta)$", "nested/input"],
    kind: "qualified-isolate",
  },
  {
    id: "grep-fixed",
    executable: "grep",
    args: ["-F", "a.b", "nested/input"],
    kind: "qualified-isolate",
  },
  {
    id: "grep-context",
    executable: "grep",
    args: ["-n", "-A", "1", "-B", "1", "needle one", "nested/input"],
    kind: "qualified-isolate",
  },
  {
    id: "grep-quiet",
    executable: "grep",
    args: ["-q", "needle", "nested/input"],
    kind: "qualified-isolate",
  },
  {
    id: "grep-no-match",
    executable: "grep",
    args: ["-n", "absent", "nested/input"],
    kind: "qualified-isolate",
  },
  {
    id: "grep-pcre",
    executable: "grep",
    args: ["-P", "needle", "nested/input"],
    kind: "machine",
    reason: "incompatible-option",
  },
  {
    id: "grep-pcre-combined",
    executable: "grep",
    args: ["-nP", "needle", "nested/input"],
    kind: "machine",
    reason: "incompatible-option",
  },
  {
    id: "grep-pcre-after-option",
    executable: "grep",
    args: ["-n", "-P", "needle", "nested/input"],
    kind: "machine",
    reason: "incompatible-option",
  },
  {
    id: "grep-dash-operand",
    executable: "grep",
    args: ["-n", "--", "-P", "nested/input"],
    kind: "qualified-isolate",
  },
  {
    id: "grep-expression-dash",
    executable: "grep",
    args: ["-e", "-P", "nested/input"],
    kind: "qualified-isolate",
  },
  {
    id: "grep-include",
    executable: "grep",
    args: ["-rn", "--include=*.txt", "needle", "nested"],
    kind: "machine",
    reason: "incompatible-option",
  },
  {
    id: "grep-exclude-dir",
    executable: "grep",
    args: ["-rn", "--exclude-dir=skip", "needle", "nested"],
    kind: "machine",
    reason: "incompatible-option",
  },
  {
    id: "grep-combined-recursive",
    executable: "grep",
    args: ["-rEin", "needle", "nested"],
    kind: "qualified-isolate",
  },
  {
    id: "sed-empty-backup",
    executable: "sed",
    args: ["-i", "", "s/needle/thread/g", "nested/input"],
    kind: "machine",
    reason: "incompatible-option",
  },
  { id: "touch-create", executable: "touch", args: ["nested/new"], kind: "qualified-isolate" },
];

function command(
  executable: string,
  args: readonly string[],
  options: {
    readonly argv0?: string;
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
  } = {},
): KernelCommand {
  return {
    executable,
    argv: [options.argv0 ?? executable, ...args],
    cwd: options.cwd ?? "/workspace",
    env: options.env ?? {},
  };
}

describe("qualifyGnuCommand", () => {
  it.each([
    ["grep", ["needle", "-"]],
    ["grep", ["needle", "-", "-"]],
    ["grep", ["needle", "nested/input", "-"]],
    ["sed", ["-n", "1p", "-"]],
    ["sed", ["-n", "1p", "-", "-"]],
    ["sed", ["-n", "1p", "nested/input", "-"]],
  ] as const)("keeps explicit stdin operands unqualified for %s", (executable, args) => {
    expect(qualifyGnuCommand(command(executable, args))).toMatchObject({
      kind: "machine",
      reason: "unqualified-script",
    });
  });

  it("preserves a dash used as grep pattern data", () => {
    expect(qualifyGnuCommand(command("grep", ["--", "-", "nested/input"]))).toEqual({
      kind: "qualified-isolate",
    });
  });

  it.each(syntheticComparisonCases)("classifies synthetic comparison case $id", (input) => {
    const captured = command(input.executable, input.args);
    const result = qualifyGnuCommand(captured);

    expect(result.kind).toBe(input.kind);
    if (input.reason !== undefined) expect(result).toMatchObject({ reason: input.reason });
  });

  it.each(["sed", "/bin/sed", "grep", "/bin/grep"])(
    "qualifies only the exact target spelling %s",
    (executable) => {
      const args = executable.includes("sed")
        ? ["-n", "2,3p", "nested/input"]
        : ["-n", "needle", "nested/input"];
      expect(qualifyGnuCommand(command(executable, args))).toEqual({ kind: "qualified-isolate" });
    },
  );

  it("does not normalize a non-target path or mutate its captured command", () => {
    const input = Object.freeze({
      executable: "./grep",
      argv: Object.freeze(["/usr/bin/grep", "-P", "needle", "nested/input"]),
      cwd: "/workspace/subdir",
      env: Object.freeze({ LANG: "fr_CH.UTF-8", PATH: "/bin:/usr/bin" }),
    });
    const before = JSON.stringify(input);

    expect(qualifyGnuCommand(input)).toEqual({ kind: "qualified-isolate" });
    expect(JSON.stringify(input)).toBe(before);
  });

  it("keeps argv0 out of option parsing and leaves cwd/env/argv untouched", () => {
    const input = command("sed", ["-n", "2,3p", "nested/input"], {
      argv0: "--sandbox",
      cwd: "/workspace/nested",
      env: { LC_ALL: "C", PATH: "/bin" },
    });
    const before = JSON.stringify(input);

    expect(qualifyGnuCommand(input)).toEqual({ kind: "qualified-isolate" });
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([
    ["interspersed GNU option", "grep", ["needle", "-P", "nested/input"], "incompatible-option"],
    ["unknown short option", "grep", ["-Z", "needle", "nested/input"], "unqualified-option"],
    [
      "unknown long option",
      "grep",
      ["--color=always", "needle", "nested/input"],
      "unqualified-option",
    ],
    ["pattern file", "grep", ["-f", "patterns", "nested/input"], "unqualified-script"],
    ["stdin pattern", "grep", ["needle"], "unqualified-script"],
    ["wide ERE", "grep", ["-E", ".*", "nested/input"], "unqualified-script"],
    ["sed script file", "sed", ["-f", "script.sed", "nested/input"], "unqualified-script"],
    ["wide sed expression", "sed", ["-E", "s/a.*b/x/", "nested/input"], "unqualified-script"],
  ] as const)("routes %s as %s", (_label, executable, args, reason) => {
    expect(qualifyGnuCommand(command(executable, args))).toMatchObject({ kind: "machine", reason });
  });

  it.each([
    ["zero address", "0p"],
    ["range starting at zero", "0,1p"],
    ["descending range", "3,1p"],
  ] as const)("leaves the malformed sed %s unqualified", (_label, script) => {
    expect(qualifyGnuCommand(command("sed", ["-n", script, "nested/input"]))).toMatchObject({
      kind: "machine",
      reason: "unqualified-script",
    });
  });

  it("respects -- and -e values instead of treating pattern data as options", () => {
    expect(qualifyGnuCommand(command("grep", ["--", "-P", "nested/input"]))).toEqual({
      kind: "qualified-isolate",
    });
    expect(qualifyGnuCommand(command("grep", ["-e", "-P", "nested/input"]))).toEqual({
      kind: "qualified-isolate",
    });
    expect(qualifyGnuCommand(command("sed", ["--", "--sandbox", "nested/input"]))).toMatchObject({
      kind: "machine",
      reason: "unqualified-script",
    });
  });

  it("parses attached context values and combined supported flags", () => {
    expect(qualifyGnuCommand(command("grep", ["-rEin", "needle", "nested"]))).toEqual({
      kind: "qualified-isolate",
    });
    expect(qualifyGnuCommand(command("grep", ["-A1", "needle", "nested/input"]))).toEqual({
      kind: "qualified-isolate",
    });
    expect(
      qualifyGnuCommand(command("sed", ["-En", "s/(needle) (one|two)/\\2/g", "nested/input"])),
    ).toEqual({ kind: "qualified-isolate" });
  });

  it.each([
    [{ LC_ALL: "C" }, "qualified-isolate"],
    [{ LANG: "POSIX" }, "qualified-isolate"],
    [{ LC_ALL: "fr_CH.UTF-8" }, "machine"],
    [{ GREP_OPTIONS: "" }, "machine"],
  ] as const)("accounts for matching environment controls %j", (env, kind) => {
    const result = qualifyGnuCommand(command("grep", ["-n", "needle", "nested/input"], { env }));
    expect(result.kind).toBe(kind);
  });
});
