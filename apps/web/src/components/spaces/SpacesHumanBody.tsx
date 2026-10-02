/**
 * Library body: the items the page scoped by source, kind and search, as a
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
            : "Pick another filter in the sidebar, or connect a source."
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
