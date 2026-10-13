/**
 * Fork: Settings > Notifications, the defaults for when supervisor agents may
 * ping you, which devices pings land on, the rules agents' bells set per
 * folder, and what breaks through Focus. Prototype state, so it skips the
 * settings scope sentence that `SettingsPageContainer` shows.
 */
import {
  NotificationDefaultsForm,
  NotificationOverridesSection,
} from "../assistant/NotificationDefaultsForm";
import { useAssistantIdentity } from "../assistant/assistantIdentity";
import { useNotifyDefaults } from "../assistant/notificationPolicy";
import { EscalationRulesSection } from "../levels/EscalationRulesSection";
import { LevelOptionsProvider } from "../levels/LevelOptionsProvider";
import { WorkspacePageContainer } from "../WorkspacePageContainer";

export function NotificationSettingsPage() {
  const [defaults, setDefaults] = useNotifyDefaults();
  const { name } = useAssistantIdentity();
  return (
    <div className="topbar-scroll-fade scrollbar-gutter-both flex-1 overflow-y-auto">
      <LevelOptionsProvider>
        <WorkspacePageContainer className="gap-8">
          <NotificationDefaultsForm value={defaults} onChange={setDefaults} assistantName={name} />
          <NotificationOverridesSection />
          <EscalationRulesSection />
        </WorkspacePageContainer>
      </LevelOptionsProvider>
    </div>
  );
}
