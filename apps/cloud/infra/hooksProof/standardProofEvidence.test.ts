import { describe, expect, it } from "vite-plus/test";
import { standardProofFilledWrite } from "./standardProofAdapter.ts";
import {
  inspectStandardProofNativeFileRead,
  STANDARD_PROOF_WIRE_TEXT,
} from "./standardProofEvidence.ts";

describe("standard proof native file evidence", () => {
  it("shares the wire fixture and validates the native cat command and filled bytes", () => {
    const command = "cat /work/official-write.txt";
    const evidence = {
      executable: "/bin/bash",
      argv: ["bash", "-lc", command],
      stdout: new TextEncoder().encode(standardProofFilledWrite()),
    };

    expect(STANDARD_PROOF_WIRE_TEXT).toContain("{{secret:VAULT_TOKEN}}");
    expect(inspectStandardProofNativeFileRead(evidence, command)).toMatchObject({
      commandMatched: true,
      matchesFilledBytes: true,
      outputBytes: evidence.stdout.byteLength,
    });
    expect(inspectStandardProofNativeFileRead(evidence, "cat /work/other.txt").commandMatched).toBe(
      false,
    );
    expect(
      inspectStandardProofNativeFileRead(
        { ...evidence, stdout: new TextEncoder().encode("changed") },
        command,
      ).matchesFilledBytes,
    ).toBe(false);
  });
});
