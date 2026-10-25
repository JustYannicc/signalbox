export function frame(value: unknown) {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const bytes = new Uint8Array(payload.length + 4);
  new DataView(bytes.buffer).setUint32(0, payload.length, true);
  bytes.set(payload, 4);
  return bytes;
}

export function exchange(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  mark: (stage: string, value?: unknown) => void,
) {
  const queue: Record<string, unknown>[] = [];
  const waiters: {
    match: (row: Record<string, unknown>) => boolean;
    resolve: (row: Record<string, unknown>) => void;
    reject: (error: unknown) => void;
  }[] = [];
  let ended = false;
  let failed: unknown;
  const done = (async () => {
    let buffer: Uint8Array = new Uint8Array(0);
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const next = new Uint8Array(buffer.length + chunk.value.length);
        next.set(buffer);
        next.set(chunk.value, buffer.length);
        buffer = next;
        while (buffer.length >= 4) {
          const size = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0, true);
          if (size > 131072) throw new Error("Proof frame exceeds limit");
          if (buffer.length < size + 4) break;
          const row = JSON.parse(new TextDecoder().decode(buffer.subarray(4, size + 4))) as Record<
            string,
            unknown
          >;
          buffer = buffer.slice(size + 4);
          mark("frame", row);
          const index = waiters.findIndex((entry) => entry.match(row));
          if (index < 0) {
            if (queue.length >= 100) throw new Error("Proof response backlog exceeded");
            queue.push(row);
          } else waiters.splice(index, 1)[0]!.resolve(row);
        }
      }
      if (buffer.length) throw new Error("Truncated proof frame");
    } catch (error) {
      failed = error;
      throw error;
    } finally {
      ended = true;
      for (const entry of waiters.splice(0))
        entry.reject(failed ?? new Error("Protocol ended before expected response"));
    }
  })();
  void done.catch(() => undefined);
  return {
    done,
    receive(match: (row: Record<string, unknown>) => boolean) {
      const index = queue.findIndex(match);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]!);
      if (ended) return Promise.reject(failed ?? new Error("Protocol ended"));
      return new Promise<Record<string, unknown>>((resolve, reject) =>
        waiters.push({ match, resolve, reject }),
      );
    },
  };
}
