// @effect-diagnostics nodeBuiltinImport:off - runs the isolated real-RPC lifetime fixture.
import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

it(
  "ends the snapshot producer event after restore while the facet caller stays open",
  { timeout: 15_000 },
  async ({ signal }) => {
    const tailed = Promise.withResolvers<unknown>();
    const collector = NodeHttp.createServer(async (request, response) => {
      request.setEncoding("utf8");
      let body = "";
      for await (const chunk of request) body += chunk;
      tailed.resolve(JSON.parse(body));
      response.end("ok");
    });
    await new Promise<void>((resolve, reject) => {
      collector.once("error", reject);
      collector.listen(0, "127.0.0.1", resolve);
    });
    const address = collector.address();
    if (address === null || typeof address === "string") throw new Error("Missing collector port");
    const harness = createTestHarness({
      workers: [
        {
          config: {
            name: "bash-snapshot-lifetime",
            main: NodeURL.fileURLToPath(
              new URL("./bashSnapshotLifetime.fixture.ts", import.meta.url),
            ),
            compatibility_date: "2026-10-19",
            compatibility_flags: ["nodejs_compat"],
            vars: { REPORT_URL: `http://127.0.0.1:${address.port}` },
            worker_loaders: [{ binding: "LOADER" }],
            durable_objects: { bindings: [{ name: "PROBE", class_name: "BashSnapshotProbe" }] },
            migrations: [{ tag: "v1", new_sqlite_classes: ["BashSnapshotProbe"] }],
          },
        },
      ],
    });
    let parent: Promise<Response> | undefined;
    let endpoint: URL | undefined;
    try {
      endpoint = (await harness.listen()).url;
      parent = fetch(new URL("/run", endpoint));
      await fetch(new URL("/restored", endpoint), { signal });
      const aborted = new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      expect(await Promise.race([tailed.promise, aborted])).toMatchObject([
        { outcome: "ok", exceptions: [] },
      ]);
    } finally {
      if (endpoint !== undefined) await fetch(new URL("/release", endpoint));
      await parent;
      await harness.close();
      await new Promise<void>((resolve, reject) =>
        collector.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
