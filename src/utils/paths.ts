/**
 * Locating a paper-run writing repository from an arbitrary working directory.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { PAPER_RUN_DIR, STATE_FILES } from "./constants.js";
import { NotAProjectError } from "./errors.js";

/**
 * Walk upward from `startDir` looking for a directory containing
 * `.paper-run/run.json`. Returns the absolute project root, or null.
 */
export function findProjectRoot(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);

  for (;;) {
    const marker = join(dir, PAPER_RUN_DIR, STATE_FILES.run);
    if (existsSync(marker)) return dir;

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Like {@link findProjectRoot}, but throws a helpful error when not found. */
export function requireProjectRoot(startDir: string = process.cwd()): string {
  const root = findProjectRoot(startDir);
  if (!root) throw new NotAProjectError(resolve(startDir));
  return root;
}

/** True when `dir` does not exist, or exists and contains no entries. */
export function isEmptyDir(dir: string): boolean {
  const path = resolve(dir);
  if (!existsSync(path)) return true;
  const stat = statSync(path);
  if (!stat.isDirectory()) return false;
  return readdirSync(path).length === 0;
}
