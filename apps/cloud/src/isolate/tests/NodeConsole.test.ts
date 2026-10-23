import * as NodeStream from "node:stream";
import * as NodeConsole from "node:console";
import * as NodeUtil from "node:util";
import { describe, expect, it, vi } from "vite-plus/test";
import { createNodeConsole } from "../NodeConsole.ts";

function capture() {
  let text = "";
  const stream = new NodeStream.Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  return { stream, text: () => text };
}

function pair() {
  const out = capture();
  const err = capture();
  return { out, err, console: createNodeConsole(out.stream, err.stream) };
}

describe("stream-bound Node console", () => {
  it("formats values and errors into the supplied streams, including detached calls", () => {
    const { console, out, err } = pair();
    const { log, info, debug, warn, error, assert, dirxml } = console;
    log("%s:%d %j", "ok", 2, { x: true });
    info({ nested: [1, 2] });
    debug("debug");
    warn("warn %d", 4);
    const failure = new Error("broken");
    error(failure);
    assert(true, "invisible");
    assert(false, "bad %s", "thing");
    assert(false);
    dirxml("xml", { a: 1 });
    expect(out.text()).toBe('ok:2 {"x":true}\n{ nested: [ 1, 2 ] }\ndebug\nxml { a: 1 }\n');
    expect(err.text()).toBe(
      `warn 4\n${NodeUtil.inspect(failure)}\nAssertion failed: bad thing\nAssertion failed\n`,
    );
  });

  it("supports positional and options constructors with independent streams and state", () => {
    const root = pair();
    const first = capture();
    const second = capture();
    const one = new root.console.Console(first.stream);
    const two = new root.console.Console({ stdout: second.stream, groupIndentation: 4 });
    one.count("jobs");
    one.count("jobs");
    two.count("jobs");
    one.countReset("jobs");
    one.count("jobs");
    one.warn("same stream");
    two.group("section");
    two.log("one\ntwo");
    two.groupCollapsed("nested");
    two.log("deep");
    two.groupEnd();
    two.groupEnd();
    two.groupEnd();
    two.log("end");
    expect(first.text()).toBe("jobs: 1\njobs: 2\njobs: 1\nsame stream\n");
    expect(second.text()).toBe(
      "jobs: 1\nsection\n    one\n    two\n    nested\n        deep\nend\n",
    );
    expect(root.out.text()).toBe("");
    expect(root.err.text()).toBe("");
  });

  it("accepts Console calls without new and preserves subclass methods", () => {
    const { console } = pair();
    const out = capture();
    console.Console(out.stream).log("callable");
    class TaggedConsole extends console.Console {
      override log(...values: unknown[]) {
        super.log("tag", ...values);
      }
    }
    const instance = new TaggedConsole(out.stream);
    const { log } = instance;
    log("detached");
    expect(instance).toBeInstanceOf(console.Console);
    expect(out.text()).toBe("callable\ntag detached\n");
  });

  it("uses monotonic time, retains timeLog labels, and removes timeEnd labels", () => {
    const { console, out, err } = pair();
    const now = vi.spyOn(performance, "now");
    try {
      now.mockReturnValueOnce(100).mockReturnValueOnce(112.25).mockReturnValueOnce(120);
      console.time("task");
      console.time("task");
      const { timeLog, timeEnd } = console;
      timeLog("task", { step: 1 });
      timeEnd("task");
      timeLog("task");
      console.countReset("missing");
      expect(out.text()).toBe("task: 12.25ms { step: 1 }\ntask: 20ms\n");
      expect(err.text()).toContain("Label 'task' already exists");
      expect(err.text()).toContain("No such label 'task'");
      expect(err.text()).toContain("Count for 'missing' does not exist");
    } finally {
      now.mockRestore();
    }
  });

  it("inspects without custom hooks for dir, and emits trace stacks on stderr", () => {
    const { console, out, err } = pair();
    const value = { hidden: { deep: 1 }, [NodeUtil.inspect.custom]: () => "custom" };
    console.dir(value, { depth: 0 });
    console.trace("origin %d", 7);
    expect(out.text()).toContain("hidden: [Object]");
    expect(out.text()).not.toBe("custom\n");
    expect(err.text()).toContain("Trace: origin 7");
    expect(err.text()).toContain("NodeConsole.test.ts");
  });

  it("renders object, property-filtered, map, set, and scalar tables", () => {
    const actual = pair();
    const nativeOut = capture();
    const native = new NodeConsole.Console(nativeOut.stream);
    for (const console of [actual.console, native]) {
      console.table(
        [
          { name: "Ada", age: 32 },
          { name: "Bo", age: 7 },
        ],
        ["name"],
      );
      console.table(new Map([["a", 1]]));
      console.table(new Set([1, 2]));
      console.table("plain");
    }
    // Compare rendered content as well as table shape; padding is presentation-only.
    const normalize = (value: string) => value.replace(/ +/g, " ");
    expect(normalize(actual.out.text())).toBe(normalize(nativeOut.text()));
    expect(actual.out.text()).not.toContain("age");
    expect(() => actual.console.table([], "name" as never)).toThrow(TypeError);
  });

  it("honors inspect options, per-stream options, and validation", () => {
    const out = capture();
    const err = capture();
    const console = createNodeConsole({
      stdout: out.stream,
      stderr: err.stream,
      inspectOptions: new Map([
        [out.stream, { depth: 0 }],
        [err.stream, { depth: 2 }],
      ]),
    });
    console.log({ a: { b: 1 } });
    console.error({ a: { b: 1 } });
    expect(out.text()).toBe("{ a: [Object] }\n");
    expect(err.text()).toBe("{ a: { b: 1 } }\n");
    expect(() => createNodeConsole({ stdout: out.stream, groupIndentation: -1 })).toThrow(
      RangeError,
    );
    expect(() =>
      createNodeConsole({ stdout: out.stream, colorMode: true, inspectOptions: { colors: false } }),
    ).toThrow(TypeError);
    expect(() => new console.Console({} as never)).toThrow(TypeError);
  });

  it("ignores writable failures by default and propagates them when requested", async () => {
    const failure = new Error("write failed");
    const throws = {
      write() {
        throw failure;
      },
    };
    const console = createNodeConsole(throws);
    expect(() => console.log("ignored")).not.toThrow();
    expect(() => new console.Console(throws, undefined, false).log("visible")).toThrow(failure);
    const failing = new NodeStream.Writable({
      write(_chunk, _encoding, done) {
        done(failure);
      },
    });
    const closed = new Promise<void>((resolve) => failing.once("close", resolve));
    createNodeConsole(failing).log("async failure");
    await closed;
  });

  it("clears a terminal while preserving redirected output", () => {
    const out = capture();
    const console = createNodeConsole(out.stream);
    console.clear();
    expect(out.text()).toBe("");
    Object.assign(out.stream, { isTTY: true });
    console.clear();
    expect(out.text()).toBe("\u001b[1;1H\u001b[0J");
  });
});
