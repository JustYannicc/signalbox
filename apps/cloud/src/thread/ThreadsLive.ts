import * as Layer from "effect/Layer";

import { makeThreads } from "./core/operations.ts";
import * as Threads from "./Threads.ts";

/** Composition supplies the transport, current home/turn context, attachment storage, and crypto. */
export const layer = Layer.effect(Threads.Threads, makeThreads);
