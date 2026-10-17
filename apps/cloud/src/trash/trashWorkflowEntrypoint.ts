import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { userObjectStub, type UserObjectNamespace } from "../user/UserDirectory.ts";
import { runTrashWorkflow } from "./runTrashWorkflow.ts";

export interface TrashWorkflowParams {
  readonly userId: string;
  readonly trashId: string;
}

interface TrashWorkflowEnv {
  readonly USERS: UserObjectNamespace;
  readonly LOCAL_WORKERD?: string;
}

export class TrashPurgeWorkflow extends WorkflowEntrypoint<TrashWorkflowEnv, TrashWorkflowParams> {
  override run(event: WorkflowEvent<TrashWorkflowParams>, step: WorkflowStep) {
    const { userId, trashId } = event.payload;
    const user = userObjectStub(this.env.USERS, userId, {
      localWorkerd: this.env.LOCAL_WORKERD === "1",
    });
    return runTrashWorkflow(step, () => user.trashProgress(trashId));
  }
}
