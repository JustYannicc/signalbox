import type { PreparedClaudeSdk } from "../../../ClaudeSdkHost.ts";
import type { NodeBridge } from "../../../../isolate/NodeBridge.ts";
import type { createNodeFs } from "../../../../isolate/NodeFs.ts";
import type { nativeFixture } from "../../../tests/productHost/native.ts";

export function fixtureSdkQuery(native: ReturnType<typeof nativeFixture>) {
  return async (bridge: NodeBridge): Promise<PreparedClaudeSdk> => {
    const sdk = await native.loadSdk(bridge);
    return {
      ...sdk,
      query(input) {
        const query = sdk.query(input);
        const next = query.next.bind(query);
        let checkedExecutor = false;
        let executorUrl: string | undefined;
        const setMcpServers = query.setMcpServers.bind(query);
        query.setMcpServers = async (servers) => {
          const executor = servers.executor;
          if (executor !== undefined && "url" in executor) executorUrl = executor.url;
          return await setMcpServers(servers);
        };
        query.next = async (...args) => {
          if (!checkedExecutor) {
            checkedExecutor = true;
            if (executorUrl === undefined) throw new Error("Native Executor MCP route is missing.");
            // @effect-diagnostics-next-line globalFetch:off - This uses the native SDK's installed MCP URL through the Node personality.
            const response = await globalThis.fetch(executorUrl, {
              method: "POST",
              body: "native-executor-request",
            });
            if (response.status !== 200 || (await response.text()) !== "fixture executor response")
              throw new Error("Native Executor MCP response changed.");
          }
          const result = await next(...args);
          if (!result.done && result.value.type === "result") {
            const fs = bridge.require("node:fs") as ReturnType<typeof createNodeFs>["fs"];
            await fs.promises.writeFile(
              "/workspace/.claude/projects/-workspace/product-native-session.jsonl",
              `${JSON.stringify(result.value)}\n`,
            );
          }
          return result;
        };
        return query;
      },
    };
  };
}
