import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { type Lang, loadLang, translate } from "./i18n";

type SignalMessage = { type: string; room?: string; from?: string; payload?: any };
type Button = "UP" | "DOWN" | "LEFT" | "RIGHT" | "A" | "B" | "START" | "SELECT" | "L" | "R";
type RosterEntry = { peerId: string; playerNumber: number; username: string };
type ChatMessage = { username: string; playerNumber?: number; text: string; timestamp: number };
type RomEntry = { file: string; game: "nes" | "snes"; size: number; owner: string | null };

const signalingUrl = import.meta.env.VITE_SIGNALING_URL ?? "ws://localhost:8080/signaling";
const apiBase = signalingUrl.replace(/^ws/, "http").replace(/\/signaling\/?$/, "");
const roomsUrl = `${apiBase}/rooms`;
const romsUrl = `${apiBase}/roms`;
const defaultRoom = import.meta.env.VITE_ROOM ?? "";
type ActiveRoom = { room: string; peerCount: number; owner: string | null; visibility?: "public" | "private" };
const buttons: Button[] = ["UP", "DOWN", "LEFT", "RIGHT", "A", "B", "L", "R", "START", "SELECT"];
const defaultKeyBindings: Record<Button, string> = {
  UP: "ArrowUp", DOWN: "ArrowDown", LEFT: "ArrowLeft", RIGHT: "ArrowRight",
  A: "z", B: "x", L: "q", R: "w", START: "Enter", SELECT: "Shift",
};

function loadKeyBindings(): Record<Button, string> {
  try {
    const stored = JSON.parse(localStorage.getItem("rc_keybindings") ?? "{}");
    return { ...defaultKeyBindings, ...stored };
  } catch {
    return { ...defaultKeyBindings };
  }
}

const statusKeys: Record<string, string> = {
  Disconnected: "statusDisconnected",
  Connecting: "statusConnecting",
  "Connected to signaling": "statusSignalingConnected",
  "WebRTC connected": "statusWebrtcConnected",
  "WebRTC failed": "statusWebrtcFailed",
  "Answer sent": "statusAnswerSent",
  "Signaling error": "statusSignalingError",
};
const mediaKeys: Record<string, string> = {
  "Waiting for game server": "waitingForGameServer",
  "Receiving media": "receivingMedia",
  "Game server disconnected": "gameServerDisconnected",
};

function IconLock() {
  return <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>;
}
function IconGlobe() {
  return <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z" />
  </svg>;
}
function IconCrown() {
  return <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
    <path d="M4 18h16l1-9-5 3-4-6-4 6-5-3 1 9Z" />
  </svg>;
}
function IconClose() {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>;
}
function IconFullscreen({ active }: { active: boolean }) {
  return active ? (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4H6a2 2 0 0 0-2 2v3M15 4h3a2 2 0 0 1 2 2v3M9 20H6a2 2 0 0 1-2-2v-3M15 20h3a2 2 0 0 0 2-2v-3" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9V6a2 2 0 0 1 2-2h3M20 9V6a2 2 0 0 0-2-2h-3M4 15v3a2 2 0 0 0 2 2h3M20 15v3a2 2 0 0 1-2 2h-3" />
    </svg>
  );
}
function IconVolume({ muted }: { muted: boolean }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 9v6h4l5 4V5L8 9H4Z" />
    {muted ? <path d="M16 9l5 6M21 9l-5 6" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a9 9 0 0 1 0 12" />}
  </svg>;
}
function IconRefresh() {
  return <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 4v5h5M20 20v-5h-5" /><path d="M5.5 9A7 7 0 0 1 19 8M18.5 15a7 7 0 0 1-13.5 1" />
  </svg>;
}

function TouchButton({ label, className, onPress }: { label: string; className: string; onPress: (pressed: boolean) => void }) {
  const [held, setHeld] = useState(false);
  const pressedRef = useRef(false);
  const press = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (pressedRef.current) return; // ignore a stray second pointerdown for the same touch
    pressedRef.current = true;
    setHeld(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (navigator.vibrate) navigator.vibrate(8);
    onPress(true);
  };
  const release = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (!pressedRef.current) return;
    pressedRef.current = false;
    setHeld(false);
    onPress(false);
  };
  return (
    <button
      className={held ? `${className} pressed` : className}
      onPointerDown={press}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );
}

function TouchControls({ sendInput, layout, size }: { sendInput: (button: Button, pressed: boolean) => void; layout: "standard" | "swapped"; size: "compact" | "large" }) {
  return (
    <div className={`touch-controls layout-${layout} size-${size}`}>
      <div className="touch-dpad">
        <TouchButton label="" className="touch-dpad-btn dpad-up" onPress={(p) => sendInput("UP", p)} />
        <TouchButton label="" className="touch-dpad-btn dpad-down" onPress={(p) => sendInput("DOWN", p)} />
        <TouchButton label="" className="touch-dpad-btn dpad-left" onPress={(p) => sendInput("LEFT", p)} />
        <TouchButton label="" className="touch-dpad-btn dpad-right" onPress={(p) => sendInput("RIGHT", p)} />
      </div>
      <div className="touch-shoulders">
        <TouchButton label="L" className="touch-shoulder-btn" onPress={(p) => sendInput("L", p)} />
        <TouchButton label="R" className="touch-shoulder-btn" onPress={(p) => sendInput("R", p)} />
      </div>
      <div className="touch-actions">
        <TouchButton label="B" className="touch-action-btn action-b" onPress={(p) => sendInput("B", p)} />
        <TouchButton label="A" className="touch-action-btn action-a" onPress={(p) => sendInput("A", p)} />
      </div>
      <div className="touch-system">
        <TouchButton label={"SELECT"} className="touch-system-btn" onPress={(p) => sendInput("SELECT", p)} />
        <TouchButton label={"START"} className="touch-system-btn" onPress={(p) => sendInput("START", p)} />
      </div>
    </div>
  );
}

function LangToggle({ lang, setLang }: { lang: Lang; setLang: (lang: Lang) => void }) {
  return (
    <div className="lang-toggle" role="group" aria-label="Language">
      <button className={lang === "es" ? "lang-option active" : "lang-option"} onClick={() => setLang("es")}>ES</button>
      <button className={lang === "en" ? "lang-option active" : "lang-option"} onClick={() => setLang("en")}>EN</button>
    </div>
  );
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [lang, setLang] = useState<Lang>(loadLang);
  const t = (key: Parameters<typeof translate>[1]) => translate(lang, key);
  useEffect(() => { localStorage.setItem("rc_lang", lang); document.documentElement.lang = lang; }, [lang]);
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
  const [roomOwner, setRoomOwner] = useState<string | null>(null);
  const [closingRoom, setClosingRoom] = useState(false);
  const [activeRooms, setActiveRooms] = useState<ActiveRoom[]>([]);
  const [lobbyView, setLobbyView] = useState<"rooms" | "catalog">("rooms");
  const [roms, setRoms] = useState<RomEntry[]>([]);
  const [selectedRom, setSelectedRom] = useState<string | null>(null);
  const [newRoomVisibility, setNewRoomVisibility] = useState<"public" | "private">("public");
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
  const [touchLayout, setTouchLayout] = useState<"standard" | "swapped">(() => (localStorage.getItem("rc_touch_layout") === "swapped" ? "swapped" : "standard"));
  const [touchSize, setTouchSize] = useState<"compact" | "large">(() => (localStorage.getItem("rc_touch_size") === "large" ? "large" : "compact"));
  const [isTouchDevice] = useState(() => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const [volume, setVolume] = useState<number>(() => Number(localStorage.getItem("rc_volume") ?? "100"));
  const [muted, setMuted] = useState<boolean>(() => localStorage.getItem("rc_muted") === "1");
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const [intrinsicSize, setIntrinsicSize] = useState<{ w: number; h: number } | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [latencyPopoverOpen, setLatencyPopoverOpen] = useState(false);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [accountPopoverOpen, setAccountPopoverOpen] = useState(false);
  const statsIntervalRef = useRef<number | null>(null);
  const myPeerIdRef = useRef<string | null>(null);
  const hostPeerIdRef = useRef<string | null>(null);
  const playerNumberRef = useRef<number>(1);
  const heldButtonsRef = useRef<Set<Button>>(new Set());
  const shouldReconnectRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const lastRoomRef = useRef<string>("");
  const lastOwnerRef = useRef<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => () => {
    shouldReconnectRef.current = false;
    if (reconnectTimeoutRef.current) window.clearTimeout(reconnectTimeoutRef.current);
    inputRef.current?.close();
    peerRef.current?.close();
    socketRef.current?.close();
    if (statsIntervalRef.current) window.clearInterval(statsIntervalRef.current);
    void audioCtxRef.current?.close();
  }, []);

  useEffect(() => {
    if (status !== "Disconnected") return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch(roomsUrl, { headers: authToken ? { authorization: `Bearer ${authToken}` } : {} });
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
  }, [status, roomTouched, authToken]);

  async function refreshRoms() {
    try {
      const response = await fetch(romsUrl, { headers: authToken ? { authorization: `Bearer ${authToken}` } : {} });
      const data = await response.json() as { roms: RomEntry[] };
      setRoms(data.roms);
      setSelectedRom((current) => current && data.roms.some((r) => r.file === current) ? current : data.roms[0]?.file ?? null);
    } catch {
      setRoms([]);
    }
  }

  async function deleteRom(file: string) {
    if (!authToken) return;
    await fetch(`${romsUrl}/${encodeURIComponent(file)}`, { method: "DELETE", headers: { authorization: `Bearer ${authToken}` } }).catch(() => {});
    await refreshRoms();
  }

  useEffect(() => {
    if (status !== "Disconnected") return;
    void refreshRoms();
  }, [status, authToken]);

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

  async function connect(targetRoom?: string, owner?: string | null) {
    if (socketRef.current) return;
    const joinRoom = (targetRoom ?? room).trim() || "local";
    const joinOwner = owner ?? lastOwnerRef.current ?? activeRooms.find((r) => r.room === joinRoom)?.owner ?? null;
    lastRoomRef.current = joinRoom;
    lastOwnerRef.current = joinOwner;
    shouldReconnectRef.current = true;
    if (reconnectTimeoutRef.current) { window.clearTimeout(reconnectTimeoutRef.current); reconnectTimeoutRef.current = null; }
    setRoom(joinRoom);
    setRoomTouched(true);
    setRoomOwner(joinOwner);
    setStatus("Connecting");
    myPeerIdRef.current = null;
    hostPeerIdRef.current = null;
    heldButtonsRef.current.clear();
    setMobilePanelOpen(false);
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
        videoRef.current.volume = volumeRef.current / 100;
        videoRef.current.muted = mutedRef.current;
        void videoRef.current.play();
        if (event.track.kind === "audio") setupAudioGraph(mediaStream);
      }
      setMediaState("Receiving media");
    };
    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      if (state === "connected") {
        setStatus("WebRTC connected");
        setReconnecting(false);
        reconnectAttemptsRef.current = 0;
        if (statsIntervalRef.current) window.clearInterval(statsIntervalRef.current);
        statsIntervalRef.current = window.setInterval(async () => {
          const stats = await peer.getStats();
          stats.forEach((report) => {
            if (report.type === "candidate-pair" && report.state === "succeeded" && typeof report.currentRoundTripTime === "number") {
              setRttMs(Math.round(report.currentRoundTripTime * 1000));
            }
          });
        }, 2000);
      }
      if (state === "failed") setStatus("WebRTC failed");
      if (state === "closed" || state === "failed" || state === "disconnected") {
        if (statsIntervalRef.current) { window.clearInterval(statsIntervalRef.current); statsIntervalRef.current = null; }
        setRttMs(null);
      }
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
        if (role === "player" && peerId !== myPeerIdRef.current) {
          const label = username ?? "player";
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
      if (message.type === "owner_changed" && message.payload) {
        setRoomOwner(message.payload.owner ?? null);
        return;
      }
      if (message.type === "closed") {
        shouldReconnectRef.current = false;
        socket.close();
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
    socket.onclose = () => {
      socketRef.current = null; peerRef.current?.close(); peerRef.current = null;
      if (statsIntervalRef.current) { window.clearInterval(statsIntervalRef.current); statsIntervalRef.current = null; }
      gainNodeRef.current = null;
      setRttMs(null);
      const maxAttempts = 6;
      if (shouldReconnectRef.current && reconnectAttemptsRef.current < maxAttempts) {
        reconnectAttemptsRef.current += 1;
        setReconnecting(true);
        setStatus("Connecting");
        const delay = Math.min(1000 * 2 ** (reconnectAttemptsRef.current - 1), 15000);
        reconnectTimeoutRef.current = window.setTimeout(() => {
          void connect(lastRoomRef.current, lastOwnerRef.current);
        }, delay);
      } else {
        setReconnecting(false);
        shouldReconnectRef.current = false;
        setStatus("Disconnected");
      }
    };
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
        body: JSON.stringify({ file: selectedRom, visibility: newRoomVisibility }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `failed to create room (${response.status})`);
      }
      const data = await response.json() as { room: string };
      await connect(data.room, authUsername);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "failed to create room");
    } finally {
      setCreating(false);
    }
  }

  async function closeRoom() {
    if (!authToken || closingRoom) return;
    shouldReconnectRef.current = false;
    setClosingRoom(true);
    try {
      const response = await fetch(`${roomsUrl}/${encodeURIComponent(room)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${authToken}` },
      });
      if (!response.ok && response.status !== 404) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `failed to close room (${response.status})`);
      }
    } catch (error) {
      console.error("[ROOM] failed to close room:", error);
    } finally {
      socketRef.current?.close();
      setClosingRoom(false);
    }
  }

  function transferHost(targetPeerId: string) {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type: "transfer_host", room, payload: { targetPeerId } }));
  }

  function setupAudioGraph(stream: MediaStream) {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    const ctx = audioCtxRef.current;
    if (ctx.state === "suspended") void ctx.resume();
    // A compressor normalizes perceived loudness so a lower slider position still sounds full/clear
    // instead of just thin and quiet — makeup gain keeps the room's average level consistent.
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -32;
    compressor.knee.value = 18;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    const gain = ctx.createGain();
    gain.gain.value = mutedRef.current ? 0 : volumeRef.current / 100;
    ctx.createMediaStreamSource(stream).connect(compressor).connect(gain).connect(ctx.destination);
    gainNodeRef.current = gain;
    if (videoRef.current) videoRef.current.muted = true; // audio now plays through the Web Audio graph above
  }

  useEffect(() => {
    volumeRef.current = volume;
    if (gainNodeRef.current) gainNodeRef.current.gain.value = muted ? 0 : volume / 100;
    else if (videoRef.current) videoRef.current.volume = volume / 100;
    localStorage.setItem("rc_volume", String(volume));
  }, [volume, muted]);

  useEffect(() => {
    mutedRef.current = muted;
    if (gainNodeRef.current) gainNodeRef.current.gain.value = muted ? 0 : volume / 100;
    else if (videoRef.current) videoRef.current.muted = muted;
    localStorage.setItem("rc_muted", muted ? "1" : "0");
  }, [muted]);

  useEffect(() => {
    localStorage.setItem("rc_scale", scale);
  }, [scale]);

  useEffect(() => { localStorage.setItem("rc_touch_layout", touchLayout); }, [touchLayout]);
  useEffect(() => { localStorage.setItem("rc_touch_size", touchSize); }, [touchSize]);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (stageWrapRef.current) {
        await stageWrapRef.current.requestFullscreen();
      }
    } catch (error) {
      console.error("[FULLSCREEN] failed:", error);
    }
  }

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
    // Dedupe: ignore a repeated "pressed" for a button already held (keyboard auto-repeat edge cases,
    // overlapping touch + keyboard, etc.) so we never spam the channel or desync from the true state.
    const isHeld = heldButtonsRef.current.has(button);
    if (pressed === isHeld) return;
    if (pressed) heldButtonsRef.current.add(button); else heldButtonsRef.current.delete(button);
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
    const isTypingTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };
    const down = (event: KeyboardEvent) => {
      if (event.repeat || isTypingTarget(event.target)) return;
      const button = reverseMap[event.key]; if (button) { event.preventDefault(); sendInput(button, true); }
    };
    const up = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const button = reverseMap[event.key]; if (button) { event.preventDefault(); sendInput(button, false); }
    };
    // If the window/tab loses focus while a key is held (alt-tab, clicking another element), no keyup
    // ever fires — the game-server keeps thinking that button is held down forever. Release everything.
    const releaseAll = () => { for (const button of buttons) sendInput(button, false); };
    const onVisibility = () => { if (document.hidden) releaseAll(); };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", down); window.removeEventListener("keyup", up);
      window.removeEventListener("blur", releaseAll);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [keyBindings, rebinding]);

  const inLobby = status === "Disconnected";

  if (!authToken) {
    return <div className="auth-split">
      <div className="auth-visual">
        <div className="brand-row">
          <div className="brand"><span className="brand-mark">◆</span><span className="brand-name">retro<em>X</em></span></div>
          <LangToggle lang={lang} setLang={setLang} />
        </div>
        <h1 className="auth-visual-title" dangerouslySetInnerHTML={{ __html: t("brandTagline") }} />
        <p className="auth-visual-sub">{t("brandSub")}</p>
        <ul className="auth-feature-list">
          <li><span className="dot live" />{t("featurePlayers")}</li>
          <li><span className="dot live" />{t("featureRoms")}</li>
          <li><span className="dot live" />{t("featureChat")}</li>
        </ul>
      </div>
      <div className="auth-form-side">
        <section className="auth-gate">
          <h2>{authMode === "login" ? t("welcomeBack") : t("createAccount")}</h2>
          <p className="auth-sub">{authMode === "login" ? t("loginSub") : t("registerSub")}</p>
          <div className="auth-form">
            <label className="auth-field-label" htmlFor="auth-username">{t("username")}</label>
            <input id="auth-username" className="field" value={authForm.username} onChange={(e) => setAuthForm((f) => ({ ...f, username: e.target.value }))} placeholder={t("usernamePlaceholder")} aria-label={t("username")} autoComplete="username" />
            <label className="auth-field-label" htmlFor="auth-password">{t("password")}</label>
            <input id="auth-password" className="field" type="password" value={authForm.password} onChange={(e) => setAuthForm((f) => ({ ...f, password: e.target.value }))} placeholder="••••••••" aria-label={t("password")} autoComplete={authMode === "login" ? "current-password" : "new-password"} />
            <button className="btn-primary" onClick={submitAuth} disabled={authLoading || !authForm.username || !authForm.password}>
              {authLoading ? "…" : authMode === "login" ? t("logIn") : t("createAccountBtn")}
            </button>
          </div>
          {authError && <p className="form-error">{authError}</p>}
          <p className="auth-switch">
            {authMode === "login" ? t("needAccount") : t("haveAccount")}{" "}
            <button className="link-button" onClick={() => { setAuthMode(authMode === "login" ? "register" : "login"); setAuthError(""); }}>
              {authMode === "login" ? t("register") : t("logIn")}
            </button>
          </p>
        </section>
      </div>
    </div>;
  }

  return <main className={inLobby ? undefined : "in-room"}>
    {inLobby && (
      <header className="brand-header">
        <div className="brand"><span className="brand-mark">◆</span><span className="brand-name">retro<em>X</em></span></div>
        <nav className="navbar-tabs">
          <button className={lobbyView === "rooms" ? "navbar-tab active" : "navbar-tab"} onClick={() => setLobbyView("rooms")}>{t("roomsTab")}</button>
          <button className={lobbyView === "catalog" ? "navbar-tab active" : "navbar-tab"} onClick={() => setLobbyView("catalog")}>{t("catalogTab")}</button>
        </nav>
        <div className="header-right">
          <LangToggle lang={lang} setLang={setLang} />
          <span className="user-chip">{authUsername}<button className="link-button" onClick={logout}>{t("logOut")}</button></span>
        </div>
      </header>
    )}

    {inLobby && (
      <nav className="bottom-tab-bar">
        <button className={lobbyView === "rooms" ? "bottom-tab active" : "bottom-tab"} onClick={() => setLobbyView("rooms")}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l9-7 9 7" /><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" /></svg>
          <span>{t("roomsTab")}</span>
        </button>
        <button className={lobbyView === "catalog" ? "bottom-tab active" : "bottom-tab"} onClick={() => setLobbyView("catalog")}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
          <span>{t("catalogTab")}</span>
        </button>
        <button className="bottom-tab" onClick={() => setAccountPopoverOpen(true)}>
          <span className="roster-avatar small">{(authUsername ?? "?").slice(0, 1).toUpperCase()}</span>
          <span>{t("account")}</span>
        </button>
      </nav>
    )}

    {accountPopoverOpen && (
      <>
        <div className="popover-backdrop" onClick={() => setAccountPopoverOpen(false)} />
        <div className="account-popover">
          <p className="account-popover-name">{authUsername}</p>
          <LangToggle lang={lang} setLang={setLang} />
          <button className="btn-danger account-popover-logout" onClick={logout}>{t("logOut")}</button>
        </div>
      </>
    )}

    {inLobby && lobbyView === "rooms" && (
      <section className="lobby">
        <div className="lobby-head">
          <div>
            <h2>{t("roomsInSession")}</h2>
            <p className="lobby-sub">{t("lobbySub")}</p>
          </div>
          <button className="btn-ghost" onClick={() => { void fetch(roomsUrl, { headers: authToken ? { authorization: `Bearer ${authToken}` } : {} }).then((r) => r.json()).then((d) => setActiveRooms(d.rooms)).catch(() => setActiveRooms([])); }}><IconRefresh /> {t("refresh")}</button>
        </div>

        <div className="stat-strip">
          <div className="stat-card">
            <span className="stat-value">{activeRooms.length}</span>
            <span className="stat-label">{t("statLiveRooms")}</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{activeRooms.reduce((sum, r) => sum + r.peerCount, 0)}</span>
            <span className="stat-label">{t("statPlayersOnline")}</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{activeRooms.filter((r) => r.visibility !== "private").length}</span>
            <span className="stat-label">{t("statPublicRooms")}</span>
          </div>
        </div>

        {activeRooms.length === 0 ? (
          <div className="empty-state">
            <div className="empty-glyph">▢</div>
            <p>{t("noRoomsOnline")}</p>
            <span>{t("createOneBelow")}</span>
          </div>
        ) : (
          <div className="room-grid">
            {activeRooms.map((entry) => (
              <button key={entry.room} className="room-card" onClick={() => connect(entry.room, entry.owner)}>
                <div className="room-card-top">
                  <span className="live-pulse" />
                  <span className="room-card-id">{entry.room}</span>
                  {entry.visibility === "private" && <span className="visibility-tag"><IconLock /> {t("private")}</span>}
                </div>
                <div className="room-card-owner">
                  <span className="roster-avatar small">{(entry.owner ?? "?").slice(0, 1).toUpperCase()}</span>
                  <span>{entry.owner ? `${t("hostedBy")} ${entry.owner}` : t("unowned")}</span>
                </div>
                <div className="room-card-meta">
                  <span className="room-card-players">{entry.peerCount} {t("playing")}</span>
                </div>
                <span className="room-card-cta">{t("joinRoomCta")}</span>
              </button>
            ))}
          </div>
        )}

        <div className="lobby-card">
          <p className="form-label">{t("joinByCode")}</p>
          <div className="form-row">
            <input
              className="field"
              value={room}
              onChange={(event) => { setRoom(event.target.value); setRoomTouched(true); }}
              placeholder={t("roomCodePlaceholder")}
              aria-label={t("room")}
            />
            <button className="btn-ghost" onClick={() => connect()} disabled={status !== "Disconnected"}>{t("join")}</button>
          </div>
        </div>
      </section>
    )}

    {inLobby && lobbyView === "catalog" && (
      <section className="lobby">
        <div className="lobby-head">
          <div>
            <h2>{t("catalogTitle")}</h2>
            <p className="lobby-sub">{t("catalogSub")}</p>
          </div>
        </div>
        <div className="lobby-split">
          <div className="lobby-games">
            <p className="form-label showcase-label">{t("chooseRom")}</p>
            {roms.length === 0 ? (
              <div className="empty-state">
                <div className="empty-glyph">▢</div>
                <p>{t("noRomsUploaded")}</p>
                <span>{t("uploadFromPanel")}</span>
              </div>
            ) : (
              <div className="catalog">
                {(["snes", "nes"] as const).map((consoleName) => {
                  const consoleRoms = roms.filter((rom) => rom.game === consoleName);
                  if (consoleRoms.length === 0) return null;
                  return (
                    <div key={consoleName} className="catalog-row">
                      <p className="catalog-row-title">{consoleName.toUpperCase()} <span className="catalog-row-count">{consoleRoms.length}</span></p>
                      <div className="catalog-track">
                        {consoleRoms.map((rom) => (
                          <div
                            key={rom.file}
                            role="button"
                            tabIndex={0}
                            className={selectedRom === rom.file ? "game-card active" : "game-card"}
                            onClick={() => setSelectedRom(rom.file)}
                            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedRom(rom.file); }}
                          >
                            {rom.owner === authUsername && (
                              <button
                                className="game-card-delete"
                                aria-label={t("deleteRom")}
                                onClick={(event) => { event.stopPropagation(); void deleteRom(rom.file); }}
                              >
                                <IconClose />
                              </button>
                            )}
                            <div className="game-card-cover">
                              <span className="game-card-glyph">{consoleName === "nes" ? "▮▮" : "▮▮▮"}</span>
                            </div>
                            <span className="game-card-label">{rom.file.replace(/\.(nes|sfc|smc)$/i, "")}</span>
                            <span className="game-card-meta">{(rom.size / 1024 / 1024).toFixed(1)} MB{!rom.owner && ` · ${t("shared")}`}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <aside className="lobby-side">
            <div className="lobby-card">
              <p className="form-label">{t("hostThisRom")}</p>
              <div className="visibility-toggle" role="group" aria-label={t("visibility")}>
                <button className={newRoomVisibility === "public" ? "visibility-option active" : "visibility-option"} onClick={() => setNewRoomVisibility("public")}><IconGlobe /> {t("public")}</button>
                <button className={newRoomVisibility === "private" ? "visibility-option active" : "visibility-option"} onClick={() => setNewRoomVisibility("private")}><IconLock /> {t("private")}</button>
              </div>
              <span className="lobby-card-hint">{newRoomVisibility === "public" ? t("publicHint") : t("privateHint")}</span>
              <button className="btn-primary lobby-card-cta" onClick={createRoom} disabled={creating || !selectedRom}>
                {creating ? t("starting") : selectedRom ? `${t("createRoom")} · ${selectedRom}` : t("selectRomFirst")}
              </button>
              {createError && <p className="form-error">{createError}</p>}
            </div>

            <div className="lobby-card">
              <p className="form-label">{t("uploadRom")}</p>
              <span className="lobby-card-hint">{t("uploadHint")}</span>
              <label className="upload-drop">
                <input
                  type="file"
                  accept=".nes,.sfc,.smc"
                  disabled={uploading || !authToken}
                  onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadRom(file); event.target.value = ""; }}
                  aria-label={t("uploadRom")}
                />
                <span>{uploading ? t("uploading") : t("chooseFileDrop")}</span>
              </label>
              {uploadError && <p className="form-error">{uploadError}</p>}
            </div>
          </aside>
        </div>
      </section>
    )}

    {!inLobby && <>
      <div className="room-layout">
        <div className="player-stage" ref={stageWrapRef}>
          <div className="player-topbar overlay-bar">
            <div className="brand brand-mini"><span className="brand-mark">◆</span><span className="brand-name">retro<em>X</em></span></div>
            <div className="latency-wrap">
              <button
                className={`latency-pill ${status.includes("Connected") ? (rttMs === null ? "pending" : rttMs < 80 ? "good" : rttMs < 150 ? "ok" : "bad") : "down"}`}
                onClick={() => setLatencyPopoverOpen((v) => !v)}
              >
                <span className="latency-bars"><span /><span /><span /></span>
                {reconnecting ? t("reconnecting") : status.includes("Connected") && rttMs !== null ? `${rttMs}ms` : ""}
              </button>
              {latencyPopoverOpen && (
                <>
                  <div className="popover-backdrop" onClick={() => setLatencyPopoverOpen(false)} />
                  <div className="latency-popover">
                    <div className="latency-popover-row">
                      <span>{t("connectionStatus")}</span>
                      <span>{translate(lang, (statusKeys[status] as any) ?? "statusDisconnected")}</span>
                    </div>
                    <div className="latency-popover-row">
                      <span>{t("latency")}</span>
                      <span>{rttMs !== null ? `${rttMs} ms` : "—"}</span>
                    </div>
                    <div className="latency-popover-row">
                      <span>{t("room")}</span>
                      <span>{room}</span>
                    </div>
                    <div className="latency-popover-row">
                      <span>{t("you")}</span>
                      <span>P{playerNumber ?? 1}</span>
                    </div>
                  </div>
                </>
              )}
            </div>
            {playerNumber && <span className="player-pill accent">P{playerNumber}</span>}
            <span className="player-pill muted room-code-pill">{room}</span>
            {authUsername === roomOwner && (
              <button className="btn-danger" onClick={closeRoom} disabled={closingRoom}>
                {closingRoom ? t("closing") : t("closeRoom")}
              </button>
            )}
            <div className="lang-toggle-desktop"><LangToggle lang={lang} setLang={setLang} /></div>
            <button className="icon-button fullscreen-toggle" aria-label={t("fullscreen")} onClick={toggleFullscreen}>
              <IconFullscreen active={isFullscreen} />
            </button>
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
            {mediaState !== "Receiving media" && <div className="placeholder">{translate(lang, (mediaKeys[mediaState] as any) ?? "waitingForGameServer")}</div>}
          </div>
          <TouchControls sendInput={sendInput} layout={touchLayout} size={touchSize} />
          <button className="mobile-panel-fab" onClick={() => setMobilePanelOpen(true)} aria-label={t("players")}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
            </svg>
            {(roster.length > 0 || chatMessages.length > 0) && <span className="fab-badge" />}
          </button>
        </div>

        {mobilePanelOpen && <div className="popover-backdrop mobile-panel-backdrop" onClick={() => setMobilePanelOpen(false)} />}
        <aside className={mobilePanelOpen ? "social-panel mobile-open" : "social-panel"}>
          <button className="mobile-panel-close" onClick={() => setMobilePanelOpen(false)} aria-label="Close"><IconClose /></button>
          <div className="social-block">
            <p className="form-label">{t("players")} · {1 + roster.length}</p>
            <ul className="roster-list">
              <li className="roster-row">
                <span className="roster-avatar">{(authUsername ?? "?").slice(0, 1).toUpperCase()}</span>
                <span className="roster-name">{authUsername} <span className="roster-you">({t("you")})</span></span>
                <span className="roster-tag">P{playerNumber ?? 1}</span>
                {authUsername === roomOwner && <span className="host-badge" title={t("host")}><IconCrown /></span>}
              </li>
              {roster.map((entry) => (
                <li key={entry.peerId} className="roster-row">
                  <span className="roster-avatar">{entry.username.slice(0, 1).toUpperCase()}</span>
                  <span className="roster-name">{entry.username}</span>
                  <span className="roster-tag">P{entry.playerNumber}</span>
                  {entry.username === roomOwner ? (
                    <span className="host-badge" title={t("host")}><IconCrown /></span>
                  ) : authUsername === roomOwner ? (
                    <button className="roster-make-host" onClick={() => transferHost(entry.peerId)} title={t("makeHost")}>{t("makeHost")}</button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
          <div className="social-block chat-block">
            <p className="form-label">{t("chat")}</p>
            <div className="chat-log">
              {chatMessages.length === 0 && <p className="chat-empty">{t("sayHi")}</p>}
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
                placeholder={t("messagePlaceholder")}
                aria-label={t("chat")}
              />
              <button className="btn-ghost" onClick={sendChat} disabled={!chatInput.trim()}>{t("send")}</button>
            </div>
          </div>
        </aside>
      </div>

      {settingsOpen && (
        <div className="settings-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="settings-panel" onClick={(event) => event.stopPropagation()}>
            <div className="settings-head">
              <h2>{t("settings")}</h2>
              <button className="icon-button" aria-label="Close" onClick={() => setSettingsOpen(false)}><IconClose /></button>
            </div>
            <div className="settings-tabs">
              <button className={settingsTab === "display" ? "tab active" : "tab"} onClick={() => setSettingsTab("display")}>{t("display")}</button>
              <button className={settingsTab === "audio" ? "tab active" : "tab"} onClick={() => setSettingsTab("audio")}>{t("audio")}</button>
              <button className={settingsTab === "controls" ? "tab active" : "tab"} onClick={() => setSettingsTab("controls")}>{isTouchDevice ? t("layout") : t("controls")}</button>
            </div>

            {settingsTab === "display" && (
              <div className="settings-section">
                <p className="settings-label">{t("fieldOfView")}</p>
                <div className="scale-options">
                  {[["fit", "Fit"], ["1", "1×"], ["2", "2×"], ["3", "3×"]].map(([value, label]) => (
                    <button key={value} className={scale === value ? "scale-option active" : "scale-option"} onClick={() => setScale(value)}>{label}</button>
                  ))}
                </div>
              </div>
            )}

            {settingsTab === "audio" && (
              <div className="settings-section">
                <p className="settings-label">{t("volume")}</p>
                <div className="volume-row">
                  <button className="icon-button" aria-label={muted ? t("unmute") : t("mute")} onClick={() => setMuted((v) => !v)}><IconVolume muted={muted} /></button>
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

            {settingsTab === "controls" && isTouchDevice && (
              <div className="settings-section">
                <p className="settings-label">{t("handedness")}</p>
                <div className="scale-options">
                  <button className={touchLayout === "standard" ? "scale-option active" : "scale-option"} onClick={() => setTouchLayout("standard")}>{t("standard")}</button>
                  <button className={touchLayout === "swapped" ? "scale-option active" : "scale-option"} onClick={() => setTouchLayout("swapped")}>{t("lefthanded")}</button>
                </div>
                <p className="settings-label" style={{ marginTop: 10 }}>{t("buttonSize")}</p>
                <div className="scale-options">
                  <button className={touchSize === "compact" ? "scale-option active" : "scale-option"} onClick={() => setTouchSize("compact")}>{t("compact")}</button>
                  <button className={touchSize === "large" ? "scale-option active" : "scale-option"} onClick={() => setTouchSize("large")}>{t("large")}</button>
                </div>
              </div>
            )}

            {settingsTab === "controls" && !isTouchDevice && (
              <div className="settings-section">
                <p className="settings-label">{t("keyboardBindings")} · P{playerNumber ?? 1}</p>
                <ul className="keybind-list">
                  {buttons.map((button) => (
                    <li key={button} className="keybind-row">
                      <span className="keybind-name">{button}</span>
                      <button className="keybind-key" onClick={() => rebindKey(button)}>
                        {rebinding === button ? t("pressAKey") : keyBindings[button]}
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
