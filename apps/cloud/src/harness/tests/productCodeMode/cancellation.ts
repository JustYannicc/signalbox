import type { createFacetSqliteStorage } from "../../../kernel/FacetSqliteStorage.ts";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import type { appServerDriver } from "./driver.ts";
import { createNodeFs } from "../../../isolate/NodeFs.ts";

export async function fileSearchProof(
  files: KernelFileSystem,
  storage: ReturnType<typeof createFacetSqliteStorage>,
  driver: ReturnType<typeof appServerDriver>,
) {
  const readdir = storage.readdir;
  try {
    createNodeFs(files).fs.writeFileSync("/work/evening-routine.md", "fixture\n");
    const fuzzy = await driver.request("fuzzyFileSearch", { query: "evrt", roots: ["/work"] });
    const cancelled = await cancelSearch(files, storage, driver);
    const replaced = await supersedeSearch(files, driver);
    return {
      fuzzy,
      cancelledSearch: {
        atStop: cancelled.atStop,
        totalDirectories: cancelled.totalDirectories,
        directoriesRead: cancelled.directoriesRead,
      },
      replacedSearch: { events: replaced.events },
    };
  } finally {
    storage.readdir = readdir;
  }
}

export async function cancelSearch(
  files: KernelFileSystem,
  storage: ReturnType<typeof createFacetSqliteStorage>,
  driver: ReturnType<typeof appServerDriver>,
) {
  const root = "/work/cancel-search";
  const totalDirectories = 1024;
  files.mkdir(root);
  for (let i = 0; i < totalDirectories; i++) {
    const path = `${root}/directory-${String(i).padStart(4, "0")}`;
    files.mkdir(path);
  }
  const inode = storage.lookup(storage.lookup(storage.root, "work"), "cancel-search");
  const directories = new Set(storage.readdir(inode).map((entry) => entry.inode));
  const visited = new Set<bigint>();
  const readdir = storage.readdir.bind(storage);
  storage.readdir = (directory) => {
    if (directories.has(directory)) visited.add(directory);
    return readdir(directory);
  };
  const sessionId = "cancel-during-walk";
  await driver.request("fuzzyFileSearch/sessionStart", { sessionId, roots: [root] });
  await driver.request("fuzzyFileSearch/sessionUpdate", { sessionId, query: "directory" });
  await driver.waitFor(
    (frame) =>
      frame.method === "fuzzyFileSearch/sessionUpdated" && frame.params?.sessionId === sessionId,
  );
  await driver.request("fuzzyFileSearch/sessionStop", { sessionId });
  return {
    atStop: visited.size,
    totalDirectories,
    get directoriesRead() {
      return visited.size;
    },
  };
}

export async function supersedeSearch(
  files: KernelFileSystem,
  driver: ReturnType<typeof appServerDriver>,
) {
  const root = "/work/replace-search";
  files.mkdir(root);
  for (let i = 0; i < 1024; i++) files.mkdir(`${root}/directory-${String(i).padStart(4, "0")}`);
  const sessionId = "replace-during-walk";
  await driver.request("fuzzyFileSearch/sessionStart", {
    sessionId,
    roots: [root],
  });
  await driver.request("fuzzyFileSearch/sessionUpdate", { sessionId, query: "directory" });
  await driver.waitFor(
    (frame) =>
      frame.method === "fuzzyFileSearch/sessionUpdated" && frame.params?.sessionId === sessionId,
  );
  await driver.request("fuzzyFileSearch/sessionUpdate", { sessionId, query: "009" });
  await driver.waitFor(
    (frame) =>
      frame.method === "fuzzyFileSearch/sessionCompleted" && frame.params?.sessionId === sessionId,
  );
  await driver.request("fuzzyFileSearch/sessionStop", { sessionId });
  return {
    get events() {
      return driver.frames
        .filter((frame) => frame.params?.sessionId === sessionId)
        .map((frame) => ({ method: frame.method, query: frame.params?.query }));
    },
  };
}
