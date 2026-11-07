import { describe, expect, it, vi } from "vite-plus/test";
import { ComputerExecutionPort } from "../ComputerExecutionPort.ts";
import type { ComputerExecutionConfiguration } from "../ComputerExecutionObject.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const configuration = {
  limit: 2,
  path: ["/bin"],
  programs: {},
} as unknown as ComputerExecutionConfiguration;
const admission = { route: "machine", command: { executable: "/bin/rg" } } as const;

/** A Computer facet whose in-memory owner an eviction can drop. */
function computer() {
  let owner: ComputerExecutionConfiguration | undefined;
  const target = {
    configure: vi.fn(async (input: ComputerExecutionConfiguration) => {
      if (owner !== undefined) throw new Error("Computer execution owner is already configured");
      owner = input;
    }),
    configured: vi.fn(async () => owner !== undefined),
    registrations: vi.fn(async () => []),
    admit: vi.fn(async (_id: string, ..._rest: unknown[]) => {
      if (owner === undefined) throw new Error("Computer execution owner is unavailable");
      return admission;
    }),
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    evict: () => (owner = undefined),
  };
  return target;
}

// The double implements only the calls the port makes.
const portFor = (target: ReturnType<typeof computer>) =>
  new ComputerExecutionPort(
    target as unknown as ConstructorParameters<typeof ComputerExecutionPort>[0],
  );

describe("Computer execution port", () => {
  it("restores an evicted Computer from the configuration it applied, once", async () => {
    const target = computer();
    const port = portFor(target);
    await port.configure(configuration);
    target.evict();
    expect(await port.admit("one", {} as never, {} as never)).toBe(admission);
    expect(target.configure).toHaveBeenCalledTimes(2);
    expect(target.configure).toHaveBeenLastCalledWith(configuration);
    expect(target.admit).toHaveBeenCalledTimes(2);
  });

  it("rethrows a failure from a Computer that is still configured", async () => {
    const target = computer();
    const port = portFor(target);
    await port.configure(configuration);
    target.admit.mockRejectedValueOnce(new Error("ENOENT"));
    await expect(port.admit("one", {} as never, {} as never)).rejects.toThrow("ENOENT");
    expect(target.configure).toHaveBeenCalledTimes(1);
    // A call with side effects never runs twice for its own failure.
    expect(target.admit).toHaveBeenCalledTimes(1);
  });

  it("restores once for concurrent calls that all found the Computer evicted", async () => {
    const target = computer();
    const port = portFor(target);
    await port.configure(configuration);
    target.evict();
    const results = await Promise.all(
      ["one", "two", "three"].map((id) => port.admit(id, {} as never, {} as never)),
    );
    expect(results).toEqual([admission, admission, admission]);
    // One re-application, not one per caller: a second configure would be refused.
    expect(target.configure).toHaveBeenCalledTimes(2);
  });

  it("never configures a Computer it was not asked to configure", async () => {
    const target = computer();
    const port = portFor(target);
    await expect(port.admit("one", {} as never, {} as never)).rejects.toThrow("unavailable");
    expect(target.configure).not.toHaveBeenCalled();
  });

  it("never retries a call's own failure, even right after another caller restored", async () => {
    const target = computer();
    const port = portFor(target);
    await port.configure(configuration);
    target.evict();
    // B finds the Computer evicted and restores it; A lands on the restored owner and fails itself.
    const evicted = target.admit.getMockImplementation()!;
    target.admit.mockImplementation(async (...args: Parameters<typeof evicted>) => {
      if (args[0] === "a") throw new Error("ENOENT");
      return await evicted(...args);
    });
    const [b, a] = await Promise.allSettled([
      port.admit("b", {} as never, {} as never),
      port.admit("a", {} as never, {} as never),
    ]);
    expect(b).toEqual({ status: "fulfilled", value: admission });
    expect(a).toMatchObject({ status: "rejected", reason: { message: "ENOENT" } });
    expect(target.admit.mock.calls.filter(([id]) => id === "a")).toHaveLength(1);
    expect(target.configure).toHaveBeenCalledTimes(2);
  });

  it("restores nothing once closed", async () => {
    const target = computer();
    const port = portFor(target);
    await port.configure(configuration);
    await port.close();
    target.evict();
    await expect(port.cancel("late" as never)).resolves.toBeUndefined();
    await expect(port.admit("late", {} as never, {} as never)).rejects.toThrow("unavailable");
    expect(target.configure).toHaveBeenCalledTimes(1);
  });

  it("keeps the call's own error when the restore itself fails", async () => {
    const target = computer();
    const port = portFor(target);
    await port.configure(configuration);
    target.evict();
    target.configured.mockRejectedValueOnce(new Error("facet aborted"));
    await expect(port.admit("one", {} as never, {} as never)).rejects.toThrow("unavailable");
  });
});
