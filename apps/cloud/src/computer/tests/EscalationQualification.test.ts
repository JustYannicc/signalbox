import { describe, expect, it, vi } from "vite-plus/test";
import { ComputerEscalationTable } from "../EscalationTable.ts";
import { COMPUTER_ISOLATE_POLICY } from "../EscalationPolicy.ts";
import { qualifyGnuCommand } from "../GnuCommandCompatibility.ts";

const command = Object.freeze({
  executable: "/bin/grep",
  argv: Object.freeze(["caller-zero", "-P", "x", "source.txt"]),
  env: Object.freeze({ EMPTY: "", EXACT: "snow雪" }),
  cwd: "/workspace/nested",
});

describe("Computer qualification decision", () => {
  it("qualifies the original tuple only after ordered rules and exact membership", () => {
    const qualify = vi.fn(qualifyGnuCommand);
    const table = new ComputerEscalationTable(
      [{ id: "explicit", executable: "/bin/grep", minimumWorkspaceBytes: 100 }],
      COMPUTER_ISOLATE_POLICY,
      qualify,
    );
    expect(table.decide(command, { workspaceBytes: 100 })).toEqual({
      kind: "machine",
      ruleId: "explicit",
    });
    expect(qualify).not.toHaveBeenCalled();
    expect(table.decide({ ...command, executable: "./grep" })).toEqual({
      kind: "machine",
      reason: "unsupported-executable",
    });
    expect(qualify).not.toHaveBeenCalled();
    expect(table.decide(command, { workspaceBytes: 99 })).toMatchObject({
      kind: "machine",
      reason: "incompatible-option",
    });
    expect(qualify).toHaveBeenCalledExactlyOnceWith(command);
    expect(qualify.mock.calls[0]?.[0]).toBe(command);
  });

  it("preserves no-policy local execution even when a qualifier is supplied", () => {
    const qualify = vi.fn(qualifyGnuCommand);
    const table = new ComputerEscalationTable([], undefined, qualify);
    expect(table.decide(command)).toEqual({ kind: "isolate" });
    expect(qualify).not.toHaveBeenCalled();
  });

  it.each(["sed", "/bin/sed", "grep", "/bin/grep"])(
    "keeps qualified %s in the same local decision",
    (executable) => {
      const table = new ComputerEscalationTable([], COMPUTER_ISOLATE_POLICY, qualifyGnuCommand);
      const argv = executable.endsWith("sed")
        ? ["unrelated-zero", "-n", "1,2p", "source.txt"]
        : ["unrelated-zero", "-n", "x", "source.txt"];
      expect(table.decide({ ...command, executable, argv })).toEqual({ kind: "isolate" });
    },
  );
});
