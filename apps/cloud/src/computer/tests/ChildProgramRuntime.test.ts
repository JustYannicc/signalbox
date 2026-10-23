import { describe, expect, it, vi } from "vite-plus/test";
import { createSeededChildProgramCatalog } from "../../../infra/childPrograms/runtime.ts";
import { KernelProgramRegistry } from "../../kernel/KernelAbi.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { childBusyboxFixture } from "./ChildBusyboxFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("seeded child program registration", () => {
  it("registers all program bindings without reading any executable bytes", async () => {
    const f = childBusyboxFixture();
    const open = vi.spyOn(f.filesystem, "open");
    const read = vi.spyOn(f.filesystem, "read");
    const run = vi.fn();
    const code = { mainModule: "main.js", modules: { "main.js": "export default {};" } };
    try {
      const catalog = createSeededChildProgramCatalog({
        filesystem: f.filesystem,
        registry: new KernelProgramRegistry(),
        capacity: new ChildWorkerCapacity(10),
        loader: { run },
        hostname: "lazy-program-test",
        programs: { bash: code, busyboxCat: code, ripgrep: code },
      });
      expect([...catalog.bindings.keys()]).toEqual(["/bin/bash", "/bin/sh", "/bin/cat", "/bin/rg"]);
      expect(open).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      await catalog.drain();
    } finally {
      await f.close();
    }
  });
});
