import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type StoredUser = { username: string; salt: string; hash: string; createdAt: string };

const dbPath = process.env.USERS_DB_PATH ?? "/data/users.json";
const usernamePattern = /^[a-zA-Z0-9_]{3,24}$/;

const users = new Map<string, StoredUser>();
const sessions = new Map<string, string>(); // token -> username

function load() {
  if (!existsSync(dbPath)) return;
  try {
    const raw = JSON.parse(readFileSync(dbPath, "utf8")) as StoredUser[];
    for (const user of raw) users.set(user.username, user);
  } catch (error) {
    console.error("[AUTH] failed to load user database:", error instanceof Error ? error.message : error);
  }
}

function persist() {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, JSON.stringify([...users.values()], null, 2));
}

load();

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

export function register(username: string, password: string): { token: string } {
  if (!usernamePattern.test(username)) {
    throw new Error("username must be 3-24 characters: letters, numbers, underscore");
  }
  if (password.length < 6) {
    throw new Error("password must be at least 6 characters");
  }
  if (users.has(username)) {
    throw new Error("username is already taken");
  }
  const salt = randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  users.set(username, { username, salt, hash, createdAt: new Date().toISOString() });
  persist();
  return { token: createSession(username) };
}

export function login(username: string, password: string): { token: string } {
  const user = users.get(username);
  if (!user) throw new Error("invalid username or password");
  const candidate = hashPassword(password, user.salt);
  const expected = Buffer.from(user.hash, "hex");
  const actual = Buffer.from(candidate, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("invalid username or password");
  }
  return { token: createSession(username) };
}

function createSession(username: string): string {
  const token = randomBytes(24).toString("hex");
  sessions.set(token, username);
  return token;
}

export function usernameForToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return sessions.get(token);
}

export function logout(token: string | undefined) {
  if (token) sessions.delete(token);
}
