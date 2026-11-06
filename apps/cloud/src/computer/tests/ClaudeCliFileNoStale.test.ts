import { describe, expect, it, vi } from "vite-plus/test";
import { cliFileBackendFixture as fixture } from "./helpers/cliFileBackend.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const settle = async (call: () => unknown) => {
  try {
    return { value: await call() };
  } catch (cause) {
    return { code: (cause as { code?: string }).code };
  }
};

describe("CLI filesystem consistency without ESTALE", () => {
  it.each([
    { machineRunning: false, label: "" },
    { machineRunning: true, label: " a machine command" },
  ])(
    "answers from the last consistent view while a child runs$label",
    async ({ machineRunning }) => {
      let machine = { machine: 0, machineRunning: false };
      const f = await fixture(1024, ["/sync"], false, { machine: () => machine });
      try {
        await f.files.beforeRemote();
        if (machineRunning) machine = { machine: 1, machineRunning: true };
        f.canonical.writeFileSync("/child", "from the child");
        const answers = [
          await settle(() => f.fs.readFileSync("/sync", "utf8")),
          await settle(() => f.fs.statSync("/sync").size),
          await settle(() => f.fs.lstatSync("/sync").size),
          await settle(() => f.fs.realpathSync("/sync")),
          await settle(() => f.fs.readdirSync("/").includes("sync")),
          await settle(() => f.fs.existsSync("/sync")),
          await settle(() => f.fs.writeFileSync("/mine", "the CLI's own")),
          await settle(() => f.fs.readFileSync("/mine", "utf8")),
          await settle(() => f.fs.promises.mkdir("/made")),
          // The CLI's own async write is visible to its next sync call.
          await settle(() => f.fs.existsSync("/made")),
          await settle(async () => (await f.fs.promises.stat("/child")).size),
          await settle(() => f.fs.promises.readFile("/sync", "utf8")),
        ];
        expect(answers).toEqual([
          { value: "before" },
          { value: 6 },
          { value: 6 },
          { value: "/sync" },
          { value: true },
          { value: true },
          { value: undefined },
          { value: "the CLI's own" },
          { value: undefined },
          { value: true },
          { value: 14 },
          { value: "before" },
        ]);
        machine = { machine: 1, machineRunning: false };
        await f.files.afterRemote();
        expect(f.fs.statSync("/child").size).toBe(14);
        expect(f.canonical.readFileSync("/mine", "utf8")).toBe("the CLI's own");
      } finally {
        await f.close();
      }
    },
  );

  it("answers sync and async calls while a round reads Computer", async () => {
    const f = await fixture();
    try {
      f.canonical.writeFileSync("/late", "late");
      const round = f.holdNext("lookup");
      const refreshing = f.files.refresh();
      await round.entered;
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("before");
      expect(f.fs.statSync("/sync").size).toBe(6);
      const stat = f.fs.promises.stat("/sync");
      f.fs.writeFileSync("/sync", "during");
      round.release();
      await refreshing;
      expect((await stat).isFile()).toBe(true);
      expect(f.fs.readFileSync("/sync", "utf8")).toBe("during");
      expect(f.fs.statSync("/late").size).toBe(4);
    } finally {
      await f.close();
    }
  });
});
