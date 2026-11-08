import type { CodexHarnessProcess } from "../../CodexHarnessProcess.ts";

interface Frame {
  readonly id?: number;
  readonly method?: string;
  readonly params?: {
    readonly sessionId?: string;
    readonly query?: string;
    readonly turn?: { readonly status: string };
    readonly thread?: { readonly id: string };
  };
  readonly result?: { readonly thread?: { readonly id: string } };
  readonly error?: unknown;
}

/** Reads real app-server output; only Responses is scripted by the fixture. */
export function appServerDriver(process: CodexHarnessProcess) {
  const writer = process.stdin.getWriter();
  const frames: Frame[] = [];
  const pending = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<NonNullable<Frame["result"]>>>
  >();
  const completed = Promise.withResolvers<Frame>();
  const waiters = new Set<{
    readonly matches: (frame: Frame) => boolean;
    readonly resolve: (frame: Frame) => void;
  }>();
  let nextId = 0;
  const output = (async () => {
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        buffer += decoder.decode(item.value, { stream: true });
        for (;;) {
          const end = buffer.indexOf("\n");
          if (end < 0) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          const frame: Frame = JSON.parse(line);
          frames.push(frame);
          for (const waiter of waiters) {
            if (waiter.matches(frame)) {
              waiters.delete(waiter);
              waiter.resolve(frame);
            }
          }
          if (frame.id !== undefined) {
            const request = pending.get(frame.id);
            pending.delete(frame.id);
            if (frame.error !== undefined) request?.reject(new Error(JSON.stringify(frame.error)));
            else request?.resolve(frame.result ?? {});
          }
          if (frame.method === "turn/completed") completed.resolve(frame);
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();
  void output.catch((error: unknown) => completed.reject(error));
  const errors: string[] = [];
  const stderr = (async () => {
    const reader = process.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        errors.push(decoder.decode(item.value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
    }
  })();
  return {
    frames,
    errors,
    completed: completed.promise,
    waitFor(matches: (frame: Frame) => boolean) {
      const existing = frames.find(matches);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<Frame>((resolve) => waiters.add({ matches, resolve }));
    },
    async request(method: string, params: unknown) {
      const id = ++nextId;
      const response = Promise.withResolvers<NonNullable<Frame["result"]>>();
      pending.set(id, response);
      await writer.write(new TextEncoder().encode(JSON.stringify({ id, method, params }) + "\n"));
      return response.promise;
    },
    async close() {
      await process.dispose();
      writer.releaseLock();
      await Promise.all([output, stderr]);
    },
  };
}
