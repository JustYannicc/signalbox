import { beforeAll, expect, it, vi } from "vite-plus/test";
import { prepareCodeModeHost } from "../../../infra/codeMode/prepare.ts";
import { createCodeModeWorkerLoader } from "../../codeMode/Loader.ts";
import { vmWorkerLoader } from "../../codeMode/workerTesting.ts";
import type { CodeModeCellCode, CodeModeCellLoaderPort } from "../../codeMode/Types.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { productCodeModeFixture } from "./productCodeModeFixture.ts";

vi.mock("evlog", () => ({ log: { warn: vi.fn() } }));
vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));
let code: CodeModeCellCode;
beforeAll(async () => {
  code = (await prepareCodeModeHost()).code;
});

it("cancels the exact suspended timer cell through product drain", async () => {
  const armed = Promise.withResolvers<void>();
  const workers = vmWorkerLoader({
    onTimer: (delay) => {
      if (delay === 60000) armed.resolve();
    },
  });
  const cells = createCodeModeWorkerLoader({ loader: workers.loader, policy: { cpuMs: 100 } });
  const fixture = await productCodeModeFixture({ code, cells });
  try {
    await fixture.execute("await new Promise(r => setTimeout(r, 60000));");
    await armed.promise;
    await fixture.child.signal(15);
    await fixture.computer.drain();
    expect(fixture.capacity.active).toBe(0);
    expect(await fixture.child.exited).toMatchObject({ signal: 15 });
  } finally {
    await fixture.close();
  }
});

it("releases failed acquisition through product drain", async () => {
  const cells = createCodeModeWorkerLoader({
    loader: {
      get() {
        throw new Error("acquisition failed");
      },
    } as unknown as WorkerLoader,
    policy: { cpuMs: 100 },
  });
  const fixture = await productCodeModeFixture({ code, cells });
  try {
    const initial = await fixture.execute('text("unreachable");');
    const waited = await fixture.request({
      method: "session/wait",
      sessionId: "s1",
      request: { cell_id: "1", yield_time_ms: 1000 },
    });
    expect(JSON.stringify([initial, await waited.response])).toContain("acquisition failed");
    await fixture.child.signal(15);
    await fixture.computer.drain();
    expect(fixture.capacity.active).toBe(0);
  } finally {
    await fixture.close();
  }
});

it("queues cells and nested exec_command at the shared ten-worker limit", async () => {
  const workers = vmWorkerLoader();
  const direct = createCodeModeWorkerLoader({ loader: workers.loader, policy: { cpuMs: 100 } });
  let active = 0;
  let peak = 0;
  let started = 0;
  const sixthCell = Promise.withResolvers<void>();
  const entered = () => {
    active++;
    peak = Math.max(peak, active);
  };
  const exited = () => {
    active--;
  };
  const commands: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  const milestones = Array.from({ length: 6 }, () => Promise.withResolvers<void>());
  const queued = Promise.withResolvers<void>();
  const acquire = ChildWorkerCapacity.prototype.acquire;
  let admissions = 0;
  const spy = vi.spyOn(ChildWorkerCapacity.prototype, "acquire").mockImplementation(function (
    this: ChildWorkerCapacity,
    signal,
    requester,
    code,
  ) {
    const permit = acquire.call(this, signal, requester, code);
    if (this.owner.endsWith("/worker-context") && ++admissions === 11) queued.resolve();
    return permit;
  });
  const cells: CodeModeCellLoaderPort = {
    async run(input, events) {
      entered();
      started++;
      if (started === 6) sixthCell.resolve();
      try {
        return await direct.run(input, events);
      } finally {
        exited();
      }
    },
  };
  let finishing = false;
  const fixture = await productCodeModeFixture({
    code,
    cells,
    async run(_input, target) {
      entered();
      const completion = target as typeof target & { stopped(): void };
      try {
        const gate = Promise.withResolvers<void>();
        commands.push(gate);
        milestones[commands.length - 1]?.resolve();
        if (!finishing) await gate.promise;
        return { exitCode: 0, signal: 0, coreDumped: false };
      } finally {
        exited();
        completion.stopped();
      }
    },
    async onDelegate(computer) {
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
      await child.exited;
      await child.dispose();
      const [stdout] = await output;
      return { output: stdout };
    },
  });
  const tools = [
    {
      name: "exec_command",
      tool_name: { name: "exec_command", namespace: null },
      kind: "function" as const,
      description: "",
      input_schema: null,
      output_schema: null,
    },
  ];
  try {
    for (let i = 0; i < 5; i++) {
      await fixture.execute('await tools.exec_command({cmd:"printf nested"});', tools);
      await milestones[i]!.promise;
    }
    expect(active).toBe(10);
    await fixture.execute('await tools.exec_command({cmd:"printf nested"});', tools);
    expect(
      await Promise.race([
        queued.promise.then(() => "queued"),
        sixthCell.promise.then(() => "overflow"),
      ]),
    ).toBe("queued");
    expect(started).toBe(5);
    expect(active).toBe(10);
    finishing = true;
    for (const gate of commands) gate.resolve();
    await milestones[5]!.promise;
    for (let i = 1; i <= 6; i++) {
      const waited = await fixture.request({
        method: "session/wait",
        sessionId: "s1",
        request: { cell_id: String(i), yield_time_ms: 1000 },
      });
      expect(JSON.stringify(await waited.response)).toContain('"Result"');
    }
    expect(peak).toBe(10);
    await fixture.child.signal(15);
    await fixture.computer.drain();
    expect(active).toBe(0);
    expect(fixture.capacity.active).toBe(0);
  } finally {
    finishing = true;
    for (const gate of commands) gate.resolve();
    await fixture.close();
    spy.mockRestore();
  }
});
