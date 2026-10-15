import { describe, expect, it } from "@effect/vitest";
import type { PreviewPort } from "@signalbox/runner-protocol/PreviewTunnel";
import type { DiscoveredLocalServer } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";

import type * as PortScanner from "../../preview/PortScanner.ts";
import { discoveredPorts } from "./RunnerPreviewPorts.ts";

type Servers = ReadonlyArray<DiscoveredLocalServer>;

const server = (
  port: number,
  processName: string | null,
  { url = `http://localhost:${port}/`, pid = null as number | null } = {},
): DiscoveredLocalServer => ({ host: "localhost", port, url, processName, pid, terminal: null });

/**
 * A scanner whose scans the test hands out; `retain` notifies with the first
 * one, as an idle scanner does. `owned` is what it would probe right now.
 */
const fakeDiscovery = (first: Servers) => {
  let listener: ((servers: Servers) => Effect.Effect<void>) | null = null;
  const owned = new Map<string, ReadonlyArray<number>>();
  const ownedAtRetain: Array<ReadonlyArray<number>> = [];
  const discovery: PortScanner.PortDiscovery["Service"] = {
    scan: () => Effect.die("unused"),
    subscribe: (_input, next) => Effect.sync(() => void (listener = next)),
    retain: Effect.suspend(() => {
      ownedAtRetain.push([...owned.values()].flat());
      return listener?.(first) ?? Effect.void;
    }),
    registerTerminalProcesses: (input) =>
      Effect.sync(() => void owned.set(input.terminalId, input.processIds)),
    unregisterTerminal: (input) => Effect.sync(() => void owned.delete(input.terminalId)),
  };
  return {
    discovery,
    owned: () => [...owned.values()].flat(),
    ownedAtRetain,
    notify: (servers: Servers) => listener?.(servers) ?? Effect.void,
  };
};

const noProcesses = Effect.succeed<ReadonlyArray<number>>([]);

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
        yield* discoveredPorts(discovery, noProcesses).watch((ports) =>
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

  it.effect("offers every process on the machine but the Runner's own for probing", () =>
    Effect.gen(function* () {
      const { discovery, owned, ownedAtRetain } = fakeDiscovery([]);
      let processes: ReadonlyArray<number> = [1, process.pid, 40];
      const scope = yield* Scope.make();
      yield* discoveredPorts(
        discovery,
        Effect.sync(() => processes),
      )
        .watch(() => Effect.void)
        .pipe(Scope.provide(scope));
      // Already owned when the first scan runs.
      expect(ownedAtRetain).toEqual([[1, 40]]);

      // A dev server an agent started after the watch began.
      processes = [1, process.pid, 40, 77];
      yield* TestClock.adjust("3 seconds");
      expect(owned()).toEqual([1, 40, 77]);

      yield* Scope.close(scope, Exit.void);
      expect(owned()).toEqual([]);
    }),
  );
});
