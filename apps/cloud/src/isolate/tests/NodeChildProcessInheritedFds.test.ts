import { expect, it } from "@effect/vitest";
import * as NodeStream from "node:stream";
import type { NodeChildProcess } from "../NodeChildProcess.ts";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { inheritedFdsFixture as harness } from "./NodeChildProcessInheritedFds.fixture.ts";

async function collect(child: NodeChildProcess) {
  const chunks: Uint8Array[] = [];
  child.stdout?.on("data", (chunk: Uint8Array) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    child.once("close", () => resolve());
    child.once("error", reject);
  });
  child.stdin?.end();
  await done;
  expect(child.exitCode).toBe(0);
  return Buffer.concat(chunks).toString();
}

it.each(["kernel", "computer"] as const)(
  "reads the parent's opened file at child fd 3 through %s",
  async (route) => {
    const h = harness(route);
    try {
      h.fs.writeFileSync("/work/target.txt", "single-file grep\n");
      const fd = h.fs.openSync(
        "/work/target.txt",
        KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_NONBLOCK,
      );
      const child = h.childProcess.spawn("/bin/read-fd", ["fd", "3"], {
        stdio: ["pipe", "pipe", "pipe", fd],
      });
      h.fs.closeSync(fd);
      expect(await collect(child)).toBe("single-file grep\n");
    } finally {
      await h.close();
    }
  },
);

it.each(["kernel", "computer"] as const)(
  "reopens sparse extra slots at the requested fd through %s",
  async (route) => {
    const h = harness(route);
    try {
      h.fs.writeFileSync("/work/target.txt", "skip:remaining bytes");
      const fd = h.fs.openSync("/work/target.txt", "r");
      const child = h.childProcess.spawn("/bin/read-fd", ["fd", "6"], {
        stdio: ["pipe", "pipe", "pipe", "ignore", null, undefined, fd],
      });
      expect(child.stdio.slice(3)).toEqual([null, null, null, null]);
      expect(await collect(child)).toBe("skip:remaining bytes");
      // Reading the child does not consume the parent's open file.
      expect(h.fs.readFileSync(fd).toString()).toBe("skip:remaining bytes");
      h.fs.closeSync(fd);
    } finally {
      await h.close();
    }
  },
);

it.each(["kernel", "computer"] as const)("opens /dev/fd/3 through %s", async (route) => {
  const h = harness(route);
  try {
    h.fs.writeFileSync("/work/target.txt", "single-file grep\n");
    const fd = h.fs.openSync("/work/target.txt", "r");
    const child = h.childProcess.spawn("/bin/read-fd", ["path", "/dev/fd/3"], {
      stdio: ["pipe", "pipe", "pipe", fd],
    });
    h.fs.closeSync(fd);
    expect(await collect(child)).toBe("single-file grep\n");
  } finally {
    await h.close();
  }
});

it("reopens extra descriptors for synchronous kernel children", async () => {
  const h = harness("kernel");
  try {
    h.fs.writeFileSync("/work/target.txt", "sync contents");
    const fd = h.fs.openSync("/work/target.txt", "r");
    const result = h.childProcess.spawnSync("/bin/read-fd", ["fd", "3"], {
      stdio: ["pipe", "pipe", "pipe", fd],
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout?.toString()).toBe("sync contents");
    h.fs.closeSync(fd);
  } finally {
    await h.close();
  }
});

it.each(["directory", "device", "write-only", "read-write", "unlinked"] as const)(
  "refuses an extra %s descriptor",
  async (kind) => {
    const h = harness("computer");
    try {
      h.fs.writeFileSync("/work/target.txt", "contents");
      const fd =
        kind === "directory"
          ? h.fs.openSync("/work", "r")
          : kind === "device"
            ? h.fs.openSync("/dev/null", "r")
            : h.fs.openSync(
                "/work/target.txt",
                kind === "write-only" ? "w" : kind === "read-write" ? "r+" : "r",
              );
      if (kind === "unlinked") h.fs.unlinkSync("/work/target.txt");
      expect(() =>
        h.childProcess.spawn("/bin/read-fd", { stdio: ["pipe", "pipe", "pipe", fd] }),
      ).toThrow(expect.objectContaining({ name: "NodeSystemError", code: "ENOTSUP" }));
      h.fs.closeSync(fd);
    } finally {
      await h.close();
    }
  },
);

it("continues to refuse IPC, stream objects and extra pipes", async () => {
  const h = harness("kernel");
  const stream = new NodeStream.PassThrough();
  try {
    for (const value of ["ipc", stream, "pipe", "inherit"]) {
      expect(() =>
        h.childProcess.spawn("/bin/read-fd", { stdio: ["pipe", "pipe", "pipe", value] }),
      ).toThrow(expect.objectContaining({ code: "ENOTSUP" }));
    }
  } finally {
    stream.destroy();
    await h.close();
  }
});

it.each(["kernel", "computer"] as const)(
  "refuses a nonzero inherited offset through %s",
  async (route) => {
    const h = harness(route);
    try {
      h.fs.writeFileSync("/work/target.txt", "offset contents");
      const fd = h.fs.openSync("/work/target.txt", "r");
      h.fs.readSync(fd, new Uint8Array(1), 0, 1, null);
      expect(() =>
        h.childProcess.spawn("/bin/read-fd", { stdio: ["pipe", "pipe", "pipe", fd] }),
      ).toThrow(expect.objectContaining({ code: "ENOTSUP" }));
      h.fs.closeSync(fd);
    } finally {
      await h.close();
    }
  },
);
