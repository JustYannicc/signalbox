import { describe, expect, it, vi } from "vite-plus/test";
import type { ChildWorkerInvocation } from "../ChildWorkerProgram.ts";
import { DEFAULT_CHILD_CPU_MS, type ChildWorkerLimits } from "../ChildWorkerLimits.ts";
import { createWorkerLoaderDispatch, type ChildWorkerLoaderPort } from "../WorkerLoaderDispatch.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const command = {
  executable: "/bin/tool",
  argv: ["/bin/tool"],
  cwd: "/",
  env: {},
};
const exit = { exitCode: 0, signal: 0, coreDumped: false };

function invocation(limits?: ChildWorkerLimits): ChildWorkerInvocation {
  return {
    mainModule: "entry.js",
    modules: { "entry.js": "export default class {}" },
    ...(limits === undefined ? {} : { limits }),
    command,
  };
}

function workerLoader() {
  let workerCode: WorkerLoaderWorkerCode | undefined;
  let entrypointOptions: WorkerStubEntrypointOptions | undefined;
  const get = vi.fn(
    (
      _name: string | null,
      getCode: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>,
    ) => {
      const code = getCode();
      if (code instanceof Promise) throw new Error("Expected synchronous child code");
      workerCode = code;
      return {
        getEntrypoint(_name?: string, options?: WorkerStubEntrypointOptions) {
          entrypointOptions = options;
          return {
            async run(_command: unknown, target: unknown) {
              (target as { stopped(): void }).stopped();
              return exit;
            },
          };
        },
      };
    },
  );
  return {
    loader: { get } as unknown as WorkerLoader,
    get,
    getWorkerCode: () => workerCode,
    getEntrypointOptions: () => entrypointOptions,
  };
}

const validBudgets: readonly [string, ChildWorkerLimits | undefined, number][] = [
  ["missing", undefined, DEFAULT_CHILD_CPU_MS],
  ["partial", {}, DEFAULT_CHILD_CPU_MS],
  ["lower", { cpuMs: 500 }, 500],
  ["higher", { cpuMs: 9_000_000_000 }, 9_000_000_000],
];

describe("WorkerLoader child CPU limits", () => {
  it("reuses code for different commands and separates source and policy changes", async () => {
    const fixture = workerLoader();
    const dispatch = createWorkerLoaderDispatch<object>(fixture.loader);
    await dispatch.run(invocation(), { first: true });
    await dispatch.run(
      { ...invocation(), command: { ...command, argv: ["second"], env: { PRIVATE: "second" } } },
      { second: true },
    );
    const firstKey = fixture.get.mock.calls[0]?.[0];
    expect(firstKey).toMatch(/^child-v1:[a-f0-9]{64}$/);
    expect(fixture.get.mock.calls[1]?.[0]).toBe(firstKey);
    await dispatch.run(
      { ...invocation(), modules: { "entry.js": "export default class { changed=true }" } },
      {},
    );
    expect(fixture.get.mock.calls[2]?.[0]).not.toBe(firstKey);
    await dispatch.run(invocation({ cpuMs: 500 }), {});
    expect(fixture.get.mock.calls[3]?.[0]).not.toBe(firstKey);
  });

  it.each(validBudgets)(
    "passes the resolved %s budget into code and entrypoint options",
    async (_name, limits, expected) => {
      const fixture = workerLoader();
      const dispatch = createWorkerLoaderDispatch<object>(fixture.loader);

      await expect(dispatch.run(invocation(limits), {})).resolves.toEqual(exit);

      expect(fixture.getWorkerCode()?.limits).toEqual({ cpuMs: expected });
      expect(fixture.getEntrypointOptions()?.limits).toEqual({ cpuMs: expected });
    },
  );

  it("passes the resolved budget through an injected child loader", async () => {
    let received: ChildWorkerInvocation | undefined;
    const loader: ChildWorkerLoaderPort = {
      async run(input, target) {
        received = input;
        (target as unknown as { stopped(): void }).stopped();
        return exit;
      },
    };
    const dispatch = createWorkerLoaderDispatch<object>(loader);

    await expect(dispatch.run(invocation(), {})).resolves.toEqual(exit);

    expect(received?.limits).toEqual({ cpuMs: DEFAULT_CHILD_CPU_MS });
  });

  it.each([
    ["zero", { cpuMs: 0 }],
    ["negative", { cpuMs: -1 }],
    ["fractional", { cpuMs: 1.5 }],
    ["unsafe", { cpuMs: Number.MAX_SAFE_INTEGER + 1 }],
    ["null cpuMs", JSON.parse('{"cpuMs":null}') as ChildWorkerLimits],
    ["array config", JSON.parse("[]") as ChildWorkerLimits],
  ])("rejects %s limits before requesting WorkerLoader", async (_name, limits) => {
    const fixture = workerLoader();
    const dispatch = createWorkerLoaderDispatch<object>(fixture.loader);

    await expect(dispatch.run(invocation(limits), {})).rejects.toThrow();

    expect(fixture.get).not.toHaveBeenCalled();
  });

  it("rejects invalid limits before invoking an injected loader", async () => {
    const run = vi.fn(async () => exit);
    const dispatch = createWorkerLoaderDispatch<object>({ run });

    await expect(dispatch.run(invocation({ cpuMs: 0 }), {})).rejects.toThrow();

    expect(run).not.toHaveBeenCalled();
  });
});
