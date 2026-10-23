import { HarnessFilesStoreObject } from "../HarnessFilesStoreObject.ts";
import { HarnessRunStoreObject } from "../HarnessRunStoreObject.ts";
import { HarnessThreadSupervisorObject } from "../HarnessThreadSupervisorObject.ts";
import {
  initializeTopology,
  readTopologySupervisor,
  recoverTopology,
} from "./harnessStateWorkerd.base.ts";
import type { WorkerdEnv } from "./harnessStateWorkerd.base.ts";
import { handoff, lifecycle } from "./harnessStateWorkerd.lifecycle.ts";
import { reconcilePrepared, reconcileUnjoined } from "./harnessStateWorkerd.reconcile.ts";
import {
  reconcileAdmissionRecovery,
  reconcileCompletedCheckpoint,
} from "./harnessStateWorkerd.reconciliationR2.ts";
import { reconcileReplayIsolation } from "./harnessStateWorkerd.reconcileReplay.ts";
import {
  repairControlSync,
  rejectMismatchedControlSyncOperation,
} from "./harnessStateWorkerd.controlRecovery.ts";
import { publicationReceiptSelection } from "./harnessStateWorkerd.publicationReceipts.ts";

export { HarnessFilesStoreObject, HarnessRunStoreObject, HarnessThreadSupervisorObject };

export default {
  async fetch(request: Request, env: WorkerdEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/initialize")
      return Response.json({ initialized: true, result: await initializeTopology(env) });
    if (path === "/recover") {
      const result = await recoverTopology(env);
      return Response.json({
        checkpoint: result.checkpoint,
        file: result.files.map((file) => ({
          path: file.path,
          text: new TextDecoder().decode(file.bytes),
        })),
      });
    }
    if (path === "/supervisor") return Response.json((await readTopologySupervisor(env)).snapshot);
    if (path === "/lifecycle") return Response.json(await lifecycle(env));
    if (path === "/handoff") return Response.json(await handoff(env));
    if (path === "/reconcile") return Response.json(await reconcilePrepared(env));
    if (path === "/unjoined") return Response.json(await reconcileUnjoined(env));
    if (path === "/reconcile-admission")
      return Response.json(await reconcileAdmissionRecovery(env));
    if (path === "/reconcile-completed")
      return Response.json(await reconcileCompletedCheckpoint(env));
    if (path === "/reconcile-replay") return Response.json(await reconcileReplayIsolation(env));
    if (path === "/control-recovery") return Response.json(await repairControlSync(env));
    if (path === "/control-sync-operation")
      return Response.json(await rejectMismatchedControlSyncOperation(env));
    if (path === "/publication-receipts")
      return Response.json(await publicationReceiptSelection(env));
    return new Response("not found", { status: 404 });
  },
};
