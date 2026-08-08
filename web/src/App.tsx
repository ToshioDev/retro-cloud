import { useEffect, useRef, useState } from "react";

type SignalMessage = { type: string; room?: string; from?: string; payload?: any };
type Button = "UP" | "DOWN" | "LEFT" | "RIGHT" | "A" | "B" | "START" | "SELECT";
type RosterEntry = { peerId: string; playerNumber: number; username: string };
type ChatMessage = { username: string; playerNumber?: number; text: string; timestamp: number };
type RomEntry = { file: string; game: "nes" | "snes"; size: number };

const signalingUrl = import.meta.env.VITE_SIGNALING_URL ?? "ws://localhost:8080/signaling";
const apiBase = signalingUrl.replace(/^ws/, "http").replace(/\/signaling\/?$/, "");
const roomsUrl = `${apiBase}/rooms`;
const romsUrl = `${apiBase}/roms`;
const defaultRoom = import.meta.env.VITE_ROOM ?? "";
type ActiveRoom = { room: string; peerCount: number; owner: string | null };
const buttons: Button[] = ["UP", "DOWN", "LEFT", "RIGHT", "A", "B", "START", "SELECT"];
const defaultKeyBindings: Record<Button, string> = {
  UP: "ArrowUp", DOWN: "ArrowDown", LEFT: "ArrowLeft", RIGHT: "ArrowRight",
  A: "z", B: "x", START: "Enter", SELECT: "Shift",
};

function loadKeyBindings(): Record<Button, string> {
  try {
    const stored = JSON.parse(localStorage.getItem("rc_keybindings") ?? "{}");
    return { ...defaultKeyBindings, ...stored };
  } catch {
    return { ...defaultKeyBindings };
  }
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const inputRef = useRef<RTCDataChannel | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem("rc_token"));
  const [authUsername, setAuthUsername] = useState<string | null>(() => localStorage.getItem("rc_username"));
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authForm, setAuthForm] = useState({ username: "", password: "" });
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [status, setStatus] = useState("Disconnected");
  const [mediaState, setMediaState] = useState("Waiting for game server");
  const [inputState, setInputState] = useState("Not connected");
  const [room, setRoom] = useState(defaultRoom || "local");
  const [roomTouched, setRoomTouched] = useState(Boolean(defaultRoom));
  const [activeRooms, setActiveRooms] = useState<ActiveRoom[]>([]);
  const [roms, setRoms] = useState<RomEntry[]>([]);
  const [selectedRom, setSelectedRom] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [playerNumber, setPlayerNumber] = useState<number | null>(null);
  const [keyBindings, setKeyBindings] = useState<Record<Button, string>>(loadKeyBindings);
  const [rebinding, setRebinding] = useState<Button | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"display" | "audio" | "controls">("display");
  const [scale, setScale] = useState<string>(() => localStorage.getItem("rc_scale") ?? "fit");
  const [volume, setVolume] = useState<number>(() => Number(localStorage.getItem("rc_volume") ?? "100"));
  const [muted, setMuted] = useState<boolean>(() => localStorage.getItem("rc_muted") === "1");
  const [intrinsicSize, setIntrinsicSize] = useState<{ w: number; h: number } | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const myPeerIdRef = useRef<string | null>(null);
  const hostPeerIdRef = useRef<string | null>(null);
  const playerNumberRef = useRef<number>(1);

  useEffect(() => () => {
    inputRef.current?.close();
    peerRef.current?.close();
    socketRef.current?.close();
  }, []);

  useEffect(() => {
    if (status !== "Disconnected") return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch(roomsUrl);
        const data = await response.json() as { rooms: ActiveRoom[] };
        if (cancelled) return;
        setActiveRooms(data.rooms);
        if (!roomTouched && data.rooms.length > 0) setRoom(data.rooms[0].room);
      } catch {
        if (!cancelled) setActiveRooms([]);
      }
    };
    void refresh();
    const interval = window.setInterval(refresh, 3000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [status, roomTouched]);

  async function refreshRoms() {
    try {
      const response = await fetch(romsUrl);
      const data = await response.json() as { roms: RomEntry[] };
      setRoms(data.roms);
      setSelectedRom((current) => current && data.roms.some((r) => r.file === current) ? current : data.roms[0]?.file ?? null);
    } catch {
      setRoms([]);
    }
  }

  useEffect(() => {
    if (status !== "Disconnected") return;
    void refreshRoms();
  }, [status]);

  async function uploadRom(file: File) {
    if (!authToken) return;
    setUploading(true);
    setUploadError("");
    try {
      const response = await fetch(`${romsUrl}?filename=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", authorization: `Bearer ${authToken}` },
        body: file,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `upload failed (${response.status})`);
      }
      const uploaded = await response.json() as RomEntry;
      await refreshRoms();
      setSelectedRom(uploaded.file);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function connect(targetRoom?: string) {
    if (socketRef.current) return;
    const joinRoom = (targetRoom ?? room).trim() || "local";
    setRoom(joinRoom);
    setRoomTouched(true);
    setStatus("Connecting");
    myPeerIdRef.current = null;
    hostPeerIdRef.current = null;
    setRoster([]);
    setChatMessages([]);
    const socket = new WebSocket(signalingUrl);
    socketRef.current = socket;
    const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    peerRef.current = peer;
    const pendingCandidates: RTCIceCandidateInit[] = [];
    peer.ondatachannel = (event) => {
      inputRef.current = event.channel;
      event.channel.onopen = () => setInputState("Connected");
      event.channel.onclose = () => setInputState("Closed");
    };
    const mediaStream = new MediaStream();
    peer.ontrack = (event) => {
      mediaStream.addTrack(event.track);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        void videoRef.current.play();
      }
      setMediaState("Receiving media");
    };
    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      if (state === "connected") setStatus("WebRTC connected");
      if (state === "failed") setStatus("WebRTC failed");
    };
    peer.onicecandidate = (event) => {
      if (event.candidate && socket.readyState === WebSocket.OPEN && hostPeerIdRef.current) {
        socket.send(JSON.stringify({ type: "candidate", room: joinRoom, to: hostPeerIdRef.current, payload: event.candidate }));
      }
    };
    socket.onopen = async () => {
      setStatus("Connected to signaling");
      socket.send(JSON.stringify({ type: "join", room: joinRoom, username: authUsername }));
    };
    socket.onmessage = async (event) => {
      const message = JSON.parse(event.data) as SignalMessage;
      if (message.type === "join" && message.payload) {
        const { peerId, playerNumber: number, role, username } = message.payload;
        if (!myPeerIdRef.current) {
          myPeerIdRef.current = peerId;
          playerNumberRef.current = number ?? 1;
          setPlayerNumber(number ?? 1);
        }
        if (role === "player") {
          const label = username ?? (peerId === myPeerIdRef.current ? authUsername : null) ?? "player";
          setRoster((prev) => prev.some((p) => p.peerId === peerId) ? prev : [...prev, { peerId, playerNumber: number, username: label }]);
        }
        return;
      }
      if (message.type === "leave" && message.payload?.peerId) {
        setRoster((prev) => prev.filter((p) => p.peerId !== message.payload.peerId));
        if (message.payload.peerId === hostPeerIdRef.current) setMediaState("Game server disconnected");
        return;
      }
      if (message.type === "chat" && message.payload) {
        const { username, playerNumber: pn, text, timestamp } = message.payload;
        setChatMessages((prev) => [...prev.slice(-99), { username, playerNumber: pn, text, timestamp }]);
        return;
      }
      if (message.type === "offer" && message.payload) {
        hostPeerIdRef.current = message.from ?? null;
        await peer.setRemoteDescription(message.payload);
        for (const candidate of pendingCandidates.splice(0)) await peer.addIceCandidate(candidate);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        if (hostPeerIdRef.current) {
          socket.send(JSON.stringify({ type: "answer", room: joinRoom, to: hostPeerIdRef.current, payload: answer }));
        }
        setStatus("Answer sent");
      }
      if (message.type === "candidate" && message.payload) {
        if (peer.remoteDescription) await peer.addIceCandidate(message.payload);
        else pendingCandidates.push(message.payload);
      }
    };
    socket.onerror = () => setStatus("Signaling error");
    socket.onclose = () => { setStatus("Disconnected"); socketRef.current = null; };
  }

  async function submitAuth() {
    setAuthLoading(true);
    setAuthError("");
    try {
      const response = await fetch(`${apiBase}/auth/${authMode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(authForm),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "authentication failed");
      localStorage.setItem("rc_token", data.token);
      localStorage.setItem("rc_username", authForm.username);
      setAuthToken(data.token);
      setAuthUsername(authForm.username);
      setAuthForm({ username: "", password: "" });
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "authentication failed");
    } finally {
      setAuthLoading(false);
    }
  }

  function logout() {
    if (authToken) void fetch(`${apiBase}/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${authToken}` } });
    localStorage.removeItem("rc_token");
    localStorage.removeItem("rc_username");
    setAuthToken(null);
    setAuthUsername(null);
  }

  async function createRoom() {
    if (!authToken || !selectedRom) return;
    setCreating(true);
    setCreateError("");
    try {
      const response = await fetch(roomsUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ file: selectedRom }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `failed to create room (${response.status})`);
      }
      const data = await response.json() as { room: string };
      await connect(data.room);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "failed to create room");
    } finally {
      setCreating(false);
    }
  }

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume / 100;
    localStorage.setItem("rc_volume", String(volume));
  }, [volume]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
    localStorage.setItem("rc_muted", muted ? "1" : "0");
  }, [muted]);

  useEffect(() => {
    localStorage.setItem("rc_scale", scale);
  }, [scale]);

  function sendChat() {
    const text = chatInput.trim();
    if (!text || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type: "chat", room, payload: { text } }));
    setChatInput("");
  }

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "end" });
  }, [chatMessages]);

  function sendInput(button: Button, pressed: boolean) {
    if (inputRef.current?.readyState !== "open") return;
    inputRef.current.send(JSON.stringify({ type: "input", player: playerNumberRef.current, button, pressed, timestamp: Date.now() }));
  }

  function rebindKey(button: Button) {
    setRebinding(button);
  }

  useEffect(() => {
    if (!rebinding) return;
    const capture = (event: KeyboardEvent) => {
      event.preventDefault();
      const next = { ...keyBindings, [rebinding]: event.key };
      setKeyBindings(next);
      localStorage.setItem("rc_keybindings", JSON.stringify(next));
      setRebinding(null);
    };
    window.addEventListener("keydown", capture, { once: true });
    return () => window.removeEventListener("keydown", capture);
  }, [rebinding, keyBindings]);

  useEffect(() => {
    if (rebinding) return;
    const reverseMap: Record<string, Button> = {};
    for (const button of buttons) reverseMap[keyBindings[button]] = button;
    const down = (event: KeyboardEvent) => { const button = reverseMap[event.key]; if (button) { event.preventDefault(); sendInput(button, true); } };
    const up = (event: KeyboardEvent) => { const button = reverseMap[event.key]; if (button) { event.preventDefault(); sendInput(button, false); } };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [keyBindings, rebinding]);

  const inLobby = status === "Disconnected";

  if (!authToken) {
    return <div className="auth-split">
      <div className="auth-visual">
        <div className="brand"><span className="brand-mark">◆</span><span className="brand-name">retro<em>deck</em></span></div>
        <h1 className="auth-visual-title">Play retro games together,<br />streamed from the cloud.</h1>
        <p className="auth-visual-sub">No downloads, no emulator setup. Host a room, share the code, and everyone plays from the browser — NES and SNES, in sync, in real time.</p>
        <ul className="auth-feature-list">
          <li><span className="dot live" />Up to 4 players per room, each with their own controller</li>
          <li><span className="dot live" />Bring your own ROMs — upload and go</li>
          <li><span className="dot live" />Built-in chat while you play</li>
        </ul>
      </div>
      <div className="auth-form-side">
        <section className="auth-gate">
          <h2>{authMode === "login" ? "Welcome back" : "Create your account"}</h2>
          <p className="auth-sub">{authMode === "login" ? "Log in to jump into a room." : "One account, every room you host or join."}</p>
          <div className="auth-form">
            <label className="auth-field-label" htmlFor="auth-username">Username</label>
            <input id="auth-username" className="field" value={authForm.username} onChange={(e) => setAuthForm((f) => ({ ...f, username: e.target.value }))} placeholder="e.g. player_one" aria-label="Username" autoComplete="username" />
            <label className="auth-field-label" htmlFor="auth-password">Password</label>
            <input id="auth-password" className="field" type="password" value={authForm.password} onChange={(e) => setAuthForm((f) => ({ ...f, password: e.target.value }))} placeholder="••••••••" aria-label="Password" autoComplete={authMode === "login" ? "current-password" : "new-password"} />
            <button className="btn-primary" onClick={submitAuth} disabled={authLoading || !authForm.username || !authForm.password}>
              {authLoading ? "…" : authMode === "login" ? "Log in" : "Create account"}
            </button>
          </div>
          {authError && <p className="form-error">{authError}</p>}
          <p className="auth-switch">
            {authMode === "login" ? "Need an account?" : "Have an account?"}{" "}
            <button className="link-button" onClick={() => { setAuthMode(authMode === "login" ? "register" : "login"); setAuthError(""); }}>
              {authMode === "login" ? "Register" : "Log in"}
            </button>
          </p>
        </section>
      </div>
    </div>;
  }

  return <main>
    <header className="brand-header">
      <div className="brand"><span className="brand-mark">◆</span><span className="brand-name">retro<em>deck</em></span></div>
      {inLobby && <span className="user-chip">{authUsername}<button className="link-button" onClick={logout}>Log out</button></span>}
      {!inLobby && <span className="user-chip">Room {room}</span>}
    </header>

    {inLobby && (
      <section className="lobby">
        <div className="lobby-head">
          <div>
            <h2>Rooms in session</h2>
            <p className="lobby-sub">Jump into a friend's game, or spin up your own.</p>
          </div>
          <button className="btn-ghost" onClick={() => { void fetch(roomsUrl).then((r) => r.json()).then((d) => setActiveRooms(d.rooms)).catch(() => setActiveRooms([])); }}>↻ Refresh</button>
        </div>

        {activeRooms.length === 0 ? (
          <div className="empty-state">
            <div className="empty-glyph">▢</div>
            <p>No rooms online right now.</p>
            <span>Create one below and you'll be P1.</span>
          </div>
        ) : (
          <div className="room-grid">
            {activeRooms.map((entry) => (
              <button key={entry.room} className="room-card" onClick={() => connect(entry.room)}>
                <div className="room-card-top">
                  <span className="live-pulse" />
                  <span className="room-card-id">{entry.room}</span>
                </div>
                <div className="room-card-meta">
                  <span>{entry.owner ? `hosted by ${entry.owner}` : "unowned"}</span>
                  <span className="room-card-players">{entry.peerCount} playing</span>
                </div>
                <span className="room-card-cta">Join room →</span>
              </button>
            ))}
          </div>
        )}

        <div className="lobby-split">
          <div className="lobby-games">
            <p className="form-label showcase-label">Choose a ROM to host</p>
            {roms.length === 0 ? (
              <div className="empty-state">
                <div className="empty-glyph">▢</div>
                <p>No ROMs uploaded yet.</p>
                <span>Upload one from the panel to start hosting.</span>
              </div>
            ) : (
              <div className="game-showcase">
                {roms.map((rom) => (
                  <button
                    key={rom.file}
                    className={selectedRom === rom.file ? "game-tile active" : "game-tile"}
                    onClick={() => setSelectedRom(rom.file)}
                  >
                    <span className="game-tile-glyph">{rom.game === "nes" ? "▮▮" : "▮▮▮"}</span>
                    <span className="game-tile-label">{rom.file}</span>
                    <span className="game-tile-blurb">{rom.game.toUpperCase()} · {(rom.size / 1024 / 1024).toFixed(1)} MB</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <aside className="lobby-side">
            <div className="lobby-card">
              <p className="form-label">Host this ROM</p>
              <button className="btn-primary lobby-card-cta" onClick={createRoom} disabled={creating || !selectedRom}>
                {creating ? "Starting…" : selectedRom ? `Create room · ${selectedRom}` : "Select a ROM first"}
              </button>
              {createError && <p className="form-error">{createError}</p>}
            </div>

            <div className="lobby-card">
              <p className="form-label">Upload ROM</p>
              <span className="lobby-card-hint">.nes · .sfc · .smc, up to 8 MB</span>
              <label className="upload-drop">
                <input
                  type="file"
                  accept=".nes,.sfc,.smc"
                  disabled={uploading || !authToken}
                  onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadRom(file); event.target.value = ""; }}
                  aria-label="Upload ROM"
                />
                <span>{uploading ? "Uploading…" : "Choose file or drop it here"}</span>
              </label>
              {uploadError && <p className="form-error">{uploadError}</p>}
            </div>

            <div className="lobby-card">
              <p className="form-label">Join by code</p>
              <div className="form-row">
                <input
                  className="field"
                  value={room}
                  onChange={(event) => { setRoom(event.target.value); setRoomTouched(true); }}
                  placeholder="room code"
                  aria-label="Room name"
                />
                <button className="btn-ghost" onClick={() => connect()} disabled={status !== "Disconnected"}>Join</button>
              </div>
            </div>
          </aside>
        </div>
      </section>
    )}

    {!inLobby && <>
      <div className="room-layout">
        <div className="player-stage">
          <div className="player-topbar">
            <span className="player-pill"><span className={status.includes("Connected") ? "dot live" : "dot"} />{status.includes("Connected") ? "Live" : status}</span>
            {playerNumber && <span className="player-pill accent">P{playerNumber}</span>}
            <span className="player-pill muted">{room}</span>
            <button className="icon-button" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="12" r="3.2" />
                <path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.5-2.4 1a7.7 7.7 0 0 0-1.7-1L15 3h-4l-.3 2.3a7.7 7.7 0 0 0-1.7 1l-2.4-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.5 2.4-1a7.7 7.7 0 0 0 1.7 1L9 21h4l.3-2.3a7.7 7.7 0 0 0 1.7-1l2.4 1 2-3.5-2-1.5Z" />
              </svg>
            </button>
          </div>
          <div className={`stage stage-${scale === "fit" ? "fit" : "fixed"}`}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              controls={false}
              onLoadedMetadata={() => { if (videoRef.current) setIntrinsicSize({ w: videoRef.current.videoWidth, h: videoRef.current.videoHeight }); }}
              style={scale !== "fit" && intrinsicSize ? { width: intrinsicSize.w * Number(scale), height: "auto" } : undefined}
            />
            {mediaState !== "Receiving media" && <div className="placeholder">{mediaState}</div>}
          </div>
        </div>

        <aside className="social-panel">
          <div className="social-block">
            <p className="form-label">Players</p>
            <ul className="roster-list">
              <li className="roster-row">
                <span className="roster-tag">P{playerNumber ?? 1}</span>
                <span className="roster-name">{authUsername} (you)</span>
              </li>
              {roster.map((entry) => (
                <li key={entry.peerId} className="roster-row">
                  <span className="roster-tag">P{entry.playerNumber}</span>
                  <span className="roster-name">{entry.username}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="social-block chat-block">
            <p className="form-label">Chat</p>
            <div className="chat-log">
              {chatMessages.length === 0 && <p className="chat-empty">Say hi to the room.</p>}
              {chatMessages.map((message, index) => (
                <div key={index} className="chat-message">
                  <span className="chat-author">{message.playerNumber ? `P${message.playerNumber} ` : ""}{message.username}</span>
                  <span className="chat-text">{message.text}</span>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <div className="chat-input-row">
              <input
                className="field"
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") sendChat(); }}
                placeholder="Message the room…"
                aria-label="Chat message"
              />
              <button className="btn-ghost" onClick={sendChat} disabled={!chatInput.trim()}>Send</button>
            </div>
          </div>
        </aside>
      </div>

      {settingsOpen && (
        <div className="settings-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="settings-panel" onClick={(event) => event.stopPropagation()}>
            <div className="settings-head">
              <h2>Settings</h2>
              <button className="icon-button" aria-label="Close" onClick={() => setSettingsOpen(false)}>✕</button>
            </div>
            <div className="settings-tabs">
              <button className={settingsTab === "display" ? "tab active" : "tab"} onClick={() => setSettingsTab("display")}>Display</button>
              <button className={settingsTab === "audio" ? "tab active" : "tab"} onClick={() => setSettingsTab("audio")}>Audio</button>
              <button className={settingsTab === "controls" ? "tab active" : "tab"} onClick={() => setSettingsTab("controls")}>Controls</button>
            </div>

            {settingsTab === "display" && (
              <div className="settings-section">
                <p className="settings-label">Field of view</p>
                <div className="scale-options">
                  {[["fit", "Fit"], ["1", "1×"], ["2", "2×"], ["3", "3×"]].map(([value, label]) => (
                    <button key={value} className={scale === value ? "scale-option active" : "scale-option"} onClick={() => setScale(value)}>{label}</button>
                  ))}
                </div>
              </div>
            )}

            {settingsTab === "audio" && (
              <div className="settings-section">
                <p className="settings-label">Volume</p>
                <div className="volume-row">
                  <button className="icon-button" aria-label={muted ? "Unmute" : "Mute"} onClick={() => setMuted((v) => !v)}>{muted ? "🔇" : "🔊"}</button>
                  <input
                    className="volume-slider"
                    type="range"
                    min={0}
                    max={100}
                    value={volume}
                    onChange={(event) => { setVolume(Number(event.target.value)); setMuted(false); }}
                  />
                  <span className="volume-value">{muted ? 0 : volume}%</span>
                </div>
              </div>
            )}

            {settingsTab === "controls" && (
              <div className="settings-section">
                <p className="settings-label">Keyboard bindings · P{playerNumber ?? 1}</p>
                <ul className="keybind-list">
                  {buttons.map((button) => (
                    <li key={button} className="keybind-row">
                      <span className="keybind-name">{button}</span>
                      <button className="keybind-key" onClick={() => rebindKey(button)}>
                        {rebinding === button ? "press a key…" : keyBindings[button]}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </>}
  </main>;
}
