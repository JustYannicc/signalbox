import type { FsClient, GitAuth } from "isomorphic-git";
import git from "isomorphic-git";
import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git/http/web";
import type {
  KernelAsyncProgramContext,
  KernelExitStatus,
} from "../../../kernel/KernelAsyncProgram.ts";
import { createNodeFs, type AsyncLeafRunner } from "../../NodeFs.ts";
import type { NodeGitProgramOptions, NodeGitRoute } from "./types.ts";

const unsupportedEnvironment =
  /^(?:GIT_DIR|GIT_WORK_TREE|GIT_CONFIG(?:_|$)|GIT_SSH(?:_|$)|GIT_ASKPASS|GIT_HTTP_|GIT_SSL_NO_VERIFY|GIT_PROXY_COMMAND|SSH_ASKPASS)$/;

export const runNodeGitHttpCommand = Object.freeze({
  async run(
    route: Exclude<NodeGitRoute, { readonly kind: "local" } | { readonly kind: "reject" }>,
    context: KernelAsyncProgramContext,
    options: NodeGitProgramOptions,
  ): Promise<KernelExitStatus> {
    const unsupportedEnv = Object.keys(context.env).find((name) =>
      unsupportedEnvironment.test(name),
    );
    if (unsupportedEnv !== undefined) {
      return this.fail(
        context,
        129,
        `git ${route.kind} does not support the ${unsupportedEnv} environment override`,
      );
    }

    try {
      for (const path of route.cwd) context.filesystem.chdir(path);
      const fs = createGitFs(context);
      const http = createGitHttpClient(options.fetch ?? globalThis.fetch, context.signal);
      const auth =
        options.onAuth === undefined
          ? undefined
          : (url: string, current: GitAuth) =>
              awaitWithAbort(Promise.resolve(options.onAuth!(url, current)), context.signal);

      if (route.kind === "clone") {
        await git.clone({
          fs,
          http,
          url: route.url,
          dir: route.dir,
          ...(route.depth === undefined ? {} : { depth: route.depth }),
          ...(route.ref === undefined ? {} : { ref: route.ref }),
          ...(route.singleBranch === undefined ? {} : { singleBranch: route.singleBranch }),
          noCheckout: route.noCheckout,
          noTags: route.noTags,
          ...(auth === undefined ? {} : { onAuth: auth }),
        });
      } else {
        await git.fetch({
          fs,
          http,
          dir: ".",
          ...(route.remote === undefined ? {} : { remote: route.remote }),
          ...(route.url === undefined ? {} : { url: route.url }),
          ...(route.depth === undefined ? {} : { depth: route.depth }),
          tags: route.tags,
          prune: route.prune,
          singleBranch: route.singleBranch,
          ...(auth === undefined ? {} : { onAuth: auth }),
        });
      }
      context.signal.throwIfAborted();
      return success();
    } catch (error) {
      if (context.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return this.fail(context, 128, message);
    }
  },

  async fail(
    context: KernelAsyncProgramContext,
    exitCode: number,
    message: string,
  ): Promise<KernelExitStatus> {
    const descriptor = context.filesystem.descriptors.get(2);
    const write = descriptor.stdio?.write;
    if (write !== undefined) {
      await write.call(
        descriptor.stdio,
        new TextEncoder().encode(`fatal: ${message}\n`),
        descriptor.flags,
      );
    }
    return { exitCode, signal: 0, coreDumped: false };
  },
});

function createGitFs(context: KernelAsyncProgramContext): FsClient {
  const runLeaf: AsyncLeafRunner = async (operation, signal) => {
    signal?.throwIfAborted();
    return operation();
  };
  const modules = createNodeFs(context.filesystem, undefined, runLeaf);
  const facade = modules["fs/promises"];
  const { chmod: _unsupportedChmod, default: _default, ...promises } = facade;
  const gitPromises = {
    ...promises,
    stat: async (path: string, options?: { bigint?: boolean }) =>
      withPosixMetadata(await facade.stat(path, options), context, path, true),
    lstat: async (path: string, options?: { bigint?: boolean }) =>
      withPosixMetadata(await facade.lstat(path, options), context, path, false),
  };
  // cf-git calls chmod when it exists; NodeFs deliberately reports that as unsupported.
  // Keeping it absent makes Git use the real mode-aware writeFile capability instead.
  return Object.freeze({ promises: Object.freeze(gitPromises) }) satisfies FsClient;
}

function withPosixMetadata<T extends object>(
  stats: T,
  context: KernelAsyncProgramContext,
  path: string,
  follow: boolean,
): T {
  // NodeFs leaves POSIX owner and permission bits as sentinels. Git writes these
  // fields into its index, so fill them from the same canonical KernelFileSystem.
  const metadata = context.filesystem.getPosixMetadata(path, follow);
  const current = stats as T & {
    mode: number | bigint;
    uid: number | bigint;
    gid: number | bigint;
  };
  const asBigInt = typeof current.mode === "bigint";
  const convert = (value: number) => (asBigInt ? BigInt(value) : value);
  const typeBits = Number(current.mode) & 0o170000;
  Object.defineProperties(stats, {
    mode: { value: convert(typeBits | metadata.mode) },
    uid: { value: convert(metadata.uid) },
    gid: { value: convert(metadata.gid) },
  });
  return stats;
}

function createGitHttpClient(fetcher: typeof globalThis.fetch, signal: AbortSignal): HttpClient {
  return Object.freeze({
    request: async (request: GitHttpRequest): Promise<GitHttpResponse> => {
      signal.throwIfAborted();
      const body =
        request.body === undefined
          ? undefined
          : await collectRequestBody(request.body as unknown, signal);
      const response = await fetcher(request.url, {
        method: request.method ?? "GET",
        ...(request.headers === undefined ? {} : { headers: request.headers }),
        ...(body === undefined ? {} : { body: toArrayBuffer(body) }),
        signal,
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return {
        url: response.url || request.url,
        method: request.method,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers,
        body: response.body === null ? emptyBody(signal) : responseBody(response.body, signal),
      };
    },
  });
}

async function collectRequestBody(body: unknown, signal: AbortSignal): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (Array.isArray(body)) return joinByteChunks(body, signal);
  if (isReadableStream(body)) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let done = false;
    try {
      for (;;) {
        signal.throwIfAborted();
        const result = await awaitWithAbort(reader.read(), signal);
        if (result.done) {
          done = true;
          break;
        }
        chunks.push(result.value);
      }
    } finally {
      try {
        if (!done) await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
    return joinByteChunks(chunks, signal);
  }

  const iterator = bodyIterator(body);
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const result = await awaitWithAbort(Promise.resolve(iterator.next()), signal);
      if (result.done) break;
      const chunk = asBytes(result.value);
      byteLength += chunk.byteLength;
      if (!Number.isSafeInteger(byteLength)) throw new RangeError("Git request body is too large");
      chunks.push(chunk);
    }
  } finally {
    if (signal.aborted) await iterator.return?.();
  }
  return joinByteChunks(chunks, signal);
}

function bodyIterator(body: unknown): AsyncIterator<unknown> | Iterator<unknown> {
  if (typeof body !== "object" || body === null)
    throw new TypeError("Git request body is not iterable");
  const candidate = body as {
    next?: unknown;
    [Symbol.asyncIterator]?: unknown;
    [Symbol.iterator]?: unknown;
  };
  if (typeof candidate.next === "function") return body as AsyncIterator<unknown>;
  if (typeof candidate[Symbol.asyncIterator] === "function") {
    return (candidate[Symbol.asyncIterator] as () => AsyncIterator<unknown>)();
  }
  if (typeof candidate[Symbol.iterator] === "function") {
    return (candidate[Symbol.iterator] as () => Iterator<unknown>)();
  }
  throw new TypeError("Git request body is not iterable");
}

function isReadableStream(body: unknown): body is ReadableStream<Uint8Array> {
  return (
    typeof body === "object" &&
    body !== null &&
    "getReader" in body &&
    typeof (body as { getReader?: unknown }).getReader === "function"
  );
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("Git request body contains a non-byte chunk");
}

function joinByteChunks(chunks: readonly Uint8Array[], signal: AbortSignal): Uint8Array {
  let byteLength = 0;
  for (const chunk of chunks) {
    signal.throwIfAborted();
    byteLength += chunk.byteLength;
    if (!Number.isSafeInteger(byteLength)) throw new RangeError("Git request body is too large");
  }
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const output = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(output).set(bytes);
  return output;
}

async function* responseBody(stream: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = stream.getReader();
  let done = false;
  const cancel = () => {
    void reader.cancel(signal.reason);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) {
        done = true;
        return;
      }
      yield result.value;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    try {
      if (!done) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

function emptyBody(signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  return responseBody(stream, signal);
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function success(): KernelExitStatus {
  return { exitCode: 0, signal: 0, coreDumped: false };
}
