import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { downloadNpmArchives } from "./claudeSdkArchives.ts";

const originalFetch = globalThis.fetch;
const temporary: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(
    temporary.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

function integrity(bytes: Uint8Array) {
  return `sha512-${NodeCrypto.createHash("sha512").update(bytes).digest("base64")}`;
}

async function directory() {
  const path = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-sdk-archives-"));
  temporary.push(path);
  return path;
}

describe("Claude SDK npm archive download", () => {
  it("deduplicates pinned registry archives and preserves their verified bytes", async () => {
    const bytes = Buffer.from("official npm package archive");
    const resolved = "https://registry.npmjs.org/example/-/example-1.0.0.tgz";
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      const response = new Response(bytes, {
        headers: { "content-length": String(bytes.byteLength) },
      });
      Object.defineProperty(response, "url", { value: url });
      return response;
    };

    const archiveDir = await directory();
    const pin = { integrity: integrity(bytes), resolved };
    const archives = await downloadNpmArchives([pin, pin], archiveDir);

    expect(requests).toEqual([resolved]);
    expect([...archives.keys()]).toEqual([pin.integrity]);
    const archive = archives.get(pin.integrity)!;
    expect(await NodeFSP.readFile(archive.path)).toEqual(bytes);
    expect(archive).toEqual({
      path: archive.path,
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
    });
  });

  it("rejects bytes that differ from the lockfile integrity before saving them", async () => {
    const directoryPath = await directory();
    const resolved = "https://registry.npmjs.org/example/-/example-1.0.0.tgz";
    const bytes = Buffer.from("different archive bytes");
    const expected = integrity(Buffer.from("pinned archive bytes"));
    globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      const response = new Response(bytes);
      Object.defineProperty(response, "url", { value: url });
      return response;
    };

    await expect(
      downloadNpmArchives([{ integrity: expected, resolved }], directoryPath),
    ).rejects.toThrow("CLAUDE_SDK_DEPENDENCY_INTEGRITY_MISMATCH");
    expect(await NodeFSP.readdir(directoryPath)).toEqual([]);
  });

  it("rejects non-registry tarball URLs before making a request", async () => {
    let requested = false;
    globalThis.fetch = async () => {
      requested = true;
      throw new Error("unexpected fetch");
    };

    await expect(
      downloadNpmArchives(
        [{ integrity: integrity(Buffer.alloc(64)), resolved: "https://example.com/package.tgz" }],
        await directory(),
      ),
    ).rejects.toThrow("CLAUDE_SDK_DEPENDENCY_REGISTRY_REQUIRED");
    expect(requested).toBe(false);
  });
});
