/** Deterministic operating-mode transitions across all application-owned state. */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { Mode } from "../utils/constants.js";
import { PaperRunError } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import { switchGatePreset } from "./gate-presets.js";
import { readGatePolicy, withStateLock, writeGatePolicy } from "./store.js";
import type { GatePolicy } from "./schema.js";

export interface ModeSwitchResult {
  previousMode: Mode;
  mode: Mode;
  policy: GatePolicy;
}

/**
 * Keep run.json, gate-policy.json, and PAPER.md's operating mode aligned.
 * Existing gate overrides are preserved relative to the old policy preset.
 */
export function switchOperatingMode(projectDir: string, mode: Mode): ModeSwitchResult {
  const root = resolve(projectDir);
  return withStateLock(root, (store) => {
    const currentPolicy = readGatePolicy(root);
    const paperPath = join(root, "PAPER.md");
    const paper = readFileSync(paperPath, "utf-8");

    // Compute and validate every new value before writing any file. Publish the
    // gate policy last so a controller reload cannot observe the new policy
    // before run.json and PAPER.md have been aligned.
    const policy = switchGatePreset(currentPolicy, mode);
    const nextPaper = replacePaperMode(paper, mode);

    writeTextAtomic(paperPath, nextPaper);
    store.updateRunState({ mode });
    writeGatePolicy(root, policy);

    log.debug(`mode switched to ${mode}; effective at the next gate`);
    return { previousMode: currentPolicy.mode, mode, policy };
  });
}

/** Replace only the Mode value in PAPER.md's Operating mode section. */
export function replacePaperMode(paper: string, mode: Mode): string {
  const sectionPattern = /^## Operating mode\s*$[\s\S]*?(?=^##\s|(?![\s\S]))/im;
  const section = sectionPattern.exec(paper);
  if (!section) {
    throw new PaperRunError('PAPER.md is missing its "## Operating mode" section.');
  }

  const modePattern = /^(\s*(?:[-*]\s+)?Mode:\s*)(autonomous|collaborative|unresolved)(\s*)$/im;
  if (!modePattern.test(section[0])) {
    throw new PaperRunError('PAPER.md has no valid "Mode:" value in its Operating mode section.');
  }

  const updatedSection = section[0].replace(modePattern, `$1${mode}$3`);
  return paper.slice(0, section.index) + updatedSection + paper.slice(section.index + section[0].length);
}

function writeTextAtomic(path: string, content: string): void {
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}
