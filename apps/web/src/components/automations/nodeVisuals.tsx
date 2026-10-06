/**
 * Icon and tone per step verb, plus the service logo a step shows when it
 * talks to a connected service. The words live in client-runtime's labels.
 */
import type { WorkflowStepNode, WorkflowStepVerb } from "@t3tools/contracts";
import { serviceIdentity } from "@t3tools/client-runtime/automations/services";
import {
  BellIcon,
  BookOpenIcon,
  BookmarkPlusIcon,
  BotIcon,
  GlobeIcon,
  HourglassIcon,
  MessageCircleQuestionIcon,
  Plug2Icon,
  ScaleIcon,
  ScanTextIcon,
  SparklesIcon,
  SquareTerminalIcon,
  TimerIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useState } from "react";

import { faviconUrlForOrigin } from "~/lib/favicon";
import { cn } from "~/lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { GitHubIcon } from "../Icons";
import { SignalboxMark } from "../SignalboxMark";

type Tone = "agent" | "ask" | "neutral" | "start";

const VERBS: Record<WorkflowStepVerb, { icon: LucideIcon; tone: Tone }> = {
  agent: { icon: BotIcon, tone: "agent" },
  llm: { icon: SparklesIcon, tone: "agent" },
  judge: { icon: ScaleIcon, tone: "agent" },
  extract: { icon: ScanTextIcon, tone: "agent" },
  ask: { icon: MessageCircleQuestionIcon, tone: "ask" },
  call: { icon: Plug2Icon, tone: "neutral" },
  http: { icon: GlobeIcon, tone: "neutral" },
  run: { icon: SquareTerminalIcon, tone: "neutral" },
  notify: { icon: BellIcon, tone: "neutral" },
  sleep: { icon: TimerIcon, tone: "neutral" },
  waitFor: { icon: HourglassIcon, tone: "neutral" },
  recall: { icon: BookOpenIcon, tone: "neutral" },
  remember: { icon: BookmarkPlusIcon, tone: "neutral" },
  start: { icon: WorkflowIcon, tone: "start" },
};

/** Tinted tile behind the verb icon. Service logos sit on a neutral tile so the brand leads. */
const TONE_CLASS: Record<Tone, string> = {
  agent: "bg-primary/10 text-primary",
  ask: "bg-warning/14 text-warning-foreground",
  neutral: "bg-muted text-foreground/80",
  start: "bg-info/12 text-info-foreground",
};

export function verbIcon(verb: WorkflowStepVerb): LucideIcon {
  return VERBS[verb].icon;
}

/** Domains whose favicon already failed this session go straight to the verb icon. */
const failedDomains = new Set<string>();

function DomainLogo(props: { domain: string; fallback: LucideIcon }) {
  const [failed, setFailed] = useState(() => failedDomains.has(props.domain));
  const url = faviconUrlForOrigin(`https://${props.domain}`, 64);
  if (props.domain === "github.com" || props.domain.endsWith(".github.com"))
    return <GitHubIcon aria-hidden className="size-4.5" />;
  if (!url || failed) return <props.fallback aria-hidden className="size-4.5" />;
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      draggable={false}
      className="size-4.5 rounded-sm"
      onError={() => {
        failedDomains.add(props.domain);
        setFailed(true);
      }}
    />
  );
}

/** The square at the start of a step card: the service logo when there is one, else the verb icon. */
export const StepTile = memo(function StepTile(props: {
  node: Pick<WorkflowStepNode, "verb" | "service">;
  size?: "card" | "panel";
}) {
  const verb = VERBS[props.node.verb];
  const identity = serviceIdentity(props.node.service);
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-lg",
        props.size === "panel" ? "size-8" : "size-9",
        identity ? "border border-border/70 bg-background" : TONE_CLASS[verb.tone],
      )}
    >
      {identity?.kind === "provider" ? (
        <ProviderInstanceIcon
          driverKind={identity.provider}
          displayName={identity.name}
          iconClassName="size-4.5"
        />
      ) : identity?.kind === "signalbox" ? (
        <SignalboxMark aria-hidden className="size-4.5" />
      ) : identity?.kind === "domain" ? (
        <DomainLogo domain={identity.domain} fallback={verb.icon} />
      ) : (
        <verb.icon aria-hidden className="size-4.5" />
      )}
    </span>
  );
});
