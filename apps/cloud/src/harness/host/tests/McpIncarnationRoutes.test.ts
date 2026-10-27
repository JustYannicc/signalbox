import { describe, expect, it } from "vite-plus/test";
import { createMcpRoutes } from "../mcp.ts";
import type { ExecutorMcpPort, ResolvedConnections } from "../contracts.ts";

const connection = (id: string, name: string, directTools = ["read"]) => ({
  id,
  name,
  directTools,
});
const access = (grant: string, servers: ResolvedConnections["servers"]) => ({
  grant,
  signal: new AbortController().signal,
  connections: { servers },
});

// Access cancellation and incarnation lifetime are independent inputs to the router.
describe("MCP process incarnation endpoints", () => {
  it("keeps captured URLs bound to the same server through reordering and permission changes", async () => {
    const calls: Parameters<ExecutorMcpPort<string>["forward"]>[0][] = [];
    const router = createMcpRoutes<string>(
      {
        async forward(input) {
          calls.push(input);
          return new Response("forwarded");
        },
      },
      new AbortController().signal,
      () => 0,
    );
    const session = router.session(new AbortController().signal);
    const first = await session.activate(
      access("grant-1", [connection("a", "A"), connection("b", "B")]),
    );
    const capturedA = first.servers.A!.url;
    const second = await session.activate(
      access("grant-2", [connection("b", "B"), connection("a", "A", ["write"])]),
    );
    expect(second.servers.A!.url).toBe(capturedA);
    expect(second.servers.B!.url).toBe(first.servers.B!.url);
    await router.fetch(new Request(capturedA));
    expect(calls.at(-1)?.grant).toBe("grant-2");
    expect(calls.at(-1)?.target).toEqual({ type: "direct", serverId: "a", tools: ["write"] });

    const third = await session.activate(access("grant-3", [connection("other", "A")]));
    expect(third.servers.A!.url).not.toBe(capturedA);
    const count = calls.length;
    await expect(router.fetch(new Request(capturedA))).rejects.toThrow();
    expect(calls).toHaveLength(count);
    session.close();
  });

  it("refuses stopped endpoints even when a late activation or replacement grant arrives", async () => {
    const calls: string[] = [];
    const router = createMcpRoutes<string>(
      {
        async forward(input) {
          calls.push(input.grant);
          return new Response("ok");
        },
      },
      new AbortController().signal,
      () => 0,
    );
    const old = router.session(new AbortController().signal);
    const first = await old.activate(access("old", []));
    old.close();
    await expect(old.activate(access("late", []))).rejects.toThrow();
    const replacement = router.session(new AbortController().signal);
    const next = await replacement.activate(access("new", []));
    expect(next.servers.executor!.url).not.toBe(first.servers.executor!.url);
    await expect(router.fetch(new Request(first.servers.executor!.url))).rejects.toThrow();
    expect(calls).toEqual([]);
    await router.fetch(new Request(next.servers.executor!.url));
    expect(calls).toEqual(["new"]);
    replacement.close();
  });
});
