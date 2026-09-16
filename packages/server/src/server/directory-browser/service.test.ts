import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DIRECTORY_BROWSER_MAX_ENTRIES, listBrowserDirectory } from "./service.js";

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("directory browser service", () => {
  it("lists directories before files, each sorted by name", async () => {
    const root = await createTempDir("paseo-directory-browser-");
    try {
      await mkdir(path.join(root, "zulu"));
      await mkdir(path.join(root, "alpha"));
      await writeFile(path.join(root, "beta.txt"), "");
      await writeFile(path.join(root, "alpha.md"), "");

      const listing = await listBrowserDirectory({ directoryPath: root, includeFiles: true });

      expect(listing.entries.map((entry) => [entry.kind, entry.name])).toEqual([
        ["directory", "alpha"],
        ["directory", "zulu"],
        ["file", "alpha.md"],
        ["file", "beta.txt"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("omits files unless the caller asks for them", async () => {
    const root = await createTempDir("paseo-directory-browser-");
    try {
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "README.md"), "");

      const listing = await listBrowserDirectory({ directoryPath: root });

      expect(listing.entries.map((entry) => entry.name)).toEqual(["src"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns absolute entry paths under the listed directory", async () => {
    const root = await createTempDir("paseo-directory-browser-");
    try {
      await mkdir(path.join(root, "packages"));

      const listing = await listBrowserDirectory({ directoryPath: root });

      expect(listing.entries[0]?.path).toBe(path.join(listing.path, "packages"));
      expect(listing.parentPath).toBe(path.dirname(listing.path));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a relative path against the working directory", async () => {
    const root = await createTempDir("paseo-directory-browser-");
    try {
      await mkdir(path.join(root, "nested"));

      const listing = await listBrowserDirectory({
        directoryPath: path.join(root, "nested", ".."),
      });

      expect(listing.path).toBe(await realpath(root));
      expect(listing.entries.map((entry) => entry.name)).toEqual(["nested"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("expands a home-relative path", async () => {
    const listing = await listBrowserDirectory({ directoryPath: "~" });

    expect(listing.path).toBe(await realpath(os.homedir()));
    expect(listing.parentPath).toBe(path.dirname(listing.path));
  });

  it("exposes hidden entries, unlike the workspace directory search", async () => {
    const root = await createTempDir("paseo-directory-browser-");
    try {
      await mkdir(path.join(root, ".config"));
      await mkdir(path.join(root, "node_modules"));
      await writeFile(path.join(root, ".env"), "");

      const listing = await listBrowserDirectory({ directoryPath: root, includeFiles: true });

      expect(listing.entries.map((entry) => entry.name)).toEqual([
        ".config",
        "node_modules",
        ".env",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a file path as an error instead of listing it", async () => {
    const root = await createTempDir("paseo-directory-browser-");
    try {
      const filePath = path.join(root, "notes.txt");
      await writeFile(filePath, "");

      await expect(listBrowserDirectory({ directoryPath: filePath })).rejects.toThrow(
        "Path is not a directory",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a missing path as an error", async () => {
    const root = await createTempDir("paseo-directory-browser-");
    try {
      await expect(
        listBrowserDirectory({ directoryPath: path.join(root, "gone") }),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("caps a huge directory and flags the result as truncated", async () => {
    const root = await createTempDir("paseo-directory-browser-");
    try {
      const overflow = DIRECTORY_BROWSER_MAX_ENTRIES + 10;
      await Promise.all(
        Array.from({ length: overflow }, (_unused, index) =>
          mkdir(path.join(root, `dir-${String(index).padStart(4, "0")}`)),
        ),
      );

      const listing = await listBrowserDirectory({ directoryPath: root });

      expect(listing.truncated).toBe(true);
      expect(listing.entries).toHaveLength(DIRECTORY_BROWSER_MAX_ENTRIES);
      expect(listing.entries[0]?.name).toBe("dir-0000");
      expect(listing.entries.at(-1)?.name).toBe("dir-0499");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not flag a directory at the cap as truncated", async () => {
    const root = await createTempDir("paseo-directory-browser-");
    try {
      await Promise.all(
        Array.from({ length: DIRECTORY_BROWSER_MAX_ENTRIES }, (_unused, index) =>
          mkdir(path.join(root, `dir-${String(index).padStart(4, "0")}`)),
        ),
      );

      const listing = await listBrowserDirectory({ directoryPath: root });

      expect(listing.truncated).toBe(false);
      expect(listing.entries).toHaveLength(DIRECTORY_BROWSER_MAX_ENTRIES);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
