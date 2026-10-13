/**
 * The Ready shelf on Now: one prepared option at a time, offered as a line of
 * text only once nothing is blocked on you. Never counted, never pushed; "Not
 * now" just moves to the next one and leaves nothing behind.
 */
import { ClockAlertIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { reactAvatar } from "./LiveAvatar";
import type { ReadyFixture } from "./topLayerFixtures";

export function ReadyLine(props: { items: readonly ReadyFixture[] }) {
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const item = props.items[index];
  if (!item) return null;
  const next = () => {
    setOpen(false);
    setIndex((current) => current + 1);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="mt-3 rounded-md text-sm text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring"
          />
        }
      >
        {item.title} is ready whenever you are.
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="center" width="md">
        <div className="flex flex-col gap-3 text-left">
          <div className="flex flex-col gap-0.5">
            <PopoverTitle>{item.title}</PopoverTitle>
            <p className="text-sm text-foreground">{item.summary}</p>
          </div>
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {item.detail.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p
            className={
              item.stale
                ? "flex items-center gap-1.5 text-xs text-warning-foreground"
                : "text-xs text-muted-foreground"
            }
          >
            {item.stale ? <ClockAlertIcon className="size-3.5" /> : null}
            {item.freshness}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                next();
                reactAvatar("celebrate", "happy", 1600);
                toastManager.add({
                  type: "success",
                  title: "On it",
                  description: `Booking "${item.title}". You'll only hear back if something needs you.`,
                });
              }}
            >
              Let's do it
            </Button>
            <Button size="sm" variant="ghost" onClick={next}>
              Not now
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
