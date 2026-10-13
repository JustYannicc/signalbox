import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopShutdown from "../app/DesktopShutdown.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-t3-import");

const MAX_ERROR_DETAIL = 2_000;

/**
 * First-launch offer to copy T3 Code's data (`~/.t3/userdata`) into a fresh
 * Signalbox home. Runs before the backend starts, only for the default home
 * in a packaged build with the local backend on, and only while Signalbox has
 * no database. Declining lets the backend create one, so the question is
 * asked once; a failed import can quit before that so the next launch asks
 * again. The copy itself is `signalbox import-t3`, run through the bundled
 * backend entry. There is
 * no progress UI: no window exists yet, so a large history means a pause
 * between the prompt and the main window.
 */
export const offerT3Import = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const { path } = environment;
  if (environment.isDevelopment) return;
  if (environment.baseDir !== path.join(environment.homeDirectory, ".signalbox")) return;
  // Only the local backend uses this home; WSL-only and remote-only setups never create it.
  const settings = yield* (yield* DesktopAppSettings.DesktopAppSettings).get;
  if (!settings.localEnvironmentEnabled) return;
  if (settings.wslOnly === true && settings.wslBackendEnabled === true) return;

  const fs = yield* FileSystem.FileSystem;
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const sourceDatabase = path.join(environment.homeDirectory, ".t3", "userdata", "state.sqlite");
  if (!(yield* exists(sourceDatabase))) return;
  if (yield* exists(path.join(environment.stateDir, "state.sqlite"))) return;

  const dialog = yield* ElectronDialog.ElectronDialog;
  const { response } = yield* dialog.showMessageBox({
    type: "question",
    buttons: ["Import", "Start fresh"],
    defaultId: 0,
    cancelId: 1,
    message: "Bring over your T3 Code data?",
    detail:
      "Signalbox found T3 Code projects, threads, and settings on this computer. Importing copies them into Signalbox. T3 Code keeps its own data and keeps working as before.",
  });
  if (response !== 0) {
    yield* logInfo("t3 import declined");
    return;
  }

  yield* logInfo("t3 import started");
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [environment.backendEntryPath, "import-t3", "--base-dir", environment.baseDir],
          {
            cwd: environment.backendCwd,
            env: { ELECTRON_RUN_AS_NODE: "1" },
            extendEnv: true,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
          },
        ),
      );
      const [exitCode, stderr] = yield* Effect.all(
        [handle.exitCode, handle.stderr.pipe(Stream.decodeText(), Stream.mkString)],
        { concurrency: 2 },
      );
      return { exitCode: Number(exitCode), stderr };
    }),
  ).pipe(
    // A spawn that fails (missing entry, killed by a signal) is a failed import too.
    Effect.catchCause((cause) => Effect.succeed({ exitCode: -1, stderr: Cause.pretty(cause) })),
  );
  if (result.exitCode === 0) {
    yield* logInfo("t3 import finished");
    return;
  }
  yield* logWarning("t3 import failed", { exitCode: result.exitCode });
  const choice = yield* dialog.showMessageBox({
    type: "warning",
    buttons: ["Quit", "Start fresh"],
    defaultId: 0,
    cancelId: 0,
    message: "Couldn't import T3 Code data",
    detail: `T3 Code's data was not changed. Quit to try again on the next launch, or start fresh without it.\n\n${result.stderr.trim().slice(-MAX_ERROR_DETAIL)}`,
  });
  if (choice.response !== 0) return;
  // Quitting before the backend starts leaves no database, so the next launch offers again.
  const state = yield* DesktopState.DesktopState;
  yield* Ref.set(state.quitting, true);
  yield* (yield* DesktopShutdown.DesktopShutdown).request;
  yield* (yield* ElectronApp.ElectronApp).quit;
}).pipe(
  // The offer must never block startup: any failure means starting fresh.
  Effect.catchCause((cause) => logWarning("t3 import offer failed", { cause: String(cause) })),
  Effect.withSpan("desktop.t3Import.offer"),
);
