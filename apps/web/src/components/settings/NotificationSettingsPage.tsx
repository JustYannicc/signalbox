/**
 * Fork: Settings > Notifications, the defaults for when supervisor agents may
 * ping you. Saved on this device (localStorage), so it skips the settings
 * scope sentence that `SettingsPageContainer` shows.
 */
import { NotificationDefaultsForm } from "../assistant/NotificationDefaultsForm";
import { useAssistantIdentity } from "../assistant/assistantIdentity";
import { useNotifyDefaults } from "../assistant/notificationPolicy";
import { WorkspacePageContainer } from "../WorkspacePageContainer";

export function NotificationSettingsPage() {
  const [defaults, setDefaults] = useNotifyDefaults();
  const { name } = useAssistantIdentity();
  return (
    <div className="topbar-scroll-fade scrollbar-gutter-both flex-1 overflow-y-auto">
      <WorkspacePageContainer className="gap-8">
        <NotificationDefaultsForm value={defaults} onChange={setDefaults} assistantName={name} />
      </WorkspacePageContainer>
    </div>
  );
}
