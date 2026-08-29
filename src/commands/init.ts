/**
 * `paper-run init` — create a new paper writing repository from the harness template.
 *
 * Full implementation: M1-11. This file provides the interface and validation;
 * the heavy lifting (template stamping, adapter install) is filled in later.
 */

import { log } from "../utils/index.js";

export interface InitOptions {
  brief: string;
  mode: string;
  template: string;
}

export async function initCommand(directory: string, opts: InitOptions): Promise<void> {
  log.step(`Initializing paper writing repository at ${directory}`);
  log.info(`  Brief: ${opts.brief}`);
  log.info(`  Mode: ${opts.mode}`);
  log.info(`  Template: agent-writing-harness@${opts.template}`);
  log.blank();
  log.warn("init command not yet implemented — see issue #14");
}
