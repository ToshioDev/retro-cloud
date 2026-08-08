import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Pool } from "pg";

const usernamePattern = /^[a-zA-Z0-9_]{3,24}$/;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ready = pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    username text PRIMARY KEY,
    salt text NOT NULL,
    hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token text PRIMARY KEY,
    username text NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`).catch((error) => {
  console.error("[AUTH] failed to initialize database schema:", error instanceof Error ? error.message : error);
  throw error;
});

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

export async function register(username: string, password: string): Promise<{ token: string }> {
  await ready;
  if (!usernamePattern.test(username)) {
    throw new Error("username must be 3-24 characters: letters, numbers, underscore");
  }
  if (password.length < 6) {
    throw new Error("password must be at least 6 characters");
  }
  const existing = await pool.query("SELECT 1 FROM users WHERE username = $1", [username]);
  if ((existing.rowCount ?? 0) > 0) {
    throw new Error("username is already taken");
  }
  const salt = randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  await pool.query("INSERT INTO users (username, salt, hash) VALUES ($1, $2, $3)", [username, salt, hash]);
  return { token: await createSession(username) };
}

export async function login(username: string, password: string): Promise<{ token: string }> {
  await ready;
  const result = await pool.query<{ salt: string; hash: string }>(
    "SELECT salt, hash FROM users WHERE username = $1",
    [username],
  );
  const user = result.rows[0];
  if (!user) throw new Error("invalid username or password");
  const candidate = hashPassword(password, user.salt);
  const expected = Buffer.from(user.hash, "hex");
  const actual = Buffer.from(candidate, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("invalid username or password");
  }
  return { token: await createSession(username) };
}

async function createSession(username: string): Promise<string> {
  const token = randomBytes(24).toString("hex");
  await pool.query("INSERT INTO sessions (token, username) VALUES ($1, $2)", [token, username]);
  return token;
}

export async function usernameForToken(token: string | undefined): Promise<string | undefined> {
  if (!token) return undefined;
  await ready;
  const result = await pool.query<{ username: string }>("SELECT username FROM sessions WHERE token = $1", [token]);
  return result.rows[0]?.username;
}

export async function logout(token: string | undefined): Promise<void> {
  if (!token) return;
  await ready;
  await pool.query("DELETE FROM sessions WHERE token = $1", [token]);
}
