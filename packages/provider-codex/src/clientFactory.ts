import { CodexSettings } from "@t3tools/contracts";
import type {
  OrchestrationV2ProviderSession,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

export type CodexAppServerSessionClient = CodexClient.CodexAppServerClient["Service"] & {
  /** A transport that initializes Codex itself must await its real ready notification. */
  readonly preinitialized?: Effect.Effect<void, CodexErrors.CodexAppServerError>;
};

export interface CodexAppServerClientFactoryShape {
  readonly open: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
    readonly providerSessionId: OrchestrationV2ProviderSession["id"];
    readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
    readonly settings: CodexSettings;
    readonly environment: NodeJS.ProcessEnv;
  }) => Effect.Effect<
    CodexAppServerSessionClient,
    ProviderAdapter.ProviderAdapterOpenSessionError,
    Scope.Scope
  >;
}
