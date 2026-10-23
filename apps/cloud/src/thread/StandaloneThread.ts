import * as CloudAttachments from "../attachments/CloudAttachments.ts";
import * as PoolDirectory from "../pool/PoolDirectory.ts";
import * as Platform from "../platform.ts";
import * as ThreadContexts from "../user/threadContexts.ts";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { ThreadId } from "@t3tools/contracts";

import * as DiagnosticsStore from "./diagnostics/DiagnosticsStore.ts";
import * as TurnDiagnostics from "./diagnostics/TurnDiagnostics.ts";
import * as MachineBackend from "./runner/MachineBackend.ts";
import * as ThreadRunner from "./runner/ThreadRunner.ts";
import * as PreviewState from "./PreviewState.ts";
import * as PullState from "./PullState.ts";
import * as SessionRows from "./session/SessionRows.ts";
import * as ThreadEngine from "./ThreadEngine.ts";
import * as ThreadKindTurns from "./ThreadKindTurns.ts";
import * as ThreadPulls from "./ThreadPulls.ts";
import * as ThreadStore from "./ThreadStore.ts";
import * as ThreadsLive from "./ThreadsLive.ts";
import * as TurnModels from "./TurnModels.ts";
import { layerStandaloneThreadDirectory } from "./standalone/ThreadDirectory.ts";

export { MachineBackend } from "./runner/MachineBackend.ts";
export { MachineRecords } from "./runner/MachineBackend.ts";
export type {
  MachineBackendShape,
  MachineBackends,
  MachineRecord,
} from "./runner/MachineBackend.ts";
export { ThreadDrives, ThreadRunner, ThreadSecrets } from "./runner/ThreadRunner.ts";
export { Threads } from "./Threads.ts";

/** Services a caller supplies for live ownership, model policy, and machine control. */
export type PlatformServices =
  | CloudAttachments.CloudAttachments
  | MachineBackend.MachineBackend
  | PoolDirectory.PoolDirectory
  | ThreadContexts.ThreadContexts
  | ThreadKindTurns.ThreadKindTurns
  | ThreadRunner.ThreadDrives
  | ThreadRunner.ThreadSecrets;

/** Services the thread engine and runner need when the user domain owns turns. */
export type EnginePlatformServices =
  | CloudAttachments.CloudAttachments
  | MachineBackend.MachineBackend
  | PoolDirectory.PoolDirectory
  | ThreadRunner.ThreadDrives
  | ThreadRunner.ThreadSecrets;

/**
 * Builds one thread's canonical storage, engine, runner, and public Threads service.
 * The caller owns the SQL database and supplies its actual platform policy and adapters.
 */
const engineLayer = <
  SqlError,
  SqlRequirements,
  PlatformError,
  PlatformRequirements,
  Services,
>(options: {
  readonly threadId: ThreadId;
  readonly sql: Layer.Layer<SqlClient.SqlClient, SqlError, SqlRequirements>;
  readonly platform: Layer.Layer<Services, PlatformError, PlatformRequirements>;
}) => {
  const storage = Layer.mergeAll(
    ThreadStore.layer,
    PullState.layer,
    SessionRows.layer,
    PreviewState.layer,
    DiagnosticsStore.layer,
  ).pipe(Layer.provideMerge(Layer.mergeAll(options.sql, Platform.layerCrypto)));
  const machineRecords = ThreadStore.layerMachineRecords.pipe(Layer.provideMerge(storage));
  const platform = options.platform.pipe(Layer.provideMerge(machineRecords));
  const modelPolicy = TurnModels.layer({ scripted: false }).pipe(Layer.provideMerge(platform));
  const engine = ThreadEngine.layer.pipe(Layer.provideMerge(Layer.mergeAll(storage, modelPolicy)));
  const pulls = ThreadPulls.layer.pipe(Layer.provideMerge(engine));
  const reports = ThreadPulls.layerReports.pipe(Layer.provideMerge(pulls));
  const diagnostics = TurnDiagnostics.layer.pipe(Layer.provideMerge(engine));
  const runner = ThreadRunner.layer.pipe(
    Layer.provideMerge(reports),
    Layer.provideMerge(diagnostics),
  );
  const directory = layerStandaloneThreadDirectory(options.threadId).pipe(
    Layer.provideMerge(runner),
  );

  return directory;
};

export const layerEngine = <
  SqlError,
  SqlRequirements,
  PlatformError,
  PlatformRequirements,
>(options: {
  readonly threadId: ThreadId;
  readonly sql: Layer.Layer<SqlClient.SqlClient, SqlError, SqlRequirements>;
  readonly platform: Layer.Layer<EnginePlatformServices, PlatformError, PlatformRequirements>;
}) => engineLayer(options);

export const layer = <SqlError, SqlRequirements, PlatformError, PlatformRequirements>(options: {
  readonly threadId: ThreadId;
  readonly sql: Layer.Layer<SqlClient.SqlClient, SqlError, SqlRequirements>;
  readonly platform: Layer.Layer<PlatformServices, PlatformError, PlatformRequirements>;
}) => ThreadsLive.layer.pipe(Layer.provideMerge(engineLayer(options)));
