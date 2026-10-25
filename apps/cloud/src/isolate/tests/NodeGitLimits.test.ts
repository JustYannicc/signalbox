import { describe, expect, it } from "@effect/vitest";
import { createNodeFs } from "../NodeFs.ts";
import { createNodeGitProgram } from "../NodeGit.ts";
import {
  createLocalGitRunner,
  createNodeGitFixture,
  createSmartHttpServer,
  finishGit,
  packWithOversizedDeclaredObject,
  packWithOversizedInflatedObject,
  spawnGit,
} from "./helpers/NodeGitFixture.ts";

describe("NodeGit HTTP limits", () => {
  it("rejects a pack object whose declared size exceeds the per-object budget", async () => {
    await expectPackRejected(
      packWithOversizedDeclaredObject(),
      { maxObjectBytes: 1024, maxTotalObjectBytes: 4096 },
      "configured 1024-byte limit",
    );
  });

  it("stops streaming inflation before an object exceeds its per-object budget", async () => {
    await expectPackRejected(
      packWithOversizedInflatedObject(),
      { maxObjectBytes: 32, maxTotalObjectBytes: 4096 },
      "configured 32-byte limit",
    );
  });

  it("rejects packs whose aggregate object bytes exceed the total budget", async () => {
    await expectPackRejected(
      undefined,
      { maxObjectBytes: 1024, maxTotalObjectBytes: 100 },
      "configured 100-byte object budget",
    );
  });

  it("cancels an oversized chunked transfer before buffering the pack", async () => {
    const fixture = createNodeGitFixture();
    const base = createSmartHttpServer({ authenticate: false });
    let cancelled = false;
    let packRequests = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/git-upload-pack")) {
        packRequests += 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(gitPacketLine(new TextEncoder().encode("NAK\n")));
              for (let index = 0; index < 11; index += 1) {
                const sideband = new Uint8Array(96).fill(index);
                sideband[0] = 1;
                controller.enqueue(gitPacketLine(sideband));
              }
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/x-git-upload-pack-result" } },
        );
      }
      return base.fetch(input, init);
    };
    try {
      const program = createNodeGitProgram({
        local: createLocalGitRunner(),
        fetch,
        maxTransferBytes: 1024,
      });
      const { host, handle } = await spawnGit(fixture.filesystem, program, [
        "/usr/bin/git",
        "clone",
        "https://git.invalid/remote.git",
        "oversized",
      ]);
      const status = await finishGit(host, handle);

      expect(status.exitCode).toBe(128);
      expect(fixture.stderr()).toContain("configured 1024-byte budget");
      expect(packRequests).toBe(1);
      expect(cancelled).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it("rejects declared response bytes that exceed the remaining command budget", async () => {
    const fixture = createNodeGitFixture();
    const base = createSmartHttpServer({ authenticate: false });
    const maxTransferBytes = 4096;
    let advertisementBytes = 0;
    let packBodyRead = false;
    let packBodyCancelled = false;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/info/refs")) {
        const response = await base.fetch(input, init);
        const body = new Uint8Array(await response.arrayBuffer());
        advertisementBytes += body.byteLength;
        return new Response(body, {
          status: response.status,
          headers: {
            "content-type": "application/x-git-upload-pack-advertisement",
            "content-length": String(body.byteLength),
          },
        });
      }
      if (url.pathname.endsWith("/git-upload-pack")) {
        const requestBody = init?.body;
        if (!(requestBody instanceof ArrayBuffer)) throw new Error("Missing buffered Git request");
        const remainingBytes = maxTransferBytes - advertisementBytes - requestBody.byteLength;
        if (remainingBytes < 1)
          throw new Error("Fixture did not leave room for a declared response");
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                packBodyRead = true;
                controller.enqueue(new Uint8Array([1]));
                controller.close();
              },
              cancel() {
                packBodyCancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          {
            headers: {
              "content-type": "application/x-git-upload-pack-result",
              "content-length": String(remainingBytes + 1),
            },
          },
        );
      }
      return base.fetch(input, init);
    };
    try {
      const program = createNodeGitProgram({
        local: createLocalGitRunner(),
        fetch,
        maxTransferBytes,
      });
      const { host, handle } = await spawnGit(fixture.filesystem, program, [
        "/usr/bin/git",
        "clone",
        "https://git.invalid/remote.git",
        "declared-overrun",
      ]);
      const status = await finishGit(host, handle);

      expect(status.exitCode).toBe(128);
      expect(fixture.stderr()).toContain("configured 4096-byte budget");
      expect(packBodyRead).toBe(false);
      expect(packBodyCancelled).toBe(true);
    } finally {
      fixture.close();
    }
  });
});

async function expectPackRejected(
  pack: Uint8Array | undefined,
  budgets: { readonly maxObjectBytes: number; readonly maxTotalObjectBytes: number },
  message: string,
): Promise<void> {
  const fixture = createNodeGitFixture();
  const server = createSmartHttpServer({
    authenticate: false,
    ...(pack === undefined ? {} : { pack }),
  });
  try {
    const program = createNodeGitProgram({
      local: createLocalGitRunner(),
      fetch: server.fetch,
      ...budgets,
    });
    const { host, handle } = await spawnGit(fixture.filesystem, program, [
      "/usr/bin/git",
      "clone",
      "--no-checkout",
      "https://git.invalid/remote.git",
      "limited",
    ]);
    const status = await finishGit(host, handle);

    expect(status.exitCode).toBe(128);
    expect(fixture.stderr()).toContain(message);
    expect(createNodeFs(fixture.filesystem).fs.existsSync("/work/limited/.git")).toBe(false);
  } finally {
    fixture.close();
  }
}

function gitPacketLine(body: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode((body.byteLength + 4).toString(16).padStart(4, "0"));
  const packet = new Uint8Array(header.byteLength + body.byteLength);
  packet.set(header);
  packet.set(body, header.byteLength);
  return packet;
}
