/**
 * Overview: is Executor up, and what needs attention.
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { needsAttention, type PluginsSection } from "./pluginsModel";
import { EXECUTOR_STATUS, HARNESS_PLUGINS, INTEGRATIONS, SKILLS } from "./pluginsFixtures";
import { comingSoon, IntegrationMark, StatusDot } from "./pluginsPrimitives";

function SectionLink(props: { section: PluginsSection; children: ReactNode }) {
  return (
    <Link
      to="/plugins"
      search={{ section: props.section }}
      className="text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
    >
      {props.children}
    </Link>
  );
}

function ExecutorStatusGroup() {
  const brokered = INTEGRATIONS.filter((item) => item.via === "executor");
  const toolCount = brokered.reduce((sum, item) => sum + item.toolCount, 0);
  const connected = EXECUTOR_STATUS.state === "connected";

  return (
    <SettingsSection title="Executor">
      <div className="flex flex-col gap-3 px-3 py-3.5 sm:flex-row sm:items-center sm:gap-4 sm:px-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <StatusDot auth={connected ? "connected" : "error"} />
            {connected ? "Connected" : "Disconnected"}
            <span className="font-normal text-muted-foreground">as {EXECUTOR_STATUS.account}</span>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {EXECUTOR_STATUS.url} · v{EXECUTOR_STATUS.version} · synced {EXECUTOR_STATUS.lastSync}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => comingSoon("Sync Executor")}>
            Sync now
          </Button>
          <Button size="sm" variant="outline" onClick={() => comingSoon("Open Executor")}>
            Open Executor
          </Button>
        </div>
      </div>
      <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
        Brokering <SectionLink section="connections">{brokered.length} integrations</SectionLink>{" "}
        with <span className="text-foreground tabular-nums">{toolCount}</span> tools. Harnesses also
        load <SectionLink section="harness-plugins">{HARNESS_PLUGINS.length} plugins</SectionLink>{" "}
        and <SectionLink section="skills">{SKILLS.length} skills</SectionLink>.
      </p>
    </SettingsSection>
  );
}

function NeedsAttentionGroup() {
  const brokenIntegrations = INTEGRATIONS.filter(needsAttention);
  const outdatedPlugins = HARNESS_PLUGINS.filter((plugin) => plugin.updateAvailable);

  return (
    <SettingsSection title="Needs attention">
      {brokenIntegrations.length + outdatedPlugins.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">Everything is connected.</p>
      ) : null}
      {brokenIntegrations.map((integration) => (
        <div key={integration.id} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
          <IntegrationMark glyph={integration.glyph} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-2 text-sm font-medium text-foreground">
              <StatusDot auth={integration.auth} />
              {integration.name}
              {integration.via === "direct" ? (
                <span className="text-xs font-normal text-muted-foreground">direct</span>
              ) : null}
            </span>
            <span className="truncate text-xs text-muted-foreground">{integration.authDetail}</span>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => comingSoon(`Reconnect ${integration.name}`)}
          >
            {integration.auth === "needs-reauth" ? "Sign in again" : "Retry"}
          </Button>
        </div>
      ))}
      {outdatedPlugins.map((plugin) => (
        <div key={plugin.id} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium text-foreground">{plugin.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              Update {plugin.version} → {plugin.updateAvailable}
            </span>
          </div>
          <Button size="sm" variant="outline" onClick={() => comingSoon(`Update ${plugin.name}`)}>
            Update
          </Button>
        </div>
      ))}
    </SettingsSection>
  );
}

export function PluginsOverview() {
  return (
    <div className="flex flex-col gap-8">
      <ExecutorStatusGroup />
      <NeedsAttentionGroup />
    </div>
  );
}
