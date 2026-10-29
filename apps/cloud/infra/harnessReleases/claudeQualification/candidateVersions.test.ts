import { expect, it } from "vite-plus/test";
import { derivePairedClaudeComponentVersions } from "./candidateVersions.ts";

const source = (cli: string, sdk: string) => ({
  harness: "claude-code",
  cli: { version: cli },
  sdk: { version: sdk },
});

it("uses the exact versions carried by the paired candidate manifests", () => {
  expect(
    derivePairedClaudeComponentVersions(source("2.1.999", "0.4.999"), source("2.1.999", "0.4.999")),
  ).toEqual({ cli: "2.1.999", sdk: "0.4.999" });
});

it("rejects component versions that disagree across the candidate pair", () => {
  expect(() =>
    derivePairedClaudeComponentVersions(source("2.1.999", "0.4.999"), source("2.2.0", "0.4.999")),
  ).toThrow("CLAUDE_QUALIFICATION_COMPONENT_VERSIONS_MISMATCH");
});

it("rejects version data without Claude component provenance", () => {
  expect(() =>
    derivePairedClaudeComponentVersions({ harness: "codex" }, { harness: "codex" }),
  ).toThrow("CLAUDE_QUALIFICATION_COMPONENT_PROVENANCE_INVALID");
});
