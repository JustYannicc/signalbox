import { OrchestrationV2Command } from "@t3tools/contracts";
import { SignalboxAskSyncCommand } from "@t3tools/contracts/signalboxAsks";
import * as Schema from "effect/Schema";

/** Object RPC also carries trusted workflow syncs; client dispatch does not. */
export const ThreadCommand = Schema.Union([OrchestrationV2Command, SignalboxAskSyncCommand]);
export type ThreadCommand = typeof ThreadCommand.Type;
