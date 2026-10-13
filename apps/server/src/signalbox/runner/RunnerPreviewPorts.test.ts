import { describe, expect, it } from "@effect/vitest";
import type { PreviewPort } from "@signalbox/runner-protocol/PreviewTunnel";
import type { DiscoveredLocalServer } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as PortScanner from "../../preview/PortScanner.ts";
import { discoveredPorts } from "./RunnerPreviewPorts.ts";

type Servers = ReadonlyArray<DiscoveredLocalServer>;

const server = (
  port: number,
  processName: string | null,
  { url = `http://localhost:${port}/`, pid = null as number | null } = {},
): DiscoveredLocalServer => ({ host: "localhost", port, url, processName, pid, terminal: null });

/** A scanner whose scans the test hands out; `retain` notifies with the first one, as an idle scanner does. */
const fakeDiscovery = (first: Servers) => {
  let listener: ((servers: Servers) => Effect.Effect<void>) | null = null;
  const unused = () => Effect.die("unused");
  const discovery: PortScanner.PortDiscovery["Service"] = {
    scan: unused,
    subscribe: (_input, next) => Effect.sync(() => void (listener = next)),
    retain: Effect.suspend(() => listener?.(first) ?? Effect.void),
    registerTerminalProcesses: unused,
    unregisterTerminal: unused,
  };
  return { discovery, notify: (servers: Servers) => listener?.(servers) ?? Effect.void };
};

describe("discoveredPorts", () => {
  it.effect("reports plain-HTTP ports once each, sorted, and only when the list changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { discovery, notify } = fakeDiscovery([
          server(5173, null),
          server(3000, "node"),
          server(5173, "vite"),
          server(5173, "other"),
          server(8443, "caddy", { url: "https://localhost:8443/" }),
        ]);
        const reports: Array<ReadonlyArray<PreviewPort>> = [];
        yield* discoveredPorts(discovery).watch((ports) =>
          Effect.sync(() => void reports.push(ports)),
        );
        expect(reports).toEqual([
          [
            { port: 3000, processName: "node" },
            { port: 5173, processName: "vite" },
          ],
        ]);

        // Only a field the tunnel drops changed.
        yield* notify([server(3000, "node", { pid: 42 }), server(5173, "vite", { pid: 7 })]);
        expect(reports).toHaveLength(1);

        yield* notify([server(3000, "node")]);
        expect(reports.at(-1)).toEqual([{ port: 3000, processName: "node" }]);
        expect(reports).toHaveLength(2);
      }),
    ),
  );
});
