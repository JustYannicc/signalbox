import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { openHarnessReleaseArtifact } from "../../src/harnessReleases/HarnessReleaseArtifact.ts";
import { readHarnessReleaseDeployment } from "../../src/harnessReleases/HarnessReleaseDeployment.ts";
import { createHarnessReleaseLedger } from "../../src/harnessReleases/HarnessReleaseLedger.ts";
import { createHarnessProjectReleaseSqliteStore } from "../../src/harnessReleases/HarnessProjectReleaseSqliteStore.ts";
import { makeHarnessReleaseLedgerTestDatabase } from "../../src/harnessReleases/testing.ts";
import { prepareHarnessArtifact } from "./prepareArtifact.ts";
import { publishCodexRelease } from "./publishCodexRelease.ts";

it.each(["green", "pending", "rejected"] as const)(
  "packages only a qualified Codex release, status=%s",
  async (status) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codex-release-assets-"));
    const database = makeHarnessReleaseLedgerTestDatabase();
    try {
      const component = NodePath.join(root, "codex");
      await NodeFSP.mkdir(component);
      await NodeFSP.writeFile(NodePath.join(component, "manifest.json"), '{"version":"test"}');
      await NodeFSP.writeFile(
        NodePath.join(component, "engine.wasm"),
        new Uint8Array([0, 97, 115, 109]),
      );
      const directory = NodePath.join(root, "prepared");
      const identity = await prepareHarnessArtifact({
        harness: "codex",
        sourceIdentity: "a".repeat(64),
        computer: { sourceIdentity: "b".repeat(64), manifestSha256: "c".repeat(64) },
        components: { codex: component },
        output: directory,
      });
      const ledger = createHarnessReleaseLedger(
        createHarnessProjectReleaseSqliteStore(database.storage, "project"),
      );
      const artifact = ledger.registerArtifact({
        ...identity,
        provider: "codex",
        releaseId: "test",
        fixtureIdentity: "fixture",
        createdAt: "2026-10-30T00:00:00.000Z",
      });
      if (status !== "pending")
        for (const environment of ["local-workerd", "deployed-do"] as const)
          ledger.recordProof({
            ...artifact,
            proofId: environment,
            environment,
            recordedAt: artifact.createdAt,
            checks: {
              unchangedSource: "passed",
              boot: "passed",
              toolTurn: status === "rejected" ? "rejected" : "passed",
              resume: "passed",
              mcp: "passed",
              interrupt: "passed",
            },
            metrics: {
              bootTimeMs: { state: "measured", value: 1 },
              moduleBytes: { state: "measured", value: 4 },
              peakHeapBytes: { state: "measured", value: 8 },
            },
          });
      const ledgerPath = NodePath.join(root, "ledger.sqlite");
      await NodeSqlite.backup(database.database, ledgerPath);
      const before = await NodeFSP.readFile(ledgerPath);
      const assetsDirectory = NodePath.join(root, "assets");
      const input = {
        ledger: ledgerPath,
        projectId: "project",
        releaseId: "test",
        identity,
        directory,
        assetsDirectory,
      };
      if (status === "green") {
        const result = await publishCodexRelease(input);
        const opened = await readHarnessReleaseDeployment(
          {
            fetch: async (request) => {
              const path = new URL(request.url).pathname
                .slice(1)
                .split("/")
                .map(decodeURIComponent)
                .join("/");
              return new Response(
                Uint8Array.from(await NodeFSP.readFile(NodePath.join(assetsDirectory, path)))
                  .buffer,
              );
            },
          },
          result.deployment.pin,
          "project",
        );
        expect(opened.ledger.getArtifact("codex", "test")).toEqual(artifact);
        const release = await openHarnessReleaseArtifact(identity, opened.source);
        expect(Array.from(await release.read("codex/engine.wasm"))).toEqual([0, 97, 115, 109]);
        await expect(
          publishCodexRelease({
            ...input,
            identity: { ...identity, sourceIdentity: "f".repeat(64) },
          }),
        ).rejects.toThrow("HARNESS_DEPLOYMENT_LEDGER_MISMATCH");
      } else {
        await expect(publishCodexRelease(input)).rejects.toThrow(
          "HARNESS_DEPLOYMENT_NOT_QUALIFIED",
        );
        await expect(NodeFSP.stat(assetsDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await NodeFSP.readFile(ledgerPath)).toEqual(before);
    } finally {
      database.database.close();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);
