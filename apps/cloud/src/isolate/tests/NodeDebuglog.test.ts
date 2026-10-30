// @effect-diagnostics nodeBuiltinImport:off - Only pure message formatting comes from the native util module.
import * as NodeUtil from "node:util";
import { describe, expect, it } from "@effect/vitest";
import { createNodeDebuglog } from "../NodeDebuglog.ts";

function guest(debug?: string, pid = 42) {
  const lines: string[] = [];
  const warnings: string[] = [];
  return {
    lines,
    warnings,
    env: { NODE_DEBUG: debug },
    pid,
    stderr: { write: (text: string) => lines.push(text) },
    emitWarning: (text: string) => warnings.push(text),
  };
}

describe("guest util.debuglog", () => {
  it("defaults to silence and initializes its callback only on the first call", () => {
    const process = guest();
    const debuglog = createNodeDebuglog(NodeUtil.format, () => process);
    const callbacks: boolean[] = [];
    const log = debuglog("worker", (logger) => callbacks.push(logger.enabled));
    expect(callbacks).toEqual([]);
    log("hidden %s", "data");
    log("still hidden");
    expect(callbacks).toEqual([false]);
    expect(process.lines).toEqual([]);
    const inspected = debuglog("worker", () => callbacks.push(true));
    expect(inspected.enabled).toBe(false);
    inspected("hidden");
    expect(callbacks).toEqual([false]);
    process.env.NODE_DEBUG = "";
    expect(debuglog("").enabled).toBe(false);
  });

  it("matches comma-separated wildcards case-insensitively and escapes regex characters", () => {
    const process = guest("worker*,pkg.other");
    const debuglog = createNodeDebuglog(NodeUtil.format, () => process);
    const first = debuglog("Worker:io");
    expect(first.enabled).toBe(true);
    first("read %d %s", 7, "bytes");
    debuglog("pkg.other")("literal dot");
    debuglog("pkgXother")("hidden");
    expect(process.lines).toEqual(["WORKER:IO 42: read 7 bytes\n", "PKG.OTHER 42: literal dot\n"]);
  });

  it("keeps the environment, PID and stderr attached to each guest", () => {
    const first = guest("*", 10);
    const second = guest(undefined, 20);
    let current = first;
    const debuglog = createNodeDebuglog(NodeUtil.format, () => current);
    const log = debuglog("worker");
    current = second;
    debuglog("worker")("hidden");
    log("first guest");
    expect(first.lines).toEqual(["WORKER 10: first guest\n"]);
    expect(second.lines).toEqual([]);
  });

  it("warns only when an enabled HTTP logger first emits", () => {
    const process = guest("http");
    const debuglog = createNodeDebuglog(NodeUtil.format, () => process);
    const log = debuglog("http");
    expect(log.enabled).toBe(true);
    expect(process.warnings).toEqual([]);
    log("request");
    log("response");
    expect(process.warnings).toHaveLength(1);
    expect(process.lines).toEqual(["HTTP 42: request\n", "HTTP 42: response\n"]);
  });
});
