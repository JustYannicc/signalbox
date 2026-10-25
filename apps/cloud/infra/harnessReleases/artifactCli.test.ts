import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { runHarnessArtifactCli } from "./artifactCli.ts";
import { fixture } from "./fixtures/claudeReleaseVariants.ts";

it.each([
  ["green", false],
  ["pending", false],
  ["rejected", false],
  ["green", true],
  ["pending", true],
  ["rejected", true],
] as const)(
  "the normal artifact publisher emits only the exact green pair, qualification=%s project=%s",
  async (status, project) => {
    const f = await fixture(project);
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-variants-cli-"));
    try {
      if (status !== "pending")
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
                  status === "rejected" && fullArtifact.releaseId === "hooks"
                    ? "rejected"
                    : "passed",
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
      const database = NodePath.join(root, "ledger.sqlite");
      await NodeSqlite.backup(f.database, database);
      for (const [variant, artifact] of [
        ["baseline", f.baseline],
        ["hooks", f.hooks],
      ] as const)
        for (const [path, bytes] of artifact.files) {
          const destination = NodePath.join(root, variant, path);
          await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
          await NodeFSP.writeFile(destination, bytes);
        }
      const pin = NodePath.join(root, "baseline-pin.json");
      await NodeFSP.writeFile(pin, JSON.stringify(f.input.baselinePin));
      const output = NodePath.join(root, "variants.json");
      const args = [
        "--mode",
        "publish-claude-variants",
        "--directory",
        NodePath.join(root, "hooks"),
        "--baseline-directory",
        NodePath.join(root, "baseline"),
        "--baseline-pin",
        pin,
        "--ledger",
        database,
        "--baseline-release",
        "baseline",
        "--hooks-release",
        "hooks",
        "--computer-source-identity",
        f.input.trustedComputer.sourceIdentity,
        "--computer-manifest-sha256",
        f.input.trustedComputer.manifestSha256,
        "--max-prepared-module-bytes",
        "4096",
        "--result",
        output,
        ...(project ? ["--project-id", "project"] : []),
      ];
      const before = await NodeFSP.readFile(database);
      if (status === "green") {
        await runHarnessArtifactCli(args);
        expect(JSON.parse(await NodeFSP.readFile(output, "utf8"))).toEqual(f.input.catalog);
        await expect(runHarnessArtifactCli(args)).rejects.toMatchObject({ code: "EEXIST" });
        for (const builtVariant of ["hooks", "baseline"] as const) {
          const catalog = NodePath.join(root, `bound-${builtVariant}.json`);
          const publish = runHarnessArtifactCli([
            ...args.map((argument) => (argument === output ? catalog : argument)),
            "--expected-cli-manifest-sha256",
            NodeCrypto.createHash("sha256")
              .update(f[builtVariant].files.get("cli/manifest.json")!)
              .digest("hex"),
          ]);
          if (builtVariant === "hooks") {
            await publish;
            expect(JSON.parse(await NodeFSP.readFile(catalog, "utf8"))).toEqual(f.input.catalog);
          } else {
            await expect(publish).rejects.toThrow("CLAUDE_VARIANTS_BUILD_MISMATCH");
            await expect(NodeFSP.stat(catalog)).rejects.toMatchObject({ code: "ENOENT" });
          }
        }
      } else {
        await expect(runHarnessArtifactCli(args)).rejects.toThrow(
          status === "rejected"
            ? "CLAUDE_VARIANTS_REJECTED_PROOF"
            : "CLAUDE_VARIANTS_NOT_QUALIFIED",
        );
        await expect(NodeFSP.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await NodeFSP.readFile(database)).toEqual(before);
      expect(await NodeFSP.readFile(NodePath.join(root, "baseline/manifest.json"))).toEqual(
        Buffer.from(f.baseline.files.get("manifest.json")!),
      );
    } finally {
      f.close();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);
