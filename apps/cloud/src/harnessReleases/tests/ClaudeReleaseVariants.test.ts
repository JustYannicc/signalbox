import { expect, it } from "vite-plus/test";
import {
  decodeClaudeReleaseVariants,
  encodeClaudeReleaseVariants,
  resolveClaudeReleaseVariants,
} from "../ClaudeReleaseVariants.ts";

const artifact = (id: string, digit: string) => ({
  provider: "claude-code" as const,
  releaseId: id,
  artifactHash: digit.repeat(64),
  artifactRef: `sha256:${digit.repeat(64)}`,
  sourceIdentity: digit.repeat(64),
  fixtureIdentity: "same-real-fixture",
  createdAt: "2026-10-24T00:00:00Z",
});
const catalog = () => ({
  baseline: { variant: "baseline" as const, fullArtifact: artifact("official-baseline", "a") },
  hooks: { variant: "hooks" as const, fullArtifact: artifact("official-hooks", "b") },
});

it("preserves full records and the same actual fixture through catalog encoding", () => {
  const input = catalog();
  const decoded = decodeClaudeReleaseVariants(
    JSON.parse(new TextDecoder().decode(encodeClaudeReleaseVariants(input))),
  );
  expect(decoded).toEqual(input);
  expect(
    resolveClaudeReleaseVariants(decoded, {
      getArtifact: (_provider, releaseId) =>
        [input.baseline, input.hooks].find((entry) => entry.fullArtifact.releaseId === releaseId)
          ?.fullArtifact ?? null,
    }),
  ).toEqual(input);
});

it.each(["releaseId", "artifactHash", "artifactRef", "sourceIdentity"] as const)(
  "rejects a shared prepared %s",
  (field) => {
    const input = catalog();
    input.hooks.fullArtifact[field] = input.baseline.fullArtifact[field];
    expect(() => decodeClaudeReleaseVariants(input)).toThrow(`CLAUDE_VARIANTS_SHARED_${field}`);
  },
);

it.each([undefined, { fullArtifact: artifact("legacy", "a") }])(
  "does not classify an absent or legacy entry",
  (baseline) => {
    expect(() => decodeClaudeReleaseVariants({ ...catalog(), baseline })).toThrow();
  },
);

it.each(["artifactRef", "sourceIdentity", "fixtureIdentity", "createdAt"] as const)(
  "rejects a changed %s from the ledger",
  (field) => {
    const input = catalog();
    expect(() =>
      resolveClaudeReleaseVariants(input, {
        getArtifact: (_provider, releaseId) => {
          const stored =
            releaseId === input.baseline.fullArtifact.releaseId
              ? input.baseline.fullArtifact
              : input.hooks.fullArtifact;
          return { ...stored, [field]: `${stored[field]}-changed` };
        },
      }),
    ).toThrow("CLAUDE_VARIANTS_LEDGER_RECORD_MISMATCH");
  },
);

it("does not fall back when hooks are missing", () => {
  const input = catalog();
  expect(() =>
    resolveClaudeReleaseVariants(input, { getArtifact: () => input.baseline.fullArtifact }),
  ).toThrow("CLAUDE_VARIANTS_LEDGER_RECORD_MISMATCH");
});
