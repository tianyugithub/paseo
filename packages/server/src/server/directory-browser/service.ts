import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { expandUserPath } from "../path-utils.js";

export type DirectoryBrowserEntryKind = "file" | "directory";

export interface DirectoryBrowserEntry {
  name: string;
  path: string;
  kind: DirectoryBrowserEntryKind;
}

export interface DirectoryBrowserListing {
  path: string;
  parentPath: string | null;
  entries: DirectoryBrowserEntry[];
  truncated: boolean;
}

// A project folder never holds thousands of entries, but a home directory browsing session will
// pass through ones that do. Cap the listing and tell the client it was cut rather than shipping a
// payload no phone list can render.
export const DIRECTORY_BROWSER_MAX_ENTRIES = 500;

// Lists one directory by absolute path. Unlike the file explorer, this is not scoped to a
// workspace: Add Project runs before any workspace exists. Callers that need containment apply it
// themselves.
export async function listBrowserDirectory(input: {
  directoryPath: string;
  includeFiles?: boolean;
}): Promise<DirectoryBrowserListing> {
  const resolvedPath = await fs.realpath(expandUserPath(input.directoryPath));
  const stats = await fs.stat(resolvedPath);
  if (!stats.isDirectory()) {
    throw new Error("Path is not a directory");
  }

  const includeFiles = input.includeFiles === true;
  const dirents = await fs.readdir(resolvedPath, { withFileTypes: true });
  const resolvedEntries = await Promise.all(
    dirents.map((dirent) => toEntry(resolvedPath, dirent, includeFiles)),
  );
  const entries = resolvedEntries.filter((entry): entry is DirectoryBrowserEntry => entry !== null);
  entries.sort(compareEntries);

  const truncated = entries.length > DIRECTORY_BROWSER_MAX_ENTRIES;
  return {
    path: resolvedPath,
    parentPath: parentOf(resolvedPath),
    entries: truncated ? entries.slice(0, DIRECTORY_BROWSER_MAX_ENTRIES) : entries,
    truncated,
  };
}

async function toEntry(
  directoryPath: string,
  dirent: Dirent,
  includeFiles: boolean,
): Promise<DirectoryBrowserEntry | null> {
  const entryPath = path.join(directoryPath, dirent.name);
  const kind = await resolveEntryKind(dirent, entryPath);
  if (kind === null) return null;
  if (kind === "file" && !includeFiles) return null;
  return { name: dirent.name, path: entryPath, kind };
}

async function resolveEntryKind(
  dirent: Dirent,
  entryPath: string,
): Promise<DirectoryBrowserEntryKind | null> {
  if (dirent.isDirectory()) return "directory";
  if (dirent.isFile()) return "file";
  // Sockets, FIFOs, and devices have nothing to pick. Symlinks do, but `readdir` reports the link
  // itself, so follow it — and drop the dangling ones, which are common enough in a home directory
  // that one broken link must not fail the whole listing.
  if (!dirent.isSymbolicLink()) return null;
  const stats = await fs.stat(entryPath).catch(() => null);
  if (stats?.isDirectory()) return "directory";
  if (stats?.isFile()) return "file";
  return null;
}

function compareEntries(a: DirectoryBrowserEntry, b: DirectoryBrowserEntry): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function parentOf(resolvedPath: string): string | null {
  const parent = path.dirname(resolvedPath);
  return parent === resolvedPath ? null : parent;
}
