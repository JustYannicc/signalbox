/**
 * Library body: the items the page scoped by place and search, as a
 * dense list (default) or a grid, plus the no-match state.
 */
import { Button } from "../ui/button";
import type { SpacesItemFixture } from "./spacesFixtures";
import { SpacesGrid, SpacesLedger } from "./SpacesItemViews";
import { SpacesEmptyState } from "./SpacesNotices";

export type SpacesLayout = "list" | "grid";

export function SpacesHumanBody(props: {
  items: readonly SpacesItemFixture[];
  layout: SpacesLayout;
  spaceId: string;
  query: string;
  onClearQuery: () => void;
  /** Why the place is empty when no search narrows it. */
  emptyDescription?: string | undefined;
  selectedId: string | undefined;
  onSelect: (itemId: string) => void;
}) {
  const query = props.query.trim();
  if (props.items.length === 0) {
    return (
      <SpacesEmptyState
        title={query ? `Nothing matches “${query}”` : "Nothing here yet"}
        description={
          query
            ? "Search looks at names, locations, owners and excerpts."
            : (props.emptyDescription ?? "Items synced or written here show up in this list.")
        }
        action={
          query ? (
            <Button variant="outline" onClick={props.onClearQuery}>
              Clear search
            </Button>
          ) : undefined
        }
      />
    );
  }
  const Body = props.layout === "grid" ? SpacesGrid : SpacesLedger;
  return (
    <Body
      items={props.items}
      spaceId={props.spaceId}
      selectedId={props.selectedId}
      onSelect={props.onSelect}
    />
  );
}
