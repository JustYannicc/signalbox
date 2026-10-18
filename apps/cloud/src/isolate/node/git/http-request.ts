export type AwaitWithAbort = <T>(promise: Promise<T>, signal: AbortSignal) => Promise<T>;

export async function collectRequestBody(
  body: unknown,
  signal: AbortSignal,
  remainingBytes: number,
  wait: AwaitWithAbort,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return assertSize(body, remainingBytes);
  if (body instanceof ArrayBuffer) return assertSize(new Uint8Array(body), remainingBytes);
  if (Array.isArray(body)) return joinByteChunks(body, signal, remainingBytes);
  if (isReadableStream(body)) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let done = false;
    try {
      for (;;) {
        signal.throwIfAborted();
        const result = await wait(reader.read(), signal);
        if (result.done) {
          done = true;
          break;
        }
        chunks.push(result.value);
        assertChunkLimit(chunks, remainingBytes);
      }
    } finally {
      try {
        if (!done) await reader.cancel(signal.reason);
      } finally {
        reader.releaseLock();
      }
    }
    return joinByteChunks(chunks, signal, remainingBytes);
  }

  const iterator = bodyIterator(body);
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      signal.throwIfAborted();
      const result = await wait(Promise.resolve(iterator.next()), signal);
      if (result.done) break;
      chunks.push(asBytes(result.value));
      assertChunkLimit(chunks, remainingBytes);
    }
  } finally {
    if (signal.aborted) await iterator.return?.();
  }
  return joinByteChunks(chunks, signal, remainingBytes);
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const output = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(output).set(bytes);
  return output;
}

export function transferLimitError(maximum: number): RangeError {
  return new RangeError(`Git HTTP transfer exceeds configured ${maximum}-byte budget`);
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

function assertSize(bytes: Uint8Array, maximum: number): Uint8Array {
  if (bytes.byteLength > maximum) throw transferLimitError(maximum);
  return bytes;
}

function assertChunkLimit(chunks: readonly Uint8Array[], maximum: number): void {
  let byteLength = 0;
  for (const chunk of chunks) {
    byteLength += chunk.byteLength;
    if (byteLength > maximum) throw transferLimitError(maximum);
  }
}

function joinByteChunks(
  chunks: readonly Uint8Array[],
  signal: AbortSignal,
  maximum: number,
): Uint8Array {
  let byteLength = 0;
  for (const chunk of chunks) {
    signal.throwIfAborted();
    byteLength += chunk.byteLength;
    if (byteLength > maximum) throw transferLimitError(maximum);
  }
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
