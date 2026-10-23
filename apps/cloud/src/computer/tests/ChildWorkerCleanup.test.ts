import { expect, it, vi } from "vite-plus/test";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createChildWorkerProgram } from "../ChildWorkerProgram.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";

it("closes owned descriptors and finishes stop handling when a host disposer fails", async () => {
  const fixture = childBusyboxFixture();
  const capacity = new ChildWorkerCapacity(1, { owner: "test/failed-host-disposer" });
  const failure = new Error("Host capability disposal failed");
  const fd = fixture.filesystem.open(
    "cleanup-output",
    KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR,
  );
  const stopped = vi.fn();
  const program = createChildWorkerProgram({
    executable: "/bin/tool",
    code: { mainModule: "main.js", modules: { "main.js": "export default {}" } },
    capacity,
    dispatch: { run: async () => exited(7) },
    createHost(_context, lease) {
      lease.hold({}, () => {
        throw failure;
      });
      return {
        host: {},
        close() {
          fixture.filesystem.close(fd);
        },
        onStopped: stopped,
      };
    },
  });
  try {
    await expect(program.run(fixture.context)).rejects.toBe(failure);
    await program.drain();
    expect(() => fixture.filesystem.read(fd, new Uint8Array(1), null)).toThrow(
      expect.objectContaining({ code: "EBADF" }),
    );
    expect(stopped).toHaveBeenCalledOnce();
    expect(capacity.active).toBe(0);
  } finally {
    await fixture.close();
  }
});
