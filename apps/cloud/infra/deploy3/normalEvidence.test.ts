import * as NodeAssert from "node:assert/strict";
import * as TestCase from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { controlDigest } from "./controlRegistry.ts";
import { exportDeploy3Locally, verifyDeploy3LocalExport } from "./normalEvidence.ts";
import { releaseDeploy3FromLocalEvidence, cleanupReleasedDeploy3 } from "./normalOperator.ts";
import { controlFixture } from "./control.fixture.ts";
import { inspectEvidenceInventory } from "./evidenceInventory.ts";
import { releaseDeploy3Owner } from "./controlLifecycle.ts";

async function exportFixture() {
  const bytes = new TextEncoder().encode("full local evidence");
  const ref = {
    id: "journal-1",
    bytes: bytes.length,
    sha256: await controlDigest("full local evidence"),
  };
  const entries = [
    ["blob/journal-1/ref", ref],
    ["journal/record/0000000001", { sequence: 1, kind: "result", payload: ref }],
    ["journal/reservation/0000000001", { sequence: 1, kind: "result", payloadHash: ref.sha256 }],
  ];
  const fetchImpl: typeof fetch = async (input) =>
    String(input).includes("/export/page")
      ? Response.json({ entries, next: null })
      : new Response(bytes);
  return { fetchImpl, entries };
}

TestCase.test(
  "normal export round-trips every blob, detects corruption and releases only the matching owner",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deploy3-normal-"));
    try {
      const fixture = controlFixture();
      const state = (await fixture.api().read()).controls[0]!;
      const directory = NodePath.join(root, "export");
      const source = await exportFixture();
      const input = {
        origin: "https://qualifier.example",
        qualifierRunId: "source-run",
        runId: "deadbeef",
        registrationSha256: state.registrationSha256,
        directory,
        fetchImpl: source.fetchImpl,
      };
      const verified = await exportDeploy3Locally(input);
      const releaseFile = NodePath.join(root, "release.json");
      await NodeFSP.writeFile(
        releaseFile,
        JSON.stringify({
          ...verified,
          owner: "1070",
          release: true,
          runId: "deadbeef",
          registrationSha256: state.registrationSha256,
          sourceMessageId: "message:actual-owner-release",
          fullText: "I release this exact deployment after verifying the full local export.",
        }),
      );
      const release = {
        api: fixture.api(),
        runId: "deadbeef",
        owner: "1070" as const,
        directory,
        explicitReleaseFile: releaseFile,
      };
      await NodeFSP.writeFile(NodePath.join(directory, "blob-0.bin"), "corrupt");
      await NodeAssert.rejects(
        releaseDeploy3FromLocalEvidence(release),
        /Local exported file differs/,
      );
      NodeAssert.equal(fixture.comments.length, 1);
      await NodeFSP.writeFile(NodePath.join(directory, "blob-0.bin"), "full local evidence");
      NodeAssert.deepEqual(await verifyDeploy3LocalExport(input), verified);
      await releaseDeploy3FromLocalEvidence(release);
      NodeAssert.deepEqual((await fixture.api().read()).controls[0]!.ownersNotReleased, ["1255"]);
      await NodeAssert.rejects(
        cleanupReleasedDeploy3({
          api: fixture.api(),
          runId: "deadbeef",
          accountId: fixture.env.DEPLOY3_ACCOUNT_ID,
          cloudflareToken: "exact-token",
          nowMs: Date.parse(state.deadlineUtc) - 1_000,
          fetchImpl: fixture.fetchImpl,
        }),
        /still needs an owner's verified export/,
      );
      NodeAssert.equal(fixture.cf.present(), true);
      await releaseDeploy3Owner({
        api: fixture.api("owner1255"),
        runId: "deadbeef",
        owner: "1255",
        async verifyLocalExportAndExplicitRelease() {
          return { ...verified, explicitReleaseSha256: "f".repeat(64) };
        },
      });
      const cleanup = await cleanupReleasedDeploy3({
        api: fixture.api(),
        runId: "deadbeef",
        accountId: fixture.env.DEPLOY3_ACCOUNT_ID,
        cloudflareToken: "exact-token",
        nowMs: Date.parse(state.deadlineUtc) - 1_000,
        fetchImpl: fixture.fetchImpl,
      });
      NodeAssert.equal(cleanup.cleanClaim, true);
      NodeAssert.equal(fixture.cf.present(), false);
      NodeAssert.match(
        await NodeFSP.readFile(NodePath.join(directory, "inventory.json"), "utf8"),
        /journal-1/,
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

TestCase.test(
  "unfinished journal reservations or omitted blobs cannot count as a full export",
  async () => {
    const fixture = await exportFixture();
    NodeAssert.equal(inspectEvidenceInventory(fixture.entries).length, 1);
    NodeAssert.throws(
      () =>
        inspectEvidenceInventory(
          fixture.entries.filter(([key]) => key !== "journal/record/0000000001"),
        ),
      /unfinished reservations/,
    );
    NodeAssert.throws(
      () =>
        inspectEvidenceInventory(fixture.entries.filter(([key]) => key !== "blob/journal-1/ref")),
      /journal is empty/,
    );
  },
);
