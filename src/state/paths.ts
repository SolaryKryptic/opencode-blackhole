/**
 * Where the plugin keeps its state.
 *
 * The state lives next to OpenCode's own data, in the user's home directory,
 * not inside the project — a project's transcript is derived data (OpenCode
 * already stores the same messages in the session record), and it has no
 * business in a repository.
 *
 *     ~/.local/share/opencode/blackhole/<projectID>/
 *       transcripts/<sessionID>.jsonl
 *       memory/<sessionID>.jsonl
 *
 * The per-project folder is keyed by OpenCode's `projectID`, not by the
 * directory path: the id survives moving or renaming a project, the path does
 * not.
 */
import { createHash } from "node:crypto"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** The root of the plugin's state, next to OpenCode's own data. */
export const stateBase = (): string => join(homedir(), ".local", "share", "opencode", "blackhole")

/** The state folder of one project. */
export const projectStateDir = (base: string, projectID: string): string => join(base, projectID)

/** A stable short id for a directory, used when a project id is unavailable. */
export const directoryKey = (directory: string): string =>
  `dir-${createHash("sha1").update(directory).digest("hex").slice(0, 12)}`

/** The project folders that exist under the base. */
export const listProjectDirs = (base: string): string[] => {
  try {
    if (!existsSync(base)) return []
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(base, entry.name))
  } catch {
    return []
  }
}
