/**
 * The library's non-happy states: a source that needs reconnecting, and the
 * empty shapes (nothing synced yet, nothing matching the filters).
 */
import { TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import type { SpacesSourceFixture } from "./spacesFixtures";
import { SourceMark } from "./SpacesGlyphs";

export function SpacesSourceProblem(props: {
  source: SpacesSourceFixture;
  onReconnect: () => void;
}) {
  return (
    <Alert variant="error">
      <TriangleAlertIcon />
      <AlertTitle>{props.source.name} stopped syncing</AlertTitle>
      <AlertDescription>{props.source.problem}</AlertDescription>
      <AlertAction>
        <Button size="xs" variant="outline" onClick={props.onReconnect}>
          Reconnect
        </Button>
      </AlertAction>
    </Alert>
  );
}

export function SpacesEmptyState(props: {
  source?: SpacesSourceFixture;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border">
      <Empty size="compact">
        {props.source ? <SourceMark connector={props.source.connector} size="md" /> : null}
        <EmptyHeader>
          <EmptyTitle>{props.title}</EmptyTitle>
          <EmptyDescription>{props.description}</EmptyDescription>
        </EmptyHeader>
        {props.action ? <EmptyContent>{props.action}</EmptyContent> : null}
      </Empty>
    </div>
  );
}
