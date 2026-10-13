import * as NodeServices from "@effect/platform-node/NodeServices";
import type { PreviewPort } from "@signalbox/runner-protocol/PreviewTunnel";
import type { DiscoveredLocalServer } from "@t3tools/contracts";
import * as Net from "@t3tools/shared/Net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

/** Reports `discovery`'s ports while the watch's scope lasts. */
export const discoveredPorts = (
  discovery: PortScanner.PortDiscovery["Service"],
): PreviewPortSource => ({
  watch: (report) =>
    Effect.gen(function* () {
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
export const makeDiscoveredPorts = Effect.map(Layer.build(layerDiscovery), (context) =>
  discoveredPorts(Context.get(context, PortScanner.PortDiscovery)),
);
