import * as NodeEvents from "node:events";
import { LineFramer } from "./LineFramer.ts";
import { createLineIterator } from "./LineIterator.ts";

export interface ReadlineOptions {
  readonly input: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream | undefined;
  readonly terminal?: boolean | undefined;
  readonly crlfDelay?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly completer?: unknown;
}

export function unsupportedReadline(method: string): never {
  throw Object.assign(new Error(`readline.${method} is not supported by the non-terminal host`), {
    code: "ERR_METHOD_NOT_IMPLEMENTED",
  });
}

export function readlineOptions(
  input: ReadlineOptions | NodeJS.ReadableStream,
  output?: NodeJS.WritableStream,
  completer?: unknown,
  terminal?: boolean,
): ReadlineOptions {
  return "input" in input ? input : { input, output, completer, terminal };
}

export class StreamLineInterface extends NodeEvents.EventEmitter {
  readonly terminal = false;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream | undefined;
  readonly #framer: LineFramer;
  readonly #signal: AbortSignal | undefined;
  #closed = false;
  #paused = false;
  #iterator: AsyncIterableIterator<string> | undefined;

  constructor(
    input: ReadlineOptions | NodeJS.ReadableStream,
    output?: NodeJS.WritableStream,
    completer?: unknown,
    terminal?: boolean,
  ) {
    super();
    const options = readlineOptions(input, output, completer, terminal);
    const isTTY: unknown = options.output && Reflect.get(options.output, "isTTY");
    if (options.terminal ?? isTTY === true) unsupportedReadline("terminal");
    if (options.completer !== undefined) unsupportedReadline("completer");
    this.input = options.input;
    this.output = options.output;
    if (!this.input || typeof this.input.on !== "function")
      throw new TypeError("readline input must be a readable stream");
    this.#framer = new LineFramer(Math.max(100, options.crlfDelay ?? 100));
    this.#signal = options.signal;
    this.input.on("data", this.#onData);
    this.input.on("end", this.#onEnd);
    this.input.on("error", this.#onError);
    this.#signal?.addEventListener("abort", this.#onAbort, { once: true });
    if (this.#signal?.aborted) queueMicrotask(this.#onAbort);
    this.input.resume();
  }

  get closed() {
    return this.#closed;
  }

  readonly #onData = (chunk: string | Uint8Array) => {
    for (const line of this.#framer.write(chunk)) {
      if (this.#closed) break;
      this.emit("line", line);
    }
  };

  readonly #onEnd = () => {
    for (const line of this.#framer.end()) {
      if (this.#closed) break;
      this.emit("line", line);
    }
    this.close();
  };

  readonly #onError = (error: Error) => {
    try {
      this.emit("error", error);
    } finally {
      this.close();
    }
  };

  readonly #onAbort = () => this.close();

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.input.off("data", this.#onData);
    this.input.off("end", this.#onEnd);
    this.input.off("error", this.#onError);
    this.#signal?.removeEventListener("abort", this.#onAbort);
    this.pause();
    this.emit("close");
  }

  pause(): this {
    if (!this.#paused) {
      this.#paused = true;
      this.input.pause();
      this.emit("pause");
    }
    return this;
  }

  resume(): this {
    if (this.#paused && !this.#closed) {
      this.#paused = false;
      this.input.resume();
      this.emit("resume");
    }
    return this;
  }

  [Symbol.asyncIterator]() {
    return (this.#iterator ??= createLineIterator(this));
  }

  [Symbol.dispose]() {
    this.close();
  }

  question(..._args: unknown[]): never {
    return unsupportedReadline("question");
  }
  prompt(..._args: unknown[]): never {
    return unsupportedReadline("prompt");
  }
  setPrompt(..._args: unknown[]): never {
    return unsupportedReadline("setPrompt");
  }
  getPrompt(): never {
    return unsupportedReadline("getPrompt");
  }
  write(data?: string | Uint8Array | null, key?: unknown): void {
    if (this.#closed)
      throw Object.assign(new Error("readline was closed"), { code: "ERR_USE_AFTER_CLOSE" });
    this.resume();
    if (data === undefined || data === null) {
      if (key !== undefined) unsupportedReadline("write key");
      if (data === undefined) return;
    }
    if (typeof data !== "string" && !(data instanceof Uint8Array))
      throw Object.assign(new TypeError("readline data must be a string or Uint8Array"), {
        code: "ERR_INVALID_ARG_TYPE",
      });
    this.#onData(data);
  }
  getCursorPos(): never {
    return unsupportedReadline("getCursorPos");
  }
}
