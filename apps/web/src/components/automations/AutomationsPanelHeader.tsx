/**
 * The Automations panel's header: its title, sort and filter, search, a way
 * to the overview, and New automation, which starts a thread asking an agent
 * to build one. Sort and the Needs-you filter persist like other sidebar
 * preferences; the search query doesn't.
 */
import { AutomationSortOrder } from "@t3tools/client-runtime/automations/list";
import { NEW_AUTOMATION_PROMPT } from "@t3tools/client-runtime/automations/prompts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import { InboxIcon, ListFilterIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";

import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import {
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { useOpenAgentDraft } from "./useAutomationAgent";
import { useOpenAutomation } from "./useOpenAutomation";

const isSortOrder = Schema.is(AutomationSortOrder);

export function useAutomationsPanelPrefs() {
  const [sortOrder, setSortOrder] = useLocalStorage<AutomationSortOrder, AutomationSortOrder>(
    "t3code:sidebar:automations-sort",
    "attention",
    AutomationSortOrder,
  );
  const [onlyNeedsYou, setOnlyNeedsYou] = useLocalStorage(
    "t3code:sidebar:automations-needs-you",
    false,
    Schema.Boolean,
  );
  return { sortOrder, setSortOrder, onlyNeedsYou, setOnlyNeedsYou };
}

type Prefs = ReturnType<typeof useAutomationsPanelPrefs>;

function FilterMenu(props: { prefs: Prefs }) {
  const { prefs } = props;
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton label="Sort and filter">
            <ListFilterIcon />
          </SidebarHeaderIconButton>
        }
      />
      <MenuPopup side="bottom" align="end">
        <MenuGroup>
          <MenuGroupLabel>Sort by</MenuGroupLabel>
          <MenuRadioGroup
            value={prefs.sortOrder}
            onValueChange={(value) => {
              if (isSortOrder(value)) prefs.setSortOrder(value);
            }}
          >
            <MenuRadioItem value="attention">Needs you, then recent</MenuRadioItem>
            <MenuRadioItem value="name">Name</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuCheckboxItem checked={prefs.onlyNeedsYou} onCheckedChange={prefs.setOnlyNeedsYou}>
          Needs you
        </MenuCheckboxItem>
      </MenuPopup>
    </Menu>
  );
}

function NewAutomationButton() {
  const { isMobile, setOpenMobile } = useSidebar();
  const { activeThread, defaultProjectRef } = useHandleNewThread();
  const openDraft = useOpenAgentDraft();
  // The project in front of the user, else the first one.
  const projectRef = activeThread
    ? scopeProjectRef(activeThread.environmentId, activeThread.projectId)
    : defaultProjectRef;
  if (!projectRef) return null;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={() => {
            if (isMobile) setOpenMobile(false);
            void openDraft(projectRef, NEW_AUTOMATION_PROMPT);
          }}
        >
          <PlusIcon />
          <span className="min-w-0 flex-1 truncate text-sidebar-foreground">New automation</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function AutomationsPanelHeader(props: {
  prefs: Prefs;
  /** Null while search is closed. */
  query: string | null;
  onQueryChange: (query: string | null) => void;
}) {
  const openAutomation = useOpenAutomation();
  const close = () => props.onQueryChange(null);
  return (
    <div className="flex flex-col gap-1 px-2 pt-2 pb-1">
      <div className="flex h-8 items-center gap-1 pl-2.5">
        {props.query !== null ? (
          <>
            <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
            <SidebarInput
              nativeInput
              autoFocus
              type="search"
              value={props.query}
              onChange={(event) => props.onQueryChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                close();
              }}
              placeholder="Search automations"
              aria-label="Search automations"
              className="min-w-0 flex-1"
            />
            <SidebarHeaderIconButton label="Close search" onClick={close}>
              <XIcon />
            </SidebarHeaderIconButton>
          </>
        ) : (
          <>
            <h2 className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight text-sidebar-foreground">
              Automations
            </h2>
            <SidebarHeaderIconButton label="What needs you" onClick={() => openAutomation()}>
              <InboxIcon />
            </SidebarHeaderIconButton>
            <FilterMenu prefs={props.prefs} />
            <SidebarHeaderIconButton
              label="Search automations"
              onClick={() => props.onQueryChange("")}
            >
              <SearchIcon />
            </SidebarHeaderIconButton>
          </>
        )}
      </div>
      <NewAutomationButton />
    </div>
  );
}
