import { describe, expect, it } from "@effect/vitest";

import {
  createBunFiles,
  type BunFileHost,
  type BunFileStat,
  type BunFileTarget,
} from "../bun/files.ts";

type Entry = { readonly kind: "file"; bytes: Uint8Array } | { readonly kind: "directory" };

const notFound = Object.assign(new Error("missing"), { code: "ENOENT" });
const accessDenied = Object.assign(new Error("denied"), { code: "EACCES" });
const encoder = new TextEncoder();

function makeHost(initial: ReadonlyArray<readonly [BunFileTarget, Entry]> = []) {
  const entries = new Map<BunFileTarget, Entry>(initial);
  const failures = new Map<BunFileTarget, Error>();
  const reads: BunFileTarget[] = [];
  const stats: BunFileTarget[] = [];
  const syncStats: BunFileTarget[] = [];

  const stat = (target: BunFileTarget): BunFileStat => {
    const failure = failures.get(target);
    if (failure) throw failure;
    const entry = entries.get(target);
    if (!entry) throw notFound;
    return {
      size: entry.kind === "file" ? entry.bytes.byteLength : 0,
      isFile: () => entry.kind === "file",
      isDirectory: () => entry.kind === "directory",
    };
  };

  const host: BunFileHost = {
    async readFile(target) {
      reads.push(target);
      const failure = failures.get(target);
      if (failure) throw failure;
      const entry = entries.get(target);
      if (!entry || entry.kind === "directory") throw notFound;
      return entry.bytes;
    },
    async writeFile(target, bytes) {
      entries.set(target, { kind: "file", bytes: bytes.slice() });
    },
    async stat(target) {
      stats.push(target);
      return stat(target);
    },
    statSync(target) {
      syncStats.push(target);
      return stat(target);
    },
  };

  return { host, entries, failures, reads, stats, syncStats };
}

const emptyInput = () =>
  new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });

describe("Bun file compatibility", () => {
  it("keeps file creation lazy and reads current contents on each operation", async () => {
    const store = makeHost([["notes.txt", { kind: "file", bytes: encoder.encode("first") }]]);
    const files = createBunFiles(store.host, emptyInput());
    const note = files.file("notes.txt");

    expect(store.reads).toEqual([]);
    expect(store.stats).toEqual([]);
    expect(store.syncStats).toEqual([]);
    expect(await note.text()).toBe("first");
    store.entries.set("notes.txt", { kind: "file", bytes: encoder.encode("updated") });
    expect(await note.text()).toBe("updated");
    expect(note.size).toBe(7);
    expect(store.reads).toEqual(["notes.txt", "notes.txt"]);
  });

  it("returns zero size and false exists for missing paths while reads retain the filesystem error", async () => {
    const files = createBunFiles(makeHost().host, emptyInput());
    const missing = files.file("missing.txt");

    expect(missing.size).toBe(0);
    expect(await missing.exists()).toBe(false);
    await expect(missing.bytes()).rejects.toBe(notFound);
  });

  it("does not hide real filesystem errors from size or exists", async () => {
    const store = makeHost();
    store.failures.set("private.txt", accessDenied);
    const privateFile = createBunFiles(store.host, emptyInput()).file("private.txt");

    expect(() => privateFile.size).toThrow(accessDenied);
    await expect(privateFile.exists()).rejects.toBe(accessDenied);
  });

  it("reports directories as not existing files", async () => {
    const store = makeHost([["folder", { kind: "directory" }]]);
    const folder = createBunFiles(store.host, emptyInput()).file("folder");

    expect(folder.size).toBe(0);
    expect(await folder.exists()).toBe(false);
  });

  it("writes only the selected view bytes and returns their byte count", async () => {
    const store = makeHost();
    const files = createBunFiles(store.host, emptyInput());
    const padded = Uint8Array.from([0xff, 0x61, 0x62, 0xee]);

    expect(await files.write("slice.bin", padded.subarray(1, 3))).toBe(2);
    expect([...(store.entries.get("slice.bin") as Extract<Entry, { kind: "file" }>).bytes]).toEqual(
      [0x61, 0x62],
    );
    expect(await files.write("view.bin", new DataView(padded.buffer, 2, 1))).toBe(1);
    expect([...(store.entries.get("view.bin") as Extract<Entry, { kind: "file" }>).bytes]).toEqual([
      0x62,
    ]);
  });

  it("encodes strings as UTF-8 and accepts Blob, Response, and BunFile sources", async () => {
    const store = makeHost([
      ["source.txt", { kind: "file", bytes: encoder.encode("file source") }],
    ]);
    const files = createBunFiles(store.host, emptyInput());

    expect(await files.write("string.txt", "snowman ☃")).toBe(encoder.encode("snowman ☃").length);
    expect((store.entries.get("string.txt") as Extract<Entry, { kind: "file" }>).bytes).toEqual(
      encoder.encode("snowman ☃"),
    );
    expect(await files.write("blob.txt", new Blob(["blob"]))).toBe(4);
    expect(await files.write("response.txt", new Response("response"))).toBe(8);
    expect(await files.write("file.txt", files.file("source.txt"))).toBe(11);
  });

  it("accepts file URLs and file descriptors through the injected host", async () => {
    const store = makeHost([
      ["/data/hello world.txt", { kind: "file", bytes: encoder.encode("url") }],
      [7, { kind: "file", bytes: encoder.encode("descriptor") }],
    ]);
    const files = createBunFiles(store.host, emptyInput());
    const fromUrl = files.file(new URL("file:///data/hello%20world.txt"));
    const fromFd = files.file(7);

    expect(fromUrl.name).toBe("/data/hello world.txt");
    expect(await fromUrl.text()).toBe("url");
    expect(fromFd.name).toBeUndefined();
    expect(await fromFd.text()).toBe("descriptor");
    expect(store.reads).toEqual(["/data/hello world.txt", 7]);
  });

  it("does not read a file stream until consumed and rejects failed reads through the stream", async () => {
    const store = makeHost([["stream.txt", { kind: "file", bytes: encoder.encode("streamed") }]]);
    const file = createBunFiles(store.host, emptyInput()).file("stream.txt");
    const stream = file.stream();

    expect(store.reads).toEqual([]);
    const reader = stream.getReader();
    expect(await reader.read()).toEqual({ done: false, value: encoder.encode("streamed") });
    expect(await reader.read()).toEqual({ done: true, value: undefined });

    const failed = makeHost();
    failed.failures.set("bad.txt", accessDenied);
    const failedReader = createBunFiles(failed.host, emptyInput())
      .file("bad.txt")
      .stream()
      .getReader();
    await expect(failedReader.read()).rejects.toBe(accessDenied);
  });

  it("consumes stdin text once and preserves split UTF-8 sequences", async () => {
    const snowman = encoder.encode("☃");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(snowman.slice(0, 1));
        controller.enqueue(snowman.slice(1));
        controller.close();
      },
    });
    const stdin = createBunFiles(makeHost().host, source).stdin;

    expect(stdin.stream()).toBe(source);
    expect(await stdin.text()).toBe("☃");
    expect(await stdin.text()).toBe("");
  });
});
