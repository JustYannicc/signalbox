import { RpcStub } from "cloudflare:workers";
import { ProviderInstanceId } from "@t3tools/contracts";
import { LocalModelTransport, LocalPoolObject } from "../LocalPoolObject.ts";

export class LocalPool extends LocalPoolObject {}

export default {
  async fetch(_request: Request, env: { POOLS: DurableObjectNamespace<LocalPool> }) {
    const pool = env.POOLS.get(env.POOLS.idFromName("owned-local-pool"));
    try {
      const sent: Array<{ body: string; header: string | null }> = [];
      {
        using transport = new RpcStub(
          new LocalModelTransport(async (request) => {
            sent.push({
              body: await request.text(),
              header: request.headers.get("x-local-request"),
            });
            return new Response("pool answer", { status: 201 });
          }),
        );
        await pool.configure("owner", transport, {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-5-5",
        });
      }
      const created = await pool.create({ userId: "owner" }, { name: "Personal", personal: true });
      if (created._tag !== "ok") throw new Error(created.reason);
      await pool.register();
      using capability = await pool.capability();
      const body =
        '{"model":"claude-opus-5-5", "messages": [{"role":"user","content":"keep exact bytes"}]}';
      const request = () =>
        new Request("https://pool.test/v1/messages?beta=true", {
          method: "POST",
          headers: { "content-type": "application/json", "x-local-request": "kept" },
          body,
        });
      const denied = await capability.forwardModel(
        { userId: "foreign-owner" },
        "/v1/messages?beta=true",
        request(),
      );
      if (sent.length !== 0) throw new Error("The pool forwarded an unowned request.");
      const forwarded = await capability.forwardModel(
        { userId: "owner" },
        "/v1/messages?beta=true",
        request(),
      );
      if (forwarded._tag !== "forwarded")
        throw new Error(`The pool did not forward: ${forwarded._tag}`);
      return Response.json({
        denied: denied._tag,
        forwarded: forwarded._tag,
        status: forwarded.response.status,
        response: await forwarded.response.text(),
        sent,
      });
    } catch (error) {
      return Response.json(
        { error: String(error), stack: error instanceof Error ? error.stack : undefined },
        { status: 500 },
      );
    } finally {
      await pool.dispose();
    }
  },
};
