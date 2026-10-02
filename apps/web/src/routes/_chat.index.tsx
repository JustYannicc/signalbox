import { createFileRoute, Link, Navigate, redirect } from "@tanstack/react-router";
import { LinkIcon, PlusIcon } from "lucide-react";

import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { isElectron } from "../env";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useEnvironments } from "../state/environments";
import { APP_BASE_NAME, APP_DISPLAY_NAME } from "~/branding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";

function ChatIndexRouteView() {
  const { environments, isReady } = useEnvironments();
  // Only the hosted static app renders here (see beforeLoad): it has nothing
  // to land on until an environment is connected.
  if (!isReady) return null;
  if (environments.length === 0) return <HostedStaticOnboardingState />;
  return <Navigate to="/assistant" replace />;
}

// Fork: "/" is the assistant. The logo, the main-app fallback, and every
// "thread is gone" redirect land here, so they all end up with the assistant.
// New chats start from New (mod+Enter) or `chat.new`, not from "/".
export const Route = createFileRoute("/_chat/")({
  beforeLoad: ({ context }) => {
    if (context.authGateState.status === "hosted-static") return;
    throw redirect({ to: "/assistant", replace: true });
  },
  component: ChatIndexRouteView,
});

function HostedStaticOnboardingState() {
  const cloudEnabled = hasCloudPublicConfig();
  const localEnvironmentOff = isLocalEnvironmentDisabled();
  const description = localEnvironmentOff
    ? "The local environment is turned off. Connect a remote environment, or turn the local environment back on in Connections."
    : cloudEnabled
      ? "Turn on remote access on that machine, then open Connections here to sign in with the same account. You can also add the machine using a pairing link."
      : "Open Connections and add that machine using its pairing link. This app must be able to reach it.";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </WorkspacePageHeader>

        <Empty className="flex-1">
          <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <LinkIcon className="size-5" />
              </div>
              <EmptyTitle>Connect to a computer running {APP_BASE_NAME}</EmptyTitle>
              <EmptyDescription>
                This app connects to {APP_BASE_NAME} running on your computer or a server. Start the{" "}
                {APP_BASE_NAME}
                desktop app or command-line server on that machine and keep it running.
              </EmptyDescription>
              <EmptyDescription>{description}</EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button render={<Link to="/settings/connections" />} size="sm">
                  <PlusIcon className="size-4" />
                  Open Connections
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
