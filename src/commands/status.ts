/**
 * `paper-run status` — print the current pipeline state.
 *
 * Full implementation: M1-12.
 */

import { log } from "../utils/index.js";

export interface StatusOptions {
  json?: boolean;
}

export async function statusCommand(_opts: StatusOptions): Promise<void> {
  log.warn("status command not yet implemented — see issue #15");
}
