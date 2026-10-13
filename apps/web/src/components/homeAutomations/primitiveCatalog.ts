/**
 * PLACEHOLDER CATALOG. Every hook a workflow can start from and every step it
 * can use, for the Add step palette and the Primitives reference. Examples
 * like the review loop are compositions of these; nothing here is special.
 */
import {
  AlarmClockIcon,
  AtSignIcon,
  BanIcon,
  BellIcon,
  BotIcon,
  CalendarClockIcon,
  CheckCheckIcon,
  CodeIcon,
  FileDiffIcon,
  FolderInputIcon,
  GitBranchIcon,
  HandshakeIcon,
  HourglassIcon,
  InboxIcon,
  LayersIcon,
  MailIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
  MonitorIcon,
  PlugZapIcon,
  RepeatIcon,
  ScaleIcon,
  Share2Icon,
  SmartphoneIcon,
  SplitIcon,
  SquareStackIcon,
  UserCheckIcon,
  UsersIcon,
  WebhookIcon,
  WorkflowIcon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";

import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export interface HookPrimitive {
  id: string;
  label: string;
  /** Inline hooks run before the thing happens and can change its outcome. */
  mode: "inline" | "async";
  description: string;
  /** Typical latency an inline hook adds. */
  budget?: string;
  icon: IconComponent;
}

export interface StepPrimitive {
  id: string;
  label: string;
  description: string;
  icon: IconComponent;
}

export interface PrimitiveGroup<T> {
  title: string;
  items: readonly T[];
}

export const HOOK_GROUPS: readonly PrimitiveGroup<HookPrimitive>[] = [
  {
    title: "Inside Signalbox, inline",
    items: [
      {
        id: "message.beforeSend",
        label: "Before a message I send reaches an agent",
        mode: "inline",
        description: "Allow, rewrite, hold for approval, or block it.",
        budget: "adds ~250ms with a model check",
        icon: ZapIcon,
      },
      {
        id: "tool.beforeCall",
        label: "Before a tool call runs",
        mode: "inline",
        description: "Inspect any agent's tool call, in any harness, and stop it.",
        budget: "adds ~5ms as plain code",
        icon: ZapIcon,
      },
    ],
  },
  {
    title: "Tasks, chats, and rooms",
    items: [
      {
        id: "turn.completed",
        label: "After a turn completes",
        mode: "async",
        description: "Every agent reply, with its diff and checkpoint.",
        icon: MessageSquareIcon,
      },
      {
        id: "thread.created",
        label: "Thread created",
        mode: "async",
        description: "A new task, chat, or room in any container.",
        icon: MessageSquareIcon,
      },
      {
        id: "task.markedDone",
        label: "Task marked done",
        mode: "async",
        description: "The usual start of a review loop.",
        icon: CheckCheckIcon,
      },
      {
        id: "room.message",
        label: "Message in a room",
        mode: "async",
        description: "Someone posts in a chat room you're in.",
        icon: UsersIcon,
      },
      {
        id: "mention.received",
        label: "You're mentioned",
        mode: "async",
        description: "An @mention of you or one of your agents.",
        icon: AtSignIcon,
      },
      {
        id: "item.shared",
        label: "Item shared or unshared",
        mode: "async",
        description: "A task, chat, or room changes who can see it.",
        icon: Share2Icon,
      },
      {
        id: "thread.archived",
        label: "Thread archived",
        mode: "async",
        description: "Clean up branches, computers, or notes.",
        icon: SquareStackIcon,
      },
      {
        id: "approval.decided",
        label: "Approval decided",
        mode: "async",
        description: "Someone approved or rejected a held step.",
        icon: UserCheckIcon,
      },
      {
        id: "workflow.finished",
        label: "Another workflow finished",
        mode: "async",
        description: "Chain workflows without merging them.",
        icon: WorkflowIcon,
      },
    ],
  },
  {
    title: "Code",
    items: [
      {
        id: "pr.opened",
        label: "PR opened or review requested",
        mode: "async",
        description: "GitHub or GitLab pull request events.",
        icon: PullRequestGlyph.pullRequest,
      },
      {
        id: "project.fileChanged",
        label: "File changed in a project",
        mode: "async",
        description: "Watch a path or glob in any project's worktree.",
        icon: FileDiffIcon,
      },
    ],
  },
  {
    title: "Your world",
    items: [
      {
        id: "capture.received",
        label: "Capture received",
        mode: "async",
        description: "Anything sent through New.",
        icon: InboxIcon,
      },
      {
        id: "client.signal",
        label: "Client signal",
        mode: "async",
        description: "Wi-Fi, NFC, time, or location reported by one of your devices.",
        icon: SmartphoneIcon,
      },
      {
        id: "focus.changed",
        label: "Focus changed",
        mode: "async",
        description: "You switched between Work, Personal, and All.",
        icon: LayersIcon,
      },
      {
        id: "email.received",
        label: "Email received",
        mode: "async",
        description: "A matching message in a connected inbox.",
        icon: MailIcon,
      },
      {
        id: "integration.failing",
        label: "Integration failing",
        mode: "async",
        description: "An MCP server or API behind Executor keeps erroring.",
        icon: PlugZapIcon,
      },
      {
        id: "schedule",
        label: "Schedule",
        mode: "async",
        description: "Cron, with a timezone.",
        icon: CalendarClockIcon,
      },
      {
        id: "webhook",
        label: "Webhook",
        mode: "async",
        description: "Any service that can POST.",
        icon: WebhookIcon,
      },
    ],
  },
];

export const STEP_GROUPS: readonly PrimitiveGroup<StepPrimitive>[] = [
  {
    title: "Agents and models",
    items: [
      {
        id: "agent",
        label: "Agent turn",
        description: "Run a turn in any harness: Codex, Claude, Cursor, and the rest.",
        icon: BotIcon,
      },
      {
        id: "judge",
        label: "Judge",
        description: "Any model, Jev included, picks one of your named outcomes.",
        icon: ScaleIcon,
      },
      {
        id: "handoff",
        label: "Agent handoff",
        description: "Ask another owner's agent; only what you allow crosses.",
        icon: HandshakeIcon,
      },
    ],
  },
  {
    title: "Flow",
    items: [
      {
        id: "condition",
        label: "Condition",
        description: "Branch on any expression.",
        icon: GitBranchIcon,
      },
      {
        id: "gate",
        label: "Gate with loop-back",
        description: "Retry earlier steps until a check passes, up to a max.",
        icon: RepeatIcon,
      },
      {
        id: "parallel",
        label: "Parallel fan-out and join",
        description: "Run branches at once and wait for all or the first.",
        icon: SplitIcon,
      },
      {
        id: "wait",
        label: "Wait, sleep, or until",
        description: "Pause for a duration, a time, or an event.",
        icon: HourglassIcon,
      },
      {
        id: "subworkflow",
        label: "Sub-workflow",
        description: "Call another workflow and use its result.",
        icon: WorkflowIcon,
      },
      {
        id: "code",
        label: "Code step",
        description: "Plain TypeScript in the workflow file.",
        icon: CodeIcon,
      },
    ],
  },
  {
    title: "People",
    items: [
      {
        id: "approval",
        label: "Human approval",
        description: "Hold until someone approves, edits, or rejects.",
        icon: UserCheckIcon,
      },
      {
        id: "ask",
        label: "Ask user",
        description: "A question in a thread; the answer comes back as data.",
        icon: MessageCircleQuestionIcon,
      },
      {
        id: "notify",
        label: "Notify",
        description: "Push, Slack, or email.",
        icon: BellIcon,
      },
    ],
  },
  {
    title: "Actions",
    items: [
      {
        id: "tool",
        label: "Executor tool call",
        description: "Any connected integration: GitHub, Gmail, Notion, Sentry.",
        icon: WrenchIcon,
      },
      {
        id: "spaces",
        label: "Write to Spaces",
        description: "Save a doc, note, or file into a Space.",
        icon: FolderInputIcon,
      },
      {
        id: "computer",
        label: "Start a computer",
        description: "An on-demand machine for QA, browsing, or builds.",
        icon: MonitorIcon,
      },
      {
        id: "schedule-later",
        label: "Schedule a follow-up",
        description: "Run this workflow again later with new input.",
        icon: AlarmClockIcon,
      },
    ],
  },
  {
    title: "Inline verdicts",
    items: [
      {
        id: "verdict",
        label: "Allow, modify, hold, or block",
        description: "Decide what happens to the intercepted request.",
        icon: BanIcon,
      },
    ],
  },
];

export function filterGroups<T extends { label: string; description: string }>(
  groups: readonly PrimitiveGroup<T>[],
  query: string,
) {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  return groups
    .map((group) => ({
      title: group.title,
      items: group.items.filter(
        (item) =>
          item.label.toLowerCase().includes(needle) ||
          item.description.toLowerCase().includes(needle),
      ),
    }))
    .filter((group) => group.items.length > 0);
}
