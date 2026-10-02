/**
 * Devices: servers that run chats and the client apps they can reach into.
 * UI prototype on placeholder data (see fleet.ts and devicesFixtures.ts).
 */
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, PlusIcon, QrCodeIcon } from "lucide-react";

import { isElectron } from "../../env";
import { COMPUTERS } from "../computers/computerFixtures";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ClientDeviceCard } from "./ClientDeviceCard";
import { CLIENT_DEVICES } from "./devicesFixtures";
import { notifyDevicesComingSoon, plural } from "./devicesModel";
import { FLEET_SERVERS, ROLLOUT_STEPS, ROLLOUT_VERSION } from "./fleet";
import { RolloutDisclosure } from "./RolloutDisclosure";
import { ServersSection } from "./ServersSection";

const LIVE_COMPUTERS = COMPUTERS.filter((computer) => computer.state === "live").length;

export function DevicesPage() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex w-full min-w-0 items-center gap-3 py-2">
            <WorkspaceBreadcrumb ariaLabel="Devices breadcrumb" className="min-w-0 flex-1">
              <WorkspaceBreadcrumbItem current>
                <h1>Devices</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => notifyDevicesComingSoon("Pairing a client")}
            >
              <QrCodeIcon aria-hidden />
              Pair a client
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => notifyDevicesComingSoon("Adding a server")}
            >
              <PlusIcon aria-hidden />
              Add server
            </Button>
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded" className="gap-10">
            <p className="text-sm text-muted-foreground">
              Servers run every chat. Clients are gateways a server can reach into; nothing runs on
              them.
            </p>

            <ServersSection servers={FLEET_SERVERS}>
              <RolloutDisclosure
                version={ROLLOUT_VERSION}
                steps={ROLLOUT_STEPS}
                servers={FLEET_SERVERS}
              />
              <Link
                to="/computers"
                className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
              >
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
                {plural(LIVE_COMPUTERS, "computer")} live
                <ArrowRightIcon className="size-3" aria-hidden />
              </Link>
            </ServersSection>

            <section aria-labelledby="devices-clients" className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h2 id="devices-clients" className="text-sm font-medium text-foreground">
                  Clients
                </h2>
                <span className="text-xs text-muted-foreground">
                  What a server may reach into, and where pings land
                </span>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {CLIENT_DEVICES.map((device) => (
                  <ClientDeviceCard key={device.id} device={device} />
                ))}
              </div>
            </section>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
