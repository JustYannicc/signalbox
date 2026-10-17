import type { ThreadId } from "@t3tools/contracts";
import { WorkerEntrypoint } from "cloudflare:workers";

import type { DirectUploadsEnv } from "../drive/directStorage.ts";
import { makePlatformUpload } from "./EgressUpload.ts";

import type { MachineBackendEnv } from "./runner/MachineBackend.ts";
import { type ThreadObjectNamespace, threadObjectStub } from "./ThreadDirectory.ts";
import { serveEgress } from "./Egress.ts";

/**
 * Where a light machine's HTTP and HTTPS requests land (`Egress.ts`). Each
 * thread's container gets one bound to its own thread, so its requests can
 * only ever be checked against that thread's secrets and answers.
 */

export interface ThreadEgressEnv extends MachineBackendEnv, DirectUploadsEnv {
  readonly DRIVE_PACKS_PREFIX?: string;
  readonly LOCAL_WORKERD?: string;
  readonly THREADS: ThreadObjectNamespace;
}

export interface ThreadEgressProps {
  readonly threadId: string;
}

/** The `ctx.exports` loopback for `ThreadEgress`, which workers-types does not declare yet. */
export interface ThreadEgressExports {
  readonly ThreadEgress: (options: { readonly props: ThreadEgressProps }) => Fetcher;
}

/** The hosts of Signalbox's own origins, which the machine reaches unchecked. */
export const ownHostsOf = (env: MachineBackendEnv): ReadonlySet<string> =>
  new Set(
    [env.CLOUD_URL, env.MODEL_GATEWAY_URL].flatMap((origin) => {
      if (origin === undefined || origin.trim() === "") return [];
      try {
        return [new URL(origin).host];
      } catch {
        return [];
      }
    }),
  );

export class ThreadEgress extends WorkerEntrypoint<ThreadEgressEnv, ThreadEgressProps> {
  override fetch(request: Request) {
    const thread = threadObjectStub(this.env.THREADS, this.ctx.props.threadId as ThreadId, {
      localWorkerd: this.env.LOCAL_WORKERD === "1",
    });
    return serveEgress(request, {
      thread: {
        secrets: () => thread.egressSecrets(),
        authorize: (input) => thread.authorizeSend(input),
      },
      ownHosts: ownHostsOf(this.env),
      platformUpload: makePlatformUpload({
        env: this.env,
        drive: () => thread.egressUploadDrive(),
      }),
      dispatch: (outgoing, revision) => thread.dispatchSend(outgoing, revision),
    });
  }
}
