import type * as NodeEvents from "node:events";

interface LineSource extends NodeEvents.EventEmitter {
  readonly closed: boolean;
  close(): void;
  pause(): this;
  resume(): this;
}

export function createLineIterator(source: LineSource): AsyncIterableIterator<string> {
  const lines: string[] = [];
  const waiting: {
    resolve: (value: IteratorResult<string>) => void;
    reject: (error: unknown) => void;
  }[] = [];
  let ended = source.closed;
  let failure: unknown;
  let paused = false;
  const detach = () => {
    source.off("line", line);
    source.off("close", close);
    source.off("error", error);
  };
  const line = (value: string) => {
    const pending = waiting.shift();
    if (pending) pending.resolve({ value, done: false });
    else lines.push(value);
    if (lines.length >= 1024 && !paused) {
      paused = true;
      source.pause();
    }
  };
  const close = () => {
    ended = true;
    detach();
    for (const pending of waiting.splice(0)) pending.resolve({ value: undefined, done: true });
  };
  const error = (cause: unknown) => {
    failure = cause;
    lines.length = 0;
    detach();
    for (const pending of waiting.splice(0)) pending.reject(cause);
  };
  if (!ended) {
    source.on("line", line);
    source.on("close", close);
    source.on("error", error);
  }
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (failure !== undefined) return Promise.reject(failure);
      const value = lines.shift();
      if (value !== undefined) {
        if (paused && lines.length === 0 && !ended) {
          paused = false;
          source.resume();
        }
        return Promise.resolve({ value, done: false });
      }
      if (ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    return() {
      lines.length = 0;
      source.close();
      close();
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(cause) {
      source.close();
      error(cause);
      return Promise.reject(cause);
    },
  };
}
