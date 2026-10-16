import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2Command,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  API_VERSION,
  COMMAND_REACH,
  defaultCommandName,
  defaultRpcName,
  exemptions,
  jsonSchemaOf,
  operations,
  RPC_REACH,
} from "./catalog.ts";

/** FNV-1a over the schema's JSON: short, stable, and changes with any change to it. */
const fingerprint = (value: unknown) => {
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify(value)) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

describe("API parity", () => {
  it("covers exactly the RPCs the contracts define", () => {
    expect(Object.keys(RPC_REACH).toSorted()).toEqual([...WsRpcGroup.requests.keys()].toSorted());
  });

  it("covers exactly the commands dispatchCommand accepts", () => {
    const types = new Set(
      OrchestrationV2Command.members.map((member) => member.fields.type.literal),
    );
    expect(Object.keys(COMMAND_REACH).toSorted()).toEqual([...types].toSorted());
  });

  it("expands commands only for dispatchCommand", () => {
    const perCommand = Object.entries(RPC_REACH).filter(
      ([, reach]) => reach._tag === "per-command",
    );
    expect(perCommand.map(([tag]) => tag)).toEqual([ORCHESTRATION_V2_WS_METHODS.dispatchCommand]);
  });

  it("gives every operation a unique name", () => {
    const names = operations.map((operation) => operation.name);
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    expect(duplicates).toEqual([]);
  });

  it("gives every exemption a reason", () => {
    expect(exemptions.filter((exemption) => exemption.reason.trim().length === 0)).toEqual([]);
  });

  it("describes every operation's input as a JSON object and its output as JSON", () => {
    const unexpressible = operations.flatMap((operation) => {
      try {
        const input = jsonSchemaOf(operation.input).schema;
        jsonSchemaOf(operation.output);
        const isObject =
          input.type === "object" ||
          (Array.isArray(input.anyOf) &&
            input.anyOf.every((member) => (member as { type?: unknown }).type === "object"));
        return isObject ? [] : [`${operation.name}: input is not an object`];
      } catch (cause) {
        return [`${operation.name}: ${String(cause)}`];
      }
    });
    expect(unexpressible).toEqual([]);
  });

  // The public surface, checked in. A change here is a change to every caller of
  // the API, CLI and MCP: review it, then update with `vp test run -u`.
  it("matches the checked-in surface", async () => {
    const surface = {
      version: API_VERSION,
      operations: operations.map((operation) => ({
        name: operation.name,
        rpc: operation.rpc,
        ...(operation.command === undefined ? {} : { command: operation.command }),
        access: operation.access,
        ...(operation.stream === undefined ? {} : { stream: operation.stream }),
        ...(operation.humanOnly ? { humanOnly: true } : {}),
        ...(operation.destructive ? { destructive: true } : {}),
        ...(operation.compiles ? { compiles: true } : {}),
        input: fingerprint(jsonSchemaOf(operation.input)),
        output: fingerprint(jsonSchemaOf(operation.output)),
      })),
      exemptions: exemptions.map((exemption) => ({
        rpc: exemption.rpc,
        ...(exemption.command === undefined ? {} : { command: exemption.command }),
        kind: exemption.kind,
      })),
    };
    await expect(`${JSON.stringify(surface, null, 2)}\n`).toMatchFileSnapshot(
      `../api/${API_VERSION}.json`,
    );
  });
});

describe("default names", () => {
  it("drops Signalbox's prefix and maps known resources", () => {
    expect(defaultRpcName("signalbox.folders.create")).toBe("folders.create");
    expect(defaultRpcName("orchestration.getTurnDiff")).toBe("threads.getTurnDiff");
    expect(defaultRpcName("accountPool.rename")).toBe("pools.rename");
    expect(defaultRpcName("provider.chatgpt.reconnect-profile")).toBe(
      "provider.chatgpt.reconnectProfile",
    );
  });

  it("turns top-level subscriptions into a resource's subscribe", () => {
    expect(defaultRpcName("subscribeVcsStatus")).toBe("vcsStatus.subscribe");
  });

  it("files commands under threads", () => {
    expect(defaultCommandName("thread.archive")).toBe("threads.archive");
    expect(defaultCommandName("queued-run.cancel")).toBe("threads.queuedRun.cancel");
    expect(defaultCommandName("thread.auto-settle.set")).toBe("threads.autoSettle.set");
  });
});
