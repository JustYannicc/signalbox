import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import {
  AUTOMATION_WS_METHODS,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import * as CloudRpc from "../user/rpc.ts";

export const HOOK_USER = "user_hooks";

/** The production RPCs and Workflow runtime, with a scripted writer and isolated SQLite. */
export const hookTestSetup = (options?: Parameters<typeof makeMemoryCloud>[0]) =>
  Effect.gen(function* () {
    const cloud = makeMemoryCloud(options);
    const user = cloud.userDirectory.forUser(HOOK_USER);
    yield* user.recordSignIn({ id: HOOK_USER, email: "hooks@example.com" });
    const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
      Effect.provide(
        Layer.mergeAll(
          CloudRpc.layerHandlers({
            identity: {
              environmentId: EnvironmentId.make("cloud-test"),
              label: "Cloud",
              scripted: true,
            },
            userId: HOOK_USER,
            sid: "test-session",
          }),
          CloudRpc.layerScopeAuthorization([
            AuthOrchestrationReadScope,
            AuthOrchestrationOperateScope,
          ]),
        ).pipe(Layer.provide(cloud.layerFor(HOOK_USER))),
      ),
    );
    yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
      commandId: CommandId.make("launch-hook-writer"),
      threadId: ThreadId.make("hook-writer"),
      projectId: Environment.SCRATCH_PROJECT_ID,
      title: "Write automations",
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: {
        messageId: MessageId.make("hook-writer-message"),
        text: "Write",
        attachments: [],
      },
    });
    yield* cloud.settle;
    const save = (source: string) => {
      const compiled = compileForCloud(source);
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
      return rpc[AUTOMATION_WS_METHODS.automationsSave]({
        source,
        projectId: Environment.SCRATCH_PROJECT_ID,
        compiled: compiled.compiled,
      }).pipe(
        Effect.flatMap((saved) =>
          saved.ok ? Effect.succeed(saved.automation) : Effect.die(saved.diagnostics),
        ),
      );
    };
    const engine = <A, E>(f: (engine: WorkflowEngine.WorkflowEngineShape) => Effect.Effect<A, E>) =>
      cloud.inUser(HOOK_USER, WorkflowEngine.WorkflowEngine.use(f));
    return { cloud, user, rpc, save, engine };
  });

export const signedBody = async (body: string, secret: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  return `sha256=${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};
