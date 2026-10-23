import { describe, expect, it, vi } from "vite-plus/test";
import { createKernelCoreutilsHost } from "../../kernel/KernelCoreutilsHost.ts";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { createChildCoreutils } from "../ChildCoreutils.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";
import { coreutilsArtifactsAvailable, coreutilsModule } from "./CoreutilsArtifactFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe.skipIf(!coreutilsArtifactsAvailable)("buffered head byte mode", () => {
  it("reads exactly its byte limit from a file, including the final partial buffer", async () => {
    const limit = 1024 * 1024 + 17;
    const input = Uint8Array.from({ length: limit + 31 }, (_, i) => i % 251);
    const fixture = childBusyboxFixture({
      args: ["head", "-c", String(limit), "input"],
      env: { PATH: "/bin", PWD: "/workspace" },
    });
    const fd = fixture.filesystem.open("input", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY);
    fixture.filesystem.write(fd, input, null);
    fixture.filesystem.close(fd);
    const owner = createKernelCoreutilsHost({ context: fixture.context });
    let bytesRead = 0;
    const port = {
      ...owner.port,
      async call(request: Parameters<typeof owner.port.call>[0]) {
        const response = await owner.port.call(request);
        if (request.name === "fd_read" && response.kind === "return" && response.value === 0) {
          const pointer = Number(request.args[3]);
          const region = response.regions.find(
            (region) =>
              region.pointer <= pointer && region.pointer + region.bytes.length >= pointer + 4,
          )!;
          bytesRead += new DataView(region.bytes.buffer, region.bytes.byteOffset).getUint32(
            pointer - region.pointer,
            true,
          );
        }
        return response;
      },
    };
    try {
      expect(
        await createChildCoreutils({
          module: coreutilsModule("head"),
          port,
          args: fixture.context.args,
          env: fixture.context.env,
        }).run(),
      ).toEqual(exited());
      expect(fixture.stdout()).toEqual(input.subarray(0, limit));
      expect(bytesRead).toBe(limit);
    } finally {
      await owner.close();
      await fixture.close();
    }
  });

  it("reports an output error when its final buffered flush fails", async () => {
    const fixture = childBusyboxFixture({
      args: ["head", "-c", "7", "input"],
      env: { PATH: "/bin", PWD: "/workspace" },
    });
    fixture.write("input", "payload trailing");
    vi.spyOn(fixture.filesystem.descriptors.get(1).stdio!, "write").mockImplementation(() => {
      throw Object.assign(new Error("Output device failed"), { code: "EIO" });
    });
    const owner = createKernelCoreutilsHost({ context: fixture.context });
    try {
      const result = await createChildCoreutils({
        module: coreutilsModule("head"),
        port: owner.port,
        args: fixture.context.args,
        env: fixture.context.env,
      }).run();
      expect(result.exitCode).not.toBe(0);
      expect(fixture.stderr()).toContain("I/O error");
    } finally {
      await owner.close();
      await fixture.close();
      vi.restoreAllMocks();
    }
  });
});
