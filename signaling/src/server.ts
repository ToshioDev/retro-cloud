import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { readdir, stat, rename, unlink, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join, basename, extname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import Docker from "dockerode";
import yauzl from "yauzl";
import * as auth from "./auth.js";

type SignalMessage = {
  type: "join" | "offer" | "answer" | "candidate" | "leave" | "chat" | "closed" | "transfer_host" | "owner_changed";
  room?: string;
  role?: string;
  username?: string;
  to?: string;
  from?: string;
  payload?: unknown;
};

type Peer = { id: string; room?: string; role?: string; playerNumber?: number; username?: string; socket: WebSocket; alive: boolean };
type RoomState = { usedNumbers: Set<number> };

const port = Number(process.env.PORT ?? 8080);
const peers = new Map<string, Peer>();
const rooms = new Map<string, RoomState>();

const gameServerImage = process.env.GAME_SERVER_IMAGE ?? "piepacker-clone-game-server";
const romsHostDir = process.env.ROMS_DIR ?? "";
const romsLocalDir = "/roms";
const biosHostDir = process.env.BIOS_DIR ?? "";
const biosLocalDir = "/system";
const signalingUrlForGameServer = process.env.GAME_SERVER_SIGNALING_URL ?? "ws://signaling:8080/signaling";
const publicIp = process.env.PUBLIC_IP ?? "";
const docker = romsHostDir ? new Docker() : null;
const managedRooms = new Map<string, { containerId: string }>();
const roomOwners = new Map<string, string>();
const roomVisibility = new Map<string, "public" | "private">();
const roomFiles = new Map<string, { game: string; file: string }>();
const extensionToGame: Record<string, string> = {
  ".nes": "nes",
  ".sfc": "snes",
  ".smc": "snes",
  ".bin": "ps1",
  ".iso": "ps1",
  ".img": "ps1",
  ".pbp": "ps1",
  ".chd": "ps1",
  ".zip": "zip",
};
const zipExtractableExts = new Set([".nes", ".sfc", ".smc", ".bin", ".iso", ".img", ".pbp", ".chd"]);
const maxRomUploadBytesByGame: Record<string, number> = { nes: 8 * 1024 * 1024, snes: 8 * 1024 * 1024, ps1: 2000 * 1024 * 1024, zip: 2000 * 1024 * 1024 };
const maxBiosUploadBytes = 4 * 1024 * 1024;
const ps1BiosFilename = "scph1001.bin";

function gameForExtension(filename: string): string | null {
  return extensionToGame[extname(filename).toLowerCase()] ?? null;
}

function extractZip(zipPath: string, destDir: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      const extractedFiles: string[] = [];
      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        const ext = extname(entry.fileName).toLowerCase();
        if (!zipExtractableExts.has(ext)) {
          zipfile.readEntry();
          return;
        }
        const outName = basename(entry.fileName);
        const outPath = join(destDir, outName);
        zipfile.openReadStream(entry, (err2, readStream) => {
          if (err2) return reject(err2);
          const out = createWriteStream(outPath);
          readStream.pipe(out);
          out.on("finish", () => {
            extractedFiles.push(outName);
            zipfile.readEntry();
          });
        });
      });
      zipfile.on("end", () => resolve(extractedFiles));
      zipfile.on("error", reject);
    });
  });
}

async function hasPs1Bios(): Promise<boolean> {
  try {
    const info = await stat(join(biosLocalDir, ps1BiosFilename));
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

const romOwnersFile = join(romsLocalDir, ".owners.json");
let romOwnersCache: Record<string, string> | null = null;

async function loadRomOwners(): Promise<Record<string, string>> {
  if (romOwnersCache) return romOwnersCache;
  try {
    romOwnersCache = JSON.parse(await readFile(romOwnersFile, "utf8"));
  } catch {
    romOwnersCache = {};
  }
  return romOwnersCache!;
}

async function setRomOwner(file: string, owner: string): Promise<void> {
  const owners = await loadRomOwners();
  owners[file] = owner;
  romOwnersCache = owners;
  await writeFile(romOwnersFile, JSON.stringify(owners, null, 2)).catch(() => {});
}

async function clearRomOwner(file: string): Promise<void> {
  const owners = await loadRomOwners();
  delete owners[file];
  romOwnersCache = owners;
  await writeFile(romOwnersFile, JSON.stringify(owners, null, 2)).catch(() => {});
}

async function listRoms(requester?: string): Promise<Array<{ file: string; game: string; size: number; owner: string | null }>> {
  let entries: string[];
  try {
    entries = await readdir(romsLocalDir);
  } catch {
    return [];
  }
  const owners = await loadRomOwners();
  const roms: Array<{ file: string; game: string; size: number; owner: string | null }> = [];
  for (const entry of entries) {
    const game = gameForExtension(entry);
    if (!game) continue;
    const owner = owners[entry] ?? null;
    if (owner && owner !== requester) continue;
    try {
      const info = await stat(join(romsLocalDir, entry));
      if (info.isFile()) roms.push({ file: entry, game, size: info.size, owner });
    } catch {
      // skip unreadable entries
    }
  }
  return roms;
}

function randomRoomId(): string {
  return randomBytes(4).toString("hex");
}

async function resolveGameServerImage(): Promise<string> {
  if (!docker) throw new Error("docker is not configured");
  const images = await docker.listImages({ filters: JSON.stringify({ reference: [gameServerImage] }) });
  const newest = images
    .filter((image) => image.RepoTags && image.RepoTags.length > 0)
    .sort((a, b) => b.Created - a.Created)[0];
  const tag = newest?.RepoTags?.find((repoTag) => !repoTag.endsWith(":latest")) ?? newest?.RepoTags?.[0];
  if (!tag) {
    throw new Error(`no built image found for ${gameServerImage}; deploy the game-server service first`);
  }
  return tag;
}

async function spawnGameServer(game: string, romPath: string, owner: string, visibility: "public" | "private", file: string): Promise<string> {
  if (!docker) throw new Error("room creation is disabled: ROMS_DIR is not configured on the signaling service");
  if (game === "ps1" && !(await hasPs1Bios())) {
    throw new Error("PS1 needs a BIOS file uploaded first (see the BIOS section in your profile)");
  }
  const room = randomRoomId();
  const image = await resolveGameServerImage();
  const binds = [`${romsHostDir}:/roms:ro`];
  if (biosHostDir) binds.push(`${biosHostDir}:/system:ro`);
  // This host is shared with several other unrelated apps. Without a cap, one room (PS1 3D titles
  // especially — CPU-bound emulation plus CPU-bound x264 encoding) can spin unbounded, and an orphaned
  // container (see reconcileOrphanedGameServers) left the whole VPS unresponsive for every user. PS1 gets
  // a bit more headroom than NES/SNES since 3D emulation is meaningfully heavier than 2D.
  const cpuCores = game === "ps1" ? 2 : 1;
  const container = await docker.createContainer({
    Image: image,
    Env: [
      `GAME=${game}`,
      `ROM_PATH=${romPath}`,
      "WEBRTC_DEBUG=1",
      `SIGNALING_URL=${signalingUrlForGameServer}`,
      `SIGNALING_ROOM=${room}`,
      `PUBLIC_IP=${publicIp}`,
    ],
    HostConfig: {
      Binds: binds,
      NetworkMode: "host",
      AutoRemove: true,
      NanoCpus: cpuCores * 1_000_000_000,
      Memory: 1024 * 1024 * 1024,
      MemorySwap: 1024 * 1024 * 1024,
    },
  });
  await container.start();
  managedRooms.set(room, { containerId: container.id });
  roomOwners.set(room, owner);
  roomVisibility.set(room, visibility);
  roomFiles.set(room, { game, file });
  console.log(`[SIGNALING] spawned game-server for room ${room} (${game}, ${romPath}, owner=${owner}, ${visibility})`);
  return room;
}

async function teardownRoom(room: string) {
  const managed = managedRooms.get(room);
  if (!managed || !docker) return;
  managedRooms.delete(room);
  roomOwners.delete(room);
  roomVisibility.delete(room);
  roomFiles.delete(room);
  rooms.delete(room);
  try {
    await docker.getContainer(managed.containerId).stop();
    console.log(`[SIGNALING] stopped game-server for empty room ${room}`);
  } catch (error) {
    console.error(`[SIGNALING] failed to stop game-server for room ${room}:`, error instanceof Error ? error.message : error);
  }
}

// Room ownership lives only in memory (managedRooms/roomOwners/etc.), so every redeploy/restart of this
// process forgets every game-server container it previously spawned — they keep running (and burning CPU
// on the shared host indefinitely) with nothing left to ever stop them via teardownRoom(). This orphaned
// several containers across repeated redeploys and starved the whole VPS (load average >20 on 8 cores),
// taking the rest of the app down for every user. Since this process's in-memory state is always empty
// right after boot, any game-server container already running at that point is by definition orphaned —
// clean them all up before accepting new rooms.
async function reconcileOrphanedGameServers() {
  if (!docker) return;
  try {
    const containers = await docker.listContainers({ all: false, filters: JSON.stringify({ ancestor: [gameServerImage] }) });
    for (const info of containers) {
      try {
        await docker.getContainer(info.Id).stop();
        console.log(`[SIGNALING] stopped orphaned game-server container ${info.Id.slice(0, 12)} from a previous instance`);
      } catch (error) {
        console.error(`[SIGNALING] failed to stop orphaned container ${info.Id.slice(0, 12)}:`, error instanceof Error ? error.message : error);
      }
    }
  } catch (error) {
    console.error("[SIGNALING] failed to list containers for orphan cleanup:", error instanceof Error ? error.message : error);
  }
}

function bearerToken(request: import("node:http").IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

function readJsonBody<T>(request: import("node:http").IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; if (raw.length > 4096) request.destroy(); });
    request.on("end", () => {
      try { resolve(JSON.parse(raw || "{}") as T); } catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
}
const httpServer = createServer((request, response) => {
  void handleRequest(request, response);
});

async function handleRequest(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === "POST" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "signaling" }));
    return;
  }
  if (request.method === "GET" && request.url === "/rooms") {
    const requester = await auth.usernameForToken(bearerToken(request));
    const peerCounts = new Map<string, number>();
    const hostedRooms = new Set<string>();
    for (const peer of peers.values()) {
      if (!peer.room) continue;
      if (peer.role === "host") { hostedRooms.add(peer.room); continue; }
      peerCounts.set(peer.room, (peerCounts.get(peer.room) ?? 0) + 1);
    }
    const candidateRooms = [...hostedRooms].filter((room) => roomOwners.has(room));
    const visibleRooms: string[] = [];
    for (const room of candidateRooms) {
      if (roomVisibility.get(room) === "public" || roomOwners.get(room) === requester) {
        visibleRooms.push(room);
        continue;
      }
      const owner = roomOwners.get(room);
      if (requester && owner && (await auth.areFriends(requester, owner))) visibleRooms.push(room);
    }
    const activeRooms = visibleRooms.map((room) => ({
      room,
      peerCount: peerCounts.get(room) ?? 0,
      owner: roomOwners.get(room) ?? null,
      visibility: roomVisibility.get(room) ?? "public",
      game: roomFiles.get(room)?.game ?? null,
      file: roomFiles.get(room)?.file ?? null,
    }));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ rooms: activeRooms }));
    return;
  }
  if (request.method === "GET" && request.url === "/roms") {
    const requester = await auth.usernameForToken(bearerToken(request));
    const roms = await listRoms(requester);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ roms }));
    return;
  }
  if (request.method === "DELETE" && request.url?.startsWith("/roms/")) {
    const username = await auth.usernameForToken(bearerToken(request));
    if (!username) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    const file = basename(decodeURIComponent(request.url.slice("/roms/".length).split("?")[0]));
    const owners = await loadRomOwners();
    if (owners[file] !== username) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "you can only delete ROMs you uploaded" }));
      return;
    }
    try {
      await unlink(join(romsLocalDir, file));
      await clearRomOwner(file);
      response.writeHead(204);
      response.end();
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "failed to delete ROM" }));
    }
    return;
  }
  if (request.method === "POST" && request.url === "/roms/share") {
    const username = await auth.usernameForToken(bearerToken(request));
    if (!username) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    const body = await readJsonBody<{ friend: string; romFile: string }>(request);
    if (!body.friend || !body.romFile) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "friend and romFile required" }));
      return;
    }
    const owners = await loadRomOwners();
    if (owners[body.romFile] !== username) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "you can only share ROMs you uploaded" }));
      return;
    }
    await auth.shareRom(username, body.friend, body.romFile);
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.method === "DELETE" && request.url === "/roms/share") {
    const username = await auth.usernameForToken(bearerToken(request));
    if (!username) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    const body = await readJsonBody<{ friend: string; romFile: string }>(request);
    if (!body.friend || !body.romFile) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "friend and romFile required" }));
      return;
    }
    await auth.unshareRom(username, body.friend, body.romFile);
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === "GET" && request.url === "/roms/shared") {
    const username = await auth.usernameForToken(bearerToken(request));
    if (!username) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    const shared = await auth.getSharedRoms(username);
    const roms = await listRoms(username);
    const romMap = new Map(roms.map((r) => [r.file, r]));
    const enriched = shared.map((s) => ({
      ...s,
      rom: romMap.get(s.rom_file) ?? null,
    }));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ shared: enriched }));
    return;
  }
  if (request.method === "POST" && (request.url === "/roms" || request.url?.startsWith("/roms?"))) {
    const username = await auth.usernameForToken(bearerToken(request));
    if (!username) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    const requestedName = basename(new URL(request.url ?? "/roms", "http://internal").searchParams.get("filename") ?? "");
    const game = gameForExtension(requestedName);
    if (!requestedName || !game) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "filename must end in .nes, .sfc, .smc, .bin, .iso, .img, .pbp, .chd, or .zip" }));
      return;
    }
    const maxRomUploadBytes = maxRomUploadBytesByGame[game] ?? 8 * 1024 * 1024;
    const finalPath = join(romsLocalDir, requestedName);
    const tmpPath = `${finalPath}.uploading-${randomUUID()}`;
    let receivedBytes = 0;
    let aborted = false;
    const out = createWriteStream(tmpPath);
    request.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > maxRomUploadBytes) {
        aborted = true;
        request.destroy();
        out.destroy();
        void unlink(tmpPath).catch(() => {});
      }
    });
    request.pipe(out);
    out.on("finish", () => {
      if (aborted) return;
      rename(tmpPath, finalPath)
        .then(async () => {
          if (extname(requestedName).toLowerCase() === ".zip") {
            try {
              const extracted = await extractZip(finalPath, romsLocalDir);
              await unlink(finalPath);
              if (extracted.length === 0) {
                response.writeHead(400, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: "ZIP contains no supported ROM files (.nes, .sfc, .bin, .iso, .chd, etc.)" }));
                return;
              }
              const results = [];
              for (const name of extracted) {
                const g = gameForExtension(name);
                if (g && g !== "zip") {
                  await setRomOwner(name, username);
                  const info = await stat(join(romsLocalDir, name));
                  results.push({ file: name, game: g, size: info.size, owner: username });
                }
              }
              console.log(`[SIGNALING] ${username} uploaded ZIP ${requestedName}, extracted ${extracted.length} ROM(s)`);
              response.writeHead(201, { "content-type": "application/json" });
              response.end(JSON.stringify(results.length === 1 ? results[0] : { files: results }));
            } catch (zipErr) {
              void unlink(finalPath).catch(() => {});
              response.writeHead(400, { "content-type": "application/json" });
              response.end(JSON.stringify({ error: `failed to extract ZIP: ${zipErr instanceof Error ? zipErr.message : "unknown error"}` }));
            }
            return;
          }
          await setRomOwner(requestedName, username);
          console.log(`[SIGNALING] ${username} uploaded ROM ${requestedName} (${receivedBytes} bytes)`);
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ file: requestedName, game, size: receivedBytes, owner: username }));
        })
        .catch((error) => {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : "failed to save ROM" }));
        });
    });
    request.on("error", () => {
      void unlink(tmpPath).catch(() => {});
      if (!response.headersSent) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "upload failed" }));
      }
    });
    return;
  }
  if (request.method === "GET" && request.url === "/bios") {
    const username = await auth.usernameForToken(bearerToken(request));
    if (!username) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ps1: await hasPs1Bios() }));
    return;
  }
  if (request.method === "POST" && request.url === "/bios/ps1") {
    const username = await auth.usernameForToken(bearerToken(request));
    if (!username) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    if (!biosHostDir) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "BIOS_DIR is not configured on the signaling service" }));
      return;
    }
    const finalPath = join(biosLocalDir, ps1BiosFilename);
    const tmpPath = `${finalPath}.uploading-${randomUUID()}`;
    let receivedBytes = 0;
    let aborted = false;
    const out = createWriteStream(tmpPath);
    request.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBiosUploadBytes) {
        aborted = true;
        request.destroy();
        out.destroy();
        void unlink(tmpPath).catch(() => {});
      }
    });
    request.pipe(out);
    out.on("finish", () => {
      if (aborted) return;
      rename(tmpPath, finalPath)
        .then(() => {
          console.log(`[SIGNALING] ${username} uploaded PS1 BIOS (${receivedBytes} bytes)`);
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ ps1: true, size: receivedBytes }));
        })
        .catch((error) => {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : "failed to save BIOS" }));
        });
    });
    request.on("error", () => {
      void unlink(tmpPath).catch(() => {});
      if (!response.headersSent) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "upload failed" }));
      }
    });
    return;
  }
  if (request.method === "POST" && request.url === "/auth/register") {
    readJsonBody<{ username?: string; password?: string; email?: string }>(request)
      .then(async (body) => {
        const { token } = await auth.register(String(body.username ?? ""), String(body.password ?? ""), String(body.email ?? ""));
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ token, username: body.username }));
      })
      .catch((error) => {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "registration failed" }));
      });
    return;
  }
  if (request.method === "POST" && request.url === "/auth/login") {
    readJsonBody<{ username?: string; password?: string }>(request)
      .then(async (body) => {
        const { token } = await auth.login(String(body.username ?? ""), String(body.password ?? ""));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ token, username: body.username }));
      })
      .catch((error) => {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "login failed" }));
      });
    return;
  }
  if (request.method === "POST" && request.url === "/auth/logout") {
    await auth.logout(bearerToken(request));
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === "GET" && request.url === "/auth/me") {
    const username = await auth.usernameForToken(bearerToken(request));
    if (!username) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    const profile = await auth.getProfile(username);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(profile));
    return;
  }
  if (request.method === "POST" && request.url === "/auth/email") {
    const username = await auth.usernameForToken(bearerToken(request));
    if (!username) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    readJsonBody<{ email?: string }>(request)
      .then(async (body) => {
        await auth.setEmail(username, String(body.email ?? ""));
        response.writeHead(204);
        response.end();
      })
      .catch((error) => {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "failed to set email" }));
      });
    return;
  }
  if (request.method === "GET" && request.url === "/friends") {
    const username = await auth.usernameForToken(bearerToken(request));
    if (!username) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    const list = await auth.listFriends(username);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(list));
    return;
  }
  if (request.method === "POST" && request.url === "/friends/request") {
    const username = await auth.usernameForToken(bearerToken(request));
    if (!username) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    readJsonBody<{ username?: string }>(request)
      .then(async (body) => {
        await auth.sendFriendRequest(username, String(body.username ?? ""));
        response.writeHead(204);
        response.end();
      })
      .catch((error) => {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "failed to send friend request" }));
      });
    return;
  }
  if (request.method === "POST" && request.url === "/friends/respond") {
    const username = await auth.usernameForToken(bearerToken(request));
    if (!username) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    readJsonBody<{ username?: string; accept?: boolean }>(request)
      .then(async (body) => {
        await auth.respondFriendRequest(username, String(body.username ?? ""), !!body.accept);
        response.writeHead(204);
        response.end();
      })
      .catch((error) => {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "failed to respond to friend request" }));
      });
    return;
  }
  if (request.method === "DELETE" && request.url?.startsWith("/friends/")) {
    const username = await auth.usernameForToken(bearerToken(request));
    if (!username) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    const other = decodeURIComponent(request.url.slice("/friends/".length).split("?")[0]);
    await auth.removeFriend(username, other);
    response.writeHead(204);
    response.end();
    return;
  }

  // ── DM / Inbox endpoints ──────────────────────────────────────
  if (request.method === "GET" && request.url === "/inbox") {
    const username = await auth.usernameForToken(bearerToken(request));
    if (!username) { response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "authentication required" })); return; }
    try {
      const inbox = await auth.getInbox(username);
      const unread = await auth.getUnreadCount(username);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ inbox, unread }));
    } catch (error) {
      console.error("[SIGNALING] failed to load inbox:", error instanceof Error ? error.message : error);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ inbox: [], unread: 0 }));
    }
    return;
  }
  if (request.method === "GET" && request.url?.startsWith("/dm/")) {
    const username = await auth.usernameForToken(bearerToken(request));
    if (!username) { response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "authentication required" })); return; }
    try {
      const peer = decodeURIComponent(request.url.slice("/dm/".length).split("?")[0]);
      const url = new URL(request.url, "http://localhost");
      const before = url.searchParams.get("before") ? parseInt(url.searchParams.get("before")!, 10) : undefined;
      const messages = await auth.getConversation(username, peer, 50, before);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ messages }));
    } catch (error) {
      console.error("[SIGNALING] failed to load DMs:", error instanceof Error ? error.message : error);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ messages: [] }));
    }
    return;
  }
  if (request.method === "POST" && request.url?.startsWith("/dm/") && request.url?.endsWith("/read")) {
    const username = await auth.usernameForToken(bearerToken(request));
    if (!username) { response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "authentication required" })); return; }
    try {
      const peer = decodeURIComponent(request.url.slice("/dm/".length).replace("/read", ""));
      await auth.markRead(peer, username);
      response.writeHead(204);
      response.end();
    } catch (error) {
      console.error("[SIGNALING] failed to mark read:", error instanceof Error ? error.message : error);
      response.writeHead(204);
      response.end();
    }
    return;
  }
  if (request.method === "POST" && request.url?.startsWith("/dm/")) {
    const username = await auth.usernameForToken(bearerToken(request));
    if (!username) { response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "authentication required" })); return; }
    try {
      const peer = decodeURIComponent(request.url.slice("/dm/".length));
      const body = await readJsonBody<{ text?: string }>(request);
      if (!body.text?.trim()) { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "message body required" })); return; }
      const msg = await auth.sendDM(username, peer, body.text.trim().slice(0, 2000));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(msg));
    } catch (error) {
      console.error("[SIGNALING] failed to send DM:", error instanceof Error ? error.message : error);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "failed to send message" }));
    }
    return;
  }

  if (request.method === "POST" && request.url === "/rooms") {
    const username = await auth.usernameForToken(bearerToken(request));
    if (!username) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    readJsonBody<{ file?: string; visibility?: string }>(request)
      .then(async (body) => {
        const roms = await listRoms(username);
        const rom = roms.find((entry) => entry.file === body.file) ?? roms[0];
        if (!rom) throw new Error("no ROMs available: upload one first");
        const visibility = body.visibility === "private" ? "private" : "public";
        const romPath = `/roms/${rom.file}`;
        const room = await spawnGameServer(rom.game, romPath, username, visibility, rom.file);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ room, game: rom.game, romPath, owner: username, visibility }));
      })
      .catch((error) => {
        console.error("[SIGNALING] failed to create room:", error instanceof Error ? error.message : error);
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "failed to create room" }));
      });
    return;
  }
  if (request.method === "DELETE" && request.url?.startsWith("/rooms/")) {
    const username = await auth.usernameForToken(bearerToken(request));
    if (!username) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "authentication required" }));
      return;
    }
    const room = decodeURIComponent(request.url.slice("/rooms/".length).split("?")[0]);
    const owner = roomOwners.get(room);
    if (!owner) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "room not found" }));
      return;
    }
    if (owner !== username) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "only the room owner can close this room" }));
      return;
    }
    broadcastAll(room, { type: "closed", room, payload: { reason: "owner closed the room" } });
    await teardownRoom(room);
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(404);
  response.end();
}

const webSockets = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (request, socket, head) => {
  if (request.url !== "/signaling") {
    socket.destroy();
    return;
  }
  webSockets.handleUpgrade(request, socket, head, (client) => webSockets.emit("connection", client, request));
});

function send(peer: Peer, message: SignalMessage) {
  if (peer.socket.readyState === WebSocket.OPEN) peer.socket.send(JSON.stringify(message));
}

function broadcast(room: string, sender: string, message: SignalMessage) {
  for (const peer of peers.values()) {
    if (peer.room === room && peer.id !== sender) send(peer, message);
  }
}

function broadcastAll(room: string, message: SignalMessage) {
  for (const peer of peers.values()) {
    if (peer.room === room) send(peer, message);
  }
}

function allocatePlayerNumber(room: string, state: RoomState, username: string | undefined): number {
  const owner = roomOwners.get(room);
  if (owner && username === owner && !state.usedNumbers.has(1)) {
    state.usedNumbers.add(1);
    return 1;
  }
  let n = owner ? 2 : 1; // reserve slot 1 for the room owner whenever the room has a known owner
  while (state.usedNumbers.has(n)) n++;
  state.usedNumbers.add(n);
  return n;
}

webSockets.on("connection", (socket) => {
  const peer: Peer = { id: randomUUID(), socket, alive: true };
  peers.set(peer.id, peer);
  console.log(`[SIGNALING] connected ${peer.id}`);
  socket.on("pong", () => { peer.alive = true; });

  socket.on("message", (raw) => {
    let message: SignalMessage;
    try {
      message = JSON.parse(raw.toString()) as SignalMessage;
    } catch {
      send(peer, { type: "leave", payload: { reason: "invalid_json" } });
      return;
    }
    if (!["join", "offer", "answer", "candidate", "leave", "chat", "transfer_host"].includes(message.type)) return;
    if (message.type === "join") {
      if (peer.room) return; // ignore duplicate join on an already-registered connection
      const room = typeof message.room === "string" && message.room.length <= 128 ? message.room : "default";
      peer.room = room;
      peer.role = message.role === "host" ? "host" : "player";
      peer.username = typeof message.username === "string" ? message.username.slice(0, 32) : undefined;
      if (!rooms.has(room)) rooms.set(room, { usedNumbers: new Set() });
      const state = rooms.get(room)!;
      if (peer.role === "player") {
        peer.playerNumber = allocatePlayerNumber(room, state, peer.username);
      }
      const joinPayload = { peerId: peer.id, playerNumber: peer.playerNumber, role: peer.role, username: peer.username };
      send(peer, { type: "join", room, payload: joinPayload });
      broadcast(room, peer.id, { type: "join", room, payload: joinPayload });
      // Catch the new peer up on everyone already in the room (and vice versa for a freshly booted host).
      for (const other of peers.values()) {
        if (other.id !== peer.id && other.room === room && other.role === "player") {
          send(peer, { type: "join", room, payload: { peerId: other.id, playerNumber: other.playerNumber, role: "player", username: other.username } });
        }
      }
      console.log(`[SIGNALING] ${peer.id} joined ${room} as ${peer.role}${peer.playerNumber ? ` P${peer.playerNumber}` : ""}`);
      return;
    }
    if (!peer.room) return;
    if (message.type === "leave") {
      broadcast(peer.room, peer.id, { type: "leave", room: peer.room, payload: { peerId: peer.id } });
      peer.room = undefined;
      return;
    }
    if (message.type === "chat") {
      const body = message.payload as { text?: string } | undefined;
      const text = typeof body?.text === "string" ? body.text.slice(0, 500).trim() : "";
      if (!text) return;
      broadcastAll(peer.room, {
        type: "chat", room: peer.room,
        payload: { username: peer.username ?? "anon", playerNumber: peer.playerNumber, text, timestamp: Date.now() },
      });
      return;
    }
    if (message.type === "transfer_host") {
      const currentOwner = roomOwners.get(peer.room);
      if (!currentOwner || peer.username !== currentOwner) return;
      const body = message.payload as { targetPeerId?: string } | undefined;
      const target = typeof body?.targetPeerId === "string" ? peers.get(body.targetPeerId) : undefined;
      if (!target || target.room !== peer.room || target.role !== "player" || !target.username) return;
      roomOwners.set(peer.room, target.username);
      console.log(`[SIGNALING] ${peer.room} host transferred: ${currentOwner} -> ${target.username}`);
      broadcastAll(peer.room, { type: "owner_changed", room: peer.room, payload: { owner: target.username } });
      return;
    }
    // offer/answer/candidate are point-to-point: deliver only to the addressed peer.
    if (message.type === "offer" || message.type === "answer" || message.type === "candidate") {
      const target = typeof message.to === "string" ? peers.get(message.to) : undefined;
      if (!target || target.room !== peer.room) return;
      send(target, { type: message.type, room: peer.room, from: peer.id, payload: message.payload });
    }
  });

  socket.on("close", () => {
    const room = peer.room;
    if (room) broadcast(room, peer.id, { type: "leave", room, payload: { peerId: peer.id } });
    peers.delete(peer.id);
    console.log(`[SIGNALING] disconnected ${peer.id}`);
    if (room && peer.playerNumber !== undefined) rooms.get(room)?.usedNumbers.delete(peer.playerNumber);
    if (room && peer.role === "player" && managedRooms.has(room)) {
      const remainingPlayers = [...peers.values()].some((other) => other.room === room && other.role === "player");
      if (!remainingPlayers) void teardownRoom(room);
    }
  });
});

setInterval(() => {
  for (const peer of peers.values()) {
    if (!peer.alive) {
      peer.socket.terminate();
      continue;
    }
    peer.alive = false;
    peer.socket.ping();
  }
}, 30_000);

void reconcileOrphanedGameServers().then(() => {
  httpServer.listen(port, () => console.log(`[SIGNALING] listening on :${port}`));
});
