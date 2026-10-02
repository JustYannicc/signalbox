import { createContext, type ReactNode } from "react";

/**
 * Optional decorations a surface can lay over `MessagesTimeline` rows without
 * changing its data model, e.g. shared chats where several people write and
 * different harnesses answer. Without a provider the timeline renders as usual.
 */
export interface TimelineAnnotations {
  /** Above a user message: who wrote it. */
  readonly userMessageHeader?: (messageId: string) => ReactNode;
  /** Above an assistant message: which harness and model answered. */
  readonly assistantMessageHeader?: (messageId: string) => ReactNode;
  /**
   * A `t3-context://v1/<kind>/<id>` reference in a user message, e.g. a person
   * mention; `null` falls back to the message's own context records.
   */
  readonly renderContextReference?: (reference: {
    readonly kind: string;
    readonly contextId: string;
    readonly label: string;
  }) => ReactNode | null;
  /** Icon for a separator row that is a system event (model switch, share), not a compaction. */
  readonly separatorIcon?: (rowId: string) => ReactNode | undefined;
}

export const TimelineAnnotationsContext = createContext<TimelineAnnotations | null>(null);
