import { beforeAll, expect, it, vi } from "vite-plus/test";
import { prepareCodeModeHost } from "../../../infra/codeMode/prepare.ts";
import { createCodeModeWorkerLoader } from "../../codeMode/Loader.ts";
import { vmWorkerLoader } from "../../codeMode/workerTesting.ts";
import type { CodeModeCellCode, CodeModeCellLoaderPort } from "../../codeMode/Types.ts";
import type { ProductComputer } from "../ProductComputer.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { productCodeModeFixture } from "./productCodeModeFixture.ts";

vi.mock("evlog", () => ({ log: { warn: vi.fn() } }));
vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));
let code: CodeModeCellCode;
beforeAll(async () => {
  code = (await prepareCodeModeHost()).code;
});

const execTool = [
  {
    name: "exec_command",
    tool_name: { name: "exec_command", namespace: null },
    kind: "function" as const,
    description: "",
    input_schema: null,
    output_schema: null,
  },
];

it.each(["idle", "awaiting exec_command"] as const)(
  "caps %s cells at nine and lets all ten finish",
  async (mode) => {
    const workers = vmWorkerLoader();
    const direct = createCodeModeWorkerLoader({ loader: workers.loader, policy: { cpuMs: 100 } });
    const release = Promise.withResolvers<void>();
    const overflow = Promise.withResolvers<void>();
    const pressure = Promise.withResolvers<void>();
    let active = 0;
    let peak = 0;
    let commands = 0;
    let closing = false;
    const acquire = ChildWorkerCapacity.prototype.acquire;
    const watched = new Set<ChildWorkerCapacity>();
    const unsubscribers: (() => void)[] = [];
    const spy = vi.spyOn(ChildWorkerCapacity.prototype, "acquire").mockImplementation(function (
      this: ChildWorkerCapacity,
      signal,
      requester,
      request,
    ) {
      if (this.owner.endsWith("/code-mode") && !watched.has(this)) {
        watched.add(this);
        unsubscribers.push(
          this.onPressure((event) => {
            if (event.kind === "capacity") pressure.resolve();
          }),
        );
      }
      return acquire.call(this, signal, requester, request);
    });
    const cells: CodeModeCellLoaderPort = {
      async run(input, events) {
        active++;
        peak = Math.max(peak, active);
        if (active === 10) overflow.resolve();
        try {
          if (mode === "idle") await release.promise;
          return await direct.run(input, events);
        } finally {
          active--;
        }
      },
    };
    const fixture = await productCodeModeFixture({
      code,
      cells,
      async run(_input, target) {
        commands++;
        await (target as typeof target & { stopped(): Promise<void> }).stopped();
        return { exitCode: 0, signal: 0, coreDumped: false };
      },
      async onDelegate(computer) {
        await release.promise;
        if (closing) return { output: "" };
        return runCommand(computer);
      },
    });
    try {
      for (let i = 0; i < 10; i++)
        await fixture.execute(
          mode === "idle" ? 'text("done");' : 'await tools.exec_command({cmd:"printf nested"});',
          mode === "idle" ? [] : execTool,
        );
      expect(
        await Promise.race([
          pressure.promise.then(() => "queued"),
          overflow.promise.then(() => "overflow"),
        ]),
      ).toBe("queued");
      expect(active).toBe(9);
      expect(commands).toBe(0);
      release.resolve();
      for (let i = 1; i <= 10; i++) {
        const waited = await fixture.request({
          method: "session/wait",
          sessionId: "s1",
          request: { cell_id: String(i), yield_time_ms: 1000 },
        });
        expect(JSON.stringify(await waited.response)).toContain('"Result"');
      }
      expect(commands).toBe(mode === "idle" ? 0 : 10);
      expect(peak).toBe(9);
      await fixture.child.signal(15);
      await fixture.computer.drain();
      expect(active).toBe(0);
    } finally {
      closing = true;
      release.resolve();
      await fixture.close();
      for (const unsubscribe of unsubscribers) unsubscribe();
      spy.mockRestore();
    }
  },
);

it("lets commands alone occupy all ten physical slots", async () => {
  const entered = Array.from({ length: 10 }, () => Promise.withResolvers<void>());
  const release = Promise.withResolvers<void>();
  let active = 0;
  let peak = 0;
  const fixture = await productCodeModeFixture({
    code,
    cells: {
      async run() {
        throw new Error("No cells expected");
      },
    },
    async run(_input, target) {
      active++;
      peak = Math.max(peak, active);
      entered[active - 1]!.resolve();
      try {
        await release.promise;
        return { exitCode: 0, signal: 0, coreDumped: false };
      } finally {
        active--;
        await (target as typeof target & { stopped(): Promise<void> }).stopped();
      }
    },
  });
  const commands: Promise<unknown>[] = [];
  try {
    for (const milestone of entered) {
      commands.push(runCommand(fixture.computer));
      await milestone.promise;
    }
    expect(active).toBe(10);
    expect(peak).toBe(10);
    release.resolve();
    await Promise.all(commands);
    await fixture.child.signal(15);
    await fixture.computer.drain();
    expect(active).toBe(0);
  } finally {
    release.resolve();
    await Promise.allSettled(commands);
    await fixture.close();
  }
});

async function runCommand(computer: ProductComputer) {
  const child = await computer.exec(
    {
      executable: "/bin/bash",
      argv: ["/bin/bash", "-c", "printf nested"],
      cwd: "/workspace",
      env: {},
    },
    new AbortController().signal,
    undefined,
  );
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  try {
    await child.exited;
    const [stdout] = await output;
    return { output: stdout };
  } finally {
    await child.dispose();
  }
}
