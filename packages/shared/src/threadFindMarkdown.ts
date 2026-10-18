import { threadFindNodeLabelAnchor, type ThreadFindTextTree } from "./markdownTextSourceMap.ts";
import { createThreadFindSegments } from "./threadFindSegments.ts";
import type { ThreadFindDocument } from "./threadFindProvenance.ts";
import type { InlineSkill } from "./inlineSkills.ts";
import {
  artifactTemplateFromHastProperties,
  renderCodexInlineDirectivesAsMarkdown,
} from "./codexMarkdownDirectives.ts";
import { codexArtifactTemplatePresentationLabel } from "./codexArtifactTemplates.ts";
import {
  buildFileLinkParentSuffixByPath,
  splitFilePathPosition,
  fileLinkLabel,
} from "./fileLinks.ts";
import {
  isMarkdownFileLinkLabel,
  extractMarkdownLinkHrefs,
  extractInlineCodeSpans,
  inlineCodeFilePathCandidate,
  resolveMarkdownFileLinkTarget,
} from "./markdownLinks.ts";
import { parseComposerContextHref } from "./composerContextReferences.ts";
import { assistantCitationLabel, parseAssistantCitationHref } from "./assistantCitations.ts";
import { unified, type PluggableList } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import remarkBreaks from "remark-breaks";
import { remarkMappedBreaks } from "./markdownMappedBreaks.ts";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
} from "./markdownPipeline.ts";

// Inline wrappers (including Shiki token spans) must not split a search phrase.
export const THREAD_FIND_BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

const assistantProcessor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
const assistantBreaksProcessor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
const userProcessor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS)
  .use(remarkRehype, { allowDangerousHtml: true });
const mappedBreakPlugins: PluggableList = CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS.map((plugin) =>
  plugin === remarkBreaks ? remarkMappedBreaks : plugin,
);
const mappedUserProcessor = unified()
  .use(remarkParse)
  .use(mappedBreakPlugins)
  .use(remarkRehype, { allowDangerousHtml: true });
const mappedAssistantBreaksProcessor = unified()
  .use(remarkParse)
  .use(mappedBreakPlugins)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(CHAT_MARKDOWN_REHYPE_PLUGINS);

export function markdownThreadFindDocument(
  markdown: string,
  userMessage = false,
  cwd?: string,
  skills: readonly InlineSkill[] = [],
  lineBreaks = false,
  provenance = false,
): ThreadFindDocument {
  const processor = userMessage
    ? provenance
      ? mappedUserProcessor
      : userProcessor
    : lineBreaks
      ? provenance
        ? mappedAssistantBreaksProcessor
        : assistantBreaksProcessor
      : assistantProcessor;
  const tree = processor.runSync(processor.parse(markdown), {
    data: { threadFindOriginalMarkdown: markdown },
  });
  const paths = [
    ...extractMarkdownLinkHrefs(renderCodexInlineDirectivesAsMarkdown(markdown)),
    ...extractInlineCodeSpans(markdown).flatMap((span) => inlineCodeFilePathCandidate(span) ?? []),
  ].flatMap((href) => {
    const target = resolveMarkdownFileLinkTarget(href, cwd);
    return target ? [splitFilePathPosition(target).path] : [];
  });
  const parentSuffixes = buildFileLinkParentSuffixByPath(paths);
  const { segments, flush, appendSlot, appendText } = createThreadFindSegments(
    markdown,
    provenance,
  );
  const visit = (
    node: ThreadFindTextTree,
    inPre = false,
    inlineSkills = false,
    codeNode?: ThreadFindTextTree,
  ) => {
    const href = node.properties?.href ?? node.properties?.src;
    if (userMessage && typeof href === "string" && parseComposerContextHref(href)) {
      flush();
      return;
    }
    const citation =
      node.tagName === "a" && typeof href === "string" ? parseAssistantCitationHref(href) : null;
    if (citation) {
      appendSlot(
        assistantCitationLabel(citation),
        "link-label",
        provenance ? threadFindNodeLabelAnchor(markdown, node) : null,
        typeof href === "string" ? href : undefined,
      );
      return;
    }
    {
      let candidate: string | null = null;
      if (node.tagName === "a" && typeof href === "string") {
        candidate = href;
      } else if (
        node.tagName === "code" &&
        !inPre &&
        node.properties?.dataInlineCode !== undefined
      ) {
        candidate = inlineCodeFilePathCandidate(
          (node.children ?? []).map((child) => child.value ?? "").join(""),
        );
      }
      const target = candidate ? resolveMarkdownFileLinkTarget(candidate, cwd) : null;
      if (target) {
        const labelText = (node: ThreadFindTextTree): string =>
          node.value ?? (node.children ?? []).map(labelText).join("");
        const label = labelText(node);
        const displayed = `${node.tagName === "a" && candidate && !isMarkdownFileLinkLabel(label, candidate) ? `${label} ` : ""}${fileLinkLabel(splitFilePathPosition(target), parentSuffixes)}`;
        appendSlot(
          displayed,
          "link-label",
          provenance ? threadFindNodeLabelAnchor(markdown, node) : null,
          candidate ?? undefined,
        );
        return;
      }
    }
    const template = artifactTemplateFromHastProperties(node.properties);
    if (template) {
      flush();
      const anchor =
        node.position?.start.offset !== undefined && node.position?.end.offset !== undefined
          ? { start: node.position.start.offset, end: node.position.end.offset }
          : null;
      appendSlot(template.displayName, "artifact-name", anchor);
      flush();
      appendSlot(
        codexArtifactTemplatePresentationLabel(template.artifactKind),
        "artifact-kind",
        anchor,
      );
      flush();
      return;
    }
    const block = THREAD_FIND_BLOCK_TAGS.has(node.tagName ?? "");
    if (block) flush();
    if (node.type === "text" || (userMessage && node.type === "raw")) {
      appendText(node, inPre, inlineSkills, skills, codeNode);
    }
    const renderSkills =
      node.tagName === "code" || node.tagName === "a"
        ? false
        : inlineSkills || node.tagName === "p" || node.tagName === "li";
    for (const child of node.children ?? [])
      visit(
        child,
        inPre || node.tagName === "pre",
        renderSkills,
        node.tagName === "code" ? node : undefined,
      );
    if (block) flush();
  };
  visit(tree);
  flush();
  return { source: markdown, segments };
}
