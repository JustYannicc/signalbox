import * as CodexSchema from "effect-codex-app-server/schema";

export type CodexWebSearchItem = {
  readonly id: string;
  readonly type: "webSearch";
  readonly query?: string | null;
  readonly action?:
    | CodexSchema.V2ItemStartedNotification__WebSearchAction
    | CodexSchema.V2ItemCompletedNotification__WebSearchAction
    | null;
};

export type CodexDynamicToolItem = Extract<
  | CodexSchema.V2ItemStartedNotification__ThreadItem
  | CodexSchema.V2ItemCompletedNotification__ThreadItem,
  { readonly type: "mcpToolCall" | "dynamicToolCall" }
>;

export type CodexCollabAgentToolCallItem = Extract<
  CodexSchema.V2ItemCompletedNotification__ThreadItem,
  { readonly type: "collabAgentToolCall" }
>;

export type CodexSubAgentActivityItem = Extract<
  | CodexSchema.V2ItemStartedNotification__ThreadItem
  | CodexSchema.V2ItemCompletedNotification__ThreadItem,
  { readonly type: "subAgentActivity" }
>;
