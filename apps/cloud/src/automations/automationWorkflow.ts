import {
  createDynamicWorkflowEntrypoint,
  type WorkflowRunner,
} from "@cloudflare/dynamic-workflows";
import { hash64 } from "@signalbox/automations/hash";
import type { AutomationRunHost } from "@signalbox/automations/workflow/hostProtocol";
import {
  AUTOMATION_MODULE,
  RUNTIME_MAIN,
  RUNTIME_MODULE,
} from "@signalbox/automations/workflow/runtimeSource";
import { exports, WorkerEntrypoint } from "cloudflare:workers";

import { userObjectStub, type UserObjectNamespace } from "../user/UserDirectory.ts";
import { COMPATIBILITY_DATE } from "../../infra/stage.ts";
import { hostOver } from "./CloudAutomations.ts";
import type { RunMetadata } from "./workflowRunner.ts";

/**
 * Automation runs on Cloudflare Dynamic Workflows (#434). The `AUTOMATION_RUNS`
 * Workflow runs `AutomationWorkflow`, which loads the run's version as a
 * Dynamic Worker and hands it `run(event, step)`: the version's code (its
 * `worker_module`) beside the shared runtime (`@signalbox/automations/workflow`).
 * The worker reaches nothing but `HOST`, an `AutomationHost` fixed to its
 * user, automation and version, which calls the user's object.
 */

export interface AutomationWorkflowEnv {
  readonly USERS: UserObjectNamespace;
  readonly LOADER?: WorkerLoader;
  readonly LOCAL_WORKERD?: string;
}

/** A new runtime is new code under the same version, so it gets its own worker. */
const RUNTIME_ID = hash64(RUNTIME_MODULE);

/**
 * One Dynamic Worker per version and runtime: Cloudflare bills each id once a
 * day and keeps its isolate warm between runs. Never `LOADER.load`, which
 * bills every call. The user is in it because the isolate's `HOST` is theirs.
 */
export const workerIdFor = (metadata: RunMetadata) =>
  `${metadata.userId}/${metadata.automationId}@${metadata.version}~${RUNTIME_ID}`;

const userObject = (env: AutomationWorkflowEnv, userId: string) =>
  userObjectStub(env.USERS, userId, { localWorkerd: env.LOCAL_WORKERD === "1" });

const isMetadata = (
  value: Record<string, unknown>,
): value is Record<string, unknown> & RunMetadata =>
  typeof value.userId === "string" &&
  typeof value.automationId === "string" &&
  typeof value.version === "number";

/** `exports` holds a loopback for each of the Worker's entrypoints; this is the one Dynamic Workers get. */
const hostFor = (props: RunMetadata) =>
  (
    exports as unknown as { AutomationHost: (options: { props: RunMetadata }) => Fetcher }
  ).AutomationHost({ props });

export const AutomationWorkflow = createDynamicWorkflowEntrypoint<AutomationWorkflowEnv>(
  ({ env, metadata }) => {
    if (!isMetadata(metadata)) throw new Error("The run's instance has no automation metadata.");
    if (env.LOADER === undefined) throw new Error("This cloud has no Worker Loader binding.");
    const { userId, automationId, version } = metadata;
    const workerId = workerIdFor(metadata);
    const worker = env.LOADER.get(workerId, async () => {
      // Only a cold id loads its code: one line per version per isolate, ids only (#284).
      // @effect-diagnostics-next-line globalConsole:off - the dispatcher runs outside Effect.
      console.log(JSON.stringify({ message: "automation worker loaded", workerId, version }));
      return {
        compatibilityDate: COMPATIBILITY_DATE,
        mainModule: RUNTIME_MAIN,
        modules: {
          [RUNTIME_MAIN]: RUNTIME_MODULE,
          [AUTOMATION_MODULE]: await userObject(env, userId).automationWorkerModule(
            automationId,
            version,
          ),
        },
        env: { HOST: hostFor({ userId, automationId, version }) },
        // Automation code reaches the world through its steps only.
        globalOutbound: null,
      };
    });
    return worker.getEntrypoint("AutomationRun") as unknown as WorkflowRunner;
  },
);

/**
 * What a version's Dynamic Worker calls as `HOST`. Its props say whose code
 * it runs; the user's object checks each run id against them.
 */
export class AutomationHost
  extends WorkerEntrypoint<AutomationWorkflowEnv, RunMetadata>
  implements AutomationRunHost
{
  private readonly host = hostOver((request) => {
    const { userId, automationId, version } = this.ctx.props;
    return userObject(this.env, userId).automationHost({ ...request, automationId, version });
  });

  step(...args: Parameters<AutomationRunHost["step"]>) {
    return this.host.step(...args);
  }

  settled(...args: Parameters<AutomationRunHost["settled"]>) {
    return this.host.settled(...args);
  }

  timedOut(...args: Parameters<AutomationRunHost["timedOut"]>) {
    return this.host.timedOut(...args);
  }

  failed(...args: Parameters<AutomationRunHost["failed"]>) {
    return this.host.failed(...args);
  }

  finish(...args: Parameters<AutomationRunHost["finish"]>) {
    return this.host.finish(...args);
  }
}
