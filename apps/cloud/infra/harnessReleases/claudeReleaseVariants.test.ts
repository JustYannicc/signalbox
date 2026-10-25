import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  validateClaudeReleaseVariantArtifacts,
  writeClaudeReleaseVariantCatalog,
} from "./claudeReleaseVariants.ts";
import { fixture, encode } from "./fixtures/claudeReleaseVariants.ts";
it.each([false, true])(
  "opens both registered graphs with truthful shared fixtures, project store=%s",
  async (project) => {
    const f = await fixture(project);
    try {
      const result = await validateClaudeReleaseVariantArtifacts(f.input);
      expect(result.catalog).toEqual(f.input.catalog);
      expect(result.baseline.qualification.status).toBe("pending");
      expect(result.hooks.plan.workerEntries["hooks-worker"]?.export).toBe("instantiate");
      expect(f.input.ledger.getArtifact("claude-code", "baseline")).toEqual(
        f.baseline.fullArtifact,
      );
      expect(() =>
        f.input.ledger.registerArtifact({
          ...f.baseline.fullArtifact,
          fixtureIdentity: "invented",
        }),
      ).toThrow("IMMUTABLE_CONFLICT");
    } finally {
      f.close();
    }
  },
);

it.each([
  [
    "OFFICIAL_CLI",
    (cli: Record<string, unknown>) => {
      cli.release = { ...(cli.release as object), binarySha256: "9".repeat(64) };
    },
  ],
  [
    "SDK",
    (_cli: Record<string, unknown>, sdk: Record<string, unknown>) => {
      sdk.release = { ...(sdk.release as object), integrity: "different" };
    },
  ],
  [
    "CORPUS_PROVENANCE",
    (cli: Record<string, unknown>) => {
      const omission = cli.omission as Record<string, unknown>;
      omission.corpus = {
        ...(omission.corpus as object),
        provenance: [{ name: "changed-capture", sha256: "f".repeat(64) }],
      };
    },
  ],
  [
    "SOURCE_MODULES",
    (cli: Record<string, unknown>) => {
      cli.sourceModules = ["different/input.js"];
    },
  ],
] as const)("rejects independently hash-valid %s drift", async (code, change) => {
  const f = await fixture(false, change);
  try {
    await expect(validateClaudeReleaseVariantArtifacts(f.input)).rejects.toThrow(
      `CLAUDE_VARIANTS_${code}_MISMATCH`,
    );
  } finally {
    f.close();
  }
});

it("reads every prepared payload rather than trusting two matching manifest labels", async () => {
  const f = await fixture(false);
  try {
    f.hooks.files.set("cli/worker-hooks.js", encode("changed payload"));
    await expect(validateClaudeReleaseVariantArtifacts(f.input)).rejects.toThrow(
      "FILE_SIZE_MISMATCH",
    );
  } finally {
    f.close();
  }
});

it("rejects an unpinned baseline graph", async () => {
  const f = await fixture(false);
  try {
    await expect(
      validateClaudeReleaseVariantArtifacts({
        ...f.input,
        baselinePin: { ...f.input.baselinePin, preparedModules: {} },
      }),
    ).rejects.toThrow("CLAUDE_VARIANTS_BASELINE_MODULES_MISMATCH");
  } finally {
    f.close();
  }
});

it("keeps a pending pair inspectable without publishing it to selectors", async () => {
  const f = await fixture(false);
  try {
    await expect(
      writeClaudeReleaseVariantCatalog({ ...f.input, output: "/unused/pending-catalog.json" }),
    ).rejects.toThrow("CLAUDE_VARIANTS_NOT_QUALIFIED");
  } finally {
    f.close();
  }
});

it.each(["green", "rejected"] as const)(
  "publishes only a fully bound green pair, proof=%s",
  async (status) => {
    const f = await fixture(false);
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-catalog-"));
    try {
      for (const fullArtifact of [f.baseline.fullArtifact, f.hooks.fullArtifact])
        for (const environment of ["local-workerd", "deployed-do"] as const)
          f.input.ledger.recordProof({
            ...fullArtifact,
            proofId: `${fullArtifact.releaseId}-${environment}`,
            environment,
            recordedAt: fullArtifact.createdAt,
            checks: {
              unchangedSource: "passed",
              boot:
                status === "rejected" && fullArtifact.releaseId === "hooks" ? "rejected" : "passed",
              toolTurn: "passed",
              resume: "passed",
              mcp: "passed",
              interrupt: "passed",
            },
            metrics: {
              bootTimeMs: { state: "measured", value: 10 },
              moduleBytes: { state: "measured", value: 50 },
              peakHeapBytes: { state: "measured", value: 100 },
            },
          });
      const output = NodePath.join(root, "catalog.json");
      if (status === "rejected") {
        await expect(writeClaudeReleaseVariantCatalog({ ...f.input, output })).rejects.toThrow(
          "CLAUDE_VARIANTS_REJECTED_PROOF",
        );
        await expect(NodeFSP.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await writeClaudeReleaseVariantCatalog({ ...f.input, output });
        expect(JSON.parse(await NodeFSP.readFile(output, "utf8"))).toEqual(f.input.catalog);
        await expect(
          writeClaudeReleaseVariantCatalog({ ...f.input, output }),
        ).rejects.toMatchObject({ code: "EEXIST" });
      }
    } finally {
      f.close();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);
