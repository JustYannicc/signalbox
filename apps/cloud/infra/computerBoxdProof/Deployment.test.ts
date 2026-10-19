// @effect-diagnostics nodeBuiltinImport:off - exercise the private proof launcher files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  createReceiptFile,
  createStageFile,
  extractWorkerUrl,
  initialProofReceipt,
  readStageFile,
  workerEvidence,
  withCheck,
} from "./Deployment.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function makeRoot() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "computer-boxd-proof-"));
  roots.push(root);
  return root;
}

describe("computer boxd proof deployment helpers", () => {
  it("accepts only the flat worker evidence shape and keeps pending status", () => {
    const stage = "computer-boxd-12345678";
    const evidence = {
      status: "pending",
      vmNames: ["computer-sb-computer-boxd-12345678-source"],
      checks: { seed: "passed" },
      cleanupConfirmed: false,
    };

    expect(workerEvidence(evidence, stage)).toEqual({
      status: "pending",
      vmNames: evidence.vmNames,
      checks: { worker_seed: "passed" },
      cleanupConfirmed: false,
    });
    expect(() => workerEvidence({ ...evidence, trace: "private" }, stage)).toThrow(
      "invalid safe evidence",
    );
    expect(() =>
      workerEvidence({ ...evidence, vmNames: [evidence.vmNames[0], evidence.vmNames[0]] }, stage),
    ).toThrow("duplicate VM names");
    expect(() =>
      workerEvidence({ ...evidence, vmNames: ["computer-sb-other-source"] }, stage),
    ).toThrow("unowned VM name");
  });

  it("keeps stage and receipt files private while updating them atomically", async () => {
    const root = await makeRoot();
    const stage = "computer-boxd-abcdef12";
    const sourceCommit = "a".repeat(40);
    const stagePath = NodePath.join(root, "stage.json");
    const receiptPath = NodePath.join(root, "receipt.json");
    const claim = await createStageFile(stagePath, {
      version: 1,
      stage,
      sourceCommit,
      phase: "created",
    });
    await claim.update("deploying");
    const recovered = await readStageFile(stagePath);
    const receipt = initialProofReceipt(stage, sourceCommit);
    const writeReceipt = await createReceiptFile(receiptPath, receipt);
    const updated = withCheck(receipt, "proofRun", "passed");
    await writeReceipt(updated);

    expect(recovered.record.phase).toBe("deploying");
    expect((await NodeFSP.stat(stagePath)).mode & 0o7777).toBe(0o600);
    expect((await NodeFSP.stat(receiptPath)).mode & 0o7777).toBe(0o600);
    expect(JSON.parse(await NodeFSP.readFile(receiptPath, "utf8"))).toEqual(updated);
  });

  it("refuses a symlink as a recovery stage file", async () => {
    const root = await makeRoot();
    const target = NodePath.join(root, "target.json");
    const link = NodePath.join(root, "link.json");
    await NodeFSP.writeFile(target, "{}\n", { mode: 0o600 });
    await NodeFSP.symlink(target, link);

    await expect(readStageFile(link)).rejects.toThrow("Could not open the recovery stage file");
  });

  it("accepts only the stage-owned Workers.dev URL", () => {
    const stage = "computer-boxd-12345678";
    const owner = "sb-computer-boxd-12345678";
    expect(extractWorkerUrl(`url: 'https://${owner}.workers.dev'`, stage).hostname).toBe(
      `${owner}.workers.dev`,
    );
    expect(() => extractWorkerUrl("url: 'https://other.workers.dev'", stage)).toThrow(
      "outside the proof Worker",
    );
  });
});
