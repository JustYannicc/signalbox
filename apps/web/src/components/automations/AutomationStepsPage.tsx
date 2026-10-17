/**
 * `/automations`: the reference of every trigger and step an automation can
 * use. Automations themselves have no list of their own; they live in their
 * folders in Home (#313).
 */
import { ScrollArea } from "../ui/scroll-area";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { AutomationsPageShell } from "./AutomationsPageShell";
import { StepsReference } from "./StepsReference";

export function AutomationStepsPage() {
  return (
    <AutomationsPageShell title="Triggers and steps">
      <div className="min-h-0 flex-1 border-t">
        <ScrollArea className="h-full">
          <WorkspacePageContainer>
            <StepsReference />
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </AutomationsPageShell>
  );
}
