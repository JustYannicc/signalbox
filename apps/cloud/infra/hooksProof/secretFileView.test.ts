import { describe, expect, it } from "vite-plus/test";
import { createSecretFileByteView } from "../../src/connections/SecretFileBytes.ts";
import { createNodeFs } from "../../src/isolate/NodeFs.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import { createKernelRevisionWorkspace } from "../../src/kernel/KernelRevisionWorkspace.ts";
import { createKernelSyscallHost } from "../../src/kernel/KernelSyscallHost.ts";
import { createProofFilesystemHost } from "../claudeTurnProof/proofFilesystem.ts";
import { createProofTestStorage } from "../claudeTurnProof/proofTestStorage.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bindings = [
  { placeholder: "{{secret:SHORT}}", value: "short-七" },
  { placeholder: "{{op://proof/item/password}}", value: "longer-than-the-token-秘密-".repeat(3) },
];
const canonical = `prefix ${bindings[0]!.placeholder} / ${bindings[1]!.placeholder}`;
const materialized = `prefix ${bindings[0]!.value} / ${bindings[1]!.value}`;
const base = { repository: "secret-view-fixture", fork: "proof", commit: "initial" };

function rig(content = canonical, bindingInputs = bindings) {
  const database = createProofTestStorage();
  const host = createProofFilesystemHost(database.storage);
  const storage = host.persistence.storage;
  host.fs.fs.writeFileSync("/work/file", content);
  host.ports.seedFile(base, "/file", encode(content));
  const view = createSecretFileByteView({
    canonical: storage,
    transactions: {
      storage,
      run: (operation) => database.storage.transactionSync(() => operation(storage)),
    },
    bindings: bindingInputs,
  });
  const raw = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    fileBytes: { kind: "view", view },
  });
  const node = createNodeFs(raw).fs;
  const workspace = createKernelRevisionWorkspace({
    database: database.storage,
    persistence: host.persistence,
    filesystem: host.filesystem,
    mountPath: "/work",
    initial: base,
  });
  return {
    host,
    raw,
    node,
    workspace,
    close() {
      raw.dispose();
      host.filesystem.dispose();
      host.persistence.dispose();
      host.wakes.dispose();
      database.close();
    },
  };
}

describe("secret file views across the execution and persistence boundaries", () => {
  it.each(bindings)(
    "refuses every interior byte cut of $placeholder across a storage boundary",
    async (binding) => {
      const prefix = "x".repeat(65_534);
      const content = `${prefix}${binding.placeholder} tail`;
      const filled = `${prefix}${binding.value} tail`;
      const fixture = rig(content, [binding]);
      const { host, raw, node, workspace } = fixture;
      const start = BigInt(encode(prefix).length);
      const length = encode(binding.value).length;
      try {
        const fd = raw.open("/work/file", KernelOpenFlags.O_RDWR);
        expect(raw.read(fd, new Uint8Array(Number(start)), null)).toBe(Number(start));
        await workspace.checkpoint("before-byte-cuts", new AbortController().signal);
        const tree = host.ports.committedTurns.at(-1)!.tree;
        const unchanged = async () => {
          expect(raw.descriptors.get(fd).offset).toBe(start);
          expect(node.readFileSync("/work/file", "utf8")).toBe(filled);
          expect(host.fs.fs.readFileSync("/work/file", "utf8")).toBe(content);
          expect(host.fs.fs.statSync("/work/file").size).toBe(encode(content).length);
          await workspace.checkpoint("after-refused-cut", new AbortController().signal);
          expect(host.ports.committedTurns.at(-1)!.tree).toEqual(tree);
        };
        for (const position of [
          start,
          start + BigInt(length - 1),
          start + BigInt(Math.floor(length / 2)),
        ]) {
          expect(() => raw.write(fd, encode("!"), position)).toThrow(
            expect.objectContaining({ code: "ENOTSUP" }),
          );
          await unchanged();
        }
        expect(() => raw.write(fd, encode("!"), null)).toThrow(
          expect.objectContaining({ code: "ENOTSUP" }),
        );
        await unchanged();
        for (let interior = 1; interior < length; interior++) {
          expect(() => raw.truncate("/work/file", start + BigInt(interior))).toThrow(
            expect.objectContaining({ code: "ENOTSUP" }),
          );
          await unchanged();
        }
        const syscalls = createKernelSyscallHost({
          filesystem: raw,
          args: [],
          env: {},
          signal: new AbortController().signal,
        });
        const memory = new Uint8Array(256 + length);
        const words = new DataView(memory.buffer);
        words.setUint32(32, 128, true);
        words.setUint32(36, 2, true);
        words.setUint32(40, 130, true);
        words.setUint32(44, length - 3, true);
        memory.fill(88, 128, 128 + length);
        const partial = await syscalls.call({
          name: "fd_write",
          args: [fd, 32, 2, 64],
          memorySize: memory.length,
          regions: [{ pointer: 0, bytes: memory }],
        });
        expect(partial).toMatchObject({ kind: "return", value: 58 });
        await unchanged();
        words.setUint32(44, length - 2, true);
        const complete = await syscalls.call({
          name: "fd_pwrite",
          args: [fd, 32, 2, start, 64],
          memorySize: memory.length,
          regions: [{ pointer: 0, bytes: memory }],
        });
        expect(complete).toMatchObject({ kind: "return", value: 0 });
        expect(raw.descriptors.get(fd).offset).toBe(start);
        expect(host.fs.fs.readFileSync("/work/file", "utf8")).toBe(
          `${prefix}${"X".repeat(length)} tail`,
        );
      } finally {
        fixture.close();
      }
    },
  );

  it("keeps Node reads, aliases and checkpoint bytes in their selected representations", async () => {
    const fixture = rig();
    const { host, raw, node, workspace } = fixture;
    try {
      expect(node.readFileSync("/work/file", "utf8")).toBe(materialized);
      expect(node.statSync("/work/file").size).toBe(encode(materialized).length);
      expect(host.fs.fs.statSync("/work/file").size).toBe(encode(canonical).length);
      node.linkSync("/work/file", "/work/link");
      node.symlinkSync("file", "/work/symlink");
      expect(node.readFileSync("/work/symlink", "utf8")).toBe(materialized);
      expect(node.statSync("/work/link").ino).toBe(host.fs.fs.statSync("/work/file").ino);

      const fd = raw.open("/work/link", KernelOpenFlags.O_RDWR);
      const first = new Uint8Array(7);
      expect(raw.read(fd, first, null)).toBe(7);
      const reopened = raw.open(`/proc/self/fd/${fd}`, KernelOpenFlags.O_RDONLY);
      const prefix = new Uint8Array(7);
      expect(raw.read(reopened, prefix, null)).toBe(7);
      expect(prefix).toEqual(first);
      expect(raw.descriptors.get(fd).offset).toBe(7n);
      const canonicalFd = host.filesystem.open("/work/file", KernelOpenFlags.O_RDWR);
      const separatorAt = BigInt(encode(`prefix ${bindings[0]!.placeholder}`).length);
      const separator = new Uint8Array(3);
      expect(host.filesystem.read(canonicalFd, separator, separatorAt)).toBe(3);
      expect(decode(separator)).toBe(" / ");
      expect(host.filesystem.write(canonicalFd, encode(" | "), separatorAt)).toBe(3);
      expect(host.filesystem.descriptors.get(canonicalFd).offset).toBe(0n);
      expect(raw.descriptors.get(fd).offset).toBe(7n);
      expect(node.readFileSync("/work/file", "utf8")).toBe(materialized.replace(" / ", " | "));
      expect(host.filesystem.write(canonicalFd, encode(" / "), separatorAt)).toBe(3);
      host.filesystem.close(canonicalFd);
      expect(raw.write(fd, encode("PREFIX"), 0n)).toBe(6);
      expect(host.fs.fs.readFileSync("/work/file", "utf8")).toBe(
        canonical.replace("prefix", "PREFIX"),
      );

      await workspace.checkpoint("while-raw-descriptor-open", new AbortController().signal);
      const saved = host.ports.committedTurns.at(-1)!.tree["/file"]!;
      expect(decode(saved.data!)).toBe(canonical.replace("prefix", "PREFIX"));
      expect(saved.stat.size).toBe(BigInt(encode(canonical).length));

      host.fs.fs.writeFileSync("/work/file", `updated ${bindings[0]!.placeholder}`);
      expect(raw.fstat(fd).size).toBe(BigInt(encode(`updated ${bindings[0]!.value}`).length));
      expect(node.readFileSync("/work/file", "utf8")).toBe(`updated ${bindings[0]!.value}`);
    } finally {
      fixture.close();
    }
  });

  it("uses one raw offset for WASI iovecs and refuses partial spans without changing a checkpoint", async () => {
    const fixture = rig();
    const { host, raw, workspace } = fixture;
    const syscalls = createKernelSyscallHost({
      filesystem: raw,
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    try {
      const fd = raw.open("/work/file", KernelOpenFlags.O_RDWR);
      const duplicate = raw.descriptors.duplicate(fd);
      const memory = new Uint8Array(512);
      const words = new DataView(memory.buffer);
      words.setUint32(32, 128, true);
      words.setUint32(36, 7, true);
      words.setUint32(40, 160, true);
      words.setUint32(44, encode(bindings[0]!.value).length, true);
      const read = await syscalls.call({
        name: "fd_read",
        args: [duplicate, 32, 2, 64],
        memorySize: memory.length,
        regions: [{ pointer: 0, bytes: memory }],
      });
      if (read.kind !== "return") throw new Error("WASI read exited the process");
      expect(read.value).toBe(0);
      const output = memory.slice();
      for (const region of read.regions) output.set(region.bytes, region.pointer);
      expect(decode(output.subarray(128, 135))).toBe("prefix ");
      expect(decode(output.subarray(160, 160 + encode(bindings[0]!.value).length))).toBe(
        bindings[0]!.value,
      );
      const offset = 7n + BigInt(encode(bindings[0]!.value).length);
      expect(raw.descriptors.get(fd).offset).toBe(offset);
      await workspace.checkpoint("before-refusal", new AbortController().signal);
      const before = host.ports.committedTurns.at(-1)!.tree;

      expect(() => raw.write(fd, encode("!"), 8n)).toThrow(
        expect.objectContaining({ code: "ENOTSUP" }),
      );
      expect(() => raw.truncate("/work/file", 8n)).toThrow(
        expect.objectContaining({ code: "ENOTSUP" }),
      );
      expect(raw.descriptors.get(fd).offset).toBe(offset);
      expect(host.fs.fs.readFileSync("/work/file", "utf8")).toBe(canonical);
      await workspace.checkpoint("after-refusal", new AbortController().signal);
      expect(host.ports.committedTurns.at(-1)!.tree).toEqual(before);

      words.setUint32(32, 128, true);
      words.setUint32(36, 1, true);
      words.setUint32(40, 160, true);
      words.setUint32(44, 1, true);
      memory[128] = 88;
      memory[160] = 89;
      const write = await syscalls.call({
        name: "fd_pwrite",
        args: [fd, 32, 2, 0n, 64],
        memorySize: memory.length,
        regions: [{ pointer: 0, bytes: memory }],
      });
      expect(write).toMatchObject({ kind: "return", value: 0 });
      expect(raw.descriptors.get(fd).offset).toBe(offset);
      expect(host.fs.fs.readFileSync("/work/file", "utf8")).toBe(`XY${canonical.slice(2)}`);
      await workspace.checkpoint("after-iovec-write", new AbortController().signal);
      expect(decode(host.ports.committedTurns.at(-1)!.tree["/file"]!.data!)).toBe(
        `XY${canonical.slice(2)}`,
      );
    } finally {
      syscalls.close();
      fixture.close();
    }
  });
});
