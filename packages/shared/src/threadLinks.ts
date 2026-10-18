import { ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { applyTextSourceEdits, type TextSourceMap } from "./textSourceMap.ts";

export const THREAD_LINK_PROTOCOL = "t3-thread";
const THREAD_LINK_HREF_PREFIX = `${THREAD_LINK_PROTOCOL}://v1/`;
// Code comes first in the alternation so a link written inside a code span or fence is skipped.
const THREAD_LINK_OUTSIDE_CODE =
  /(?<fence>(`{3,}|~{3,})[\s\S]*?(?:\2|$))|(?<span>(`+)[^\n]*?\4)|\[[^\]\n]*\]\((?<href>t3-thread:\/\/v1\/[^\s)]+)\)/g;

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** The id as written. Thread ids can hold percent escapes of their own, so it is not decoded. */
export function parseThreadLinkHref(href: string): ThreadId | null {
  if (!href.startsWith(THREAD_LINK_HREF_PREFIX)) return null;
  return Option.getOrNull(decodeThreadId(href.slice(THREAD_LINK_HREF_PREFIX.length)));
}

export function percentDecodedThreadLinkId(threadId: ThreadId): ThreadId | null {
  try {
    const decoded = decodeURIComponent(threadId);
    return decoded === threadId ? null : Option.getOrNull(decodeThreadId(decoded));
  } catch {
    return null;
  }
}

export function formatThreadLink(threadId: string, label: string): string {
  const cleaned = label
    .replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `[${cleaned || threadId}](${THREAD_LINK_HREF_PREFIX}${threadId})`;
}

export function hasThreadLinks(markdown: string): boolean {
  return markdown.includes(`](${THREAD_LINK_HREF_PREFIX}`);
}

// signalbox: mapped and ordinary labels must use the same encoded-id/title precedence.
function resolvedThreadLink(
  href: string | undefined,
  title: (threadId: ThreadId) => string | undefined,
): string | null {
  const written = href === undefined ? null : parseThreadLinkHref(href);
  if (written === null) return null;
  const decoded = percentDecodedThreadLinkId(written);
  const threadId =
    title(written) === undefined && decoded !== null && title(decoded) !== undefined
      ? decoded
      : written;
  const label = title(threadId)?.trim();
  return label ? formatThreadLink(threadId, label) : null;
}

export function relabelThreadLinks(
  markdown: string,
  title: (threadId: ThreadId) => string | undefined,
): string {
  if (!hasThreadLinks(markdown)) return markdown;
  return markdown.replace(THREAD_LINK_OUTSIDE_CODE, (source, ...args) => {
    const href = (args.at(-1) as { href?: string }).href;
    return resolvedThreadLink(href, title) ?? source;
  });
}

// signalbox: live titles can change length, so retain the source link as their owner.
export function relabelThreadLinksSourceMap(
  markdown: string,
  title: (threadId: ThreadId) => string | undefined,
): TextSourceMap {
  return applyTextSourceEdits(
    markdown,
    [...markdown.matchAll(THREAD_LINK_OUTSIDE_CODE)].flatMap((match) => {
      const replacement = resolvedThreadLink(match.groups?.href, title);
      return replacement
        ? [
            {
              start: match.index,
              end: match.index + match[0].length,
              text: replacement,
            },
          ]
        : [];
    }),
  );
}
