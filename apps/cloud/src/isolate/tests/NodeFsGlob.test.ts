import { describe, expect, it } from "@effect/vitest";
import type * as NodeFS from "node:fs";
import { createNodeFs } from "../NodeFs.ts";
import { nodeFsPosixFixture } from "./helpers/NodeFsPosixFixture.ts";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

describe("Node fs/promises glob", () => {
  it("matches brace, class, and recursive patterns inside the kernel filesystem", async () => {
    const fixture = nodeFsPosixFixture();
    const promises = createNodeFs(fixture.kernelFs)["fs/promises"];
    try {
      await promises.mkdir("/work/src/deep", { recursive: true });
      await promises.writeFile("/work/src/app.ts", "ts");
      await promises.writeFile("/work/src/view.tsx", "tsx");
      await promises.writeFile("/work/src/deep/model.ts", "model");
      await promises.writeFile("/work/src/readme.md", "md");
      await promises.writeFile("/work/src/.hidden.ts", "hidden");

      const matches: string[] = [];
      for await (const match of promises.glob("src/**/*.{t[s],tsx,js}", { cwd: "/work" })) {
        if (typeof match !== "string") throw new Error("Expected string paths");
        matches.push(match);
      }

      expect(matches.toSorted()).toEqual(["src/app.ts", "src/deep/model.ts", "src/view.tsx"]);
    } finally {
      fixture.close();
    }
  });

  it("uses the kernel cwd, resolves relative and file URL cwd values, and deduplicates patterns", async () => {
    const fixture = nodeFsPosixFixture();
    const otherFixture = nodeFsPosixFixture();
    const promises = createNodeFs(fixture.kernelFs)["fs/promises"];
    const otherPromises = createNodeFs(otherFixture.kernelFs)["fs/promises"];
    try {
      await promises.mkdir("/work/first", { recursive: true });
      await promises.mkdir("/work/second", { recursive: true });
      await promises.writeFile("/work/first/first.txt", "first");
      await promises.writeFile("/work/second/second.txt", "second");
      await otherPromises.mkdir("/work/first", { recursive: true });

      fixture.kernelFs.chdir("/work/first");
      expect(await collect(promises.glob("*.txt"))).toEqual(["first.txt"]);

      const pending = promises.glob("*.txt");
      fixture.kernelFs.chdir("/work/second");
      expect(await collect(pending)).toEqual(["second.txt"]);
      expect(await collect(promises.glob("*.txt", { cwd: "../first" }))).toEqual(["first.txt"]);
      expect(await collect(promises.glob("*.txt", { cwd: new URL("file:///work/first") }))).toEqual(
        ["first.txt"],
      );
      const duplicateMatches = await collect(
        promises.glob(["**/*.txt", "**/*.txt"], { cwd: "/work" }),
      );
      expect(duplicateMatches.toSorted()).toEqual(["first/first.txt", "second/second.txt"]);
      expect(await collect(otherPromises.glob("**/*.txt", { cwd: "/work" }))).toEqual([]);
    } finally {
      fixture.close();
      otherFixture.close();
    }
  });

  it("passes Dirents to function excludes and prunes string-pattern exclusions", async () => {
    const fixture = nodeFsPosixFixture();
    const directoriesRead: string[] = [];
    const observedFs = new Proxy(fixture.kernelFs, {
      get(target, property) {
        if (property === "readdir") {
          return (path: string) => {
            directoriesRead.push(path);
            return target.readdir(path);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const promises = createNodeFs(observedFs)["fs/promises"];
    try {
      await promises.mkdir("/work/.git", { recursive: true });
      await promises.mkdir("/work/node_modules/pkg", { recursive: true });
      await promises.mkdir("/work/src", { recursive: true });
      await promises.writeFile("/work/.git/config", "git");
      await promises.writeFile("/work/node_modules/pkg/index.js", "package");
      await promises.writeFile("/work/src/app.js", "app");
      fixture.kernelFs.chdir("/work");

      const excludedNames: string[] = [];
      const dirents: NodeFS.Dirent<string>[] = [];
      for await (const entry of promises.glob("**/*", {
        cwd: "/work",
        withFileTypes: true,
        exclude: (candidate) => {
          if (typeof candidate === "string") throw new Error("Expected a Dirent exclude value");
          const dirent = candidate as NodeFS.Dirent<string>;
          excludedNames.push(String(dirent.name));
          return dirent.name === ".git" || dirent.name === "node_modules";
        },
      })) {
        if (typeof entry === "string") throw new Error("Expected Dirent results");
        dirents.push(entry as NodeFS.Dirent<string>);
      }

      expect(excludedNames).toContain("node_modules");
      expect(dirents.map((entry) => String(entry.name)).toSorted()).toEqual(["app.js", "src"]);
      const app = dirents.find((entry) => entry.name === "app.js");
      const src = dirents.find((entry) => entry.name === "src");
      expect(app?.isFile()).toBe(true);
      expect(app?.parentPath).toBe("/work/src");
      expect(src?.isDirectory()).toBe(true);
      expect(src?.parentPath).toBe("/work");

      const excludedPatterns: string[] = [];
      directoriesRead.length = 0;
      for await (const entry of promises.glob("**/*.js", {
        cwd: "/work",
        exclude: ["**/.git/**", "**/node_modules/**"],
      })) {
        if (typeof entry !== "string") throw new Error("Expected string results");
        excludedPatterns.push(entry);
      }
      expect(excludedPatterns).toEqual(["src/app.js"]);
      expect(directoriesRead).toContain("/work");
      expect(directoriesRead).not.toContain("/work/.git");
      expect(directoriesRead).not.toContain("/work/node_modules");

      const excludedByFunction: string[] = [];
      for await (const entry of promises.glob("**/*.js", {
        cwd: "/work",
        exclude: (candidate) => {
          if (typeof candidate !== "string") throw new Error("Expected a string exclude value");
          return candidate === "node_modules";
        },
      })) {
        if (typeof entry !== "string") throw new Error("Expected string results");
        excludedByFunction.push(entry);
      }
      expect(excludedByFunction).toEqual(["src/app.js"]);

      const gitExclusions: string[] = [];
      const explicitlyIncludedGit = await collect(
        promises.glob(".git/**", {
          cwd: "/work",
          withFileTypes: true,
          exclude: (candidate) => {
            if (typeof candidate === "string") throw new Error("Expected a Dirent exclude value");
            const dirent = candidate as NodeFS.Dirent<string>;
            gitExclusions.push(String(dirent.name));
            return dirent.name === ".git";
          },
        }),
      );
      expect(gitExclusions).toContain(".git");
      expect(explicitlyIncludedGit).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("honors default symlink behavior and can follow links without cycling", async () => {
    const fixture = nodeFsPosixFixture();
    const promises = createNodeFs(fixture.kernelFs)["fs/promises"];
    try {
      await promises.mkdir("/work/real/nested", { recursive: true });
      await promises.writeFile("/work/real/nested/file.ts", "source");
      await promises.symlink("/work/real", "/work/alias");
      await promises.symlink("/work", "/work/real/nested/cycle");

      const withoutFollowing: string[] = [];
      for await (const entry of promises.glob("**/*.ts", { cwd: "/work" })) {
        if (typeof entry !== "string") throw new Error("Expected string results");
        withoutFollowing.push(entry);
      }
      expect(withoutFollowing).toEqual(["real/nested/file.ts"]);

      const following: string[] = [];
      for await (const entry of promises.glob("**/*.ts", {
        cwd: "/work",
        followSymlinks: true,
      })) {
        if (typeof entry !== "string") throw new Error("Expected string results");
        following.push(entry);
      }
      expect(following.toSorted()).toEqual(["alias/nested/file.ts", "real/nested/file.ts"]);
    } finally {
      fixture.close();
    }
  });

  it("stops directory reads when the async iterator is closed early", async () => {
    const fixture = nodeFsPosixFixture();
    const directories: string[] = [];
    const observedFs = new Proxy(fixture.kernelFs, {
      get(target, property) {
        if (property === "readdir") {
          return (path: string) => {
            directories.push(path);
            return target.readdir(path);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const promises = createNodeFs(observedFs)["fs/promises"];
    try {
      const writer = createNodeFs(fixture.kernelFs)["fs/promises"];
      await writer.mkdir("/work/deep", { recursive: true });
      await writer.writeFile("/work/root.txt", "root");
      await writer.writeFile("/work/deep/nested.txt", "nested");

      const iterator = promises.glob("**/*.txt", { cwd: "/work" });
      expect(directories).toEqual([]);
      const first = await iterator.next();
      expect(first).toMatchObject({ done: false, value: "root.txt" });
      expect(directories).toEqual(["/work"]);
      if (iterator.return === undefined) throw new Error("Expected an iterator return method");
      await iterator.return();
      expect(directories).toEqual(["/work"]);

      directories.length = 0;
      const lazy = promises.glob("late/*.txt", { cwd: "/work" });
      expect(directories).toEqual([]);
      await writer.mkdir("/work/late", { recursive: true });
      await writer.writeFile("/work/late/created.txt", "created after glob construction");
      expect(await collect(lazy)).toEqual(["late/created.txt"]);
      expect(directories).toContain("/work/late");

      directories.length = 0;
      expect(await collect(promises.glob("**/*.txt", { cwd: "/work" }))).toHaveLength(3);
      expect(directories).toContain("/work/deep");
    } finally {
      fixture.close();
    }
  });

  it("validates patterns and options during iteration while keeping truthy withFileTypes behavior", async () => {
    const fixture = nodeFsPosixFixture();
    const promises = createNodeFs(fixture.kernelFs)["fs/promises"];
    const looseGlob = promises.glob as unknown as (
      pattern: unknown,
      options?: unknown,
    ) => AsyncIterableIterator<unknown>;
    try {
      await promises.mkdir("/work", { recursive: true });
      await promises.writeFile("/work/file.txt", "file");

      await expect(looseGlob(42).next()).rejects.toMatchObject({
        code: "ERR_INVALID_ARG_TYPE",
      });
      await expect(looseGlob(["*.txt", 42]).next()).rejects.toMatchObject({
        code: "ERR_INVALID_ARG_TYPE",
      });
      await expect(looseGlob("*.txt", { exclude: 42 }).next()).rejects.toMatchObject({
        code: "ERR_INVALID_ARG_TYPE",
      });
      await expect(looseGlob("*.txt", { cwd: 42 }).next()).rejects.toMatchObject({
        code: "ERR_INVALID_ARG_TYPE",
      });

      const truthyFileTypes = await collect(
        looseGlob("*.txt", { cwd: "/work", withFileTypes: "yes" }),
      );
      expect(truthyFileTypes).toHaveLength(1);
      const result = truthyFileTypes[0];
      if (
        typeof result !== "object" ||
        result === null ||
        !("name" in result) ||
        !("isFile" in result) ||
        typeof result.isFile !== "function"
      ) {
        throw new Error("Expected a Node Dirent result");
      }
      expect(result.name).toBe("file.txt");
      expect(result.isFile()).toBe(true);
    } finally {
      fixture.close();
    }
  });
});
