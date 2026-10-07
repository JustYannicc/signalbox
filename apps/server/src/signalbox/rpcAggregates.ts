import { SIGNALBOX_WS_RPCS } from "@t3tools/contracts";

type SignalboxRpc = (typeof SIGNALBOX_WS_RPCS)[number];

/** Pool RPCs keep upstream's provider label, beside the provider RPCs they extend. */
const aggregateOf = (tag: SignalboxRpc["_tag"]) =>
  tag.startsWith("automations.")
    ? "automations"
    : tag.startsWith("signalbox.analytics.")
      ? "analytics"
      : "provider";

/**
 * The `rpc.aggregate` span label of every Signalbox RPC, spread into upstream's
 * `RPC_AGGREGATES` so its exhaustiveness check covers fork methods too.
 */
export const SIGNALBOX_RPC_AGGREGATES = Object.fromEntries(
  SIGNALBOX_WS_RPCS.map((rpc) => [rpc._tag, aggregateOf(rpc._tag)]),
) as Record<SignalboxRpc["_tag"], string>;
