import * as NodeServices from "@effect/platform-node/NodeServices";
import type { PreviewPort } from "@signalbox/runner-protocol/PreviewTunnel";
import type { DiscoveredLocalServer } from "@t3tools/contracts";
import * as Net from "@t3tools/shared/Net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { FetchHttpClient } from "effect/http";

import * as PortScanner from "../../preview/PortScanner.ts";
import * as ProcessRunner from "../../processRunner.ts";
import type { PreviewPortSource } from "./RunnerPreviewTunnel.ts";

/**
 * The machine's web servers for the PreviewGateway, found by upstream's own
 * `PortDiscovery`: `lsof` (in the Runner image), else probing common dev
 * ports, keeping only listeners that answer with HTML or a redirect. Only the
 * services it asks for are provided, the way `RunnerAdapters.ts` builds the
 * adapters, so upstream's scanner reaches the Runner through a normal merge.
 * One discovery serves every Runner on the machine; it scans only while a
 * tunnel watches.
 *
 * Upstream probes only listeners its own terminals started. A Runner's machine
 * belongs to its thread, and agents start dev servers however they like
 * (detached, through a harness), so every process here but the Runner's own
 * counts as the thread's.
 */

const layerDiscovery = PortScanner.layer.pipe(
  Layer.provide(Layer.mergeAll(Net.layer, ProcessRunner.layer, FetchHttpClient.layer)),
  Layer.provide(NodeServices.layer),
);

/**
 * One entry per plain-HTTP port, sorted by port. A port found twice keeps the
 * entry that names its process, else the first.
 */
const toPorts = (servers: ReadonlyArray<DiscoveredLocalServer>): ReadonlyArray<PreviewPort> => {
  const byPort = new Map<number, PreviewPort>();
  for (const server of servers) {
    // The tunnel speaks plain HTTP; a server that only answered over TLS can't be reached.
    if (!server.url.startsWith("http:")) continue;
    const known = byPort.get(server.port);
    if (known === undefined || (known.processName === null && server.processName !== null)) {
      byPort.set(server.port, { port: server.port, processName: server.processName });
    }
  }
  return [...byPort.values()].toSorted((a, b) => a.port - b.port);
};

const samePorts = (a: ReadonlyArray<PreviewPort>, b: ReadonlyArray<PreviewPort>) =>
  a.length === b.length &&
  a.every(
    (port, index) => port.port === b[index]!.port && port.processName === b[index]!.processName,
  );

/** The machine's processes as one terminal, so the scanner probes their listeners. */
const MACHINE = { threadId: "runner-machine", terminalId: "machine" };

/** Matches the scanner's poll, so a new dev server shows up within a scan or two. */
const OWNERSHIP_REFRESH = Schedule.spaced("3 seconds");

/** Every process id on a Linux machine; none elsewhere. */
const linuxProcesses = (fileSystem: FileSystem.FileSystem) =>
  fileSystem.readDirectory("/proc").pipe(
    Effect.map((entries) => entries.filter((entry) => /^\d+$/.test(entry)).map(Number)),
    Effect.orElseSucceed((): ReadonlyArray<number> => []),
  );

/**
 * Reports `discovery`'s ports while the watch's scope lasts, probing the
 * listeners of `machineProcesses`.
 */
export const discoveredPorts = (
  discovery: PortScanner.PortDiscovery["Service"],
  machineProcesses: Effect.Effect<ReadonlyArray<number>>,
): PreviewPortSource => ({
  watch: (report) =>
    Effect.gen(function* () {
      const claimMachine = machineProcesses.pipe(
        Effect.flatMap((processIds) =>
          discovery.registerTerminalProcesses({
            ...MACHINE,
            processIds: processIds.filter((processId) => processId !== process.pid),
          }),
        ),
      );
      yield* Effect.acquireRelease(claimMachine, () => discovery.unregisterTerminal(MACHINE));
      yield* Effect.forkScoped(claimMachine.pipe(Effect.repeat(OWNERSHIP_REFRESH)));
      // The scanner notifies on any change, including fields dropped here
      // (url, pid), so only a different port list goes out. Both start
      // empty, like the tunnel's own list.
      let last: ReadonlyArray<PreviewPort> = [];
      yield* discovery.subscribe({ configuredUrls: [], initialSnapshot: [] }, (servers) => {
        const next = toPorts(servers);
        if (samePorts(last, next)) return Effect.void;
        last = next;
        return report(next);
      });
      // The first retainer's retain scans at once and notifies the listener
      // above; a later one sees the ports on the next poll, seconds away.
      yield* discovery.retain;
    }),
});

/** A port source that lives as long as the scope. */
export const makeDiscoveredPorts = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const context = yield* Layer.build(layerDiscovery);
  return discoveredPorts(
    Context.get(context, PortScanner.PortDiscovery),
    linuxProcesses(fileSystem),
  );
});
