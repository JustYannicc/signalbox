/**
 * "Just Files": the space as agents see it. Every source is a folder under
 * /spaces/<section path>, documents render as Markdown and records as JSON, so an
 * agent reads and edits files instead of learning each API. Executor turns
 * writes back into source API calls. PLACEHOLDER content derived from fixtures.
 */
import type { SpacesAccess, SpacesItemFixture, SpacesPhotoFixture } from "./spacesFixtures";
import { findSource, spaceSources } from "./spacesModel";
import { noteTitle, type SpacesNote } from "./spacesNotes";
import { spaceRootPath, type Space } from "./spacesSpace";

export interface SpacesFile {
  /** Absolute, e.g. `/spaces/northwind/drive/Q3 plan.gdoc.md`. */
  readonly path: string;
  readonly name: string;
  readonly access: SpacesAccess;
  /** Human name of the system edits flow back to; `undefined` for generated files. */
  readonly origin: string | undefined;
  readonly itemId?: string;
  readonly photo?: SpacesPhotoFixture;
}

export type SpacesTreeNode =
  | {
      readonly kind: "dir";
      readonly name: string;
      readonly path: string;
      readonly children: SpacesTreeNode[];
    }
  | {
      readonly kind: "file";
      readonly name: string;
      readonly path: string;
      readonly file: SpacesFile;
    };

export const spaceRoot = (space: Space) => space.root;

const EXTENSION: Record<SpacesItemFixture["type"], string> = {
  doc: ".gdoc.md",
  sheet: ".gsheet.md",
  slides: ".gslides.md",
  page: ".md",
  note: ".md",
  pdf: ".md",
  image: ".json",
  album: "",
  issue: ".md",
  task: ".json",
  message: ".md",
  email: ".eml.md",
  link: ".json",
};

// Formats that only ever mirror the source; nothing can be written back.
const READ_ONLY_TYPES = new Set<SpacesItemFixture["type"]>(["pdf", "image", "album"]);

// Slashes and colons make hostile file names; turn them into a spaced dash.
const clean = (segment: string) => segment.replaceAll(/\s*[/:]\s*/g, " - ").trim();

function relativePath(item: SpacesItemFixture): string {
  if (item.file) return item.file;
  const dirs = item.location
    .split(" / ")
    .map((part) => clean(part.split(" · ")[0] ?? part))
    .filter(Boolean);
  return [...dirs, `${clean(item.name)}${EXTENSION[item.type]}`].join("/");
}

/** Every file in the space, sorted by path. Albums expand to one JSON per photo. */
export function buildSpaceFiles(space: Space, items: readonly SpacesItemFixture[]): SpacesFile[] {
  const root = spaceRoot(space);
  const files: SpacesFile[] = [
    { path: `${root}/README.md`, name: "README.md", access: "read-only", origin: undefined },
    { path: `${root}/_types.ts`, name: "_types.ts", access: "read-only", origin: undefined },
  ];
  for (const item of items) {
    const source = findSource(item.source);
    if (!source) continue;
    const access = READ_ONLY_TYPES.has(item.type) ? "read-only" : source.access;
    const origin = source.connector === "notes" ? "Spaces" : source.name;
    // Items from nested sections sit under their own section's folder.
    const base = `${spaceRootPath(item.space)}/${source.connector}/${relativePath(item)}`;
    if (item.preview?.kind === "album") {
      for (const photo of item.preview.photos) {
        const name = `${photo.name}.json`;
        files.push({ path: `${base}/${name}`, name, access, origin, itemId: item.id, photo });
      }
      continue;
    }
    files.push({
      path: base,
      name: base.slice(base.lastIndexOf("/") + 1),
      access,
      origin,
      itemId: item.id,
    });
  }
  return files.toSorted((a, b) => a.path.localeCompare(b.path));
}

/** Folders first, then files, both alphabetical. */
export function buildTree(root: string, files: readonly SpacesFile[]): SpacesTreeNode[] {
  const top: SpacesTreeNode[] = [];
  for (const file of files) {
    const parts = file.path.slice(root.length + 1).split("/");
    let level = top;
    let path = root;
    for (const dir of parts.slice(0, -1)) {
      path = `${path}/${dir}`;
      let node = level.find((entry) => entry.kind === "dir" && entry.name === dir);
      if (!node) {
        node = { kind: "dir", name: dir, path, children: [] };
        level.push(node);
      }
      level = (node as Extract<SpacesTreeNode, { kind: "dir" }>).children;
    }
    level.push({ kind: "file", name: file.name, path: file.path, file });
  }
  const sort = (nodes: SpacesTreeNode[]): SpacesTreeNode[] =>
    nodes
      .map((node) => (node.kind === "dir" ? { ...node, children: sort(node.children) } : node))
      .toSorted((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
      );
  return sort(top);
}

function frontmatter(fields: Record<string, string | number>): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return ["---", ...lines, "---", ""].join("\n");
}

export function noteToMarkdown(note: SpacesNote, pathOf: (itemId: string) => string | undefined) {
  const body = note.blocks.map((entry) => {
    switch (entry.type) {
      case "heading1":
        return `## ${entry.text}`;
      case "heading2":
        return `### ${entry.text}`;
      case "todo":
        return `- [${entry.checked ? "x" : " "}] ${entry.text}`;
      case "bullet":
        return `- ${entry.text}`;
      case "callout":
        return `> [!NOTE]\n> ${entry.text}`;
      case "link": {
        const path = entry.itemId ? pathOf(entry.itemId) : undefined;
        return path ? `[${path.slice(path.lastIndexOf("/") + 1)}](<${path}>)` : "[missing item]";
      }
      default:
        return entry.text;
    }
  });
  const meta = frontmatter({ location: note.location, updated: note.updatedAt });
  // Adjacent list items stay one tight list; every other block is a paragraph.
  const listLike = (index: number) => ["todo", "bullet"].includes(note.blocks[index]?.type ?? "");
  const joined = body
    .map((text, index) =>
      index === 0 ? text : `${listLike(index) && listLike(index - 1) ? "\n" : "\n\n"}${text}`,
    )
    .join("");
  return `${meta}\n# ${noteTitle(note)}\n\n${joined}\n`;
}

function itemToText(item: SpacesItemFixture, file: SpacesFile): string {
  const source = findSource(item.source);
  if (file.photo) {
    const { photo } = file;
    return JSON.stringify(
      {
        kind: "photo",
        name: photo.name,
        album: item.name,
        takenAt: photo.takenAt,
        place: photo.place,
        source: source?.name,
      },
      null,
      2,
    );
  }
  if (EXTENSION[item.type].endsWith(".json")) {
    return JSON.stringify(
      {
        kind: item.type,
        name: item.name,
        owner: item.owner,
        location: item.location,
        updatedAt: item.updatedAt,
        summary: item.excerpt,
      },
      null,
      2,
    );
  }
  const meta = frontmatter({
    source: source?.name ?? item.source,
    owner: item.owner,
    updated: item.updatedAt,
  });
  const preview = item.preview;
  let body = item.excerpt;
  if (preview?.kind === "sheet") {
    const row = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
    body = [
      row(preview.columns),
      row(preview.columns.map(() => "---")),
      ...preview.rows.map(row),
    ].join("\n");
  } else if (preview?.kind === "slides") {
    body = preview.slides.map((title, index) => `## Slide ${index + 1}: ${title}`).join("\n\n");
  } else if (preview?.kind === "pdf") {
    body = `<!-- Extracted text, ${preview.pages} pages -->\n\n${item.excerpt}`;
  }
  return `${meta}\n# ${item.name}\n\n${body}\n`;
}

const TYPES_TS = `// Shapes of the JSON files in this space. Generated by Spaces; read-only.
export interface Photo {
  kind: "photo";
  name: string;
  album: string;
  takenAt: string; // ISO 8601
  place: string;
  source: string;
}

export interface Entry {
  kind: "task" | "link" | "image" | "issue";
  name: string;
  owner: string;
  location: string;
  updatedAt: string;
  summary: string;
}
`;

function readme(space: Space): string {
  const sources = spaceSources(space);
  const list = (access: SpacesAccess) =>
    sources
      .filter((source) => source.access === access)
      .map((source) => source.connector)
      .join(", ");
  return `# ${space.name}

Everything in ${space.id === "all" ? "every section in sight" : space.label}, as files.

- \`*.md\` documents, notes, issues and messages
- \`*.json\` records such as photos, tasks and links (shapes in \`_types.ts\`)

Edits are saved back through Executor. Read/write: ${list("read-write")}.
Read-only: ${list("read-only")}.
`;
}

export function fileContent(
  space: Space,
  file: SpacesFile,
  items: readonly SpacesItemFixture[],
  notes: Readonly<Record<string, SpacesNote>>,
  pathOf: (itemId: string) => string | undefined,
): string {
  if (file.name === "README.md" && !file.itemId) return readme(space);
  if (file.name === "_types.ts" && !file.itemId) return TYPES_TS;
  const note = file.itemId ? notes[file.itemId] : undefined;
  if (note) return noteToMarkdown(note, pathOf);
  const item = items.find((entry) => entry.id === file.itemId);
  return item ? itemToText(item, file) : "";
}
