import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "fs"
import { join } from "path"
import { dataDir } from "@/os/data-dir"
import { gitLogger } from "./logging"
import { SOURCE_FS_ID } from "./filesystems"

export interface GitRemoteConfig {
  name: string
  url: string
  provider: "github" | "gitlab" | "generic"
  /** How git authenticates to this remote. Derived from the provider at add
   *  time (github/gitlab → oauth, generic → token) and used to resolve the
   *  right credential for test/fetch/push. Absent on legacy remotes. */
  authType?: "oauth" | "token" | "ssh"
  autoPush: boolean
  defaultBranch?: string
  remoteBranch?: string
  lastFetched?: string
  lastPushed?: string
  oauthTokenExpiresAt?: number
  /** Id of the GitFS instance this remote belongs to (see filesystems.ts).
   *  Absent on legacy remotes, which belong to the BrowserOS source repo. */
  filesystem?: string
  /** Last observed connection state, updated by test/fetch/push. */
  lastStatus?: "connected" | "error" | "disconnected"
  lastError?: string
  createdAt: string
  updatedAt: string
}

const CONFIG_PATH = join(dataDir(), "config", "git-remotes.json")

export function readRemoteConfigs(): GitRemoteConfig[] {
  if (!existsSync(CONFIG_PATH)) return []
  const content = readFileSync(CONFIG_PATH, "utf-8")
  return JSON.parse(content)
}

function writeRemoteConfigs(configs: GitRemoteConfig[]): void {
  const dir = join(dataDir(), "config")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tempPath = `${CONFIG_PATH}.tmp`
  writeFileSync(tempPath, JSON.stringify(configs, null, 2))
  renameSync(tempPath, CONFIG_PATH)
  gitLogger().info({ op: "write_remote_config" })
}

export function addRemoteConfig(config: Omit<GitRemoteConfig, "createdAt" | "updatedAt">): GitRemoteConfig {
  const configs = readRemoteConfigs()
  const uniqueName = getUniqueRemoteName(config.name, config.filesystem)
  const now = new Date().toISOString()
  const newConfig: GitRemoteConfig = {
    ...config,
    name: uniqueName,
    createdAt: now,
    updatedAt: now,
  }
  configs.push(newConfig)
  writeRemoteConfigs(configs)
  gitLogger().info({ op: "add_remote", remote: newConfig.url })
  return newConfig
}

// Remote names are only unique WITHIN a filesystem (see getUniqueRemoteName), so
// two filesystems may each have an "origin". Callers that operate on a specific
// GitFS instance MUST pass its `filesystem` id, otherwise the first same-named
// config wins and the wrong remote gets mutated. Legacy configs with no tag
// belong to the BrowserOS source repo. When `filesystem` is omitted the match is
// by name only (legacy behaviour for source-repo callers).
function matchesRemote(c: GitRemoteConfig, name: string, filesystem?: string): boolean {
  if (c.name !== name) return false
  if (filesystem === undefined) return true
  return (c.filesystem ?? SOURCE_FS_ID) === filesystem
}

export function updateRemoteConfig(name: string, patch: Partial<GitRemoteConfig>, filesystem?: string): GitRemoteConfig | null {
  const configs = readRemoteConfigs()
  const index = configs.findIndex((c) => matchesRemote(c, name, filesystem))
  if (index === -1) {
    gitLogger().warn({ op: "update_remote_config", remote: name, success: false, error: { code: "REMOTE_NOT_FOUND", message: `no remote config named "${name}"${filesystem ? ` in filesystem ${filesystem}` : ""}` } })
    return null
  }
  configs[index] = { ...configs[index], ...patch, updatedAt: new Date().toISOString() }
  writeRemoteConfigs(configs)
  gitLogger().info({ op: "update_remote_config", remote: name, success: true })
  return configs[index]
}

export function removeRemoteConfig(name: string, filesystem?: string): boolean {
  const configs = readRemoteConfigs()
  const index = configs.findIndex((c) => matchesRemote(c, name, filesystem))
  if (index === -1) return false
  configs.splice(index, 1)
  writeRemoteConfigs(configs)
  gitLogger().info({ op: "remove_remote", remote: name })
  return true
}

// Remote names must be unique WITHIN a filesystem (git enforces this per repo).
// When a filesystem is given, only that filesystem's remotes are considered, so
// two filesystems may each have an "origin". When omitted, uniqueness is global
// (legacy behaviour, used by callers that operate on the source repo).
export function getUniqueRemoteName(name: string, filesystem?: string): string {
  const all = readRemoteConfigs()
  const configs = filesystem === undefined ? all : all.filter((c) => (c.filesystem ?? undefined) === filesystem)
  if (!configs.find((c) => c.name === name)) return name
  let counter = 2
  while (configs.find((c) => c.name === `${name}-${counter}`)) {
    counter++
  }
  return `${name}-${counter}`
}
