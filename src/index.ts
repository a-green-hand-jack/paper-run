/**
 * Public API for programmatic use.
 *
 * The CLI is the primary interface, but this export makes it possible
 * for other tools to drive paper-run as a library.
 */

export { version } from "./version.js";
export * from "./utils/errors.js";
export * from "./utils/constants.js";
export * from "./state/index.js";
export * from "./harness/index.js";
export * from "./opencode/index.js";
export * from "./adapter/index.js";
export * from "./pipeline/index.js";
export * from "./controller/index.js";
