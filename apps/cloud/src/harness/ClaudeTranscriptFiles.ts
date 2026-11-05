import { CLAUDE_STREAM_PREFIX } from "@signalbox/runner-protocol/SessionProtocol";
import { RpcTarget } from "cloudflare:workers";
import {
  KernelOpenFlags,
  type KernelFileSystem,
  type KernelStat,
} from "../kernel/KernelFileSystem.ts";
import {
  KERNEL_FILE_TRANSFER_BYTES,
  type KernelFileTransferPort,
} from "../kernel/KernelFileTransfer.ts";
import type { ClaudeTranscriptCapture } from "./ClaudeTranscriptPort.ts";

class TranscriptSource extends RpcTarget implements KernelFileTransferPort {
  #files: KernelFileSystem | undefined;
  #entries: ReadonlyMap<string, KernelStat> | undefined;
  readonly #signal;
  readonly #controller = new AbortController();
  #pending = Promise.resolve();
  #closed: Promise<void> | undefined;
  constructor(
    files: KernelFileSystem,
    entries: ReadonlyMap<string, KernelStat>,
    signal: AbortSignal,
  ) {
    super();
    this.#files = files;
    this.#entries = entries;
    this.#signal = AbortSignal.any([signal, this.#controller.signal]);
  }
  read(path: string, offset: number, length: number) {
    // A capture may have only one descriptor and frame read in flight.
    const pending = this.#pending.then(() => this.#read(path, offset, length));
    this.#pending = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
  async #read(path: string, offset: number, length: number) {
    const files = this.#files;
    if (files === undefined || this.#closed !== undefined)
      throw Object.assign(new Error("Transcript transfer is closed"), { code: "EBADF" });
    const entry = this.#entries?.get(path);
    if (
      entry === undefined ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > KERNEL_FILE_TRANSFER_BYTES ||
      BigInt(offset) + BigInt(length) > entry.size
    )
      throw new RangeError("Invalid transcript transfer range");
    this.#signal.throwIfAborted();
    const fd = await files.openAsync(path, KernelOpenFlags.O_RDONLY, undefined, this.#signal);
    try {
      const current = files.fstat(fd);
      if (
        current.ino !== entry.ino ||
        current.dev !== entry.dev ||
        current.size !== entry.size ||
        current.mtimeNs !== entry.mtimeNs ||
        current.ctimeNs !== entry.ctimeNs
      )
        throw new Error("Claude transcript changed during capture.");
      const bytes = new Uint8Array(length);
      let read = 0;
      while (read < length) {
        const count = await files.readAsync(
          fd,
          bytes.subarray(read),
          BigInt(offset + read),
          this.#signal,
        );
        if (count === 0) throw new Error("Claude transcript transfer ended early.");
        read += count;
      }
      this.#signal.throwIfAborted();
      return bytes;
    } finally {
      files.close(fd);
    }
  }
  close() {
    return (this.#closed ??= (async () => {
      this.#controller.abort(new Error("Transcript transfer closed"));
      await this.#pending;
      this.#entries = undefined;
      this.#files = undefined;
    })());
  }
}

/** Reads the canonical native transcripts only inside their kernel owner. */
export async function captureClaudeTranscriptFiles(
  files: KernelFileSystem,
  configurationDirectory: string,
  nativeId: string,
  signal: AbortSignal,
): Promise<ClaudeTranscriptCapture> {
  if (!/^[a-zA-Z0-9-]+$/.test(nativeId)) throw new Error("Claude native session id is invalid.");
  const projects = `${configurationDirectory.replace(/\/$/, "")}/projects`;
  const statIfPresent = async (path: string) => {
    try {
      return await files.statAsync(path, signal);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    }
  };
  const matches: string[] = [];
  if (await statIfPresent(projects)) {
    for (const entry of await files.readdirAsync(projects, signal)) {
      const directory = `${projects}/${entry}`;
      const path = `${directory}/${nativeId}.jsonl`;
      const directoryStat = await files.statAsync(directory, signal);
      if (directoryStat.type === "directory" && (await statIfPresent(path))) matches.push(path);
    }
  }
  if (matches.length !== 1) throw new Error("Claude's native transcript is missing or ambiguous.");
  const main = matches[0]!;
  const streams = [{ stream: `${CLAUDE_STREAM_PREFIX}${nativeId}`, path: main }];
  const sidecars = main.slice(0, -".jsonl".length);
  const visit = async (directory: string, relative: string) => {
    for (const name of await files.readdirAsync(directory, signal)) {
      const path = `${directory}/${name}`;
      const subpath = relative === "" ? name : `${relative}/${name}`;
      const stat = await files.lstatAsync(path, signal);
      if (stat.type === "directory") await visit(path, subpath);
      else if (stat.type === "file" && name.endsWith(".jsonl"))
        streams.push({ stream: `${CLAUDE_STREAM_PREFIX}${nativeId}/${subpath}`, path });
    }
  };
  if (await statIfPresent(sidecars)) await visit(sidecars, "");
  const entries = new Map<string, KernelStat>();
  const manifest = [];
  for (const { path } of streams) {
    const stat = await files.statAsync(path, signal);
    const bytes = Number(stat.size);
    if (stat.type !== "file" || !Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error("Claude transcript has an invalid size or file type.");
    entries.set(path, stat);
    manifest.push({ path, mode: (stat.posix?.mode ?? 0o644) & 0o7777, bytes });
  }
  signal.throwIfAborted();
  return {
    streams,
    manifest,
    source: new TranscriptSource(files, entries, signal),
  };
}
