import {
  createDynamicWorkflowEntrypoint,
  type WorkflowRunner,
} from "@cloudflare/dynamic-workflows";
import type { HostStepRequest, Marks, RunEnd } from "@signalbox/automations/runner/hostedDriver";
import {
  AUTOMATION_MODULE,
  RUNTIME_MAIN,
  RUNTIME_MODULE,
} from "@signalbox/automations/workflow/runtimeSource";
import { exports, WorkerEntrypoint } from "cloudflare:workers";

import { userObjectStub, type UserObjectNamespace } from "../user/UserDirectory.ts";
import type { AutomationHostCall } from "./CloudAutomations.ts";
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

/** The Dynamic Workers' date, kept with the Worker's own (`wrangler.jsonc`). */
const COMPATIBILITY_DATE = "2026-09-30";

/** Two FNV-1a passes over `text`, 16 hex characters. */
const contentHash = (text: string) => {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x811c9dc5) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
};

/** A new runtime is new code under the same version, so it gets its own worker. */
const RUNTIME_ID = contentHash(RUNTIME_MODULE);

/**
 * One Dynamic Worker per version and runtime: Cloudflare bills each id once a
 * day and keeps its isolate warm between runs. Never `LOADER.load`, which
 * bills every call.
 */
export const workerIdFor = (metadata: RunMetadata) =>
  `${metadata.automationId}@${metadata.version}~${RUNTIME_ID}`;

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
    const worker = env.LOADER.get(workerIdFor(metadata), async () => ({
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
    }));
    return worker.getEntrypoint("AutomationRun") as unknown as WorkflowRunner;
  },
);

/**
 * What a version's Dynamic Worker calls as `HOST`. Its props say whose code
 * it runs; the user's object checks each run id against them.
 */
export class AutomationHost extends WorkerEntrypoint<AutomationWorkflowEnv, RunMetadata> {
  private call(call: AutomationHostCall) {
    return userObject(this.env, this.ctx.props.userId).automationHost(call);
  }

  /** Whose run this is; the object checks the run id against it. */
  private get version() {
    const { automationId, version } = this.ctx.props;
    return { automationId, version };
  }

  step(runId: string, request: HostStepRequest, marks: Marks) {
    return this.call({ ...this.version, method: "step", runId, request, marks });
  }

  async settled(runId: string, key: string) {
    await this.call({ ...this.version, method: "settled", runId, key });
  }

  timedOut(runId: string, key: string) {
    return this.call({ ...this.version, method: "timedOut", runId, key });
  }

  async failed(runId: string, key: string, error: string) {
    await this.call({ ...this.version, method: "failed", runId, key, error });
  }

  async finish(runId: string, end: RunEnd, marks: Marks) {
    await this.call({ ...this.version, method: "finish", runId, end, marks });
  }
}
