import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  validateClaudeReleaseVariantArtifacts,
  writeClaudeReleaseVariantCatalog,
} from "./claudeReleaseVariants.ts";
import { fixture, encode } from "./fixtures/claudeReleaseVariants.ts";

function recordProofs(f: Awaited<ReturnType<typeof fixture>>, status: "green" | "rejected") {
  for (const fullArtifact of [f.baseline.fullArtifact, f.hooks.fullArtifact])
    for (const environment of ["local-workerd", "deployed-do"] as const)
      f.input.ledger.recordProof({
        ...fullArtifact,
        proofId: `${fullArtifact.releaseId}-${environment}`,
        environment,
        recordedAt: fullArtifact.createdAt,
        checks: {
          unchangedSource: "passed",
          boot: status === "rejected" && fullArtifact.releaseId === "hooks" ? "rejected" : "passed",
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
}
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

it("opens a full pair without optional omission metadata", async () => {
  const omit = (cli: Record<string, unknown>) => {
    delete cli.omission;
  };
  const f = await fixture(false, omit, 0, omit);
  try {
    const result = await validateClaudeReleaseVariantArtifacts(f.input);
    expect(result.baseline.plan.workerEntries).toEqual({});
    expect(result.hooks.plan.workerEntries["hooks-worker"]?.export).toBe("instantiate");
    expect(result.baseline.qualification.status).toBe("pending");
    expect(result.hooks.qualification.status).toBe("pending");
  } finally {
    f.close();
  }
});

it.each(["baseline", "hooks"] as const)(
  "rejects omission metadata present only in %s",
  async (present) => {
    const omit = (cli: Record<string, unknown>) => {
      delete cli.omission;
    };
    const f = await fixture(
      false,
      present === "baseline" ? omit : undefined,
      0,
      present === "hooks" ? omit : undefined,
    );
    try {
      await expect(validateClaudeReleaseVariantArtifacts(f.input)).rejects.toThrow(
        "CLAUDE_VARIANTS_OMISSION_MISMATCH",
      );
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

it("rejects malformed present omission configuration", async () => {
  const f = await fixture(false, (cli) => {
    const omission = cli.omission as Record<string, unknown>;
    omission.configuration = { ...(omission.configuration as object), evidence: "changed" };
  });
  try {
    await expect(validateClaudeReleaseVariantArtifacts(f.input)).rejects.toThrow(
      "INVALID_OMISSION",
    );
  } finally {
    f.close();
  }
});

it.each(["binarySha256", "provenance"] as const)(
  "rejects invalid present corpus %s",
  async (field) => {
    const invalidate = (cli: Record<string, unknown>) => {
      const omission = cli.omission as Record<string, unknown>;
      omission.corpus = {
        ...(omission.corpus as object),
        [field]: field === "binarySha256" ? "9".repeat(64) : [],
      };
    };
    const f = await fixture(false, invalidate, 0, invalidate);
    try {
      await expect(validateClaudeReleaseVariantArtifacts(f.input)).rejects.toThrow(
        "CLAUDE_VARIANTS_CORPUS_INVALID",
      );
    } finally {
      f.close();
    }
  },
);

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

it("does not publish an omission-free pair even with green proofs", async () => {
  const omit = (cli: Record<string, unknown>) => {
    delete cli.omission;
  };
  const f = await fixture(false, omit, 0, omit);
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-full-catalog-"));
  try {
    recordProofs(f, "green");
    const output = NodePath.join(root, "catalog.json");
    await expect(writeClaudeReleaseVariantCatalog({ ...f.input, output })).rejects.toThrow(
      "CLAUDE_VARIANTS_PROVENANCE_MISSING",
    );
    await expect(NodeFSP.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    f.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it.each(["green", "rejected"] as const)(
  "publishes only a fully bound green pair, proof=%s",
  async (status) => {
    const f = await fixture(false);
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-catalog-"));
    try {
      recordProofs(f, status);
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

it("does not publish when proof becomes rejected while the graphs are being read", async () => {
  const f = await fixture(false);
  const root = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "claude-catalog-proof-change-"),
  );
  try {
    recordProofs(f, "green");
    let changed = false;
    const output = NodePath.join(root, "catalog.json");
    await expect(
      writeClaudeReleaseVariantCatalog({
        ...f.input,
        output,
        source: {
          async read(ref, path) {
            if (!changed) {
              changed = true;
              const proof = f.input.ledger.listProofs("claude-code", "baseline")[0]!;
              f.input.ledger.recordProof({
                ...proof,
                proofId: "baseline-new-failure",
                checks: { ...proof.checks, boot: "rejected" },
              });
            }
            return f.input.source.read(ref, path);
          },
        },
      }),
    ).rejects.toThrow("CLAUDE_VARIANTS_NOT_QUALIFIED");
    await expect(NodeFSP.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    f.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
