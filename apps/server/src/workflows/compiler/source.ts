import type { WorkflowDiagnostic } from "@t3tools/contracts";
import type { Comment, Node, Span } from "oxc-parser";

const MAX_LABEL_LENGTH = 80;

/**
 * The workflow file being compiled: offset → line/column lookup, comments for
 * labels, and the diagnostics found so far.
 */
export class WorkflowSource {
  readonly diagnostics: WorkflowDiagnostic[] = [];
  readonly text: string;
  private readonly lineStarts: number[] = [0];
  private comments: ReadonlyArray<Comment> = [];

  constructor(text: string) {
    this.text = text;
    for (let index = 0; index < text.length; index++) {
      if (text.charCodeAt(index) === 10) this.lineStarts.push(index + 1);
    }
  }

  setComments(comments: ReadonlyArray<Comment>) {
    this.comments = comments;
  }

  position(offset: number) {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.lineStarts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: offset - this.lineStarts[low]! + 1 };
  }

  line(span: Span) {
    return this.position(span.start).line;
  }

  slice(span: Span) {
    return this.text.slice(span.start, span.end);
  }

  /** Source text on one line, shortened for a label. */
  summary(span: Span) {
    const text = this.slice(span).replace(/\s+/g, " ").trim();
    return text.length > MAX_LABEL_LENGTH ? `${text.slice(0, MAX_LABEL_LENGTH - 1)}…` : text;
  }

  /** The comment directly above a statement, which labels it in the diagram. */
  commentBefore(span: Span): string | null {
    for (let index = this.comments.length - 1; index >= 0; index--) {
      const comment = this.comments[index]!;
      if (comment.end > span.start) continue;
      const between = this.text.slice(comment.end, span.start);
      if (!/^\s*$/.test(between) || (between.match(/\n/g)?.length ?? 0) > 1) return null;
      const lineStart = this.text.lastIndexOf("\n", comment.start - 1) + 1;
      if (this.text.slice(lineStart, comment.start).trim()) return null;
      const text = comment.value
        .split("\n")
        .map((line) => line.replace(/^\s*\*?\s?/, "").trim())
        .filter(Boolean)
        .join(" ");
      return text || null;
    }
    return null;
  }

  error(at: Span | Node, message: string, hint?: string) {
    this.diagnostics.push({ message, ...this.position(at.start), ...(hint ? { hint } : {}) });
  }
}
