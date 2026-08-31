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
import { validateCommand, publicationStatusCommand } from "./commands/diagnostics.js";
import { reviewCommand } from "./commands/review.js";
import { transferCommand } from "./commands/transfer.js";

const program = new Command()
  .name("paper-run")
  .description("OpenCode-native manuscript production and independent review system")
  .version(version, "-V, --version")
  .option("--debug", "enable verbose output")
  .hook("preAction", (thisCommand) => {
    if (thisCommand.opts().debug) setLogLevel("debug");
  });

// --- init ---
program
  .command("init [directory]")
  .description("Initialize a new manuscript production repository from the harness template")
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
  .option("--profile <profile>", "execution plan profile (full|existing-manuscript|review-and-revise|review-report|build-only)")
  .option("--stages <stages>", "comma-separated stages for a custom execution plan")
  .option("--port <port>", "OpenCode server port", parseInt)
  .option("--session <id>", "attach to an existing OpenCode session")
  .option("--headless", "run the pipeline without attaching a TUI")
  .option("--model <model>", "model for the TUI session")
  .option("--variant <variant>", "reasoning variant for stage prompts")
  .option(
    "--stage-timeout-multiplier <number>",
    "multiply every pipeline stage timeout (or set PAPER_RUN_STAGE_TIMEOUT_MULTIPLIER)",
  )
  .action(async (opts) => {
    await startCommand(opts);
  });

program
  .command("review <source>")
  .description("Review an external TeX repository in an isolated workspace without revising it")
  .option("--output <directory>", "review workspace (default: <source>-review)")
  .option("--entry <path>", "main TeX file relative to the source directory")
  .option("--mode <mode>", "operating mode (autonomous|collaborative)", "collaborative")
  .option("--template <version>", "harness template version", "v0.3.0")
  .option("--prepare-only", "prepare the workspace without launching OpenCode")
  .option("--headless", "run the review without attaching a TUI")
  .option("--port <port>", "OpenCode server port", parseInt)
  .option("--model <model>", "model for the OpenCode adapter and review session")
  .option("--variant <variant>", "reasoning variant for review prompts")
  .option("--stage-timeout-multiplier <number>", "multiply review stage timeouts")
  .action(async (source: string, opts) => {
    await reviewCommand(source, opts);
  });

program
  .command("transfer <source>")
  .alias("adopt")
  .description("Adopt an external TeX repository into a new paper-run workspace")
  .option("--output <directory>", "adopted workspace (default: <source>-adopted)")
  .option("--entry <path>", "main TeX file relative to the source directory")
  .option("--mode <mode>", "operating mode (autonomous|collaborative)", "collaborative")
  .option("--template <version>", "harness template version", "v0.3.0")
  .option("--model <model>", "model for the OpenCode adapter")
  .action(async (source: string, opts) => {
    await transferCommand(source, opts);
  });

// --- status ---
program
  .command("status")
  .description("Print current pipeline status")
  .option("--json", "output as JSON")
  .action(async (opts) => {
    await statusCommand(opts);
  });

program
  .command("validate")
  .description("Validate the writing repository and run plan without starting OpenCode")
  .option("--json", "output as JSON")
  .action(async (opts) => {
    await validateCommand(opts);
  });

program
  .command("publication")
  .description("Inspect publication variant build state")
  .command("status")
  .option("--json", "output as JSON")
  .action(async (opts) => {
    await publicationStatusCommand(opts);
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
  .option(
    "--authorize-locked-change <base:digest>",
    "authorize this exact staged locked-contract candidate against its HEAD base",
  )
  .action(async (opts) => {
    await checkpointCommand(opts);
  });

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
