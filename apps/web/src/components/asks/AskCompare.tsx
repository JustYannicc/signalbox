import type { ScopedThreadRef } from "@t3tools/contracts";
import type { AskKitImage, AskKitPreview } from "@t3tools/contracts/askKit";
import type { SignalboxAskQuestion } from "@t3tools/contracts/signalboxAsks";
import type { AskKitComponentSpec } from "@t3tools/shared/askKit";
import { MonitorPlayIcon } from "lucide-react";

import { useAssetUrlState } from "../../assets/assetUrls";
import { cn } from "../../lib/utils";
import { showPreviewPopup } from "../preview/showPreviewPopup";
import { Button } from "../ui/button";
import { AskOptionLabel } from "./AskChoices";
import { AskHtmlFrame } from "./AskHtmlFrame";

type CompareSpec = Extract<AskKitComponentSpec, { component: "compare" }>;

const PANE_FRAME = "aspect-video w-full rounded-md";

function AskImageView(props: {
  readonly image: AskKitImage;
  readonly alt: string;
  readonly threadRef: ScopedThreadRef;
}) {
  const { image } = props;
  const resource =
    image.source === "attachment"
      ? {
          _tag: "attachment" as const,
          attachmentId: image.attachmentId,
          mimeType: image.mimeType,
          disposition: "inline" as const,
        }
      : null;
  const asset = useAssetUrlState(
    resource === null ? null : props.threadRef.environmentId,
    resource,
  );
  const src =
    image.source === "https"
      ? image.url
      : image.source === "data"
        ? image.dataUrl
        : asset._tag === "Success"
          ? asset.url
          : null;
  if (src === null) {
    return (
      <div
        className={cn(
          PANE_FRAME,
          "flex items-center justify-center bg-muted/50 text-xs text-muted-foreground",
        )}
      >
        {asset._tag === "Failure" ? "Image unavailable" : "Loading image…"}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={props.alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      className={cn(PANE_FRAME, "bg-muted/30 object-contain")}
    />
  );
}

function PanePreview(props: {
  readonly preview: AskKitPreview;
  readonly threadRef: ScopedThreadRef;
}) {
  const { preview, threadRef } = props;
  switch (preview.kind) {
    case "image":
      return <AskImageView image={preview.image} alt={preview.alt} threadRef={threadRef} />;
    case "html":
      return <AskHtmlFrame html={preview.html} title={preview.title} maxHeight={320} />;
    case "thread-preview": {
      // Live tabs belong to their thread's browser panel; this thread can open its own.
      const own = preview.threadId === threadRef.threadId;
      return (
        <div className="flex flex-col items-start gap-1.5">
          {preview.still ? (
            <AskImageView
              image={preview.still.image}
              alt={preview.still.alt}
              threadRef={threadRef}
            />
          ) : (
            <div
              className={cn(
                PANE_FRAME,
                "flex items-center justify-center bg-muted/50 text-xs text-muted-foreground",
              )}
            >
              Live preview
            </div>
          )}
          {own ? (
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              onClick={() => showPreviewPopup(threadRef, preview.tabId, "panel")}
            >
              <MonitorPlayIcon />
              Open live preview
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">Live in another thread</span>
          )}
        </div>
      );
    }
  }
}

/** Panes side by side; picking one answers with its option. Nothing is picked until chosen. */
export function AskCompare(props: {
  readonly label: string;
  readonly options: SignalboxAskQuestion["options"];
  readonly spec: CompareSpec;
  readonly selected: number | undefined;
  readonly disabled: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly onChange: (selected: number | undefined) => void;
}) {
  return (
    <div role="group" aria-label={props.label} className="grid gap-2 sm:grid-cols-2">
      {props.spec.panes.map((pane) => {
        const option = props.options[pane.option];
        const picked = props.selected === pane.option;
        return (
          <figure
            key={pane.option}
            className={cn(
              "flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-2",
              picked ? "border-ring" : "border-border",
            )}
          >
            <PanePreview preview={pane.preview} threadRef={props.threadRef} />
            <figcaption className="flex min-w-0 items-center justify-between gap-2">
              <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-1.5 text-sm font-medium wrap-anywhere">
                  <AskOptionLabel
                    label={option?.label ?? ""}
                    look={props.spec.looks[pane.option]}
                  />
                </span>
                {pane.caption ? (
                  <span className="text-xs text-muted-foreground wrap-anywhere">
                    {pane.caption}
                  </span>
                ) : null}
              </span>
              <Button
                type="button"
                size="xs"
                variant={picked ? "secondary" : "outline"}
                aria-pressed={picked}
                aria-label={`Pick ${option?.label ?? "this option"}`}
                disabled={props.disabled}
                onClick={() => props.onChange(picked ? undefined : pane.option)}
              >
                {picked ? "Picked" : "Pick"}
              </Button>
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}
