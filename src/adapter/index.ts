/** OpenCode adapter templates — installs `.opencode/` files into a writing repo. */
export {
  installAdapter,
  updateAdapter,
  isAdapterInstalled,
  ensureGitignore,
  findTemplatesDir,
  substitutePlaceholders,
  DEFAULT_MODEL,
} from "./install.js";
export type { InstallOptions, InstallResult } from "./install.js";
