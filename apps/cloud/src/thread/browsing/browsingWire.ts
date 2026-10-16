import {
  BrowsingCommand,
  BrowsingMember,
  BrowsingRecord,
  BrowsingStreamItem,
  BrowsingTab,
} from "@t3tools/contracts/signalboxBrowsing";
import { NonNegativeInt } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { jsonCodec, jsonLine } from "../threadWire.ts";

/** Browsing payloads between the Worker or user objects and a thread object, as JSON. */
export const browsingWire = {
  member: jsonCodec(BrowsingMember),
  command: jsonCodec(BrowsingCommand),
  batch: jsonCodec(Schema.Array(BrowsingStreamItem)),
  head: jsonCodec(Schema.Struct({ sequence: NonNegativeInt, record: BrowsingRecord })),
  dispatched: jsonCodec(
    Schema.Struct({ sequence: NonNegativeInt, tab: Schema.NullOr(BrowsingTab) }),
  ),
};

/** One batch as a line of the thread object's stream. */
export const encodeBrowsingLine = jsonLine(browsingWire.batch);
