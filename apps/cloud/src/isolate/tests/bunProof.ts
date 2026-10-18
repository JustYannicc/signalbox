import * as NodeBuffer from "node:buffer";

import {
  BunCapabilityUnavailable,
  createBunShim,
  installBunShim,
  type BunFileHost,
  type BunFileTarget,
  type BunShimHost,
} from "../BunShim.ts";

export function memoryFileHost(): BunFileHost {
  const files = new Map<BunFileTarget, Uint8Array>();
  const read = (path: BunFileTarget) => {
    const data = files.get(path);
    if (!data) throw Object.assign(new Error("No such file"), { code: "ENOENT" });
    return data;
  };
  const stat = (path: BunFileTarget) => ({
    size: read(path).length,
    isFile: () => true,
    isDirectory: () => false,
  });
  return {
    readFile: async (path) => read(path),
    writeFile: async (path, data) => {
      files.set(path, data);
    },
    stat: async (path) => stat(path),
    statSync: stat,
  };
}

export async function runBunShimProof(files = memoryFileHost()) {
  const checks: string[] = [];
  const missingMembers: string[] = [];
  function check(name: string, actual: unknown, expected: unknown) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
    checks.push(name);
  }
  const events: string[] = [];
  let exitCode: number | null = null;
  const host = {
    env: { PATH: "/bin", MARKER: "isolate" },
    main: "/claude/cli",
    version: "1.4.3",
    files,
    onMissing: (name: string) => {
      missingMembers.push(name);
    },
    stdin: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("input ✓"));
        controller.close();
      },
    }),
    which: (command: string) => (command === "bash" ? "/bin/bash" : null),
    spawn: (command: readonly string[]) => {
      events.push(command.join(" "));
      return {
        pid: 7,
        exited: Promise.resolve(0).then((code) => {
          exitCode = code;
          return code;
        }),
        get exitCode() {
          return exitCode;
        },
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("child output"));
            controller.close();
          },
        }),
        kill: () => {
          events.push("killed");
        },
        ref: () => {
          events.push("ref");
        },
        unref: () => {
          events.push("unref");
        },
      };
    },
  } satisfies BunShimHost;
  const shim = createBunShim(host);
  const bun = shim.bun;
  check("wyhash", bun.hash("Aé😀𝌆\u0000ñ").toString(16), "1f60eb7e59a9a399");
  check("seeded-wyhash", bun.hash("Aé😀𝌆\u0000ñ", 123n).toString(16), "6ae7578da5782190");
  check("xxhash64", bun.hash.xxHash64("Aé😀𝌆\u0000ñ").toString(16), "80b6ce9891ad989d");
  check("crc32", bun.hash.crc32("123456789"), 0xcbf43926);
  check(
    "sha256",
    bun.SHA256.hash("abc", "hex"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  check(
    "semver",
    [bun.semver.order("1.2.3", "1.2.4"), bun.semver.satisfies("2.3.4", "^2.0.0")],
    [-1, true],
  );
  check(
    "semver-leading-zeroes",
    [bun.semver.order("01.2.3", "1.2.3"), bun.semver.satisfies("01.2.3", ">=1.0.0")],
    [0, true],
  );
  check("yaml", bun.YAML.parse("items:\n  - name: test\n"), { items: [{ name: "test" }] });
  check("yaml-roundtrip", bun.YAML.parse(bun.YAML.stringify({ answer: 42 }, null, 2)), {
    answer: 42,
  });
  check("toml", bun.TOML.parse('[mcp]\ncommand = "bash"\nargs = ["-l"]\n'), {
    mcp: { command: "bash", args: ["-l"] },
  });
  check("jsonl", bun.JSONL.parse('{"a":1}\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
  const partial = bun.JSONL.parseChunk('"é"\n{');
  check(
    "jsonl-partial",
    [partial.values, partial.read, partial.done, partial.error],
    [["é"], 3, false, null],
  );
  check(
    "deep-equals",
    [
      bun.deepEquals({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }),
      bun.deepEquals({ a: undefined }, {}),
      bun.deepEquals({ a: undefined }, {}, true),
    ],
    [true, true, false],
  );
  class Entry {
    value = 1;
  }
  check(
    "strict-equality-prototypes",
    [bun.deepEquals(new Entry(), { value: 1 }), bun.deepEquals(new Entry(), { value: 1 }, true)],
    [true, false],
  );
  check(
    "jsonl-corrupt-prefix",
    bun.JSONL.parseChunk('{bad\n{"ok":1}\n').error instanceof SyntaxError,
    true,
  );
  check("ansi-width", bun.stringWidth("\u001b[31m中e\u0301😀\u001b[39m"), 5);
  check("ansi-strip", bun.stripANSI("\u001b[31mred\u001b[39m"), "red");
  check("ansi-slice", bun.stripANSI(bun.sliceAnsi("\u001b[31mabc\u001b[39m", 1, 3)), "bc");
  check("ansi-wrap", bun.wrapAnsi("hello world", 5), "hello\nworld");
  const compressed = new Uint8Array([
    40, 181, 47, 253, 32, 23, 185, 0, 0, 115, 104, 105, 109, 32, 226, 156, 147, 32, 101, 109, 98,
    101, 100, 100, 101, 100, 32, 97, 115, 115, 101, 116,
  ]);
  check("zstd-sync", bun.zstdDecompressSync(compressed).toString("utf8"), "shim ✓ embedded asset");
  check(
    "zstd-async",
    (await bun.zstdDecompress(compressed)).toString("utf8"),
    "shim ✓ embedded asset",
  );
  const padded = NodeBuffer.Buffer.from([99, 0, 255, 1, 99]);
  check("file-write-byte-count", await bun.write("/proof.bin", padded.subarray(1, 4)), 3);
  check(
    "file-exact-bytes",
    Array.from(new Uint8Array(await bun.file("/proof.bin").arrayBuffer())),
    [0, 255, 1],
  );
  check("file-size", bun.file("/proof.bin").size, 3);
  check(
    "file-exists",
    [await bun.file("/proof.bin").exists(), await bun.file("/missing").exists()],
    [true, false],
  );
  check("file-write-text-count", await bun.write("/proof.txt", "text ✓"), 8);
  check("file-stream", await new Response(bun.file("/proof.txt").stream()).text(), "text ✓");
  check("stdin", await bun.stdin.text(), "input ✓");
  check("which", [bun.which("bash"), bun.which("missing")], ["/bin/bash", null]);
  const child = bun.spawn(["bash", "-c", "echo proof"], { stdout: "pipe" });
  check("spawn-stdout", await child.stdout?.text(), "child output");
  check("spawn-exit", [await child.exited, child.exitCode], [0, 0]);
  child.unref();
  child.ref();
  child.kill();
  check("spawn-host-boundary", events, ["bash -c echo proof", "unref", "ref", "killed"]);
  const reads = bun as typeof bun & Record<string, unknown>;
  check("unknown", reads.futureApi, undefined);
  void reads.futureApi;
  void bun.ant.getPeerPid;
  check("unknown-inventory", shim.missingMembers, ["ant.getPeerPid", "futureApi"]);
  check("unknown-once", missingMembers, ["futureApi", "ant.getPeerPid"]);
  try {
    bun.sleepSync();
    throw new Error("sleepSync unexpectedly returned");
  } catch (error) {
    if (!(error instanceof BunCapabilityUnavailable)) throw error;
    checks.push("no-blocking-sleep");
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, "Bun");
  const installed = installBunShim(host);
  check("global-installed", Reflect.get(globalThis, "Bun") === installed.bun, true);
  installed.restore();
  check(
    "global-restored",
    Object.getOwnPropertyDescriptor(globalThis, "Bun")?.value === original?.value,
    true,
  );
  return { ok: true, checks, hostMode: "injected-files-and-process-boundary" };
}
