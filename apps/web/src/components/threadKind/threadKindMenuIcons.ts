// signalbox: the kind icons for the web context menu (`contextMenuFallback.ts`), as Lucide draws them.
export const THREAD_KIND_MENU_ICON_PATHS: Record<
  string,
  ReadonlyArray<{ tag: string; attrs: Record<string, string> }>
> = {
  "message-circle": [
    {
      tag: "path",
      attrs: {
        d: "M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719",
      },
    },
  ],
  "list-todo": [
    { tag: "path", attrs: { d: "M13 5h8" } },
    { tag: "path", attrs: { d: "M13 12h8" } },
    { tag: "path", attrs: { d: "M13 19h8" } },
    { tag: "path", attrs: { d: "m3 17 2 2 4-4" } },
    { tag: "rect", attrs: { x: "3", y: "4", width: "6", height: "6", rx: "1" } },
  ],
};
