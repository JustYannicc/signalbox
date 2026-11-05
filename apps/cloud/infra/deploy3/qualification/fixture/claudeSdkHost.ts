import * as Effect from "effect/Effect";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  claudeSdkFileSystem,
  createClaudeSdkHostEntrypoint,
  installClaudeSdkHostEnvironment,
} from "../../../../src/harness/ClaudeSdkHost.ts";
import { HarnessError } from "../../../../src/harness/Harness.ts";
import { buildClaudeSdkAdapter } from "./claudeSdkAdapter.ts";
import { createClaudePreparedImports } from "./claudePreparedModules.ts";
import type { ClaudePreparedPlan } from "./claudePreparedModules.ts";
import type { HarnessRelease } from "../../../../src/harness/Harness.ts";

export class ClaudeSdkHost extends createClaudeSdkHostEntrypoint<{
  readonly CLAUDE_SDK_PLAN: ClaudePreparedPlan;
  readonly CLAUDE_SDK_RELEASE: HarnessRelease;
}>({
  prepare: ({ env, input, context, process, files }) =>
    Effect.gen(function* () {
      if (
        input.release.manifestSha256 !== env.CLAUDE_SDK_RELEASE.manifestSha256 ||
        input.release.harness !== "claude-code"
      )
        return yield* new HarnessError({
          operation: "open",
          message: "Claude SDK host and CLI selected different verified releases.",
        });
      const environment = yield* Effect.acquireRelease(
        Effect.try({
          try: () => installClaudeSdkHostEnvironment(context, process),
          catch: (cause) =>
            new HarnessError({
              operation: "open",
              message: "Claude SDK environment could not open.",
              cause,
            }),
        }),
        (owner) => Effect.promise(() => owner.dispose()),
      );
      const fileSystem = claudeSdkFileSystem(files);
      const adapter = yield* buildClaudeSdkAdapter({
        fileSystem,
        instanceId: input.session.modelSelection.instanceId,
        attachmentsDir: `${context.identity.homedir}/.attachments`,
      });
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions.pipe(
        Effect.provide(McpProviderSessions.layer),
      );
      const imports = createClaudePreparedImports();
      return {
        adapter,
        mcpSessions,
        loadSdk: (signal: AbortSignal) => imports.loadSdk(env.CLAUDE_SDK_PLAN, signal),
        assertCompatibility: environment.assertCompatibility,
      };
    }),
}) {}
