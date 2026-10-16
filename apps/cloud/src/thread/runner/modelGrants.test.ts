import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import type { ModelForwardReply, PoolObjectNamespace } from "../../pool/PoolDirectory.ts";
import type { UserObjectNamespace } from "../../user/UserDirectory.ts";
import type { ThreadObjectNamespace } from "../ThreadDirectory.ts";
import { serveModel } from "./modelGrants.ts";

/** A model token for thread `thread-a` (`modelToken.ts`). */
const TOKEN = "sbm1.dGhyZWFkLWE.live";

const byName = <A>(get: (name: string) => A) => ({
  idFromName: (name: string) => name as unknown as DurableObjectId,
  jurisdiction: () => ({ idFromName: (name: string) => name as unknown as DurableObjectId }),
  get: (id: DurableObjectId) => get(id as unknown as string),
});

describe("serveModel", () => {
  it("names a turn's thread to its pool, which keeps the thread on one account", async () => {
    const asked: Array<{ readonly objectName: string; readonly thread: string | undefined }> = [];
    const threads = byName(() => ({
      authorizeModel: async () => ({
        _tag: "granted",
        runId: RunId.make("run-1"),
        traceId: "trace",
        pool: { objectName: "user_1:personal", userId: "user_1" },
      }),
    })) as unknown as ThreadObjectNamespace;
    const pools = byName((objectName) => ({
      forwardModel: async (_actor: unknown, _path: string, _request: Request, thread?: string) => {
        asked.push({ objectName, thread });
        return {
          _tag: "forwarded",
          response: new Response("ok"),
          upstreamMs: 1,
        } satisfies ModelForwardReply;
      },
    })) as unknown as PoolObjectNamespace;
    const served = await serveModel(
      {
        threads,
        users: byName(() => ({})) as unknown as UserObjectNamespace,
        pools,
        verifyLocalKey: async () => null,
        token: TOKEN,
        provider: "anthropic",
        path: "/v1/messages",
        request: new Request("http://gateway.test/anthropic/v1/messages", { method: "POST" }),
      },
      { localWorkerd: true },
    );
    expect(served._tag).toBe("granted");
    expect(asked).toEqual([{ objectName: "user_1:personal", thread: "thread-a" }]);
  });
});
