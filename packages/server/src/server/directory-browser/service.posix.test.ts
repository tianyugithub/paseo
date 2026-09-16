// POSIX-only: symlink fixtures and a single filesystem root
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listBrowserDirectory } from "./service.js";
import { isPlatform } from "../../test-utils/platform.js";

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe.skipIf(isPlatform("win32"))("directory browser service POSIX-only", () => {
  it("follows a symlinked directory and reports it as a directory", async () => {
    const root = await createTempDir("paseo-directory-browser-");
    try {
      await mkdir(path.join(root, "real-target"));
      await symlink(path.join(root, "real-target"), path.join(root, "link-to-target"));

      const listing = await listBrowserDirectory({ directoryPath: root });

      expect(listing.entries.map((entry) => [entry.name, entry.kind])).toEqual([
        ["link-to-target", "directory"],
        ["real-target", "directory"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists a symlinked directory through the link path", async () => {
    const root = await createTempDir("paseo-directory-browser-");
    try {
      await mkdir(path.join(root, "real-target", "inner"), { recursive: true });
      await symlink(path.join(root, "real-target"), path.join(root, "link-to-target"));

      const listing = await listBrowserDirectory({
        directoryPath: path.join(root, "link-to-target"),
      });

      expect(listing.path).toBe(await realpath(path.join(root, "real-target")));
      expect(listing.entries.map((entry) => entry.name)).toEqual(["inner"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops a dangling symlink instead of failing the listing", async () => {
    const root = await createTempDir("paseo-directory-browser-");
    try {
      await mkdir(path.join(root, "kept"));
      await symlink(path.join(root, "gone"), path.join(root, "broken"));
      await symlink(path.join(root, "gone.txt"), path.join(root, "broken-file"));

      const listing = await listBrowserDirectory({ directoryPath: root, includeFiles: true });

      expect(listing.entries.map((entry) => entry.name)).toEqual(["kept"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports no parent for the filesystem root", async () => {
    const listing = await listBrowserDirectory({ directoryPath: "/" });

    expect(listing.path).toBe("/");
    expect(listing.parentPath).toBeNull();
  });
});
