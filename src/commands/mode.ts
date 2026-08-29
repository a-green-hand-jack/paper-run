/**
 * `paper-run mode` — show or switch operating mode.
 *
 * Full implementation: M1-12.
 */

import { MODES, log } from "../utils/index.js";
import type { Mode } from "../utils/index.js";

export async function modeCommand(target?: string): Promise<void> {
  if (!target) {
    log.warn("mode query not yet implemented — see issue #15");
    return;
  }

  if (!MODES.includes(target as Mode)) {
    log.error(`Invalid mode "${target}". Must be one of: ${MODES.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  log.warn(`mode switch to "${target}" not yet implemented — see issue #15`);
}
