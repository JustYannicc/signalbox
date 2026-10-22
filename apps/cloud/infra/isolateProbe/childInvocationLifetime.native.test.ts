// @effect-diagnostics nodeBuiltinImport:off - Wrangler loads the native fixture from disk.
import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

let tailed = Promise.withResolvers<unknown>();
const collector = NodeHttp.createServer(async (request, response) => {
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) body += chunk;
  tailed.resolve(JSON.parse(body));
  response.end("ok");
});

let harness: ReturnType<typeof createTestHarness>;
let endpoint: URL;
let parent: Promise<Response> | undefined;

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    collector.once("error", reject);
    collector.listen(0, "127.0.0.1", () => {
      collector.off("error", reject);
      resolve();
    });
  });
  const address = collector.address();
  if (address === null || typeof address === "string") throw new Error("Missing collector port");
  harness = createTestHarness({
    workers: [
      {
        config: {
          name: "child-invocation-lifetime",
          main: NodeURL.fileURLToPath(
            new URL("./childInvocationLifetime.fixture.ts", import.meta.url),
          ),
          compatibility_date: "2026-10-19",
          compatibility_flags: ["nodejs_compat"],
          vars: { REPORT_URL: `http://127.0.0.1:${address.port}` },
          worker_loaders: [{ binding: "LOADER" }],
          durable_objects: { bindings: [{ name: "PROBE", class_name: "ChildInvocationProbe" }] },
          migrations: [{ tag: "v1", new_sqlite_classes: ["ChildInvocationProbe"] }],
        },
      },
    ],
  });

  endpoint = (await harness.listen()).url;
}, 60_000);

afterEach(async () => {
  await fetch(new URL("/release", endpoint));
  await parent;
  parent = undefined;
  tailed = Promise.withResolvers<unknown>();
  await harness.reset();
  endpoint = (await harness.listen()).url;
});

afterAll(async () => {
  await harness?.close();
  await new Promise<void>((resolve, reject) =>
    collector.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("native child invocation completion", () => {
  it.for([
    ["direct", "ok"],
    ["port", "ok"],
    ["direct", "fail"],
    ["port", "fail"],
    ["port", "gated"],
  ])(
    "finishes the %s %s child event before the caller's event ends",
    { timeout: 3_000 },
    async ([loader, result], { signal }) => {
      parent = fetch(new URL(`/run?loader=${loader}&result=${result}`, endpoint));
      if (result === "gated") {
        await fetch(new URL("/entered", endpoint), { signal });
        // A separate request resolves the host call; the child must keep awaiting its RPC reply.
        await fetch(new URL("/ready", endpoint), { signal });
      }
      const completed = await fetch(new URL("/completed", endpoint), { signal });
      expect(await completed.json()).toEqual(
        result !== "fail"
          ? { exit: { exitCode: 7, signal: 0, coreDumped: false } }
          : { error: "ChildWorkerDispatchError: expected child failure", termination: "stopped" },
      );
      const aborted = new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      expect(await Promise.race([tailed.promise, aborted])).toMatchObject([
        { outcome: "ok", exceptions: [] },
      ]);
    },
  );
});
