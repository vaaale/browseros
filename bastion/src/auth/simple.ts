import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import yaml from "js-yaml";
import chokidar from "chokidar";
import type { Config } from "../config";
import type { AuthProvider, UserRecord } from "./index";

const USERNAME_RE = /^[a-z0-9_-]+$/;

interface UserEntry {
  passwordHash: string;
  admin: boolean;
}

interface UsersFile {
  users: Record<string, UserEntry>;
}

export class SimpleProvider implements AuthProvider {
  private usersFile: string;
  private users: Record<string, UserEntry> = {};

  constructor(cfg: Config) {
    this.usersFile = path.join(cfg.dataDir, "users.yml");
    this.load();
    chokidar.watch(this.usersFile, { ignoreInitial: true }).on("change", () => this.load());
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.usersFile, "utf8");
      const parsed = yaml.load(raw) as UsersFile;
      if (parsed?.users) {
        this.users = {};
        for (const [name, entry] of Object.entries(parsed.users)) {
          if (!USERNAME_RE.test(name)) continue;
          this.users[name] = entry;
        }
      }
    } catch { /* file not yet created */ }
  }

  private save(): void {
    const data: UsersFile = { users: this.users };
    fs.mkdirSync(path.dirname(this.usersFile), { recursive: true });
    fs.writeFileSync(this.usersFile, yaml.dump(data));
  }

  async authenticate(username: string, password: string): Promise<UserRecord | null> {
    const entry = this.users[username];
    if (!entry) return null;
    const match = await bcrypt.compare(password, entry.passwordHash);
    if (!match) return null;
    return { username, isAdmin: entry.admin };
  }

  async getUser(username: string): Promise<UserRecord | null> {
    const entry = this.users[username];
    return entry ? { username, isAdmin: entry.admin } : null;
  }

  async listUsers(): Promise<UserRecord[]> {
    return Object.entries(this.users).map(([username, e]) => ({
      username,
      isAdmin: e.admin,
    }));
  }

  async createUser(username: string, password: string, isAdmin: boolean): Promise<void> {
    if (!USERNAME_RE.test(username)) throw new Error(`Invalid username: ${username}`);
    if (this.users[username]) throw new Error(`User already exists: ${username}`);
    const passwordHash = await bcrypt.hash(password, 12);
    this.users[username] = { passwordHash, admin: isAdmin };
    this.save();
  }

  async deleteUser(username: string): Promise<void> {
    if (!this.users[username]) throw new Error(`User not found: ${username}`);
    delete this.users[username];
    this.save();
  }

  async updatePassword(username: string, newPassword: string): Promise<void> {
    const entry = this.users[username];
    if (!entry) throw new Error(`User not found: ${username}`);
    entry.passwordHash = await bcrypt.hash(newPassword, 12);
    this.save();
  }

  async setAdmin(username: string, isAdmin: boolean): Promise<void> {
    const entry = this.users[username];
    if (!entry) throw new Error(`User not found: ${username}`);

    if (!isAdmin) {
      const adminCount = Object.values(this.users).filter((u) => u.admin).length;
      if (adminCount <= 1 && entry.admin) {
        throw new Error("Cannot remove the last admin user");
      }
    }
    entry.admin = isAdmin;
    this.save();
  }
}
