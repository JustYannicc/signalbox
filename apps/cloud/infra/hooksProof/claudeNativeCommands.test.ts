import { describe, expect, it } from "vite-plus/test";
import { KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import { createProofFilesystemHost } from "../claudeTurnProof/proofFilesystem.ts";
import { createProofTestStorage } from "../claudeTurnProof/proofTestStorage.ts";
import { createClaudeNativeCommands } from "./claudeNativeCommands.ts";
import {
  createStandardProofAdapter,
  standardProofFilledWrite,
  STANDARD_PROOF_WRITE,
} from "./standardProofAdapter.ts";
import {
  createStandardProofCommandViewHost,
  standardProofCommandViewArtifactsAvailable,
} from "./standardProofCommandViewFixture.ts";

function observe(child: ReturnType<ReturnType<typeof createClaudeNativeCommands>["spawn"]>) {
  return new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code: number | null, signal: string | null) => resolve({ code, signal }));
  });
}

describe.skipIf(!standardProofCommandViewArtifactsAvailable)("native Claude output files", () => {
  it("runs actual Bash with merged file stdio while the harness keeps canonical descriptors", async () => {
    const database = createProofTestStorage();
    const proof = createProofFilesystemHost(database.storage);
    const standard = createStandardProofAdapter(
      database.storage,
      "native-claude-output",
      undefined,
      proof.persistence.storage,
    );
    let programs: ReturnType<typeof createStandardProofCommandViewHost> | undefined;
    try {
      await standard.prepare();
      proof.fs.fs.writeFileSync("/work/official-write.txt", STANDARD_PROOF_WRITE);
      proof.fs.fs.writeFileSync("/work/output", "");
      for (const path of ["/bin/bash", "/bin/cat"]) {
        proof.fs.fs.writeFileSync(path, "");
        proof.filesystem.chmod(path, 0o755);
      }
      const root = proof.filesystem;
      const output = root.open("/work/output", KernelOpenFlags.O_WRONLY);
      const held = root.open("/work/official-write.txt", KernelOpenFlags.O_RDONLY);
      const heldDescription = root.descriptors.get(held);
      const outputDescription = root.descriptors.get(output);
      const before = [...root.descriptors.entries()].map(([fd]) => fd);
      programs = createStandardProofCommandViewHost({
        filesystem: root,
        wakes: proof.wakes,
        selectFileBytes: standard.selectFileBytes,
      });
      const commands = createClaudeNativeCommands(
        programs.host,
        { filesystem: root, env: { HOME: "/home/claude", PATH: "/bin" } },
        standard,
      );
      const child = commands.spawn(
        "/bin/bash",
        ["--noprofile", "--norc", "-c", "cat /work/official-write.txt; printf tail >&2"],
        { cwd: "/work", stdio: ["ignore", output, output] },
      );
      const exit = await observe(child);
      const diagnostic = standard.output.takeFileRead("/work/official-write.txt");
      expect({ exit, output: new TextDecoder().decode(diagnostic?.stdout) }).toEqual({
        exit: { code: 0, signal: null },
        output: `${standardProofFilledWrite()}tail`,
      });
      expect(await programs.host.processes.dispose()).toMatchObject({ status: "ok" });
      expect(programs.capacity.active).toBe(0);
      expect(root.descriptors.get(held)).toBe(heldDescription);
      expect(heldDescription.offset).toBe(0n);
      expect(heldDescription.byteAccess).toBeUndefined();
      expect(root.descriptors.get(output)).toBe(outputDescription);
      expect(outputDescription.byteAccess).toBeUndefined();
      expect([...root.descriptors.entries()].map(([fd]) => fd)).toEqual(before);
      const canonicalOutput = `${standard.scrub(standardProofFilledWrite())}tail`;
      expect(proof.fs.fs.readFileSync("/work/output", "utf8")).toBe(canonicalOutput);
      expect(outputDescription.offset).toBe(
        BigInt(new TextEncoder().encode(canonicalOutput).length),
      );
      const captured = diagnostic;
      expect(captured?.executable).toBe("/bin/bash");
      expect(new TextDecoder().decode(captured?.stdout)).toBe(`${standardProofFilledWrite()}tail`);
      expect(proof.fs.fs.readFileSync("/work/official-write.txt", "utf8")).toBe(
        STANDARD_PROOF_WRITE,
      );
      root.close(output);
      root.close(held);
    } finally {
      if (programs) await programs.host.processes.dispose();
      standard.close();
      proof.filesystem.dispose();
      proof.persistence.dispose();
      proof.wakes.dispose();
      database.close();
    }
  });
});
