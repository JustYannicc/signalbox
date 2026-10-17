import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Platform from "../platform.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import * as CloudTerminalsLayer from "./CloudTerminalsLayer.ts";
import * as CloudAnalytics from "./diagnostics/CloudAnalytics.ts";
import * as DiagnosticsStore from "./diagnostics/DiagnosticsStore.ts";
import * as TurnDiagnostics from "./diagnostics/TurnDiagnostics.ts";
import * as TurnReports from "./diagnostics/TurnReports.ts";
import * as ThreadBrowsing from "./browsing/ThreadBrowsing.ts";
import * as SessionRows from "./session/SessionRows.ts";
import * as StatusNoteModel from "./statusLine/StatusNoteModel.ts";
import * as ThreadStatusNotes from "./statusLine/ThreadStatusNotes.ts";
import * as ThreadEngine from "./ThreadEngine.ts";
import * as ThreadStore from "./ThreadStore.ts";
import * as MachineBackends from "./runner/machineBackends.ts";
import type * as MachineBackend from "./runner/MachineBackend.ts";
import { CONNECT_TIMEOUT_MS } from "./runner/MachineBackend.ts";
import * as ThreadRunner from "./runner/ThreadRunner.ts";
import * as TerminalOutbox from "./terminal/TerminalOutbox.ts";
import * as TerminalStore from "./terminal/TerminalStore.ts";
import * as ThreadTerminals from "./terminal/ThreadTerminals.ts";
import { deliverPendingTerminals } from "./terminal/terminalDelivery.ts";
import * as TurnModels from "./TurnModels.ts";

export type TerminalOutboxRequirement = TerminalOutbox.TerminalOutbox;
export type ThreadTerminalsRequirement = ThreadTerminals.ThreadTerminals;

export const layerCloudTerminals = CloudTerminalsLayer.layer;
export { CONNECT_TIMEOUT_MS };
export { deliverPendingTerminals };

/** A thread object's services on SQLite, including its terminal state and outbox. */
export const layerThreadObject = (
  filename: string,
  machines: Layer.Layer<MachineBackend.MachineBackend> = MachineBackends.layerNone,
  options: {
    readonly drives?: boolean;
    readonly writes?: (
      userId: string,
      driveId: string,
    ) => Effect.Effect<boolean, UserDirectory.UserObjectError>;
    readonly commitAuthor?: ThreadRunner.ThreadDrives["Service"]["commitAuthor"];
    readonly secretsToken?: ThreadRunner.ThreadSecrets["Service"]["token"];
    readonly analytics?: Layer.Layer<
      CloudAnalytics.CloudAnalytics,
      never,
      DiagnosticsStore.DiagnosticsStore | Crypto.Crypto
    >;
    readonly models?: Layer.Layer<TurnModels.TurnModels>;
    readonly statusNoteModel?: Layer.Layer<StatusNoteModel.StatusNoteModel>;
  } = {},
) =>
  ThreadTerminals.layer.pipe(
    Layer.provideMerge(ThreadRunner.layer.pipe(Layer.provide(ThreadTerminals.holdLayer))),
    Layer.provideMerge(
      Layer.succeed(ThreadRunner.ThreadDrives, {
        enabled: options.drives === true,
        writes: options.writes ?? (() => Effect.succeed(true)),
        commitAuthor: options.commitAuthor ?? (() => Effect.succeed(null)),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ThreadRunner.ThreadSecrets, {
        token: options.secretsToken ?? (() => Effect.succeed(null)),
      }),
    ),
    Layer.provideMerge(ThreadBrowsing.layer),
    Layer.provideMerge(
      ThreadStatusNotes.layer.pipe(
        Layer.provide(options.statusNoteModel ?? StatusNoteModel.layerNone),
      ),
    ),
    Layer.provideMerge(ThreadEngine.layer),
    Layer.provideMerge(Layer.mergeAll(TerminalStore.layer, TerminalOutbox.layer)),
    Layer.provideMerge(options.models ?? TurnModels.layerUnchecked),
    Layer.provideMerge(Layer.mergeAll(TurnDiagnostics.layer, TurnReports.layer)),
    Layer.provideMerge(options.analytics ?? CloudAnalytics.layerOff),
    Layer.provideMerge(machines),
    Layer.provideMerge(DiagnosticsStore.layer),
    Layer.provideMerge(Layer.mergeAll(ThreadStore.layer, SessionRows.layer)),
    Layer.provideMerge(Layer.mergeAll(NodeSqliteClient.layer({ filename }), Platform.layerCrypto)),
  );

export type TerminalTestContext = Layer.Success<ReturnType<typeof layerThreadObject>>;

/** Services the terminal tests inspect after driving a thread object. */
export const terminalTestServices = (context: Context.Context<TerminalTestContext>) => ({
  terminals: Context.get(context, ThreadTerminals.ThreadTerminals),
  runner: Context.get(context, ThreadRunner.ThreadRunner),
  engine: Context.get(context, ThreadEngine.ThreadEngine),
  store: Context.get(context, TerminalStore.TerminalStore),
});

/** Runs an outbox example with isolated SQLite storage and a scoped service. */
export const withTerminalOutbox = <A, E>(
  use: (outbox: TerminalOutbox.TerminalOutbox["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Layer.build(
      TerminalOutbox.layer.pipe(Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
    ).pipe(Effect.flatMap((services) => use(Context.get(services, TerminalOutbox.TerminalOutbox)))),
  );
