import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PaperRunError } from "./errors.js";

/** Return a deterministic digest for every regular file in the imported paper tree. */
export function reviewTreeDigest(projectDir: string): string {
  const root = join(resolve(projectDir), "paper");
  const hash = createHash("sha256");
  for (const file of listFiles(root)) {
    const path = join(root, file);
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new PaperRunError(`Standalone review tree contains a non-file: paper/${file}`);
    hash.update(file).update("\0").update(readFileSync(path)).update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function assertReviewTreeUnchanged(projectDir: string, expected: string): void {
  const actual = reviewTreeDigest(projectDir);
  if (actual !== expected) {
    throw new PaperRunError("Standalone review refused to checkpoint because imported paper content changed.", {
      hint: "Restore the paper/ tree to its transfer baseline; standalone review never revises manuscript files.",
    });
  }
}

function listFiles(root: string, current = root): string[] {
  if (!existsSync(root)) throw new PaperRunError("Standalone review paper directory is missing.");
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new PaperRunError("Standalone review paper directory must be a real directory.");
  }
  const result: string[] = [];
  for (const entry of readdirSync(current).sort()) {
    const path = join(current, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new PaperRunError(`Standalone review paper tree contains an unsafe entry: ${relative(root, path)}`);
    }
    if (stat.isDirectory()) result.push(...listFiles(root, path));
    else result.push(relative(root, path).split("\\").join("/"));
  }
  return result;
}
