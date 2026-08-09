import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Pool } from "pg";

const usernamePattern = /^[a-zA-Z0-9_]{3,24}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ready = pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    username text PRIMARY KEY,
    salt text NOT NULL,
    hash text NOT NULL,
    email text UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE users ADD COLUMN IF NOT EXISTS email text UNIQUE;
  CREATE TABLE IF NOT EXISTS sessions (
    token text PRIMARY KEY,
    username text NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS friend_requests (
    requester text NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    addressee text NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (requester, addressee)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id bigserial PRIMARY KEY,
    sender text NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    receiver text NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (sender, receiver, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_receiver_unread ON messages (receiver, created_at) WHERE NOT read;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS read boolean NOT NULL DEFAULT false;
`).catch((error) => {
  console.error("[AUTH] failed to initialize database schema:", error instanceof Error ? error.message : error);
  throw error;
});

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

export async function register(username: string, password: string, email: string): Promise<{ token: string }> {
  await ready;
  if (!usernamePattern.test(username)) {
    throw new Error("username must be 3-24 characters: letters, numbers, underscore");
  }
  if (password.length < 6) {
    throw new Error("password must be at least 6 characters");
  }
  if (!emailPattern.test(email)) {
    throw new Error("a valid email is required");
  }
  const existing = await pool.query("SELECT 1 FROM users WHERE username = $1", [username]);
  if ((existing.rowCount ?? 0) > 0) {
    throw new Error("username is already taken");
  }
  const existingEmail = await pool.query("SELECT 1 FROM users WHERE email = $1", [email]);
  if ((existingEmail.rowCount ?? 0) > 0) {
    throw new Error("email is already in use");
  }
  const salt = randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  await pool.query("INSERT INTO users (username, salt, hash, email) VALUES ($1, $2, $3, $4)", [username, salt, hash, email]);
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

export async function getProfile(username: string): Promise<{ username: string; email: string | null }> {
  await ready;
  const result = await pool.query<{ email: string | null }>("SELECT email FROM users WHERE username = $1", [username]);
  if (!result.rows[0]) throw new Error("user not found");
  return { username, email: result.rows[0].email };
}

export async function setEmail(username: string, email: string): Promise<void> {
  await ready;
  if (!emailPattern.test(email)) {
    throw new Error("a valid email is required");
  }
  const existingEmail = await pool.query("SELECT 1 FROM users WHERE email = $1 AND username <> $2", [email, username]);
  if ((existingEmail.rowCount ?? 0) > 0) {
    throw new Error("email is already in use");
  }
  await pool.query("UPDATE users SET email = $1 WHERE username = $2", [email, username]);
}

function assertKnownUser(username: string) {
  return pool.query("SELECT 1 FROM users WHERE username = $1", [username]).then((result) => {
    if ((result.rowCount ?? 0) === 0) throw new Error("user not found");
  });
}

export async function sendFriendRequest(from: string, to: string): Promise<void> {
  await ready;
  if (from === to) throw new Error("you can't friend yourself");
  await assertKnownUser(to);
  const reverse = await pool.query(
    "SELECT status FROM friend_requests WHERE requester = $1 AND addressee = $2",
    [to, from],
  );
  if (reverse.rows[0]?.status === "pending") {
    await pool.query(
      "UPDATE friend_requests SET status = 'accepted' WHERE requester = $1 AND addressee = $2",
      [to, from],
    );
    return;
  }
  if (reverse.rows[0]?.status === "accepted") return;
  await pool.query(
    `INSERT INTO friend_requests (requester, addressee, status) VALUES ($1, $2, 'pending')
     ON CONFLICT (requester, addressee) DO UPDATE SET status = 'pending'`,
    [from, to],
  );
}

export async function respondFriendRequest(username: string, from: string, accept: boolean): Promise<void> {
  await ready;
  if (accept) {
    const result = await pool.query(
      "UPDATE friend_requests SET status = 'accepted' WHERE requester = $1 AND addressee = $2 AND status = 'pending'",
      [from, username],
    );
    if (result.rowCount === 0) throw new Error("no pending request from that user");
  } else {
    await pool.query("DELETE FROM friend_requests WHERE requester = $1 AND addressee = $2", [from, username]);
  }
}

export async function removeFriend(username: string, other: string): Promise<void> {
  await ready;
  await pool.query(
    "DELETE FROM friend_requests WHERE (requester = $1 AND addressee = $2) OR (requester = $2 AND addressee = $1)",
    [username, other],
  );
}

export async function listFriends(username: string): Promise<{
  friends: string[];
  incoming: string[];
  outgoing: string[];
}> {
  await ready;
  const accepted = await pool.query<{ requester: string; addressee: string }>(
    "SELECT requester, addressee FROM friend_requests WHERE (requester = $1 OR addressee = $1) AND status = 'accepted'",
    [username],
  );
  const incoming = await pool.query<{ requester: string }>(
    "SELECT requester FROM friend_requests WHERE addressee = $1 AND status = 'pending'",
    [username],
  );
  const outgoing = await pool.query<{ addressee: string }>(
    "SELECT addressee FROM friend_requests WHERE requester = $1 AND status = 'pending'",
    [username],
  );
  return {
    friends: accepted.rows.map((row) => (row.requester === username ? row.addressee : row.requester)),
    incoming: incoming.rows.map((row) => row.requester),
    outgoing: outgoing.rows.map((row) => row.addressee),
  };
}

export async function areFriends(a: string, b: string): Promise<boolean> {
  await ready;
  const result = await pool.query(
    `SELECT 1 FROM friend_requests WHERE status = 'accepted'
     AND ((requester = $1 AND addressee = $2) OR (requester = $2 AND addressee = $1))`,
    [a, b],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function sendDM(from: string, to: string, body: string): Promise<{ id: number; created_at: string }> {
  await ready;
  const result = await pool.query<{ id: number; created_at: string }>(
    "INSERT INTO messages (sender, receiver, body) VALUES ($1, $2, $3) RETURNING id, created_at",
    [from, to, body],
  );
  return result.rows[0];
}

export async function getConversation(a: string, b: string, limit = 50, before?: number): Promise<Array<{ id: number; sender: string; receiver: string; body: string; created_at: string; read: boolean }>> {
  await ready;
  if (before) {
    const result = await pool.query(
      `SELECT id, sender, receiver, body, created_at, read FROM messages
       WHERE ((sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)) AND id < $3
       ORDER BY created_at DESC LIMIT $4`,
      [a, b, before, limit],
    );
    return result.rows.reverse();
  }
  const result = await pool.query(
    `SELECT id, sender, receiver, body, created_at, read FROM messages
     WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)
     ORDER BY created_at DESC LIMIT $3`,
    [a, b, limit],
  );
  return result.rows.reverse();
}

export async function markRead(from: string, to: string): Promise<void> {
  await ready;
  await pool.query(
    "UPDATE messages SET read = true WHERE sender = $1 AND receiver = $2 AND NOT read",
    [from, to],
  );
}

export async function getInbox(username: string): Promise<Array<{ peer: string; lastMessage: string; lastTime: string; unread: number }>> {
  await ready;
  const result = await pool.query(
    `SELECT DISTINCT ON (peer)
      peer, last_message, last_time, unread_count
    FROM (
      SELECT
        CASE WHEN sender = $1 THEN receiver ELSE sender END AS peer,
        body AS last_message,
        created_at AS last_time,
        SUM(CASE WHEN receiver = $1 AND NOT read THEN 1 ELSE 0 END) OVER (
          PARTITION BY CASE WHEN sender = $1 THEN receiver ELSE sender END
        ) AS unread_count
      FROM messages
      WHERE sender = $1 OR receiver = $1
      ORDER BY created_at DESC
    ) sub
    ORDER BY peer, last_time DESC`,
    [username],
  );
  return result.rows;
}

export async function getUnreadCount(username: string): Promise<number> {
  await ready;
  const result = await pool.query<{ cnt: string }>(
    "SELECT COUNT(*)::text AS cnt FROM messages WHERE receiver = $1 AND NOT read",
    [username],
  );
  return parseInt(result.rows[0]?.cnt ?? "0", 10);
}
