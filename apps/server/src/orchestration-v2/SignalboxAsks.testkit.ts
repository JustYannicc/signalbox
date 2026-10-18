import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type {
  SignalboxAskAnswerCommand,
  SignalboxAskRaiseCommand,
} from "@t3tools/contracts/signalboxAsks";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

export const instanceId = ProviderInstanceId.make("codex");
export const driver = ProviderDriverKind.make("codex");
const adapter = ProviderAdapter.ProviderAdapterV2.of({
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("This journal test must not start a provider"),
});
const db = SqlitePersistence.layerMemory;
const stores = Layer.mergeAll(
  db,
  ProjectionStore.layer.pipe(Layer.provide(db)),
  EventStore.layer.pipe(Layer.provide(db)),
  EffectOutbox.layer.pipe(Layer.provide(db)),
);
export const layer = Layer.mergeAll(
  stores,
  ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "signalbox-asks" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: db, runEffectWorker: false },
  ),
).pipe(
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(db))),
);
export const threadId = ThreadId.make("thread:asks");
export const create = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId,
    projectId: ProjectId.make("project:asks"),
    title: "Asks",
    modelSelection: { instanceId, model: "gpt-6.1-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return orchestrator;
});
const question = (id: string) => ({
  id,
  question: `Choose ${id}`,
  why: "Need your preference",
  unblocks: "The next choice",
  recommendation: "yes",
  options: [],
  blocking: false,
  decisionOwner: "Owner",
  surface: { kind: "kit" as const, component: "text" },
});
export const raise: typeof SignalboxAskRaiseCommand.Type = {
  type: "thread.ask.raise",
  commandId: CommandId.make("raise"),
  threadId,
  askId: "ask",
  ask: {
    kind: "ready",
    source: { kind: "agent" },
    questions: [question("a"), question("b")],
  },
};
export const answer = (
  askId = "ask",
  round = 1,
  ids = ["a"],
): typeof SignalboxAskAnswerCommand.Type => ({
  type: "thread.ask.answer",
  commandId: CommandId.make(`answer:${askId}:${round}`),
  threadId,
  askId,
  round,
  answers: ids.map((questionId) => ({ questionId, value: "yes" })),
  deferredQuestionIds: [],
  answeredBy: { kind: "person", personId: "owner" },
});
