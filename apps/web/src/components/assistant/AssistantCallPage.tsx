/**
 * A phone call with the assistant. PLACEHOLDER: nothing connects; the timer is
 * static and the transcript is canned. Mobile will run this over realtime voice.
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { MicOffIcon, PhoneOffIcon, Volume2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { cn } from "~/lib/utils";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { AssistantIcon, useAssistantIdentity } from "./assistantIdentity";

const TRANSCRIPT = [
  { speaker: "you", text: "Hey, anything I need to deal with before lunch?" },
  {
    speaker: "assistant",
    text: "Two things. The sidebar Task wants your OK to push, and the lease reply needs a start date.",
  },
  { speaker: "you", text: "Approve the push. I'll do the lease tonight." },
  { speaker: "assistant", text: "Approved. The t3code agent is pushing now." },
] as const;

function CallControl(props: {
  label: string;
  pressed?: boolean;
  tone?: "default" | "end";
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        aria-label={props.label}
        aria-pressed={props.pressed}
        onClick={props.onClick}
        className={cn(
          "flex size-14 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&_svg]:size-6",
          props.tone === "end"
            ? "bg-destructive text-white hover:bg-destructive/90"
            : props.pressed
              ? "bg-foreground text-background"
              : "bg-muted text-foreground hover:bg-accent",
        )}
      >
        {props.children}
      </button>
      <span className="text-xs text-muted-foreground">{props.label}</span>
    </div>
  );
}

export function AssistantCallPage() {
  const navigate = useNavigate();
  const { name } = useAssistantIdentity();
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(true);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Call breadcrumb">
            <WorkspaceBreadcrumbItem>
              <Link
                to="/assistant"
                className="flex min-w-0 items-center gap-2 hover:text-foreground"
              >
                <AssistantIcon />
                <WorkspaceBreadcrumbText>{name}</WorkspaceBreadcrumbText>
              </Link>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>
              <WorkspaceBreadcrumbText>Call</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>

        <main className="flex min-h-0 flex-1 flex-col items-center justify-between gap-8 overflow-y-auto px-6 pt-10 pb-10">
          <div className="flex flex-col items-center gap-3 text-center">
            <AssistantIcon size={120} expression="listening" />
            <h1 className="text-3xl font-semibold tracking-tight">{name}</h1>
            <p className="text-sm text-muted-foreground tabular-nums">04:12</p>
          </div>

          <section aria-label="Live transcript" className="flex w-full max-w-md flex-col gap-2.5">
            {TRANSCRIPT.map((line) => (
              <p
                key={line.text}
                className={cn(
                  "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
                  line.speaker === "you"
                    ? "self-end bg-message text-message-foreground"
                    : "self-start text-foreground",
                )}
              >
                <span className="sr-only">{line.speaker === "you" ? "You: " : `${name}: `}</span>
                {line.text}
              </p>
            ))}
          </section>

          <div className="flex flex-col items-center gap-5">
            <div className="flex items-start gap-6">
              <CallControl
                label={muted ? "Unmute" : "Mute"}
                pressed={muted}
                onClick={() => setMuted(!muted)}
              >
                <MicOffIcon aria-hidden />
              </CallControl>
              <CallControl label="Speaker" pressed={speaker} onClick={() => setSpeaker(!speaker)}>
                <Volume2Icon aria-hidden />
              </CallControl>
              <CallControl
                label="End"
                tone="end"
                onClick={() => void navigate({ to: "/assistant" })}
              >
                <PhoneOffIcon aria-hidden />
              </CallControl>
            </div>
          </div>
        </main>
      </div>
    </SidebarInset>
  );
}
