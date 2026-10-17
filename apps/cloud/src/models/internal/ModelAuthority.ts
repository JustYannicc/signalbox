import type { ModelGatewayProvider } from "@signalbox/runner-protocol/RunnerProtocol";
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";

import type { ModelGatewayRecord, ModelUsage } from "../ModelRecords.ts";
import type {
  LocalModelAuthorization,
  ModelAuthorization,
  ModelForwardReply,
  ModelPoolRoute,
} from "../ModelProtocol.ts";

export class ModelAuthority extends Context.Service<
  ModelAuthority,
  {
    readonly authorizeThread: (
      threadId: ThreadId,
      token: string,
      provider: ModelGatewayProvider,
    ) => Promise<ModelAuthorization>;
    readonly authorizeLocal: (token: string) => Promise<LocalModelAuthorization>;
    readonly forward: (
      pool: ModelPoolRoute,
      path: string,
      request: Request,
      thread?: string,
    ) => Promise<ModelForwardReply>;
    readonly recordThread: (threadId: ThreadId, record: ModelGatewayRecord) => Promise<void>;
    readonly recordLocal: (
      local: { readonly userId: string; readonly keyId: string },
      usage: ModelUsage | null,
    ) => Promise<void>;
  }
>()("@signalbox/cloud/models/internal/ModelAuthority") {}
