import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "fs"
import { join } from "path"
import { dataDir } from "@/os/data-dir"
import { gitLogger } from "./logging"

export interface GitRemoteConfig {
  name: string
  url: string
  provider: "github" | "gitlab" | "generic"
  autoPush: boolean
  defaultBranch?: string
  remoteBranch?: string
  lastFetched?: string
  lastPushed?: string
  oauthTokenExpiresAt?: number
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
  const uniqueName = getUniqueRemoteName(config.name)
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

export function updateRemoteConfig(name: string, patch: Partial<GitRemoteConfig>): GitRemoteConfig | null {
  const configs = readRemoteConfigs()
  const index = configs.findIndex((c) => c.name === name)
  if (index === -1) return null
  configs[index] = { ...configs[index], ...patch, updatedAt: new Date().toISOString() }
  writeRemoteConfigs(configs)
  return configs[index]
}

export function removeRemoteConfig(name: string): boolean {
  const configs = readRemoteConfigs()
  const index = configs.findIndex((c) => c.name === name)
  if (index === -1) return false
  configs.splice(index, 1)
  writeRemoteConfigs(configs)
  gitLogger().info({ op: "remove_remote", remote: name })
  return true
}

export function getUniqueRemoteName(name: string): string {
  const configs = readRemoteConfigs()
  if (!configs.find((c) => c.name === name)) return name
  let counter = 2
  while (configs.find((c) => c.name === `${name}-${counter}`)) {
    counter++
  }
  return `${name}-${counter}`
}
