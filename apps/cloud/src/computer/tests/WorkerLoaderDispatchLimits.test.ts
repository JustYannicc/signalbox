import { describe, expect, it, vi } from "vite-plus/test";
import type { ChildWorkerInvocation } from "../ChildWorkerProgram.ts";
import { DEFAULT_CHILD_CPU_MS, type ChildWorkerLimits } from "../ChildWorkerLimits.ts";
import {
  childWorkerDispatchCodeId,
  createWorkerLoaderDispatch,
  type ChildWorkerLoaderPort,
} from "../WorkerLoaderDispatch.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const command = {
  executable: "/bin/tool",
  argv: ["/bin/tool"],
  cwd: "/",
  env: {},
};
const exit = { exitCode: 0, signal: 0, coreDumped: false };

function invocation(
  limits?: ChildWorkerLimits,
  loaderId = "slot-1",
): ChildWorkerInvocation & { readonly loaderId: string } {
  return {
    loaderId,
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
  it("uses the supplied loader ID verbatim", async () => {
    const fixture = workerLoader();
    const dispatch = createWorkerLoaderDispatch<object>(fixture.loader);

    await dispatch.run(invocation(undefined, "slot-owner:17"), {});

    expect(fixture.get).toHaveBeenCalledWith("slot-owner:17", expect.any(Function));
  });

  it("keeps concurrent calls with distinct slot IDs on separate loader entries", async () => {
    const resultFor = (exitCode: number) => ({ exitCode, signal: 0, coreDumped: false });
    const get = vi.fn<WorkerLoader["get"]>().mockImplementation(
      (loaderId) =>
        ({
          getEntrypoint: vi.fn().mockReturnValue({
            run: async (_command: unknown, target: { stopped(): void }) => {
              target.stopped();
              return resultFor(loaderId === "slot-a" ? 17 : 23);
            },
          }),
          getDurableObjectClass: vi.fn(),
        }) as unknown as WorkerStub,
    );
    const dispatch = createWorkerLoaderDispatch<object>({ get, load: vi.fn() });

    const [first, second] = await Promise.all([
      dispatch.run(invocation(undefined, "slot-a"), {}),
      dispatch.run(invocation(undefined, "slot-b"), {}),
    ]);

    expect(get.mock.calls.map(([id]) => id)).toEqual(["slot-a", "slot-b"]);
    expect([first, second]).toEqual([resultFor(17), resultFor(23)]);
  });

  it("passes the slot ID through an injected compiled loader port", async () => {
    let received: ChildWorkerInvocation | undefined;
    const loader: ChildWorkerLoaderPort = {
      async run(input, target) {
        received = input;
        (target as unknown as { stopped(): void }).stopped();
        return exit;
      },
    };
    const dispatch = createWorkerLoaderDispatch<object>(loader);

    await dispatch.run(invocation(undefined, "compiled-slot:42"), {});

    expect(received).toHaveProperty("loaderId", "compiled-slot:42");
  });

  it("prepares the exact wrapped code identity independently of commands", async () => {
    const first = invocation();
    const firstCodeId = await childWorkerDispatchCodeId(first);

    expect(firstCodeId).toMatch(/^child-v1:[a-f0-9]{64}$/);
    expect(
      await childWorkerDispatchCodeId({
        ...first,
        command: { ...command, argv: ["second"], env: { PRIVATE: "second" } },
      }),
    ).toBe(firstCodeId);
    expect(
      await childWorkerDispatchCodeId({
        ...first,
        modules: { "entry.js": "export default class { changed=true }" },
      }),
    ).not.toBe(firstCodeId);
    expect(await childWorkerDispatchCodeId(invocation({ cpuMs: 500 }))).not.toBe(firstCodeId);
    expect(await childWorkerDispatchCodeId({ ...first, entrypoint: "Alternate" })).not.toBe(
      firstCodeId,
    );
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

  it("rejects missing or empty loader IDs before loading and acknowledges no child", async () => {
    const { loaderId: _loaderId, ...missingId } = invocation();
    const inputs = [invocation(undefined, ""), missingId as ChildWorkerInvocation];

    for (const input of inputs) {
      const fixture = workerLoader();
      const dispatch = createWorkerLoaderDispatch<object>(fixture.loader);

      await expect(dispatch.run(input, {})).rejects.toMatchObject({
        message: "Child loader ID must be a nonempty string",
        termination: { kind: "stopped" },
      });

      expect(fixture.get).not.toHaveBeenCalled();
    }
  });

  it("returns SIGKILL after a memory limit and never reuses that worker handle", async () => {
    const failedRun = vi.fn().mockRejectedValue(new Error("Worker exceeded memory limit"));
    const recoveryRun = vi.fn(async (_command: unknown, target: { stopped(): void }) => {
      target.stopped();
      return exit;
    });
    const stub = (run: typeof failedRun | typeof recoveryRun) =>
      ({
        getEntrypoint: vi.fn().mockReturnValue({ run }),
        getDurableObjectClass: vi.fn(),
      }) as unknown as WorkerStub;
    const failedStub = stub(failedRun);
    const get = vi
      .fn<WorkerLoader["get"]>()
      .mockImplementation((loaderId) =>
        loaderId === "slot-lost" ? failedStub : stub(recoveryRun),
      );
    const load = vi.fn<WorkerLoader["load"]>();
    const dispatch = createWorkerLoaderDispatch<object>({ get, load });

    const onMemoryLost = vi.fn(async () => {});
    await expect(
      dispatch.run(invocation(undefined, "slot-lost"), {}, onMemoryLost),
    ).resolves.toEqual({
      exitCode: 0,
      signal: 9,
      coreDumped: false,
    });
    await expect(dispatch.run(invocation(undefined, "slot-fresh"), {})).resolves.toEqual(exit);

    expect(failedRun).toHaveBeenCalledOnce();
    expect(onMemoryLost).toHaveBeenCalledOnce();
    expect(get.mock.calls.map(([id]) => id)).toEqual(["slot-lost", "slot-fresh"]);
    expect(load).not.toHaveBeenCalled();
    expect(recoveryRun).toHaveBeenCalledOnce();
  });

  it("awaits loader retirement before acknowledging a memory loss", async () => {
    const enteredLoss = Promise.withResolvers<void>();
    const finishLoss = Promise.withResolvers<void>();
    const events: string[] = [];
    const run = vi.fn(async (_command: unknown, target: object) => {
      const completion = target as { stopped(): void };
      const acknowledge = completion.stopped.bind(target);
      vi.spyOn(completion, "stopped").mockImplementation(() => {
        events.push("stopped");
        acknowledge();
      });
      throw new Error("Worker exceeded memory limit");
    });
    const get = vi.fn<WorkerLoader["get"]>().mockReturnValue({
      getEntrypoint: vi.fn().mockReturnValue({ run }),
      getDurableObjectClass: vi.fn(),
    } as unknown as WorkerStub);
    const dispatch = createWorkerLoaderDispatch<object>({ get, load: vi.fn() });
    const onMemoryLost = vi.fn(async () => {
      events.push("loss-started");
      enteredLoss.resolve();
      await finishLoss.promise;
      events.push("loss-finished");
    });

    const pending = dispatch.run(invocation(), {}, onMemoryLost);
    await enteredLoss.promise;
    expect(events).toEqual(["loss-started"]);
    expect(onMemoryLost).toHaveBeenCalledOnce();

    finishLoss.resolve();
    await expect(pending).resolves.toEqual({ exitCode: 0, signal: 9, coreDumped: false });
    expect(events).toEqual(["loss-started", "loss-finished", "stopped"]);
  });

  it("calls the retirement handler once even when the loader reports memory loss twice", async () => {
    const onMemoryLost = vi.fn(async () => {});
    const loader: ChildWorkerLoaderPort = {
      async run(_input, target) {
        const lifecycle = target as unknown as { lost(): Promise<void> };
        await lifecycle.lost();
        await lifecycle.lost();
        throw new Error("Worker exceeded memory limit");
      },
    };
    const dispatch = createWorkerLoaderDispatch<object>(loader);

    await expect(dispatch.run(invocation(), {}, onMemoryLost)).resolves.toEqual({
      exitCode: 0,
      signal: 9,
      coreDumped: false,
    });

    expect(onMemoryLost).toHaveBeenCalledOnce();
  });

  it("leaves memory loss unconfirmed when no retirement callback is supplied", async () => {
    const run = vi.fn().mockRejectedValue(new Error("Worker exceeded memory limit"));
    const get = vi.fn<WorkerLoader["get"]>().mockReturnValue({
      getEntrypoint: vi.fn().mockReturnValue({ run }),
      getDurableObjectClass: vi.fn(),
    } as unknown as WorkerStub);
    const dispatch = createWorkerLoaderDispatch<object>({ get, load: vi.fn() });

    await expect(dispatch.run(invocation(), {})).rejects.toMatchObject({
      message: "Child memory loss requires an onMemoryLost callback",
      termination: { kind: "unconfirmed" },
    });
  });

  it("keeps unknown worker failures unconfirmed without switching to an unnamed worker", async () => {
    const failure = new Error("Worker call disconnected");
    const run = vi.fn().mockRejectedValue(failure);
    const get = vi.fn<WorkerLoader["get"]>().mockReturnValue({
      getEntrypoint: vi.fn().mockReturnValue({ run }),
      getDurableObjectClass: vi.fn(),
    } as unknown as WorkerStub);
    const load = vi.fn<WorkerLoader["load"]>();
    const dispatch = createWorkerLoaderDispatch<object>({ get, load });

    await expect(dispatch.run(invocation(), {})).rejects.toMatchObject({
      cause: failure,
      termination: { kind: "unconfirmed" },
    });

    expect(get).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
  });
});
