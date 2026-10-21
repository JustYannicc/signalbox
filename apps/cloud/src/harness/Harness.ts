import type {
  RunnerItem,
  RunnerTurn,
  ThreadMessage,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type {
  ProviderAdapterV2OpenSessionInput,
  ProviderAdapterV2ThreadSnapshot,
} from "@t3tools/provider-core/server/ProviderAdapter";
import type { OrchestrationV2ProviderSession } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type { LoadedHarnessRelease } from "./HarnessReleaseLoader.ts";
import type { HarnessRelease } from "./HarnessRelease.ts";
import type { Computer } from "../computer/Computer.ts";
import type { HarnessHookCallback } from "../hooks/HarnessHooks.ts";
import type { FileCommitReceipt } from "../kernel/FilePersistencePorts.ts";

export type { HarnessRelease };

/** Session files and workspace files are saved together before this checkpoint is returned. */
export interface HarnessCheckpoint {
  readonly release: HarnessRelease;
  readonly providerSession: OrchestrationV2ProviderSession;
  readonly snapshot: ProviderAdapterV2ThreadSnapshot;
  readonly revision: FileCommitReceipt;
}

export type HarnessControl = Extract<
  ThreadMessage,
  { readonly type: "steer" | "interrupt" | "runtime-request.respond" }
>;

export class HarnessError extends Schema.TaggedError<HarnessError>()("HarnessError", {
  operation: Schema.Literals(["open", "turn", "control", "export", "events", "dispose"]),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface HarnessOpenInput {
  readonly loadedRelease?: LoadedHarnessRelease;
  readonly release: HarnessRelease;
  readonly session: ProviderAdapterV2OpenSessionInput;
  readonly computer: Computer;
  readonly modelTransport: (request: Request) => Promise<Response>;
  readonly hooks?: HarnessHookCallback;
  readonly checkpoint?: HarnessCheckpoint;
}

export interface HarnessSession {
  readonly release: HarnessRelease;
  readonly providerSession: OrchestrationV2ProviderSession;
  readonly events: Stream.Stream<RunnerItem, HarnessError>;
  readonly turn: (input: RunnerTurn) => Effect.Effect<void, HarnessError>;
  readonly control: (input: HarnessControl) => Effect.Effect<void, HarnessError>;
  readonly export: () => Effect.Effect<HarnessCheckpoint, HarnessError>;
  readonly dispose: Effect.Effect<void, HarnessError>;
}

/** Hosts differ only at construction. A running session has no placement or fallback setting. */
export interface Harness {
  readonly open: (
    input: HarnessOpenInput,
  ) => Effect.Effect<HarnessSession, HarnessError, Scope.Scope>;
}
