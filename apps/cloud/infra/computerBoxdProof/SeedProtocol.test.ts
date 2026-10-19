import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";

const artifact = vi.hoisted(() => ({
  bytes: 256,
  sha256: "40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880",
}));
vi.mock("../../src/kernel/KernelBashProgram.ts", () => ({ KERNEL_BASH_ARTIFACT: artifact }));
vi.mock("../../src/kernel/KernelBusyboxProgram.ts", () => ({ KERNEL_BUSYBOX_ARTIFACT: artifact }));
vi.mock("../../src/kernel/KernelRipgrepProgram.ts", () => ({ KERNEL_RIPGREP_ARTIFACT: artifact }));

import { decodeProofSeed } from "./SeedProtocol.ts";

function fixture() {
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  const code = { mainModule: "main.js", modules: { "main.js": "export {};" } };
  const source = "export const message = '雪';";
  return {
    sourceCommit: "a".repeat(40),
    runner: { source, sha256: NodeCrypto.createHash("sha256").update(source).digest("hex") },
    programs: { bash: code, busyboxCat: code, ripgrep: code },
    executables: ["/bin/bash", "/bin/cat", "/bin/rg"].map((path) => ({
      path,
      data: Buffer.from(bytes).toString("base64"),
      sha256: artifact.sha256,
    })),
  };
}

describe("real-machine proof seed decoding", () => {
  it("preserves every byte value and the UTF-8 Runner under the pinned hashes", async () => {
    const input = fixture();
    const decoded = await decodeProofSeed(input);
    expect(decoded.runner.bytes).toEqual(new TextEncoder().encode(input.runner.source));
    for (const executable of decoded.executables) {
      expect(executable.bytes).toEqual(Uint8Array.from({ length: 256 }, (_, index) => index));
      expect(NodeCrypto.createHash("sha256").update(executable.bytes).digest("hex")).toBe(
        artifact.sha256,
      );
    }
  });

  it("rejects changed executable bytes even when the caller preserves the declared hash", async () => {
    const input = fixture();
    input.executables[0]!.data = Buffer.alloc(256).toString("base64");
    await expect(decodeProofSeed(input)).rejects.toThrow(
      "Proof executable does not match its pinned artifact",
    );
  });

  it("rejects duplicate executable identities", async () => {
    const input = fixture();
    input.executables[1]!.path = "/bin/bash";
    await expect(decodeProofSeed(input)).rejects.toThrow("Duplicate proof executable");
  });
});
