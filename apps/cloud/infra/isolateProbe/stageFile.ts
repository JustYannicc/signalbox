// @effect-diagnostics nodeBuiltinImport:off - retain only an owned stage identifier for runner cancellation recovery.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

export const isolatedStage = /^isolate-probe-[a-f0-9]{8,20}$/;

export async function stageFile(path: string, createStage?: string) {
  const handle = await NodeFSP.open(
    path,
    createStage === undefined ? NodeFS.constants.O_RDWR | NodeFS.constants.O_NOFOLLOW : "wx+",
    0o600,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 100 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Stage file must be an owned regular file with mode 0600.");
    if (createStage !== undefined) {
      if (!isolatedStage.test(createStage)) throw new Error("Invalid probe stage.");
      await handle.writeFile(`${createStage}\n`);
      await handle.sync();
    }
    const buffer = Buffer.alloc(100);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const contents = buffer.subarray(0, bytesRead).toString("utf8");
    const match = /^(isolate-probe-[a-f0-9]{8,20})\n(cleanup-failed\n)?$/.exec(contents);
    if (!match) throw new Error("Invalid probe stage file.");
    const stage = match[1]!;
    const assertOwned = async () => {
      const current = await NodeFSP.lstat(path);
      if (current.dev !== stat.dev || current.ino !== stat.ino)
        throw new Error("Stage file was replaced; leaving it untouched.");
    };
    return {
      stage,
      cleanupFailed: match[2] !== undefined,
      async markFailed() {
        await assertOwned();
        await handle.write(`${stage}\ncleanup-failed\n`, 0, "utf8");
        await handle.sync();
      },
      async remove() {
        await assertOwned();
        await NodeFSP.unlink(path);
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
