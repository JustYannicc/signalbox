import * as NodeUtil from "node:util";
import { consoleOptions, type NodeConsoleOptions, type NodeConsoleWritable } from "./options.ts";
import { consoleTable } from "./table.ts";

const methods = [
  "log",
  "info",
  "debug",
  "warn",
  "error",
  "assert",
  "dir",
  "dirxml",
  "trace",
  "time",
  "timeEnd",
  "timeLog",
  "count",
  "countReset",
  "group",
  "groupCollapsed",
  "groupEnd",
  "clear",
  "table",
] as const;

function elapsedTime(milliseconds: number) {
  if (milliseconds < 1000) return `${Number(milliseconds.toFixed(3))}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(3)}s`;
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = ((milliseconds % 60_000) / 1000).toFixed(3).padStart(6, "0");
  const prefix = hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}` : String(minutes);
  return `${prefix}:${seconds} (${hours > 0 ? "h:mm" : "m"}:ss.mmm)`;
}

export class StreamConsole {
  readonly #options: ReturnType<typeof consoleOptions>;
  readonly #timers = new Map<string, number>();
  readonly #counts = new Map<string, number>();
  #indent = "";

  constructor(options: NodeConsoleOptions);
  constructor(stdout: NodeConsoleWritable, stderr?: NodeConsoleWritable, ignoreErrors?: boolean);
  constructor(
    options: NodeConsoleOptions | NodeConsoleWritable,
    stderr?: NodeConsoleWritable,
    ignoreErrors?: boolean,
  );
  constructor(
    options: NodeConsoleOptions | NodeConsoleWritable,
    stderr?: NodeConsoleWritable,
    ignoreErrors?: boolean,
  ) {
    if (!options || typeof options !== "object") throw new TypeError("Console requires stdout");
    this.#options = consoleOptions(options, stderr, ignoreErrors);
    for (const method of methods)
      Object.defineProperty(this, method, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: this[method].bind(this),
      });
  }

  #write(stream: NodeConsoleWritable, text: string) {
    const message = this.#indent + text.replace(/\n/g, `\n${this.#indent}`) + "\n";
    if (!this.#options.ignoreErrors) {
      stream.write(message);
      return;
    }
    // Writable errors may arrive through both the callback and an error event.
    const swallow = () => {};
    try {
      if (stream.listenerCount?.("error") === 0) stream.once?.("error", swallow);
      stream.write(message, (error: Error | null | undefined) => {
        if (error && stream.listenerCount?.("error") === 0) stream.once?.("error", swallow);
      });
    } catch (error) {
      if (error instanceof RangeError && /call stack/i.test(error.message)) throw error;
    } finally {
      stream.removeListener?.("error", swallow);
    }
  }

  #format(stream: NodeConsoleWritable, data: unknown[]) {
    return NodeUtil.formatWithOptions(this.#options.inspectFor(stream), ...data);
  }
  log(...data: unknown[]) {
    this.#write(this.#options.out, this.#format(this.#options.out, data));
  }
  info(...data: unknown[]) {
    this.log(...data);
  }
  debug(...data: unknown[]) {
    this.log(...data);
  }
  warn(...data: unknown[]) {
    this.#write(this.#options.err, this.#format(this.#options.err, data));
  }
  error(...data: unknown[]) {
    this.warn(...data);
  }
  dir(value: unknown, options?: NodeUtil.InspectOptions) {
    this.#write(
      this.#options.out,
      NodeUtil.inspect(value, {
        customInspect: false,
        ...this.#options.inspectFor(this.#options.out),
        ...options,
      }),
    );
  }
  dirxml(...data: unknown[]) {
    this.log(...data);
  }
  assert(value: unknown, ...data: unknown[]) {
    if (value) return;
    if (typeof data[0] === "string") data[0] = `Assertion failed: ${data[0]}`;
    else data.unshift("Assertion failed");
    this.warn(...data);
  }
  trace(...data: unknown[]) {
    const error = new Error(this.#format(this.#options.err, data));
    error.name = "Trace";
    Error.captureStackTrace(error, StreamConsole.prototype.trace);
    this.error(error.stack);
  }
  time(label = "default") {
    label = `${label}`;
    if (this.#timers.has(label)) {
      this.warn(`Label '${label}' already exists for console.time()`);
      return;
    }
    this.#timers.set(label, performance.now());
  }
  #elapsed(label: string, data: unknown[]) {
    const start = this.#timers.get(label);
    if (start === undefined) {
      this.warn(`No such label '${label}' for console.timeLog()`);
      return;
    }
    this.log(`${label}: ${elapsedTime(performance.now() - start)}`, ...data);
  }
  timeLog(label = "default", ...data: unknown[]) {
    this.#elapsed(`${label}`, data);
  }
  timeEnd(label = "default") {
    label = `${label}`;
    this.#elapsed(label, []);
    this.#timers.delete(label);
  }
  count(label = "default") {
    label = `${label}`;
    const value = (this.#counts.get(label) ?? 0) + 1;
    this.#counts.set(label, value);
    this.log(`${label}: ${value}`);
  }
  countReset(label = "default") {
    label = `${label}`;
    if (!this.#counts.delete(label)) this.warn(`Count for '${label}' does not exist`);
  }
  group(...data: unknown[]) {
    if (data.length > 0) this.log(...data);
    this.#indent += " ".repeat(this.#options.indentation);
  }
  groupCollapsed(...data: unknown[]) {
    this.group(...data);
  }
  groupEnd() {
    this.#indent = this.#indent.slice(
      0,
      Math.max(0, this.#indent.length - this.#options.indentation),
    );
  }
  clear() {
    // Node leaves redirected output alone; terminal output clears without a newline.
    if (this.#options.out.isTTY) this.#options.out.write("\u001b[1;1H\u001b[0J");
  }
  table(data: unknown, properties?: readonly string[]) {
    if (properties !== undefined && !Array.isArray(properties))
      throw new TypeError("Console table properties must be an array");
    if (data === null || typeof data !== "object") {
      this.log(data);
      return;
    }
    this.log(consoleTable(data, properties, this.#options.inspectFor(this.#options.out)));
  }
}
