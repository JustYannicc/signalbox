import type { NodeWorkerMessage } from "../NodeWorkerThreads.ts";
import { NodeWorkerPortService, type NodeWorkerPortOwner } from "../NodeWorkerPortsRpc.ts";

interface PortClient {
  touch(amount: number): Promise<number>;
  pair(): Promise<{ id: string; packet: NodeWorkerMessage }>;
  movedPair(): Promise<{ first: NodeWorkerMessage; second: NodeWorkerMessage }>;
  accept(packet: NodeWorkerMessage, echo: boolean): Promise<string>;
  roundTrip(id: string): Promise<unknown>;
  close(): Promise<void>;
}

interface Child {
  open(ports: NodeWorkerPortOwner, owner: string): Promise<PortClient>;
}

const trace: string[] = [];

export default {
  async fetch(request: Request, env: { LOADER: WorkerLoader; CHILD_SOURCE: string }) {
    if (new URL(request.url).pathname === "/trace") return Response.json(trace);
    trace.length = 0;
    const hub = new NodeWorkerPortService();
    const clients: PortClient[] = [];
    const owners: NodeWorkerPortOwner[] = [];
    const children: Child[] = [];
    try {
      for (const owner of ["1396/a", "1396/b", "1396/c"]) {
        trace.push(`open ${owner}`);
        const worker = env.LOADER.get(owner, () => ({
          compatibilityDate: "2026-10-19",
          compatibilityFlags: ["nodejs_compat"],
          mainModule: "child.js",
          modules: { "child.js": env.CHILD_SOURCE },
          globalOutbound: null,
        }));
        const child = worker.getEntrypoint() as unknown as Child;
        const ports = hub.owner(owner);
        children.push(child);
        owners.push(ports);
        clients.push(await child.open(ports, owner));
      }
      const [creator, first, second] = clients;
      if (!creator || !first || !second) throw new Error("Missing child");
      const isolation = [
        await creator.touch(11),
        await first.touch(7),
        await second.touch(3),
        await creator.touch(0),
      ];
      trace.push("create pair");
      const pair = await creator.pair();
      trace.push("transfer pair");
      await hub.transfer("1396/a", "1396/b", pair.packet);
      trace.push("accept pair");
      await first.accept(pair.packet, true);
      trace.push("first round trip");
      const ordinary = await Promise.race([creator.roundTrip(pair.id), hub.failure]);
      trace.push("create moved pair");
      const moved = await creator.movedPair();
      await hub.transfer("1396/a", "1396/b", moved.first);
      await hub.transfer("1396/a", "1396/c", moved.second);
      const id = await first.accept(moved.first, false);
      await second.accept(moved.second, true);
      trace.push("close creator");
      await creator.close();
      const oldChild = children[0];
      const oldOwner = owners[0];
      if (!oldChild || !oldOwner) throw new Error("Missing old process capability");
      let staleOwnerRejected = false;
      try {
        await oldChild.open(oldOwner, "1396/a");
      } catch (error) {
        staleOwnerRejected = String(error).includes("already connected or closed");
        if (!staleOwnerRejected) throw error;
      }
      const replacement = await oldChild.open(hub.owner("1396/a-next"), "1396/a-next");
      clients.push(replacement);
      await replacement.pair();
      await replacement.close();
      trace.push("round trip after creator exit");
      const afterCreatorExit = await Promise.race([first.roundTrip(id), hub.failure]);
      await first.close();
      await second.close();
      trace.push("drain broker");
      await hub.drain();
      return Response.json({
        isolation,
        ordinary,
        afterCreatorExit,
        staleOwnerRejected,
        ports: hub.residentPorts,
      });
    } finally {
      trace.push("cleanup clients");
      try {
        await Promise.all(clients.map((client) => client.close()));
      } finally {
        await hub.dispose();
      }
    }
  },
};
