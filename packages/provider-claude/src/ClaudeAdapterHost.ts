import type {
  ChatAttachment,
  ClaudeSettings,
  OrchestrationWorkflowFileError,
  ServerProviderSkill,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

export interface ClaudeAdapterHost {
  readonly cwd: () => string;
  readonly taskOutputRoot: (
    environment: Readonly<Record<string, string | undefined>>,
    path: Path.Path,
  ) => string | undefined;
  readonly resolveAttachmentPath: (input: {
    readonly attachmentsDir: string;
    readonly attachment: ChatAttachment;
  }) => string | null;
  readonly discoverSkills: (
    settings: ClaudeSettings,
    cwd: string | undefined,
    environment: Readonly<Record<string, string | undefined>>,
  ) => Effect.Effect<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path>;
  readonly readWorkflowAgentAnswers: (input: {
    readonly transcriptDir: string;
    readonly agentId: string;
    readonly configDir?: string;
  }) => Effect.Effect<ReadonlyArray<string>, OrchestrationWorkflowFileError>;
  readonly signedOutMessage: (input: {
    readonly configDir: string | undefined;
    readonly cwd: string;
  }) => string;
}
