/** A section heading with an optional right-aligned note. */
export function SectionHeading({
  id,
  title,
  note,
}: {
  readonly id: string;
  readonly title: string;
  readonly note?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 id={id} className="text-sm font-medium text-foreground">
        {title}
      </h2>
      {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
    </div>
  );
}
