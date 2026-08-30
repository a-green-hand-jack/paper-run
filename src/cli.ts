/**
 * paper-run CLI entry point.
 *
 * This file is the `bin` target. It parses arguments, dispatches to the
 * appropriate command handler, and translates thrown errors into exit codes.
 */

import { Command } from "commander";

import { PaperRunError, EXIT_CODES, log, setLogLevel } from "./utils/index.js";
import { version } from "./version.js";

import { initCommand } from "./commands/init.js";
import { startCommand, statusCommand, modeCommand } from "./commands/start.js";
import { checkpointCommand } from "./commands/checkpoint.js";
import { approveCommand } from "./commands/approve.js";

const program = new Command()
  .name("paper-run")
  .description("OpenCode-native paper writing harness for end-to-end manuscript production")
  .version(version, "-V, --version")
  .option("--debug", "enable verbose output")
  .hook("preAction", (thisCommand) => {
    if (thisCommand.opts().debug) setLogLevel("debug");
  });

// --- init ---
program
  .command("init [directory]")
  .description("Initialize a new paper writing repository from the harness template")
  .requiredOption("--brief <path>", "path to brief file or materials directory")
  .option("--mode <mode>", "initial operating mode (autonomous|collaborative)", "collaborative")
  .option("--template <version>", "harness template version", "v0.3.0")
  .option("--repo <owner/name>", "GitHub repository to create from the template")
  .option("--local", "fetch the template directly instead of creating a GitHub repository")
  .option("--public", "create the GitHub repository public (default: private)")
  .option("--model <model>", "model for the OpenCode adapter")
  .action(async (directory: string | undefined, opts) => {
    await initCommand(directory ?? ".", opts);
  });

// --- start (also the default when no subcommand given) ---
program
  .command("start", { isDefault: true })
  .description("Verify the run checkpoint, then launch or resume the paper pipeline")
  .option("--mode <mode>", "override operating mode for this run")
  .option("--stage <stage>", "start from a specific stage")
  .option("--port <port>", "OpenCode server port", parseInt)
  .option("--session <id>", "attach to an existing OpenCode session")
  .option("--headless", "run the pipeline without attaching a TUI")
  .option("--model <model>", "model for the TUI session")
  .action(async (opts) => {
    await startCommand(opts);
  });

// --- status ---
program
  .command("status")
  .description("Print current pipeline status")
  .option("--json", "output as JSON")
  .action(async (opts) => {
    await statusCommand(opts);
  });

// --- mode ---
program
  .command("mode [target]")
  .description("Show or switch the operating mode")
  .action(async (target: string | undefined) => {
    await modeCommand(target);
  });

// --- resume (convenience alias) ---
program
  .command("resume")
  .description("Verify Git state and resume from the latest Paper-Run checkpoint")
  .action(async () => {
    await startCommand({});
  });

// --- checkpoint ---
program
  .command("checkpoint")
  .description("Commit an explicit manual checkpoint from already staged changes")
  .action(checkpointCommand);

// --- approve ---
program
  .command("approve")
  .description("Approve the current gate if the pipeline is waiting for a human")
  .action(approveCommand);

// --- error boundary ---
async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof PaperRunError) {
      log.error(err.message);
      if (err.hint) log.hint(err.hint);
      process.exitCode = err.exitCode;
    } else if (err instanceof Error) {
      log.error(err.message);
      if (process.env.PAPER_RUN_DEBUG) {
        log.hint(err.stack ?? "");
      }
      process.exitCode = EXIT_CODES.ERROR;
    } else {
      log.error(String(err));
      process.exitCode = EXIT_CODES.ERROR;
    }
  }
}

main();
