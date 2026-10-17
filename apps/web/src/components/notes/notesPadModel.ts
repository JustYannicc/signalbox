/** Enter adds the note; Shift+Enter is a newline, and IME composition keeps its Enter. */
export function addsNote(event: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
}): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}
