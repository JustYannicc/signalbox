import type { ChatAttachment, ThreadId } from "@t3tools/contracts";
import type { McpAppReference } from "@t3tools/shared/mcpApp";
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";

export interface CodexAttachments {
  readonly resolvePath: (input: {
    readonly attachmentsDir: string;
    readonly attachment: ChatAttachment;
  }) => string | null;
  readonly resolvePathById: (input: {
    readonly attachmentsDir: string;
    readonly attachmentId: string;
  }) => string | null;
  readonly snapshotMcpApp: (input: {
    readonly attachmentsDir: string;
    readonly threadId: ThreadId;
    readonly server: string;
    readonly tool: string;
    readonly resourceUri: string;
    readonly contents: ReadonlyArray<unknown>;
  }) => Effect.Effect<
    McpAppReference | undefined,
    PlatformError.PlatformError,
    FileSystem.FileSystem
  >;
}
