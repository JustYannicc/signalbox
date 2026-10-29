import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { fixture } from "./fixtures/claudeReleaseVariants.ts";
import { writeClaudeReleaseLedgerCandidate } from "./writeClaudeReleaseLedgerCandidate.ts";

const moduleBytes = (files: ReadonlyMap<string, Uint8Array>) =>
  [...files]
    .filter(([path]) => path.endsWith(".js"))
    .reduce((total, [, bytes]) => total + bytes.length, 0);

it.each([524288, 524289])(
  "enforces the hooks prepared-module delta cap at %s bytes",
  async (addedBytes) => {
    const original = await fixture(false);
    const initialDelta = moduleBytes(original.hooks.files) - moduleBytes(original.baseline.files);
    original.close();
    const f = await fixture(false, undefined, addedBytes - initialDelta);
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "harness-hooks-cap-"));
    try {
      expect(moduleBytes(f.hooks.files) - moduleBytes(f.baseline.files)).toBe(addedBytes);
      for (const [variant, prepared] of [
        ["baseline", f.baseline],
        ["hooks", f.hooks],
      ] as const) {
        for (const [path, bytes] of prepared.files) {
          const destination = NodePath.join(root, variant, path);
          await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
          await NodeFSP.writeFile(destination, bytes);
        }
      }
      const outputDirectory = NodePath.join(root, "candidate");
      const result = writeClaudeReleaseLedgerCandidate({
        createdAt: "2026-10-29T20:00:00.000Z",
        baseline: {
          directory: NodePath.join(root, "baseline"),
          identity: {
            artifactRef: f.baseline.fullArtifact.artifactRef,
            artifactHash: f.baseline.fullArtifact.artifactHash,
            sourceIdentity: f.baseline.fullArtifact.sourceIdentity,
          },
        },
        hooks: {
          directory: NodePath.join(root, "hooks"),
          identity: {
            artifactRef: f.hooks.fullArtifact.artifactRef,
            artifactHash: f.hooks.fullArtifact.artifactHash,
            sourceIdentity: f.hooks.fullArtifact.sourceIdentity,
          },
        },
        trustedComputer: f.input.trustedComputer,
        maxPreparedModuleBytes: 1048576,
        outputDirectory,
      });
      if (addedBytes === 524288) {
        const written = await result;
        expect(written.descriptor.qualification).toBe("pending");
      } else {
        await expect(result).rejects.toThrow("HARNESS_CANDIDATE_HOOKS_STARTUP_BYTES_EXCEEDED");
        await expect(NodeFSP.stat(outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      f.close();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);
