import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createHarnessReleaseLedger } from "../../src/harnessReleases/HarnessReleaseLedger.ts";
import { createHarnessProjectReleaseSqliteStore } from "../../src/harnessReleases/HarnessProjectReleaseSqliteStore.ts";
import {
  createHarnessReleaseSqliteStore,
  type HarnessReleaseSqliteDatabase,
} from "../../src/harnessReleases/HarnessReleaseSqliteStore.ts";
import { fixture } from "./fixtures/claudeReleaseVariants.ts";
import {
  writeClaudeReleaseLedgerCandidate,
  type ClaudeReleaseCandidateInput,
} from "./writeClaudeReleaseLedgerCandidate.ts";

const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
};

const writePreparedArtifact = async (directory: string, files: ReadonlyMap<string, Uint8Array>) => {
  for (const [path, bytes] of files) {
    const destination = NodePath.join(directory, path);
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.writeFile(destination, bytes);
  }
};

const candidateInput = async (
  root: string,
  project: boolean,
  change?: Parameters<typeof fixture>[1],
): Promise<{
  readonly input: ClaudeReleaseCandidateInput;
  readonly close: () => void;
}> => {
  const f = await fixture(project, change);
  const baselineDirectory = NodePath.join(root, "prepared-baseline");
  const hooksDirectory = NodePath.join(root, "prepared-hooks");
  await NodeFSP.mkdir(baselineDirectory);
  await NodeFSP.mkdir(hooksDirectory);
  await writePreparedArtifact(baselineDirectory, f.baseline.files);
  await writePreparedArtifact(hooksDirectory, f.hooks.files);
  return {
    input: {
      createdAt: "2026-10-29T20:00:00.000Z",
      baseline: {
        directory: baselineDirectory,
        identity: {
          artifactRef: f.baseline.fullArtifact.artifactRef,
          artifactHash: f.baseline.fullArtifact.artifactHash,
          sourceIdentity: f.baseline.fullArtifact.sourceIdentity,
        },
      },
      hooks: {
        directory: hooksDirectory,
        identity: {
          artifactRef: f.hooks.fullArtifact.artifactRef,
          artifactHash: f.hooks.fullArtifact.artifactHash,
          sourceIdentity: f.hooks.fullArtifact.sourceIdentity,
        },
      },
      trustedComputer: f.input.trustedComputer,
      maxPreparedModuleBytes: f.input.maxPreparedModuleBytes,
      ...(project ? { projectId: "project" } : {}),
      outputDirectory: NodePath.join(root, "candidate-output"),
    },
    close: f.close,
  };
};

const storageFor = (database: NodeSqlite.DatabaseSync): HarnessReleaseSqliteDatabase => ({
  sql: {
    exec(query, ...bindings) {
      const statement = database.prepare(query);
      return statement.columns().length > 0
        ? statement.all(...bindings)
        : (statement.run(...bindings), []);
    },
  },
  transactionSync(operation) {
    database.exec("BEGIN");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  },
});

const verifyPin = async (
  directory: string,
  pin: { path: string; bytes: number; sha256: string },
) => {
  const bytes = await NodeFSP.readFile(NodePath.join(directory, pin.path));
  expect(bytes.byteLength).toBe(pin.bytes);
  expect(hash(bytes)).toBe(pin.sha256);
};

it.each([false, true])(
  "writes a frozen pending candidate snapshot with global/project lookup, project=%s",
  async (project) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "harness-ledger-candidate-"));
    const f = await candidateInput(root, project);
    try {
      const written = await writeClaudeReleaseLedgerCandidate(f.input);
      const { descriptor } = written;
      const output = f.input.outputDirectory;
      expect(descriptor.schema).toBe("signalbox/claude-release-ledger-candidate/v1");
      expect(descriptor.status).toBe("candidate");
      expect(descriptor.qualification).toBe("pending");
      expect(descriptor.variants.baseline.artifact.createdAt).toBe(f.input.createdAt);
      expect(descriptor.variants.hooks.artifact.createdAt).toBe(f.input.createdAt);
      expect(descriptor.scope).toBe(project ? "project" : "global");
      expect(Object.hasOwn(descriptor, "baselinePin")).toBe(false);
      expect(Object.hasOwn(descriptor, "baseline")).toBe(false);

      const baseline = descriptor.variants.baseline.artifact;
      const hooks = descriptor.variants.hooks.artifact;
      for (const [variant, artifact] of [
        ["baseline", baseline],
        ["hooks", hooks],
      ] as const) {
        expect(Object.keys(artifact).sort()).toEqual(
          [
            "provider",
            "releaseId",
            "artifactHash",
            "artifactRef",
            "sourceIdentity",
            "fixtureIdentity",
            "createdAt",
          ].sort(),
        );
        expect(artifact.provider).toBe("claude-code");
        expect(artifact.fixtureIdentity).toBe(
          hash(
            Buffer.from(
              canonicalJson({
                cli: descriptor.variants[variant].official.cli,
                sdk: descriptor.variants[variant].official.sdk,
              }),
            ),
          ),
        );
        expect(Number.isNaN(Date.parse(artifact.createdAt))).toBe(false);
      }
      expect(baseline.releaseId).toBe(
        [
          "claude-code",
          descriptor.variants.baseline.official.cli.version,
          "agent-sdk",
          descriptor.variants.baseline.official.sdk.version,
          f.input.baseline.identity.artifactHash,
        ].join(":"),
      );
      expect(hooks.releaseId).toBe(
        [
          "claude-code",
          descriptor.variants.hooks.official.cli.version,
          "agent-sdk",
          descriptor.variants.hooks.official.sdk.version,
          f.input.hooks.identity.artifactHash,
        ].join(":"),
      );
      expect(baseline.releaseId).not.toBe(hooks.releaseId);
      expect(baseline.artifactHash).toBe(f.input.baseline.identity.artifactHash);
      expect(hooks.artifactHash).toBe(f.input.hooks.identity.artifactHash);
      expect(baseline.sourceIdentity).toBe(f.input.baseline.identity.sourceIdentity);
      expect(hooks.sourceIdentity).toBe(f.input.hooks.identity.sourceIdentity);
      expect(baseline.createdAt).toBe(hooks.createdAt);
      expect(descriptor.variants.baseline.verifiedCandidateGraph.preparedModules).toHaveProperty(
        "cli/signalbox/release.js",
      );

      expect(descriptor.eligibility.baseline).toMatchObject({
        status: "pending",
        reasons: ["missing-local-proof", "missing-deployed-proof"],
      });
      expect(descriptor.eligibility.hooks).toMatchObject({
        status: "pending",
        reasons: ["missing-local-proof", "missing-deployed-proof"],
      });

      const database = new NodeSqlite.DatabaseSync(
        NodePath.join(output, descriptor.files.ledger.path),
        { readOnly: true },
      );
      try {
        const ledger = createHarnessReleaseLedger(
          project
            ? createHarnessProjectReleaseSqliteStore(storageFor(database), "project")
            : createHarnessReleaseSqliteStore(storageFor(database)),
        );
        for (const artifact of [baseline, hooks]) {
          expect(ledger.getArtifact("claude-code", artifact.releaseId)).toEqual(artifact);
          expect(ledger.listProofs("claude-code", artifact.releaseId)).toEqual([]);
          expect(ledger.getEligibility("claude-code", artifact.releaseId).status).toBe("pending");
        }
      } finally {
        database.close();
      }

      await verifyPin(output, descriptor.files.ledger);
      await verifyPin(output, written.candidateFile);
      for (const pin of Object.values(descriptor.files.baseline))
        await verifyPin(f.input.baseline.directory, pin);
      for (const pin of Object.values(descriptor.files.hooks))
        await verifyPin(f.input.hooks.directory, pin);
      for (const suffix of ["-wal", "-shm"])
        await expect(
          NodeFSP.stat(`${NodePath.join(output, descriptor.files.ledger.path)}${suffix}`),
        ).rejects.toMatchObject({ code: "ENOENT" });

      const before = await NodeFSP.readFile(NodePath.join(output, descriptor.files.ledger.path));
      await expect(writeClaudeReleaseLedgerCandidate(f.input)).rejects.toThrow(
        "HARNESS_CANDIDATE_OUTPUT_EXISTS",
      );
      expect(await NodeFSP.readFile(NodePath.join(output, descriptor.files.ledger.path))).toEqual(
        before,
      );
    } finally {
      f.close();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

it("rejects a prepared payload whose bytes no longer match the artifact identity", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "harness-ledger-corrupt-"));
  const f = await candidateInput(root, false);
  try {
    const modulePath = NodePath.join(f.input.baseline.directory, "cli/release.js");
    const corrupt = await NodeFSP.readFile(modulePath);
    corrupt[0] = corrupt[0] === 0x78 ? 0x79 : 0x78;
    await NodeFSP.writeFile(modulePath, corrupt);
    await expect(writeClaudeReleaseLedgerCandidate(f.input)).rejects.toThrow("FILE_HASH_MISMATCH");
    await expect(NodeFSP.stat(f.input.outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    f.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("does not emit a row when the prepared artifacts are not distinct", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "harness-ledger-duplicate-"));
  const f = await candidateInput(root, false);
  try {
    await NodeFSP.rm(f.input.hooks.directory, { recursive: true, force: true });
    await NodeFSP.cp(f.input.baseline.directory, f.input.hooks.directory, { recursive: true });
    const duplicateInput: ClaudeReleaseCandidateInput = {
      ...f.input,
      hooks: { ...f.input.hooks, identity: f.input.baseline.identity },
    };
    await expect(writeClaudeReleaseLedgerCandidate(duplicateInput)).rejects.toThrow(
      "HARNESS_CANDIDATE_VARIANTS_NOT_DISTINCT",
    );
    await expect(NodeFSP.stat(f.input.outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    f.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("rejects a pair whose official CLI releases differ", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "harness-ledger-mismatch-"));
  const f = await candidateInput(root, false, (cli) => {
    cli.release = { ...(cli.release as object), version: "2.1.304" };
  });
  try {
    await expect(writeClaudeReleaseLedgerCandidate(f.input)).rejects.toThrow(
      "HARNESS_CANDIDATE_OFFICIAL_CLI_MISMATCH",
    );
    await expect(NodeFSP.stat(f.input.outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    f.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("rejects swapped baseline and hooks graphs", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "harness-ledger-swapped-"));
  const f = await candidateInput(root, false);
  try {
    await expect(
      writeClaudeReleaseLedgerCandidate({
        ...f.input,
        baseline: f.input.hooks,
        hooks: f.input.baseline,
      }),
    ).rejects.toThrow("HARNESS_CANDIDATE_BASELINE_WORKER_ENTRIES");
    await expect(NodeFSP.stat(f.input.outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    f.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
