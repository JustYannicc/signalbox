import { describe, expect, it, vi } from "vite-plus/test";
import { firstCommandFixture } from "./FirstMachineCommandFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("Product Computer first machine command", () => {
  it.each([false, true])("preserves uname after first spawn with attached=%s", async (attached) => {
    const fixture = firstCommandFixture(attached);
    await fixture.attach();
    const before = fixture.files.current().generation;
    expect(before).toBe(attached ? 1 : null);
    const computer = fixture.open();
    try {
      const child = await computer.exec(
        {
          executable: "/usr/bin/uname",
          argv: ["uname", "-s"],
          cwd: "/workspace",
          env: { PATH: "/usr/bin" },
        },
        new AbortController().signal,
        undefined,
      );
      await fixture.finish();
      const exit = child.exited.catch((error: unknown) => {
        throw new AggregateError(
          [error, ...fixture.lookupFailures],
          `Completion failed with ${fixture.lookupGenerations.length} live lookups`,
        );
      });
      await expect(exit).resolves.toEqual({ exitCode: 0, signal: 0, coreDumped: false });
      expect(await new Response(child.stdout).text()).toBe("Linux\n");
      expect(fixture.starts).toHaveLength(1);
      expect(fixture.lookupGenerations.length).toBeGreaterThan(0);
      expect(new Set(fixture.lookupGenerations)).toEqual(new Set([1]));
      await child.dispose();
      expect(fixture.release).toHaveBeenCalledOnce();
    } finally {
      await computer.close();
      await fixture.close();
    }
  });

  it.each(["unattested", "replaced", "unpersisted"] as const)(
    "rejects completion when the first machine generation is %s",
    async (state) => {
      const fixture = firstCommandFixture(false, {
        omitGeneration: state === "unattested",
        replaceGeneration: state === "replaced",
        failDirtyPersist: state === "unpersisted",
      });
      const computer = fixture.open();
      try {
        const child = await computer.exec(
          {
            executable: "/usr/bin/uname",
            argv: ["uname", "-s"],
            cwd: "/workspace",
            env: { PATH: "/usr/bin" },
          },
          new AbortController().signal,
          undefined,
        );
        if (state !== "unpersisted") await fixture.finish();
        await expect(child.exited).rejects.toMatchObject({ code: "IO_ERROR" });
        expect(fixture.starts).toHaveLength(state === "unpersisted" ? 0 : 1);
        expect(fixture.lookupGenerations).toEqual([]);
      } finally {
        await computer.close();
        await fixture.close();
      }
    },
  );
});
