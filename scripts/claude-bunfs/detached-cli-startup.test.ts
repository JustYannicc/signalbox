// @effect-diagnostics nodeBuiltinImport:off -- Synthetic transformed code runs in an isolated Node context.
import { describe, expect, it } from "@effect/vitest";
import * as NodeVM from "node:vm";
import { CLAUDE_CLI_STARTUP_FAILURE_REPORTER_KEY } from "@t3tools/contracts/harnessReleaseOmission";
import { observeDetachedCliStartupRejection } from "./detached-cli-startup.ts";

const reporterSymbol = Symbol.for(CLAUDE_CLI_STARTUP_FAILURE_REPORTER_KEY);

describe("detached CLI startup rejection hook", () => {
  it("reports the original rejection without awaiting or reordering startup", async () => {
    const failure = new Error("original startup rejection");
    const reported = Promise.withResolvers<unknown>();
    const order: string[] = [];
    const source = `async function renamedStartup() { await 0; throw failure; }
      renamedStartup(); order.push("scheduled");`;
    NodeVM.runInNewContext(observeDetachedCliStartupRejection(source, "cli"), {
      failure,
      order,
      process: {
        [reporterSymbol]: (cause: unknown) => {
          order.push("reported");
          reported.resolve(cause);
        },
      },
    });
    expect(order).toEqual(["scheduled"]);
    expect(await reported.promise).toBe(failure);
    expect(order).toEqual(["scheduled", "reported"]);
  });

  it("keeps the owning reporter when the global process changes", async () => {
    const failure = new Error("late startup rejection");
    const gate = Promise.withResolvers<void>();
    const reported = Promise.withResolvers<unknown>();
    const context = NodeVM.createContext({
      gate: gate.promise,
      failure,
      process: { [reporterSymbol]: (cause: unknown) => reported.resolve(cause) },
    });
    const source = `async function startup() { await gate; throw failure; } startup();`;
    NodeVM.runInContext(observeDetachedCliStartupRejection(source, "cli"), context);
    context.process = {
      [reporterSymbol]: () => {
        throw new Error("Wrong owner");
      },
    };
    gate.resolve();
    expect(await reported.promise).toBe(failure);
  });

  it("fails before startup if the owning host reporter is absent", () => {
    const context = { process: {}, started: false };
    const source = `async function startup() { started = true; } startup();`;
    expect(() =>
      NodeVM.runInNewContext(observeDetachedCliStartupRejection(source, "cli"), context),
    ).toThrow("CLAUDE_CLI_STARTUP_REPORTER_MISSING");
    expect(context.started).toBe(false);
  });

  it("does not report a successful startup", async () => {
    let reported = false;
    const source = `async function startup() { return 42; } startup();`;
    const result: unknown = NodeVM.runInNewContext(
      observeDetachedCliStartupRejection(source, "cli"),
      {
        process: {
          [reporterSymbol]: () => {
            reported = true;
          },
        },
      },
    );
    expect(await result).toBe(42);
    expect(reported).toBe(false);
  });

  it.each([
    "async function startup() {} export const ready = true;",
    "async function* startup() {} startup();",
  ])("refuses an entry without a detached promise-returning startup call", (source) => {
    expect(() => observeDetachedCliStartupRejection(source, "cli")).toThrow(
      "BUNDLE_CLAUDE_STARTUP_ASYNC_CALL_MISSING",
    );
  });

  it("rejects ambiguous detached async startup calls", () => {
    expect(() =>
      observeDetachedCliStartupRejection(
        "async function first() {} async function second() {} first(); second();",
        "cli",
      ),
    ).toThrow("BUNDLE_CLAUDE_STARTUP_ASYNC_CALL_AMBIGUOUS");
  });
});
