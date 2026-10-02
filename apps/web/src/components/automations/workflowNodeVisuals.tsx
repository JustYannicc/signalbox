/**
 * Icon, type label, and tone for each workflow node, shared by the canvas
 * cards and the details panel so a node reads the same in both places.
 */
import {
  BanIcon,
  BellIcon,
  BotIcon,
  BugIcon,
  CalendarClockIcon,
  CircleCheckIcon,
  CirclePauseIcon,
  ClockIcon,
  CodeIcon,
  FileTextIcon,
  FolderOpenIcon,
  GitBranchIcon,
  HandshakeIcon,
  HashIcon,
  HeadsetIcon,
  InboxIcon,
  LaptopIcon,
  MailIcon,
  MapPinIcon,
  MonitorIcon,
  MonitorSmartphoneIcon,
  NfcIcon,
  PenLineIcon,
  PlugZapIcon,
  ReceiptIcon,
  RepeatIcon,
  ScaleIcon,
  SmartphoneIcon,
  UserCheckIcon,
  WebhookIcon,
  WifiOffIcon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { createElement, type ComponentType, type SVGProps } from "react";

import { cn } from "~/lib/utils";
import { ASSISTANT_NAME } from "../assistant/assistantIdentity";
import { AssistantIcon } from "../assistant/AssistantIcon";
import { ClaudeAI, GitHubIcon, OpenAI } from "../Icons";
import type { WorkflowNodeConfig, WorkflowNodeKind } from "./automationModel";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;
type ClientSignalConfig = Extract<WorkflowNodeConfig, { kind: "clientSignal" }>;
type VerdictAction = Extract<WorkflowNodeConfig, { kind: "verdict" }>["action"];

const INTEGRATION_ICONS: Record<string, IconComponent> = {
  Executor: PlugZapIcon,
  GitHub: GitHubIcon,
  Gmail: MailIcon,
  "Google Drive": FolderOpenIcon,
  Notion: FileTextIcon,
  "Quick Capture": InboxIcon,
  Sentry: BugIcon,
  Signalbox: MonitorSmartphoneIcon,
  Slack: HashIcon,
  "Northwind Expenses": ReceiptIcon,
  Zendesk: HeadsetIcon,
};

const SIGNAL_ICONS: Record<ClientSignalConfig["signal"], IconComponent> = {
  wifi: WifiOffIcon,
  nfc: NfcIcon,
  time: ClockIcon,
  location: MapPinIcon,
};

const SIGNAL_LABEL: Record<ClientSignalConfig["signal"], string> = {
  wifi: "Wi-Fi",
  nfc: "NFC tag",
  time: "Time",
  location: "Location",
};

const VERDICT_ICONS: Record<VerdictAction, IconComponent> = {
  allow: CircleCheckIcon,
  hold: CirclePauseIcon,
  block: BanIcon,
  modify: PenLineIcon,
};

export const VERDICT_LABEL: Record<VerdictAction, string> = {
  allow: "Allow",
  hold: "Hold for approval",
  block: "Block",
  modify: "Modify",
};

/** Verdicts are colored by what they do to the intercepted request. */
const VERDICT_TILE_CLASS: Record<VerdictAction, string> = {
  allow: "bg-success/12 text-success-foreground",
  hold: "bg-warning/14 text-warning-foreground",
  block: "bg-destructive/12 text-destructive-foreground",
  modify: "bg-info/12 text-info-foreground",
};

/** Tinted tile behind the node icon; tools stay neutral so the brand mark leads. */
const NODE_TILE_CLASS: Record<Exclude<WorkflowNodeKind, "verdict">, string> = {
  trigger: "bg-info/12 text-info-foreground",
  clientSignal: "bg-info/12 text-info-foreground",
  agent: "bg-primary/12 text-primary",
  tool: "bg-muted text-foreground",
  step: "bg-muted text-foreground",
  condition: "bg-warning/14 text-warning-foreground",
  handoff: "bg-primary/12 text-primary",
  approval: "bg-warning/14 text-warning-foreground",
  notify: "bg-muted text-foreground",
  gate: "bg-warning/14 text-warning-foreground",
  judge: "bg-primary/12 text-primary",
  computer: "bg-muted text-foreground",
};

export function nodeTileClass(config: WorkflowNodeConfig) {
  return config.kind === "verdict"
    ? VERDICT_TILE_CLASS[config.action]
    : NODE_TILE_CLASS[config.kind];
}

export function nodeIcon(config: WorkflowNodeConfig): IconComponent {
  switch (config.kind) {
    case "trigger":
      if (config.source === "event") return INTEGRATION_ICONS[config.integration] ?? WebhookIcon;
      if (config.source === "hook")
        return config.mode === "inline" ? ZapIcon : MonitorSmartphoneIcon;
      return config.source === "schedule" ? CalendarClockIcon : WebhookIcon;
    case "clientSignal":
      return config.deviceKind === "phone" ? SmartphoneIcon : LaptopIcon;
    case "agent":
      if (config.provider === "assistant") return BotIcon;
      return config.provider === "codex" ? OpenAI : ClaudeAI;
    case "tool":
      return INTEGRATION_ICONS[config.integration] ?? WrenchIcon;
    case "step":
      return CodeIcon;
    case "condition":
      return GitBranchIcon;
    case "handoff":
      return HandshakeIcon;
    case "approval":
      return UserCheckIcon;
    case "gate":
      return RepeatIcon;
    case "judge":
      return ScaleIcon;
    case "verdict":
      return VERDICT_ICONS[config.action];
    case "computer":
      return MonitorIcon;
    case "notify":
      return BellIcon;
  }
}

const IMPORTANCE_LABEL = { low: "low", normal: "normal", urgent: "urgent" } as const;

/** The small label above the node title, e.g. "Agent · Codex" or "Google Drive · List files". */
export function nodeTypeLabel(config: WorkflowNodeConfig) {
  switch (config.kind) {
    case "trigger":
      if (config.source === "event") return `${config.integration} event`;
      if (config.source === "hook") {
        return `${config.mode === "inline" ? "Inline hook" : "Hook"} · ${config.hook}`;
      }
      return config.source === "schedule" ? "Schedule trigger" : "Webhook trigger";
    case "clientSignal":
      return `Client signal · ${config.device}`;
    case "agent":
      return `${config.provider === "assistant" ? "Assistant" : "Agent"} · ${config.providerLabel}`;
    case "tool":
      return `${config.integration} · ${config.action}`;
    case "step":
      return `Code step · ${config.fn}()`;
    case "condition":
      return "Condition";
    case "handoff":
      return `Agent handoff · ${config.from} → ${config.to}`;
    case "approval":
      return `Approval · ${config.approver}`;
    case "gate":
      return `Loop · max ${config.maxIterations} iterations`;
    case "judge":
      return `Judge · ${config.model}`;
    case "verdict":
      return `Verdict · ${VERDICT_LABEL[config.action]}`;
    case "computer":
      return "Computer · on demand";
    case "notify":
      return `Notify · ${IMPORTANCE_LABEL[config.importance]} importance`;
  }
}

export function clientSignalLabel(config: ClientSignalConfig) {
  return SIGNAL_LABEL[config.signal];
}

function isOwnAssistant(config: WorkflowNodeConfig) {
  return (
    config.kind === "agent" &&
    config.provider === "assistant" &&
    config.providerLabel === ASSISTANT_NAME
  );
}

/** Renders the node's icon; the icon component is picked from static tables. */
export function NodeIcon(props: { config: WorkflowNodeConfig; className?: string }) {
  // The user's own assistant shows its avatar; other named agents keep the bot glyph.
  if (isOwnAssistant(props.config)) return <AssistantIcon className={props.className} />;
  return createElement(nodeIcon(props.config), { "aria-hidden": true, className: props.className });
}

/**
 * The tinted icon tile. Client signals add the signal glyph in the corner so
 * the device and what it reported read together.
 */
export function NodeTile(props: { config: WorkflowNodeConfig; size: "card" | "panel" }) {
  const { config } = props;
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-lg",
        props.size === "card" ? "size-9" : "size-8",
        nodeTileClass(config),
      )}
    >
      <NodeIcon config={config} className={props.size === "card" ? "size-4.5" : "size-4"} />
      {config.kind === "clientSignal"
        ? createElement(SIGNAL_ICONS[config.signal], {
            "aria-hidden": true,
            strokeWidth: 2.5,
            className:
              "absolute -right-1 -bottom-1 size-4 rounded-full bg-card p-0.5 text-info-foreground ring-1 ring-border",
          })
        : null}
    </span>
  );
}
