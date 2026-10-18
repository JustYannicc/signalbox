/*
 * Adapted from Nimbus's `packages/worker/src/runtime/bun-file.ts`.
 * Copyright (c) 2026 Ashish Kumar Singh and Nimbus contributors.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export type BunFileTarget = string | number;
export type BunFileInput = BunFileTarget | URL;

export interface BunFileStat {
  readonly size: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

/** The only filesystem operations this compatibility layer needs. */
export interface BunFileHost {
  readFile(target: BunFileTarget): Promise<Uint8Array>;
  writeFile(target: BunFileTarget, bytes: Uint8Array): Promise<void>;
  stat(target: BunFileTarget): Promise<BunFileStat>;
  statSync(target: BunFileTarget): BunFileStat;
  isNotFound?(error: unknown): boolean;
}

export interface BunFile {
  readonly name: string | undefined;
  readonly size: number;
  readonly type: string;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  exists(): Promise<boolean>;
  stream(): ReadableStream<Uint8Array>;
}

interface ByteSource {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type BunWriteData = string | ArrayBuffer | ArrayBufferView | ByteSource;

export interface BunFiles {
  file(input: BunFileInput): BunFile;
  write(destination: BunFileInput | BunFile, data: BunWriteData): Promise<number>;
  stdin: {
    stream(): ReadableStream<Uint8Array>;
    text(): Promise<string>;
  };
}

const MIME: Readonly<Record<string, string>> = {
  html: "text/html",
  css: "text/css",
  js: "application/javascript",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
};

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return true;
  return "name" in error && error.name === "NotFoundError";
}

function normalizeInput(input: BunFileInput): { target: BunFileTarget; name: string | undefined } {
  if (typeof input === "number") {
    if (!Number.isSafeInteger(input) || input < 0) {
      throw new TypeError("Bun.file: expected a non-negative file descriptor");
    }
    return { target: input, name: undefined };
  }
  if (typeof input === "string") {
    if (input.length === 0) throw new TypeError("Bun.file: path must not be empty");
    return { target: input, name: input };
  }
  if (input.protocol !== "file:" || (input.hostname !== "" && input.hostname !== "localhost")) {
    throw new TypeError('Bun.file: URL must be a local "file:" path');
  }
  const name = decodeURIComponent(input.pathname);
  if (name.length === 0) throw new TypeError("Bun.file: path must not be empty");
  return { target: name, name };
}

function byteSource(value: object): value is ByteSource {
  return "arrayBuffer" in value && typeof value.arrayBuffer === "function";
}

export function createBunFiles(host: BunFileHost, input: ReadableStream<Uint8Array>): BunFiles {
  const encoder = new TextEncoder();
  const fileTargets = new WeakMap<BunFile, BunFileTarget>();

  const file = (input: BunFileInput): BunFile => {
    const { target, name } = normalizeInput(input);
    const read = async (): Promise<Uint8Array> => copyBytes(await host.readFile(target));
    const missing = (error: unknown) => host.isNotFound?.(error) ?? isNotFound(error);
    const type = name?.split(".").pop()?.toLowerCase() ?? "";
    const result: BunFile = {
      name,
      get size() {
        try {
          const stat = host.statSync(target);
          return stat.isFile() ? stat.size : 0;
        } catch (error) {
          if (missing(error)) return 0;
          throw error;
        }
      },
      type: MIME[type] ?? "application/octet-stream",
      bytes: read,
      async text() {
        return new TextDecoder().decode(await read());
      },
      async json() {
        return JSON.parse(new TextDecoder().decode(await read())) as unknown;
      },
      async arrayBuffer() {
        return (await read()).buffer as ArrayBuffer;
      },
      async exists() {
        try {
          return (await host.stat(target)).isFile();
        } catch (error) {
          if (missing(error)) return false;
          throw error;
        }
      },
      stream() {
        return new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                const bytes = await read();
                if (bytes.byteLength > 0) controller.enqueue(bytes);
                controller.close();
              } catch (error) {
                controller.error(error);
              }
            },
          },
          { highWaterMark: 0 },
        );
      },
    };
    fileTargets.set(result, target);
    return result;
  };

  const bytesOf = async (data: BunWriteData): Promise<Uint8Array> => {
    if (typeof data === "string") return encoder.encode(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data)) {
      return copyBytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
    if (byteSource(data)) return new Uint8Array(await data.arrayBuffer());
    throw new TypeError("Bun.write: unsupported data type");
  };

  const write = async (
    destination: BunFileInput | BunFile,
    data: BunWriteData,
  ): Promise<number> => {
    const target =
      typeof destination === "object" && destination !== null && !(destination instanceof URL)
        ? fileTargets.get(destination as BunFile)
        : normalizeInput(destination as BunFileInput).target;
    if (target === undefined)
      throw new TypeError(
        "Bun.write: destination must be a path, file descriptor, URL, or BunFile",
      );
    const bytes = await bytesOf(data);
    await host.writeFile(target, bytes);
    return bytes.byteLength;
  };

  let stdinConsumed = false;
  const stdin = {
    stream: () => input,
    async text() {
      if (stdinConsumed) return "";
      stdinConsumed = true;
      const reader = input.getReader();
      const decoder = new TextDecoder();
      let text = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return text + decoder.decode();
          text += decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
    },
  };

  return { file, write, stdin };
}
