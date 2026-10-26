// @effect-diagnostics nodeBuiltinImport:off - The fixture verifies imported Git index checksums.
import * as NodeCrypto from "node:crypto";
import { vi } from "vite-plus/test";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import type { Inode } from "../../kernel/storage.ts";
import {
  createCodexLocaleProductComputer,
  type CodexLocalePrograms,
} from "./CodexLocaleProductComputerFixture.ts";

export function gitRepositoryFixture(
  programs: CodexLocalePrograms,
  options: { readonly nowNs?: () => bigint; readonly beforeTrackedRead?: () => void } = {},
) {
  let nowNs = 1_700_000_000_000_000_000n;
  const fixture = createCodexLocaleProductComputer(programs, {
    nowNs: options.nowNs ?? (() => nowNs),
  });
  const fs = createNodeFs(fixture.filesystem).fs;
  const reads: { inode: Inode; bytes: number }[] = [];
  const tracked = new Set<Inode>();
  const storage = fixture.filesystem.resolve("/workspace").mount.storage;
  const originalRead = storage.readInto.bind(storage);
  const spy = vi.spyOn(storage, "readInto").mockImplementation((inode, offset, target) => {
    if (tracked.has(inode)) options.beforeTrackedRead?.();
    const result = originalRead(inode, offset, target);
    if (tracked.has(inode)) {
      if (typeof result !== "number") throw new Error("Git fixture needs synchronous storage");
      reads.push({ inode, bytes: result });
    }
    return result;
  });

  return {
    ...fixture,
    fs,
    reads,
    advanceClock() {
      // Imported file metadata predates readiness. Same-second behavior is tested separately.
      nowNs += 2_000_000_000n;
    },
    track(path: string) {
      tracked.add(fixture.filesystem.resolve(`/workspace/${path}`).inode);
    },
    clearReads() {
      reads.length = 0;
    },
    zeroIndexStats() {
      const path = "/workspace/.git/index";
      const original = fs.readFileSync(path);
      if (!(original instanceof Uint8Array)) throw new Error("Index is not bytes");
      const bytes = new Uint8Array(original);
      const view = new DataView(bytes.buffer);
      if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "DIRC" || view.getUint32(4) !== 2)
        throw new Error("Fixture requires a Git v2 index");
      const count = view.getUint32(8);
      let offset = 12;
      for (let i = 0; i < count; i++) {
        if ((view.getUint16(offset + 60) & 0x4000) !== 0)
          throw new Error("Fixture does not rewrite extended index flags");
        const end = bytes.indexOf(0, offset + 62);
        if (end < 0) throw new Error("Index entry has no terminator");
        bytes.fill(0, offset, offset + 24);
        bytes.fill(0, offset + 28, offset + 40);
        offset += Math.ceil((end + 1 - offset) / 8) * 8;
      }
      bytes.set(
        NodeCrypto.createHash("sha1").update(bytes.subarray(0, -20)).digest(),
        bytes.length - 20,
      );
      fs.writeFileSync(path, bytes);
    },
    async close() {
      spy.mockRestore();
      await fixture.close();
    },
  };
}

export async function runGit(
  fixture: ReturnType<typeof gitRepositoryFixture>,
  args: readonly string[],
  cwd = "/workspace",
) {
  const child = await fixture.computer.exec(
    {
      executable: "/usr/bin/git",
      argv: ["git", ...args],
      cwd,
      env: { HOME: "/home/codex", LANG: "C" },
    },
    new AbortController().signal,
    undefined,
  );
  try {
    const input = child.stdin.getWriter();
    await input.close();
    input.releaseLock();
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, ...exit };
  } finally {
    await child.dispose();
  }
}
