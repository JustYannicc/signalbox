/**
 * Format-aware previews for the preview panel: slide strip, sheet table,
 * photo grid and PDF pages. All drawn from fixture structure with theme
 * tokens; no network images until real sources exist.
 */
import { cn } from "~/lib/utils";
import type { SpacesPhotoTone, SpacesPreviewFixture } from "./spacesFixtures";

const PHOTO_TONE: Record<SpacesPhotoTone, string> = {
  primary: "bg-primary/20",
  info: "bg-info/25",
  success: "bg-success/25",
  warning: "bg-warning/25",
  muted: "bg-muted",
  error: "bg-destructive/15",
};

function SlidesPreview(props: { slides: readonly string[] }) {
  const [cover, ...rest] = props.slides;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex aspect-video flex-col justify-end rounded-md border border-border bg-card p-3">
        <span className="text-sm font-semibold text-balance text-foreground">{cover}</span>
        <span className="text-xs text-muted-foreground">Slide 1</span>
      </div>
      <ol aria-label="Slides" className="flex gap-2 overflow-x-auto pb-1">
        {rest.map((title, index) => (
          <li
            key={title}
            className="flex aspect-video w-24 shrink-0 flex-col justify-between rounded-sm border border-border bg-card p-1.5"
          >
            <span className="text-3xs text-muted-foreground tabular-nums">{index + 2}</span>
            <span className="line-clamp-2 text-3xs leading-tight font-medium text-foreground">
              {title}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function SheetPreview(props: { columns: readonly string[]; rows: readonly (readonly string[])[] }) {
  const numeric = (value: string) => /^[-\d.,:\s]+$/.test(value);
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead className="bg-muted">
          <tr>
            {props.columns.map((column) => (
              <th
                key={column}
                scope="col"
                className="border-b border-border px-2 py-1.5 text-left font-medium whitespace-nowrap text-muted-foreground"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr key={row.join("|")} className="border-b border-border last:border-0">
              {row.map((cell, index) => (
                <td
                  key={props.columns[index]}
                  className={cn(
                    "px-2 py-1.5 whitespace-nowrap text-foreground",
                    index > 0 && numeric(cell) && "text-right tabular-nums",
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const PHOTO_TILES = 9;

function AlbumPreview(props: {
  total: number;
  photos: readonly { name: string; place: string; tone: SpacesPhotoTone }[];
}) {
  const shown = props.photos.slice(0, props.total > PHOTO_TILES ? PHOTO_TILES - 1 : PHOTO_TILES);
  const hidden = props.total - shown.length;
  return (
    <ul aria-label="Photos" className="grid grid-cols-3 gap-1">
      {shown.map((photo) => (
        <li
          key={photo.name}
          role="img"
          aria-label={`${photo.name}, ${photo.place}`}
          className={cn(
            "flex aspect-square flex-col justify-end overflow-hidden rounded-sm",
            PHOTO_TONE[photo.tone],
          )}
        >
          <span aria-hidden className="h-2/5 bg-foreground/5" />
        </li>
      ))}
      {hidden > 0 ? (
        <li className="flex aspect-square items-center justify-center rounded-sm bg-muted text-xs font-medium text-muted-foreground tabular-nums">
          +{hidden}
        </li>
      ) : null}
    </ul>
  );
}

function PdfPreview(props: { pages: number }) {
  const shown = Math.min(props.pages, 4);
  return (
    <div className="flex flex-col gap-2">
      <ol aria-label="Pages" className="grid grid-cols-4 gap-2">
        {Array.from({ length: shown }, (_, index) => (
          <li key={index} className="flex flex-col items-center gap-1">
            <span
              aria-hidden
              className="flex aspect-[1/1.414] w-full flex-col gap-1 rounded-sm border border-border bg-card p-1.5"
            >
              <span className="h-1 w-3/4 rounded-full bg-foreground/20" />
              <span className="h-0.5 w-full rounded-full bg-foreground/10" />
              <span className="h-0.5 w-full rounded-full bg-foreground/10" />
              <span className="h-0.5 w-2/3 rounded-full bg-foreground/10" />
            </span>
            <span className="text-3xs text-muted-foreground tabular-nums">{index + 1}</span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">
        {props.pages} pages · agents read the extracted text
      </p>
    </div>
  );
}

export function SpacesRichPreview(props: { preview: SpacesPreviewFixture }) {
  const { preview } = props;
  switch (preview.kind) {
    case "slides":
      return <SlidesPreview slides={preview.slides} />;
    case "sheet":
      return <SheetPreview columns={preview.columns} rows={preview.rows} />;
    case "album":
      return <AlbumPreview total={preview.total} photos={preview.photos} />;
    case "pdf":
      return <PdfPreview pages={preview.pages} />;
  }
}
