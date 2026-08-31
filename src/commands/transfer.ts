import { prepareImportedWorkspace, type ReviewOptions } from "./review.js";
import { log, printKeyValues } from "../utils/logger.js";

export type TransferOptions = Pick<ReviewOptions, "output" | "entry" | "mode" | "template" | "model">;

export async function transferCommand(source: string, opts: TransferOptions): Promise<void> {
  const result = await prepareImportedWorkspace(source, opts, "adoption");
  log.blank();
  log.success("External manuscript adopted into a paper-run workspace.");
  printKeyValues([
    ["Workspace", result.workspace],
    ["Entrypoint", `paper/${result.entrypoint}`],
    ["Imported files", String(result.files.length)],
    ["Plan", "existing-manuscript"],
  ]);
  log.blank();
  log.info("Next:");
  log.info(`  cd ${result.workspace}`);
  log.info("  paper-run start");
}
