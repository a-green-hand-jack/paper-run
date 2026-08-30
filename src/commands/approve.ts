/** `paper-run approve` - atomically release the current human gate. */

import { updateRunState } from "../state/store.js";
import { PaperRunError } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import { requireProjectRoot } from "../utils/paths.js";

export function approveCommand(): void {
  const projectDir = requireProjectRoot();
  const approved = approveGate(projectDir);

  log.success(`Approved gate at "${approved.current_stage}".`);
}

export function approveGate(projectDir: string) {
  return updateRunState(projectDir, (current) => {
    if (current.stage_status !== "gate_waiting") {
      throw new PaperRunError(
        `Cannot approve stage "${current.current_stage}": current status is "${current.stage_status}", not "gate_waiting".`,
      );
    }
    return { stage_status: "approved" };
  });
}
