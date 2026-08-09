import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { type Lang, loadLang, translate } from "./i18n";
import { isSoundEnabled, setSoundEnabled, playClickSound, playJoinSound, playSuccessSound, playChatSound } from "./soundFx";

type SignalMessage = { type: string; room?: string; from?: string; payload?: any };
type Button = "UP" | "DOWN" | "LEFT" | "RIGHT" | "A" | "B" | "X" | "Y" | "START" | "SELECT" | "L" | "R" | "L2" | "R2";
type RosterEntry = { peerId: string; playerNumber: number; username: string };
type ChatMessage = { username: string; playerNumber?: number; text: string; timestamp: number };
type RomEntry = { file: string; game: "nes" | "snes" | "ps1"; size: number; owner: string | null };

const UPLOAD_INFO: Record<string, { exts: string[]; label: string; maxMB: number }> = {
  nes: { exts: [".nes"], label: ".nes", maxMB: 8 },
  snes: { exts: [".sfc", ".smc"], label: ".sfc · .smc", maxMB: 8 },
  ps1: { exts: [".bin", ".iso", ".img", ".pbp", ".chd"], label: ".bin · .iso · .img · .pbp · .chd", maxMB: 700 },
};
const EXTENSION_TO_GAME: Record<string, string> = {
  ".nes": "nes", ".sfc": "snes", ".smc": "snes",
  ".bin": "ps1", ".iso": "ps1", ".img": "ps1", ".pbp": "ps1", ".chd": "ps1",
};

const CONSOLES: { id: string; label: string; sub: string; active: boolean; hue: string }[] = [
  { id: "nes", label: "NES", sub: "8-bit", active: true, hue: "nes" },
  { id: "snes", label: "SNES", sub: "16-bit", active: true, hue: "snes" },
  { id: "ps1", label: "PS1", sub: "32-bit", active: true, hue: "ps1" },
  { id: "gba", label: "GBA", sub: "Próximamente", active: false, hue: "gba" },
  { id: "genesis", label: "Genesis", sub: "Próximamente", active: false, hue: "genesis" },
  { id: "pce", label: "PC Engine", sub: "Próximamente", active: false, hue: "pce" },
  { id: "gb", label: "Game Boy", sub: "Próximamente", active: false, hue: "gb" },
  { id: "n64", label: "N64", sub: "Próximamente", active: false, hue: "n64" },
];

const signalingUrl = import.meta.env.VITE_SIGNALING_URL ?? "ws://localhost:8080/signaling";
const apiBase = signalingUrl.replace(/^ws/, "http").replace(/\/signaling\/?$/, "");
const roomsUrl = `${apiBase}/rooms`;
const romsUrl = `${apiBase}/roms`;
const defaultRoom = import.meta.env.VITE_ROOM ?? "";
type ActiveRoom = { room: string; peerCount: number; owner: string | null; visibility?: "public" | "private"; game?: string | null; file?: string | null };
const buttons: Button[] = ["UP", "DOWN", "LEFT", "RIGHT", "A", "B", "X", "Y", "L", "R", "L2", "R2", "START", "SELECT"];
// Each console's real controller only has some of these — NES has no X/Y/L/R/L2/R2, SNES has no L2/R2 —
// so bindings and the Settings > Controls list are scoped per console instead of one list of everything.
const CONSOLE_BUTTONS: Record<string, Button[]> = {
  nes: ["UP", "DOWN", "LEFT", "RIGHT", "A", "B", "START", "SELECT"],
  snes: ["UP", "DOWN", "LEFT", "RIGHT", "A", "B", "X", "Y", "L", "R", "START", "SELECT"],
  ps1: ["UP", "DOWN", "LEFT", "RIGHT", "A", "B", "X", "Y", "L", "R", "L2", "R2", "START", "SELECT"],
};
const defaultKeyBindings: Record<Button, string> = {
  UP: "ArrowUp", DOWN: "ArrowDown", LEFT: "ArrowLeft", RIGHT: "ArrowRight",
  A: "z", B: "x", X: "a", Y: "s", L: "q", R: "w", L2: "1", R2: "2", START: "Enter", SELECT: "Shift",
};

// Bindings are stored per console ({ nes: {...}, snes: {...}, ps1: {...} }, each a partial override of the
// defaults above) so rebinding a key for one console never touches another's — the room you're in decides
// which map applies.
function loadKeyBindingsByGame(): Record<string, Partial<Record<Button, string>>> {
  try {
    return JSON.parse(localStorage.getItem("rc_keybindings") ?? "{}");
  } catch {
    return {};
  }
}

// Standard Gamepad API mapping (https://w3c.github.io/gamepad/#remapping): 0=A 1=B 2=X 3=Y 4=LB 5=RB
// 6=LT 7=RT 8=Select 9=Start 12-15=D-pad.
const defaultGamepadBindings: Record<Button, number> = {
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, A: 0, B: 1, X: 2, Y: 3, L: 4, R: 5, L2: 6, R2: 7, START: 9, SELECT: 8,
};

function loadGamepadBindingsByGame(): Record<string, Partial<Record<Button, number>>> {
  try {
    return JSON.parse(localStorage.getItem("rc_gamepad_bindings") ?? "{}");
  } catch {
    return {};
  }
}

// Unlike the passive "remembered zoom" that used to get stuck across sessions, a locked position is an
// explicit save the user opted into (via the pin button) — so, unlike scale, it's fine for this one to
// persist and restore automatically.
type LockedCanvas = { locked: true; x: number; y: number; zoom: number };
function loadLockedCanvas(): LockedCanvas | null {
  try {
    const stored = JSON.parse(localStorage.getItem("rc_canvas_lock") ?? "null");
    return stored?.locked ? stored : null;
  } catch {
    return null;
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
function IconProfile() {
  return <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.5-6 8-6s8 2 8 6" />
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
function IconMove() {
  return <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2v20M2 12h20M5 9l-3 3 3 3M19 9l3 3-3 3M9 5l3-3 3 3M9 19l3 3 3-3" />
  </svg>;
}
function IconPin({ locked }: { locked: boolean }) {
  return locked ? (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.5-2" />
    </svg>
  );
}
function IconRefresh() {
  return <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 4v5h5M20 20v-5h-5" /><path d="M5.5 9A7 7 0 0 1 19 8M18.5 15a7 7 0 0 1-13.5 1" />
  </svg>;
}

function IconLogout() {
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" />
  </svg>;
}
function IconGrid() {
  return <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>;
}
function IconRoomsNav() {
  return <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 11l9-7 9 7" /><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" />
  </svg>;
}
function IconFriends() {
  return <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>;
}

function IconTv({ active }: { active: boolean }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="7" width="20" height="13" rx="2" /><path d="M17 2l-5 5-5-5" />
    {active && <path d="M6 11h12M6 14h12M6 17h12" strokeWidth="1.2" opacity="0.6" />}
  </svg>;
}

function IconSoundFx({ enabled }: { enabled: boolean }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 5L6 9H2v6h4l5 4V5z" />
    {enabled ? <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" /> : <line x1="23" y1="9" x2="17" y2="15" />}
  </svg>;
}

function IconNesConsole() {
  return <svg viewBox="0 0 120 80" width="80" height="53" fill="none">
    <rect x="15" y="20" width="90" height="48" rx="4" fill="#e2e8f0"/>
    <rect x="25" y="20" width="70" height="24" fill="#334155"/>
    <rect x="30" y="26" width="60" height="12" fill="#1e293b"/>
    <rect x="25" y="48" width="14" height="12" fill="#94a3b8"/>
    <rect x="43" y="48" width="14" height="12" fill="#94a3b8"/>
    <circle cx="85" cy="54" r="3" fill="#ef4444"/>
    <circle cx="95" cy="54" r="3" fill="#ef4444"/>
  </svg>;
}
function IconSnesConsole() {
  return <svg viewBox="0 0 120 80" width="80" height="53" fill="none">
    <rect x="15" y="18" width="90" height="50" rx="6" fill="#cbd5e1"/>
    <rect x="25" y="18" width="70" height="16" fill="#8b5cf6"/>
    <rect x="35" y="22" width="50" height="8" fill="#4c1d95"/>
    <rect x="35" y="40" width="50" height="20" rx="3" fill="#94a3b8"/>
    <rect x="42" y="45" width="14" height="10" fill="#8b5cf6"/>
    <rect x="64" y="45" width="14" height="10" fill="#8b5cf6"/>
  </svg>;
}
function IconPs1Console() {
  return <svg viewBox="0 0 120 80" width="80" height="53" fill="none">
    <rect x="15" y="16" width="90" height="52" rx="8" fill="#cbd5e1"/>
    <circle cx="60" cy="42" r="20" fill="#94a3b8"/>
    <circle cx="60" cy="42" r="14" fill="#64748b"/>
    <circle cx="30" cy="30" r="7" fill="#94a3b8"/>
    <circle cx="90" cy="30" r="7" fill="#94a3b8"/>
    <rect x="25" y="54" width="20" height="6" rx="2" fill="#64748b"/>
    <rect x="75" y="54" width="20" height="6" rx="2" fill="#64748b"/>
  </svg>;
}
function IconN64Console() {
  return <svg viewBox="0 0 120 80" width="80" height="53" fill="none">
    <path d="M15 28 C15 20, 105 20, 105 28 L100 64 C100 68, 20 68, 20 64 Z" fill="#1e293b"/>
    <rect x="38" y="22" width="44" height="14" rx="3" fill="#334155"/>
    <rect x="44" y="25" width="32" height="8" rx="2" fill="#0f172a"/>
    <circle cx="30" cy="52" r="6" fill="#dc2626"/>
    <circle cx="90" cy="52" r="6" fill="#2563eb"/>
    <circle cx="78" cy="56" r="4" fill="#ca8a04"/>
    <circle cx="84" cy="46" r="4" fill="#ca8a04"/>
  </svg>;
}
function IconGbaConsole() {
  return <svg viewBox="0 0 120 80" width="80" height="53" fill="none">
    <rect x="10" y="20" width="100" height="46" rx="14" fill="#e056fd"/>
    <rect x="35" y="24" width="50" height="34" rx="4" fill="#0f172a"/>
    <rect x="39" y="27" width="42" height="28" rx="2" fill="#84cc16"/>
    <circle cx="22" cy="43" r="8" fill="#a855f7"/>
    <circle cx="98" cy="38" r="4" fill="#38bdf8"/>
    <circle cx="104" cy="46" r="4" fill="#38bdf8"/>
  </svg>;
}
function IconGenesisConsole() {
  return <svg viewBox="0 0 120 80" width="80" height="53" fill="none">
    <rect x="15" y="18" width="90" height="50" rx="6" fill="#1e293b"/>
    <circle cx="60" cy="42" r="18" fill="#0f172a"/>
    <circle cx="60" cy="42" r="14" stroke="#eab308" strokeWidth="2" fill="none"/>
    <rect x="30" y="22" width="60" height="8" rx="2" fill="#334155"/>
    <rect x="25" y="48" width="16" height="6" fill="#64748b"/>
  </svg>;
}

const JAM_CONSOLES = [
  { id: "snes", name: "SUPER NES", bg: "#8b5cf6", active: true, icon: IconSnesConsole },
  { id: "ps1", name: "PS1", bg: "#00a8ff", active: true, icon: IconPs1Console },
  { id: "n64", name: "NINTENDO 64", bg: "#ff2a6d", active: false, icon: IconN64Console },
  { id: "gba", name: "GBA", bg: "#e056fd", active: false, icon: IconGbaConsole },
  { id: "genesis", name: "GENESIS", bg: "#f0932b", active: false, icon: IconGenesisConsole },
  { id: "nes", name: "NES", bg: "#a55eea", active: true, icon: IconNesConsole },
];

const FEATURED_GAMES = [
  {
    id: "kof98",
    title: "The King of Fighters '98",
    desc: "You can have your 99 hits. My KO just needs 1...",
    bg: "linear-gradient(135deg, #1e3a8a, #0f172a)",
    tags: ["#fighting", "#arcade", "#versus"],
    maxPlayers: "2P",
    game: "ps1",
    players: 1,
  },
  {
    id: "mslugx",
    title: "Metal Slug X",
    desc: "If bullets and bombs don't work, bring in the cannons!",
    bg: "linear-gradient(135deg, #78350f, #1e293b)",
    tags: ["#arcade", "#run and gun", "#shoot'em up"],
    maxPlayers: "2P",
    game: "ps1",
    players: 0,
  },
  {
    id: "bomber",
    title: "Arsène Bomber",
    desc: "Bomb or be bombed? That is the question.",
    bg: "linear-gradient(135deg, #0369a1, #0f172a)",
    tags: ["#action", "#arcade"],
    maxPlayers: "4P",
    game: "snes",
    players: 0,
  },
];

const HASHTAGS = ["#action", "#arcade", "#sports", "#platformer", "#indie", "#shooter", "#puzzle", "#shoot'em up", "#fighting"];

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
  const [authForm, setAuthForm] = useState({ username: "", password: "", email: "" });
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
  const [lobbyView, setLobbyView] = useState<"rooms" | "catalog" | "profile" | "social">("rooms");
  const [roms, setRoms] = useState<RomEntry[]>([]);
  const [selectedRom, setSelectedRom] = useState<string | null>(null);
  const [catalogConsole, setCatalogConsole] = useState<string>("all");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [gameModalRom, setGameModalRom] = useState<RomEntry | null>(null);
  const [ps1BiosReady, setPs1BiosReady] = useState<boolean | null>(null);
  const [biosUploading, setBiosUploading] = useState(false);
  const [biosError, setBiosError] = useState("");
  const [newRoomVisibility, setNewRoomVisibility] = useState<"public" | "private">("public");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadDone, setUploadDone] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [playerNumber, setPlayerNumber] = useState<number | null>(null);
  const [currentGame, setCurrentGame] = useState<string | null>(null);
  const [keyBindingsByGame, setKeyBindingsByGame] = useState<Record<string, Partial<Record<Button, string>>>>(loadKeyBindingsByGame);
  const [rebinding, setRebinding] = useState<Button | null>(null);
  const [gamepadBindingsByGame, setGamepadBindingsByGame] = useState<Record<string, Partial<Record<Button, number>>>>(loadGamepadBindingsByGame);
  const [rebindingGamepad, setRebindingGamepad] = useState<Button | null>(null);
  const [gamepadConnected, setGamepadConnected] = useState(false);
  const gamepadHeldRef = useRef<Set<Button>>(new Set());
  const rebindingGamepadRef = useRef<Button | null>(null);
  const activeConsole = currentGame ?? "ps1";
  const activeConsoleButtons = CONSOLE_BUTTONS[activeConsole] ?? buttons;
  const keyBindings = useMemo<Record<Button, string>>(
    () => ({ ...defaultKeyBindings, ...(keyBindingsByGame[activeConsole] ?? {}) }),
    [keyBindingsByGame, activeConsole],
  );
  const gamepadBindings = useMemo<Record<Button, number>>(
    () => ({ ...defaultGamepadBindings, ...(gamepadBindingsByGame[activeConsole] ?? {}) }),
    [gamepadBindingsByGame, activeConsole],
  );
  const gamepadBindingsRef = useRef(gamepadBindings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"display" | "audio" | "controls">("display");
  const [crtEffect, setCrtEffect] = useState<boolean>(() => localStorage.getItem("rc_crt") === "1");
  const [soundFxEnabled, setSoundFxEnabledState] = useState<boolean>(isSoundEnabled);
  const [roomCopied, setRoomCopied] = useState(false);
  const [pinnedRoms, setPinnedRoms] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("rc_pinned_roms") ?? "[]"); } catch { return []; }
  });
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadCustomName, setUploadCustomName] = useState("");
  const togglePinRom = (file: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    playClickSound();
    setPinnedRoms((prev) => {
      const next = prev.includes(file) ? prev.filter((f) => f !== file) : [...prev, file];
      try { localStorage.setItem("rc_pinned_roms", JSON.stringify(next)); } catch {}
      return next;
    });
  };
  useEffect(() => { localStorage.setItem("rc_crt", crtEffect ? "1" : "0"); }, [crtEffect]);
  const [scale, setScale] = useState<string>("fit");
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
  const [canvasOffset, setCanvasOffset] = useState(() => { const l = loadLockedCanvas(); return l ? { x: l.x, y: l.y } : { x: 0, y: 0 }; });
  const [canvasZoom, setCanvasZoom] = useState(() => loadLockedCanvas()?.zoom ?? 1);
  const [canvasLocked, setCanvasLocked] = useState(() => loadLockedCanvas() !== null);
  const [draggingCanvas, setDraggingCanvas] = useState(false);
  const [canvasHintVisible, setCanvasHintVisible] = useState(false);
  const [canvasToast, setCanvasToast] = useState<string | null>(null);
  const canvasDragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [latencyPopoverOpen, setLatencyPopoverOpen] = useState(false);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [accountPopoverOpen, setAccountPopoverOpen] = useState(false);
  const [profileEmail, setProfileEmail] = useState<string | null>(null);
  const [emailPromptOpen, setEmailPromptOpen] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [friends, setFriends] = useState<{ friends: string[]; incoming: string[]; outgoing: string[] }>({ friends: [], incoming: [], outgoing: [] });
  const [addFriendInput, setAddFriendInput] = useState("");
  const [friendError, setFriendError] = useState("");
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
  const lastGameRef = useRef<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [hudVisible, setHudVisible] = useState(true);
  const hudTimeoutRef = useRef<number | null>(null);

  useEffect(() => () => {
    shouldReconnectRef.current = false;
    if (reconnectTimeoutRef.current) window.clearTimeout(reconnectTimeoutRef.current);
    inputRef.current?.close();
    peerRef.current?.close();
    socketRef.current?.close();
    if (statsIntervalRef.current) window.clearInterval(statsIntervalRef.current);
    void audioCtxRef.current?.close();
  }, []);

  async function refreshRooms() {
    try {
      const response = await fetch(roomsUrl, { headers: authToken ? { authorization: `Bearer ${authToken}` } : {} });
      const data = await response.json() as { rooms: ActiveRoom[] };
      setActiveRooms(data.rooms);
      if (!roomTouched && data.rooms.length > 0) setRoom(data.rooms[0].room);
    } catch {
      setActiveRooms([]);
    }
  }

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
    const ext = `.${file.name.split(".").pop()?.toLowerCase() ?? ""}`;
    const game = EXTENSION_TO_GAME[ext];
    const info = game ? UPLOAD_INFO[game] : null;
    if (!info) {
      setUploadError(`unsupported file type: ${ext}`);
      return;
    }
    if (file.size > info.maxMB * 1024 * 1024) {
      setUploadError(`file is too big — ${info.maxMB} MB max for this console`);
      return;
    }
    setUploading(true);
    setUploadProgress(0);
    setUploadDone(false);
    setUploadError("");
    try {
      const uploaded = await new Promise<RomEntry>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${romsUrl}?filename=${encodeURIComponent(file.name)}`);
        xhr.setRequestHeader("content-type", "application/octet-stream");
        xhr.setRequestHeader("authorization", `Bearer ${authToken}`);
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) setUploadProgress(Math.round((event.loaded / event.total) * 100));
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error("upload failed")); }
          } else {
            const body = (() => { try { return JSON.parse(xhr.responseText); } catch { return {}; } })();
            reject(new Error(body.error ?? `upload failed (${xhr.status})`));
          }
        };
        xhr.onerror = () => reject(new Error("upload failed"));
        xhr.send(file);
      });
      setUploadProgress(100);
      await refreshRoms();
      setSelectedRom(uploaded.file);
      setUploadDone(true);
      window.setTimeout(() => setUploadDone(false), 1800);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function refreshBios() {
    if (!authToken) return;
    try {
      const response = await fetch(`${apiBase}/bios`, { headers: { authorization: `Bearer ${authToken}` } });
      if (!response.ok) return;
      const body = await response.json() as { ps1: boolean };
      setPs1BiosReady(body.ps1);
    } catch { /* ignore transient failures */ }
  }

  async function uploadBios(file: File) {
    if (!authToken) return;
    setBiosUploading(true);
    setBiosError("");
    try {
      const response = await fetch(`${apiBase}/bios/ps1`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", authorization: `Bearer ${authToken}` },
        body: file,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `upload failed (${response.status})`);
      }
      setPs1BiosReady(true);
    } catch (error) {
      setBiosError(error instanceof Error ? error.message : "upload failed");
    } finally {
      setBiosUploading(false);
    }
  }

  async function connect(targetRoom?: string, owner?: string | null, game?: string | null) {
    if (socketRef.current) return;
    const joinRoom = (targetRoom ?? room).trim() || "local";
    const joinOwner = owner ?? lastOwnerRef.current ?? activeRooms.find((r) => r.room === joinRoom)?.owner ?? null;
    const joinGame = game ?? lastGameRef.current ?? activeRooms.find((r) => r.room === joinRoom)?.game ?? null;
    lastRoomRef.current = joinRoom;
    lastOwnerRef.current = joinOwner;
    lastGameRef.current = joinGame;
    shouldReconnectRef.current = true;
    if (reconnectTimeoutRef.current) { window.clearTimeout(reconnectTimeoutRef.current); reconnectTimeoutRef.current = null; }
    setRoom(joinRoom);
    setRoomTouched(true);
    setRoomOwner(joinOwner);
    setCurrentGame(joinGame);
    setStatus("Connecting");
    myPeerIdRef.current = null;
    hostPeerIdRef.current = null;
    heldButtonsRef.current.clear();
    setMobilePanelOpen(false);
    setRoster([]);
    setChatMessages([]);
    if (!canvasLocked) { setCanvasOffset({ x: 0, y: 0 }); setCanvasZoom(1); }
    setCanvasHintVisible(!canvasLocked);
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
          void connect(lastRoomRef.current, lastOwnerRef.current, lastGameRef.current);
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
      setAuthForm({ username: "", password: "", email: "" });
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "authentication failed");
    } finally {
      setAuthLoading(false);
    }
  }

  async function refreshFriends() {
    if (!authToken) return;
    try {
      const response = await fetch(`${apiBase}/friends`, { headers: { authorization: `Bearer ${authToken}` } });
      if (response.ok) setFriends(await response.json());
    } catch {
      // ignore transient failures
    }
  }

  async function saveEmail() {
    if (!authToken || !emailInput.trim()) return;
    setEmailSaving(true);
    setEmailError("");
    try {
      const response = await fetch(`${apiBase}/auth/email`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ email: emailInput.trim() }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "failed to save email");
      }
      setProfileEmail(emailInput.trim());
      setEmailPromptOpen(false);
    } catch (error) {
      setEmailError(error instanceof Error ? error.message : "failed to save email");
    } finally {
      setEmailSaving(false);
    }
  }

  async function sendFriendRequest() {
    if (!authToken || !addFriendInput.trim()) return;
    setFriendError("");
    try {
      const response = await fetch(`${apiBase}/friends/request`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ username: addFriendInput.trim() }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "failed to send friend request");
      }
      setAddFriendInput("");
      await refreshFriends();
    } catch (error) {
      setFriendError(error instanceof Error ? error.message : "failed to send friend request");
    }
  }

  async function respondFriendRequest(username: string, accept: boolean) {
    if (!authToken) return;
    await fetch(`${apiBase}/friends/respond`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ username, accept }),
    });
    await refreshFriends();
  }

  async function removeFriend(username: string) {
    if (!authToken) return;
    await fetch(`${apiBase}/friends/${encodeURIComponent(username)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${authToken}` },
    });
    await refreshFriends();
  }

  useEffect(() => {
    if (!authToken) { setProfileEmail(null); return; }
    (async () => {
      try {
        const response = await fetch(`${apiBase}/auth/me`, { headers: { authorization: `Bearer ${authToken}` } });
        if (!response.ok) return;
        const profile = await response.json() as { email: string | null };
        setProfileEmail(profile.email);
        if (!profile.email) setEmailPromptOpen(true);
      } catch {
        // ignore transient failures
      }
      void refreshFriends();
      void refreshBios();
    })();
  }, [authToken]);

  function logout() {
    if (authToken) void fetch(`${apiBase}/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${authToken}` } });
    localStorage.removeItem("rc_token");
    localStorage.removeItem("rc_username");
    setAuthToken(null);
    setAuthUsername(null);
  }

  async function createRoom(file?: string) {
    const targetFile = file ?? selectedRom;
    if (!authToken || !targetFile) return;
    setCreating(true);
    setCreateError("");
    try {
      const response = await fetch(roomsUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ file: targetFile, visibility: newRoomVisibility }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `failed to create room (${response.status})`);
      }
      const data = await response.json() as { room: string };
      await connect(data.room, authUsername, roms.find((r) => r.file === targetFile)?.game ?? null);
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


  useEffect(() => { localStorage.setItem("rc_touch_layout", touchLayout); }, [touchLayout]);
  useEffect(() => { localStorage.setItem("rc_touch_size", touchSize); }, [touchSize]);

  useEffect(() => {
    const onFsChange = () => { if (!document.fullscreenElement) setIsFullscreen(false); };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  async function toggleFullscreen() {
    // iOS Safari doesn't reliably support (or, pre-16.4, doesn't support at all) the Fullscreen API on
    // an arbitrary element, and can silently no-op. A CSS-driven "pseudo-fullscreen" (fixed, covers the
    // full dynamic viewport) is what actually maximizes the game there; on browsers that do support real
    // fullscreen we still request it too, so the browser chrome hides where possible.
    if (isFullscreen) {
      setIsFullscreen(false);
      if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch { /* ignore */ } }
      return;
    }
    setIsFullscreen(true);
    if (stageWrapRef.current?.requestFullscreen) {
      try { await stageWrapRef.current.requestFullscreen(); } catch { /* CSS fallback still applies */ }
    }
  }

  function onCanvasPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (canvasLocked) return;
    if (event.button !== 0 && event.pointerType === "mouse") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggingCanvas(true);
    setCanvasHintVisible(false);
    canvasDragRef.current = { startX: event.clientX, startY: event.clientY, originX: canvasOffset.x, originY: canvasOffset.y };
  }
  function onCanvasPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = canvasDragRef.current;
    if (!drag) return;
    setCanvasOffset({ x: drag.originX + (event.clientX - drag.startX), y: drag.originY + (event.clientY - drag.startY) });
  }
  function onCanvasPointerUp() {
    canvasDragRef.current = null;
    setDraggingCanvas(false);
  }
  function resetCanvasPosition() {
    setCanvasOffset({ x: 0, y: 0 });
    setCanvasZoom(1);
  }
  function toggleCanvasLock() {
    if (canvasLocked) {
      setCanvasLocked(false);
      localStorage.removeItem("rc_canvas_lock");
      setCanvasToast(t("positionUnlocked"));
    } else {
      setCanvasLocked(true);
      localStorage.setItem("rc_canvas_lock", JSON.stringify({ locked: true, x: canvasOffset.x, y: canvasOffset.y, zoom: canvasZoom }));
      setCanvasToast(t("positionLocked"));
    }
    window.setTimeout(() => setCanvasToast(null), 1800);
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
      const next = { ...keyBindingsByGame, [activeConsole]: { ...(keyBindingsByGame[activeConsole] ?? {}), [rebinding]: event.key } };
      setKeyBindingsByGame(next);
      localStorage.setItem("rc_keybindings", JSON.stringify(next));
      setRebinding(null);
    };
    window.addEventListener("keydown", capture, { once: true });
    return () => window.removeEventListener("keydown", capture);
  }, [rebinding, keyBindingsByGame, activeConsole]);

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

  useEffect(() => { gamepadBindingsRef.current = gamepadBindings; }, [gamepadBindings]);
  useEffect(() => { rebindingGamepadRef.current = rebindingGamepad; }, [rebindingGamepad]);

  useEffect(() => {
    const onConnect = () => setGamepadConnected(true);
    const onDisconnect = () => { if (navigator.getGamepads().every((gp) => !gp)) setGamepadConnected(false); };
    window.addEventListener("gamepadconnected", onConnect);
    window.addEventListener("gamepaddisconnected", onDisconnect);
    if (navigator.getGamepads().some((gp) => gp)) setGamepadConnected(true);
    return () => {
      window.removeEventListener("gamepadconnected", onConnect);
      window.removeEventListener("gamepaddisconnected", onDisconnect);
    };
  }, []);

  // Polls the Gamepad API every frame — it has no press/release events, only a live snapshot — and either
  // captures the next pressed button while rebinding, or forwards held/released buttons like the keyboard.
  useEffect(() => {
    if (status === "Disconnected") return;
    let raf = 0;
    const tick = () => {
      const pad = navigator.getGamepads().find((gp) => gp && gp.connected);
      if (pad) {
        const rebindTarget = rebindingGamepadRef.current;
        if (rebindTarget) {
          const pressedIndex = pad.buttons.findIndex((b) => b.pressed || b.value > 0.5);
          if (pressedIndex >= 0) {
            const next = { ...gamepadBindingsByGame, [activeConsole]: { ...(gamepadBindingsByGame[activeConsole] ?? {}), [rebindTarget]: pressedIndex } };
            setGamepadBindingsByGame(next);
            localStorage.setItem("rc_gamepad_bindings", JSON.stringify(next));
            setRebindingGamepad(null);
          }
        } else {
          for (const button of buttons) {
            const index = gamepadBindingsRef.current[button];
            const gamepadButton = pad.buttons[index];
            const pressed = !!gamepadButton && (gamepadButton.pressed || gamepadButton.value > 0.5);
            const wasHeld = gamepadHeldRef.current.has(button);
            if (pressed !== wasHeld) {
              if (pressed) gamepadHeldRef.current.add(button); else gamepadHeldRef.current.delete(button);
              sendInput(button, pressed);
            }
          }
        }
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [status, activeConsole, gamepadBindingsByGame]);

  useEffect(() => {
    if (!canvasHintVisible) return;
    const timer = window.setTimeout(() => setCanvasHintVisible(false), 5000);
    return () => window.clearTimeout(timer);
  }, [canvasHintVisible]);

  const inLobby = status === "Disconnected";

  function flashHud() {
    setHudVisible(true);
    if (hudTimeoutRef.current) window.clearTimeout(hudTimeoutRef.current);
    hudTimeoutRef.current = window.setTimeout(() => setHudVisible(false), 3000);
  }

  useEffect(() => {
    if (!inLobby && isTouchDevice) {
      flashHud();
      return () => { if (hudTimeoutRef.current) window.clearTimeout(hudTimeoutRef.current); };
    }
  }, [inLobby, isTouchDevice]);

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
            {authMode === "register" && (
              <>
                <label className="auth-field-label" htmlFor="auth-email">{t("email")}</label>
                <input id="auth-email" className="field" type="email" value={authForm.email} onChange={(e) => setAuthForm((f) => ({ ...f, email: e.target.value }))} placeholder="you@example.com" aria-label={t("email")} autoComplete="email" />
              </>
            )}
            <label className="auth-field-label" htmlFor="auth-password">{t("password")}</label>
            <input id="auth-password" className="field" type="password" value={authForm.password} onChange={(e) => setAuthForm((f) => ({ ...f, password: e.target.value }))} placeholder="••••••••" aria-label={t("password")} autoComplete={authMode === "login" ? "current-password" : "new-password"} />
            <button className="btn-primary" onClick={submitAuth} disabled={authLoading || !authForm.username || !authForm.password || (authMode === "register" && !authForm.email)}>
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
      <nav className="side-rail">
        <div className="side-rail-brand"><span className="brand-mark">◆</span></div>
        <div className="side-rail-nav">
          <button className={lobbyView === "catalog" ? "side-rail-btn active" : "side-rail-btn"} onClick={() => setLobbyView("catalog")}>
            <IconGrid /><span>{t("catalogTab")}</span>
          </button>
          <button className={lobbyView === "rooms" ? "side-rail-btn active" : "side-rail-btn"} onClick={() => setLobbyView("rooms")}>
            <IconRoomsNav /><span>{t("roomsTab")}</span>
          </button>
          <button className={lobbyView === "social" ? "side-rail-btn active" : "side-rail-btn"} onClick={() => setLobbyView("social")}>
            <IconFriends /><span>{t("socialTab")}</span>
          </button>
        </div>
        <div className="side-rail-bottom">
          <LangToggle lang={lang} setLang={setLang} />
          <button className="side-rail-avatar-btn" onClick={() => setAccountPopoverOpen((v) => !v)} aria-label={t("account")}>
            <span className="roster-avatar small">{(authUsername ?? "?").slice(0, 1).toUpperCase()}</span>
            {friends.incoming.length > 0 && <span className="fab-badge inline-badge" />}
          </button>
          <button className="side-rail-logout" onClick={logout} aria-label={t("logOut")}><IconLogout /></button>
        </div>
      </nav>
    )}

    {inLobby && (
      <nav className="bottom-tab-bar">
        <button className={lobbyView === "catalog" ? "bottom-tab active" : "bottom-tab"} onClick={() => setLobbyView("catalog")}>
          <IconGrid /><span>{t("catalogTab")}</span>
        </button>
        <button className={lobbyView === "rooms" ? "bottom-tab active" : "bottom-tab"} onClick={() => setLobbyView("rooms")}>
          <IconRoomsNav /><span>{t("roomsTab")}</span>
        </button>
        <button className={lobbyView === "social" ? "bottom-tab active" : "bottom-tab"} onClick={() => setLobbyView("social")}>
          <IconFriends /><span>{t("socialTab")}</span>
        </button>
        <button className="bottom-tab" onClick={() => setAccountPopoverOpen(true)}>
          <span className="roster-avatar small" style={{ position: "relative" }}>
            {(authUsername ?? "?").slice(0, 1).toUpperCase()}
            {friends.incoming.length > 0 && <span className="fab-badge inline-badge" />}
          </span>
          <span>{t("account")}</span>
        </button>
      </nav>
    )}



    {inLobby && accountPopoverOpen && (
      <>
        <div className="popover-backdrop" onClick={() => setAccountPopoverOpen(false)} />
        <div className="account-popover">
          <div className="account-popover-head">
            <span className="roster-avatar">{(authUsername ?? "?").slice(0, 1).toUpperCase()}</span>
            <p className="account-popover-name">{authUsername}</p>
          </div>
          <button className="account-popover-item" onClick={() => { setLobbyView("profile"); setAccountPopoverOpen(false); }}>
            <IconProfile /> {t("goToProfile")}
          </button>
          <div className="account-popover-item account-popover-plan">
            <IconCrown /> {t("plan")}
            <span className="soon-badge">{t("comingSoon")}</span>
          </div>
          <button className="btn-danger account-popover-logout" onClick={logout}>{t("logOut")}</button>
        </div>
      </>
    )}

    {emailPromptOpen && authToken && (
      <div className="settings-backdrop">
        <div className="settings-panel email-prompt">
          <div className="settings-head">
            <h2>{t("addEmailTitle")}</h2>
            {profileEmail && <button className="icon-button" aria-label="Close" onClick={() => setEmailPromptOpen(false)}><IconClose /></button>}
          </div>
          <p className="lobby-sub">{t("addEmailSub")}</p>
          <input
            className="field"
            type="email"
            value={emailInput}
            onChange={(event) => setEmailInput(event.target.value)}
            placeholder="you@example.com"
            aria-label={t("email")}
          />
          {emailError && <p className="form-error">{emailError}</p>}
          <button className="btn-primary" onClick={saveEmail} disabled={emailSaving || !emailInput.trim()}>
            {emailSaving ? "…" : t("save")}
          </button>
        </div>
      </div>
    )}

    {inLobby && lobbyView === "rooms" && (
      <section className="lobby">
        <div className="lobby-head">
          <div>
            <h2>{t("roomsInSession")}</h2>
            <p className="lobby-sub">{t("lobbySub")}</p>
          </div>
          <button className="btn-ghost" onClick={() => void refreshRooms()}><IconRefresh /> {t("refresh")}</button>
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
              <button key={entry.room} className="room-card" onClick={() => connect(entry.room, entry.owner, entry.game)}>
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
        {/* Header Toolbar (Search + Hashtags) */}
        <div className="jam-header-bar">
          <div className="jam-search-box">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input
              className="jam-search-input"
              value={catalogSearch}
              onChange={(event) => setCatalogSearch(event.target.value)}
              placeholder={t("searchGames")}
              aria-label={t("searchGames")}
            />
          </div>
          <div className="jam-hashtags-row">
            {HASHTAGS.map((tag) => (
              <button
                key={tag}
                className={`jam-hashtag-pill${catalogSearch === tag ? " active" : ""}`}
                onClick={() => { setCatalogSearch(catalogSearch === tag ? "" : tag); playClickSound(); }}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>

        {/* Featured / Pinned ROMs */}
        <div className="jam-section">
          {pinnedRoms.length === 0 ? (
            <div className="featured-empty-banner">
              <span className="featured-empty-icon">⭐</span>
              <h3 className="featured-empty-title">{t("featuredEmptyTitle")}</h3>
              <p className="featured-empty-desc">{t("featuredEmptyDesc")}</p>
            </div>
          ) : (
            <>
              <h3 className="netflix-row-title">{t("featuredTitle")}</h3>
              <div className="jam-featured-grid">
                {roms.filter(r => pinnedRoms.includes(r.file)).map((rom) => {
                  const roomsForGame = activeRooms.filter((r) => r.file === rom.file && r.visibility !== "private");
                  const bgColors: Record<string, string> = {
                    nes: "linear-gradient(135deg, #a55eea, #0f172a)",
                    snes: "linear-gradient(135deg, #8b5cf6, #0f172a)",
                    ps1: "linear-gradient(135deg, #00a8ff, #0f172a)",
                  };
                  return (
                    <div
                      key={rom.file}
                      className="jam-featured-card"
                      onClick={() => { playClickSound(); setSelectedRom(rom.file); setGameModalRom(rom); }}
                    >
                      <div className="jam-featured-banner">
                        <div className="jam-featured-banner-bg" style={{ background: bgColors[rom.game] ?? bgColors.ps1 }} />
                        <div className="jam-featured-overlay" />
                        <button
                          className="pin-btn pinned featured-pin"
                          title="Desfijar de Destacados"
                          onClick={(e) => togglePinRom(rom.file, e)}
                        >
                          ⭐
                        </button>
                        {roomsForGame.length > 0 && (
                          <span className="jam-player-badge"><span className="live-pulse" /> {roomsForGame.length} {t("playing")}</span>
                        )}
                        <div className="jam-featured-content">
                          <h3 className="jam-featured-title">{rom.file.replace(/\.(nes|sfc|smc|bin|iso|img|pbp|chd)$/i, "")}</h3>
                          <p className="jam-featured-desc">{rom.game.toUpperCase()} · {(rom.size / 1024 / 1024).toFixed(1)} MB</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Netflix Row 2: Consolas y Emuladores 🕹️ */}
        <div className="netflix-row">
          <h3 className="netflix-row-title">Categorías por Consola 🕹️</h3>
          <div className="jam-consoles-grid">
            {JAM_CONSOLES.map((c) => {
              const ConsoleIcon = c.icon;
              const isSelected = catalogConsole === c.id;
              return (
                <div
                  key={c.id}
                  className="jam-console-card"
                  style={{ background: c.bg, opacity: c.active ? 1 : 0.55 }}
                  onClick={() => {
                    playClickSound();
                    if (c.active) setCatalogConsole(isSelected ? "all" : c.id);
                  }}
                >
                  <span className="jam-console-title">{c.name}</span>
                  <div className="jam-console-icon">
                    <ConsoleIcon />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Netflix Row 3: Super Nintendo (SNES) */}
        {roms.some(r => r.game === "snes") && (
          <div className="netflix-row">
            <h3 className="netflix-row-title">Juegos de Super Nintendo (SNES) 💜</h3>
            <div className="netflix-row-scroll">
              {roms.filter(r => r.game === "snes").map((rom) => {
                const isPinned = pinnedRoms.includes(rom.file);
                const roomsForGame = activeRooms.filter((r) => r.file === rom.file && r.visibility !== "private");
                return (
                  <div
                    key={rom.file}
                    className="netflix-card"
                    onClick={() => { playClickSound(); setSelectedRom(rom.file); setGameModalRom(rom); }}
                  >
                    <div className="netflix-card-cover console-snes" />
                    <button
                      className={`pin-btn${isPinned ? " pinned" : ""}`}
                      title={isPinned ? "Desfijar de Mis Pines" : "Fijar a Mis Pines"}
                      onClick={(e) => togglePinRom(rom.file, e)}
                    >
                      📌
                    </button>
                    {roomsForGame.length > 0 && (
                      <span className="poster-live-badge"><span className="live-pulse" /> {roomsForGame.length}</span>
                    )}
                    <div className="netflix-card-overlay">
                      <h4 className="netflix-card-title">{rom.file.replace(/\.(nes|sfc|smc)$/i, "")}</h4>
                      <p className="netflix-card-sub">SNES · {(rom.size / 1024 / 1024).toFixed(1)} MB</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Netflix Row 4: PlayStation 1 (PS1) */}
        {roms.some(r => r.game === "ps1") && (
          <div className="netflix-row">
            <h3 className="netflix-row-title">Juegos de PlayStation 1 (PS1) 🟦</h3>
            <div className="netflix-row-scroll">
              {roms.filter(r => r.game === "ps1").map((rom) => {
                const isPinned = pinnedRoms.includes(rom.file);
                const roomsForGame = activeRooms.filter((r) => r.file === rom.file && r.visibility !== "private");
                return (
                  <div
                    key={rom.file}
                    className="netflix-card"
                    onClick={() => { playClickSound(); setSelectedRom(rom.file); setGameModalRom(rom); }}
                  >
                    <div className="netflix-card-cover console-ps1" />
                    <button
                      className={`pin-btn${isPinned ? " pinned" : ""}`}
                      title={isPinned ? "Desfijar de Mis Pines" : "Fijar a Mis Pines"}
                      onClick={(e) => togglePinRom(rom.file, e)}
                    >
                      📌
                    </button>
                    {roomsForGame.length > 0 && (
                      <span className="poster-live-badge"><span className="live-pulse" /> {roomsForGame.length}</span>
                    )}
                    <div className="netflix-card-overlay">
                      <h4 className="netflix-card-title">{rom.file.replace(/\.(bin|iso|img|pbp|chd)$/i, "")}</h4>
                      <p className="netflix-card-sub">PS1 · {(rom.size / 1024 / 1024).toFixed(1)} MB</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Netflix Row 5: NES 8-Bit */}
        {roms.some(r => r.game === "nes") && (
          <div className="netflix-row">
            <h3 className="netflix-row-title">Juegos de NES 8-Bit (NES) 🟥</h3>
            <div className="netflix-row-scroll">
              {roms.filter(r => r.game === "nes").map((rom) => {
                const isPinned = pinnedRoms.includes(rom.file);
                const roomsForGame = activeRooms.filter((r) => r.file === rom.file && r.visibility !== "private");
                return (
                  <div
                    key={rom.file}
                    className="netflix-card"
                    onClick={() => { playClickSound(); setSelectedRom(rom.file); setGameModalRom(rom); }}
                  >
                    <div className="netflix-card-cover console-nes" />
                    <button
                      className={`pin-btn${isPinned ? " pinned" : ""}`}
                      title={isPinned ? "Desfijar de Mis Pines" : "Fijar a Mis Pines"}
                      onClick={(e) => togglePinRom(rom.file, e)}
                    >
                      📌
                    </button>
                    {roomsForGame.length > 0 && (
                      <span className="poster-live-badge"><span className="live-pulse" /> {roomsForGame.length}</span>
                    )}
                    <div className="netflix-card-overlay">
                      <h4 className="netflix-card-title">{rom.file.replace(/\.nes$/i, "")}</h4>
                      <p className="netflix-card-sub">NES · {(rom.size / 1024 / 1024).toFixed(1)} MB</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Netflix Row 6: Toda Tu Biblioteca de ROMs */}
        <div className="netflix-row">
          <h3 className="netflix-row-title">Tus ROMs Cargadas 🎮</h3>
          {roms.length === 0 ? (
            <div className="empty-state">
              <div className="empty-glyph">▢</div>
              <p>{t("noRomsUploaded")}</p>
              <span>{t("uploadFromPanel")}</span>
            </div>
          ) : (() => {
            const search = catalogSearch.trim().toLowerCase();
            const visible = roms.filter((rom) =>
              (catalogConsole === "all" || rom.game === catalogConsole) &&
              (!search || rom.file.toLowerCase().includes(search) || search.startsWith("#")));
            if (visible.length === 0) {
              return <div className="empty-state"><div className="empty-glyph">▢</div><p>{t("noResults")}</p></div>;
            }
            return (
              <div className="netflix-row-scroll">
                {visible.map((rom) => {
                  const isPinned = pinnedRoms.includes(rom.file);
                  const roomsForGame = activeRooms.filter((r) => r.file === rom.file && r.visibility !== "private");
                  return (
                    <div
                      key={rom.file}
                      role="button"
                      tabIndex={0}
                      className="netflix-card"
                      onClick={() => { playClickSound(); setSelectedRom(rom.file); setGameModalRom(rom); }}
                    >
                      <div className={`netflix-card-cover console-${rom.game}`} />
                      <button
                        className={`pin-btn${isPinned ? " pinned" : ""}`}
                        title={isPinned ? "Desfijar de Mis Pines" : "Fijar a Mis Pines"}
                        onClick={(e) => togglePinRom(rom.file, e)}
                      >
                        📌
                      </button>
                      {roomsForGame.length > 0 && (
                        <span className="poster-live-badge"><span className="live-pulse" /> {roomsForGame.length}</span>
                      )}
                      <div className="netflix-card-overlay">
                        {rom.owner === authUsername && (
                          <button
                            className="game-card-delete"
                            aria-label={t("deleteRom")}
                            onClick={(event) => { event.stopPropagation(); void deleteRom(rom.file); }}
                          >
                            <IconClose />
                          </button>
                        )}
                        <h4 className="netflix-card-title">{rom.file.replace(/\.(nes|sfc|smc|bin|iso|img|pbp|chd)$/i, "")}</h4>
                        <p className="netflix-card-sub">{rom.game.toUpperCase()} · {(rom.size / 1024 / 1024).toFixed(1)} MB</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>

        {/* Upload ROM Button */}
        <div className="lobby-card catalog-upload-card">
          <button className="upload-rom-btn" onClick={() => setUploadModalOpen(true)}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span>{t("uploadRom")}</span>
          </button>
        </div>

        {ps1BiosReady === false && (
          <div className="lobby-card catalog-upload-card">
            <p className="form-label">{t("uploadBios")}</p>
            <span className="lobby-card-hint">{t("uploadBiosHint")}</span>
            <label className="upload-drop">
              <input
                type="file"
                accept=".bin"
                disabled={biosUploading || !authToken}
                onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadBios(file); event.target.value = ""; }}
                aria-label={t("uploadBios")}
              />
              <span>{biosUploading ? t("uploading") : t("chooseFileDrop")}</span>
            </label>
            {biosError && <p className="form-error">{biosError}</p>}
          </div>
        )}
      </section>
    )}

    {inLobby && lobbyView === "profile" && (
      <section className="lobby">
        <div className="lobby-head">
          <div>
            <h2>{t("profileTitle")}</h2>
            <p className="lobby-sub">{t("profileSub")}</p>
          </div>
        </div>

        <div className="profile-grid">
          <div className="lobby-card profile-card">
            <div className="profile-card-avatar-row">
              <span className="roster-avatar profile-avatar">{(authUsername ?? "?").slice(0, 1).toUpperCase()}</span>
              <div>
                <p className="profile-username">{authUsername}</p>
                <p className="lobby-card-hint" style={{ margin: 0 }}>{t("memberSince")}</p>
              </div>
            </div>
            <p className="form-label" style={{ marginTop: 8 }}>{t("email")}</p>
            <p className="account-popover-email">
              {profileEmail ?? t("noEmailSet")}
              <button className="link-button" onClick={() => { setEmailInput(profileEmail ?? ""); setEmailPromptOpen(true); }}>{t("edit")}</button>
            </p>
          </div>

          <div className="lobby-card profile-card">
            <p className="form-label">{t("plan")}</p>
            <div className="profile-plan-row">
              <div>
                <p className="profile-plan-name">{t("freePlan")}</p>
                <span className="lobby-card-hint">{t("planHint")}</span>
              </div>
              <span className="soon-badge">{t("comingSoon")}</span>
            </div>
          </div>

          <div className="lobby-card profile-card">
            <p className="form-label">{t("friends")} · {friends.friends.length}</p>
            {friends.incoming.length > 0 && (
              <ul className="friend-list">
                {friends.incoming.map((name) => (
                  <li key={name} className="friend-row">
                    <span className="roster-avatar small">{name.slice(0, 1).toUpperCase()}</span>
                    <span className="friend-name">{name}</span>
                    <button className="btn-primary friend-accept" onClick={() => respondFriendRequest(name, true)}>{t("accept")}</button>
                    <button className="link-button" onClick={() => respondFriendRequest(name, false)}>{t("decline")}</button>
                  </li>
                ))}
              </ul>
            )}
            {friends.friends.length > 0 && (
              <ul className="friend-list">
                {friends.friends.map((name) => (
                  <li key={name} className="friend-row">
                    <span className="roster-avatar small">{name.slice(0, 1).toUpperCase()}</span>
                    <span className="friend-name">{name}</span>
                    <button className="link-button" onClick={() => removeFriend(name)}>{t("remove")}</button>
                  </li>
                ))}
              </ul>
            )}
            {friends.friends.length === 0 && friends.incoming.length === 0 && (
              <p className="lobby-card-hint">{t("noFriendsYet")}</p>
            )}
            <div className="form-row" style={{ marginTop: 8 }}>
              <input
                className="field"
                value={addFriendInput}
                onChange={(event) => setAddFriendInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") sendFriendRequest(); }}
                placeholder={t("addFriendPlaceholder")}
                aria-label={t("addFriendPlaceholder")}
              />
              <button className="btn-ghost" onClick={sendFriendRequest} disabled={!addFriendInput.trim()}>{t("add")}</button>
            </div>
            {friendError && <p className="form-error">{friendError}</p>}
          </div>

          <div className="lobby-card profile-card">
            <p className="form-label">{t("language")}</p>
            <LangToggle lang={lang} setLang={setLang} />
          </div>
        </div>
      </section>
    )}

    {inLobby && lobbyView === "social" && (
      <section className="lobby">
        <div className="lobby-head">
          <div>
            <h2>{t("socialTitle")}</h2>
            <p className="lobby-sub">{t("socialSub")}</p>
          </div>
          <button className="btn-ghost" onClick={() => void refreshFriends()}><IconRefresh /> {t("refresh")}</button>
        </div>

        {/* Add Friend */}
        <div className="lobby-card">
          <p className="form-label">{t("addFriend")}</p>
          <div className="form-row">
            <input
              className="field"
              value={addFriendInput}
              onChange={(event) => setAddFriendInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") sendFriendRequest(); }}
              placeholder={t("addFriendPlaceholder")}
              aria-label={t("addFriendPlaceholder")}
            />
            <button className="btn-ghost" onClick={sendFriendRequest} disabled={!addFriendInput.trim()}>{t("add")}</button>
          </div>
          {friendError && <p className="form-error">{friendError}</p>}
        </div>

        {/* Pending Requests */}
        {friends.incoming.length > 0 && (
          <div className="lobby-card">
            <p className="form-label">{t("pendingRequests")} · {friends.incoming.length}</p>
            <ul className="friend-list">
              {friends.incoming.map((name) => (
                <li key={name} className="friend-row">
                  <span className="roster-avatar small">{name.slice(0, 1).toUpperCase()}</span>
                  <span className="friend-name">{name}</span>
                  <button className="btn-primary friend-accept" onClick={() => respondFriendRequest(name, true)}>{t("accept")}</button>
                  <button className="link-button" onClick={() => respondFriendRequest(name, false)}>{t("decline")}</button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Friends List */}
        <div className="lobby-card">
          <p className="form-label">{t("friends")} · {friends.friends.length}</p>
          {friends.friends.length === 0 ? (
            <p className="lobby-card-hint">{t("noFriendsYet")}</p>
          ) : (
            <ul className="friend-list">
              {friends.friends.map((name) => {
                const friendRoom = activeRooms.find((r) => r.owner === name && r.visibility !== "private");
                const isOnline = !!friendRoom;
                return (
                  <li key={name} className="friend-row">
                    <span className={`roster-avatar small ${isOnline ? "online" : ""}`}>{name.slice(0, 1).toUpperCase()}</span>
                    <span className="friend-name">
                      {name}
                      {isOnline && <span className="friend-status">{t("playing")}</span>}
                    </span>
                    {isOnline && friendRoom && (
                      <button className="btn-primary" onClick={() => connect(friendRoom.room, friendRoom.owner, friendRoom.game)}>
                        {t("joinFriend")}
                      </button>
                    )}
                    <button className="link-button" onClick={() => removeFriend(name)}>{t("remove")}</button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    )}

    {inLobby && gameModalRom && (
      <div className="settings-backdrop game-modal-backdrop" onClick={() => setGameModalRom(null)}>
        <div className="game-modal" onClick={(event) => event.stopPropagation()}>
          <div className={`game-modal-hero console-${gameModalRom.game}`}>
            <button className="icon-button game-modal-close" aria-label="Close" onClick={() => setGameModalRom(null)}><IconClose /></button>
            <span className="game-modal-glyph">{gameModalRom.game === "nes" ? "▮▮" : gameModalRom.game === "snes" ? "▮▮▮" : "◉"}</span>
            <h2 className="game-modal-title">{gameModalRom.file.replace(/\.(nes|sfc|smc|bin|iso|img|pbp|chd)$/i, "")}</h2>
            <span className="poster-tag game-modal-tag">{gameModalRom.game.toUpperCase()}</span>
          </div>

          <div className="game-modal-body">
            <div className="visibility-toggle" role="group" aria-label={t("visibility")}>
              <button className={newRoomVisibility === "public" ? "visibility-option active" : "visibility-option"} onClick={() => setNewRoomVisibility("public")}><IconGlobe /> {t("public")}</button>
              <button className={newRoomVisibility === "private" ? "visibility-option active" : "visibility-option"} onClick={() => setNewRoomVisibility("private")}><IconLock /> {t("private")}</button>
            </div>
            <button
              className="btn-primary game-modal-create"
              onClick={() => { setSelectedRom(gameModalRom.file); void createRoom(gameModalRom.file); }}
              disabled={creating}
            >
              {creating ? t("starting") : t("createNewRoom")}
            </button>
            {createError && <p className="form-error">{createError}</p>}

            <div className="game-modal-rooms-head">
              <p className="form-label showcase-label">{t("publicRooms")}</p>
              <button className="icon-button game-modal-refresh" aria-label={t("refresh")} onClick={() => void refreshRooms()}><IconRefresh /></button>
            </div>

            {(() => {
              const rooms = activeRooms.filter((r) => r.file === gameModalRom.file && r.visibility !== "private");
              if (rooms.length === 0) {
                return <p className="lobby-card-hint game-modal-empty">{t("noPublicRoomsForGame")}</p>;
              }
              return (
                <ul className="room-list">
                  {rooms.map((entry) => (
                    <li key={entry.room} className="room-row" role="button" tabIndex={0} onClick={() => { setGameModalRom(null); void connect(entry.room, entry.owner, entry.game); }}>
                      <span className="live-pulse" />
                      <span className="roster-avatar small">{(entry.owner ?? "?").slice(0, 1).toUpperCase()}</span>
                      <span className="room-row-info">
                        <span className="room-row-title">{entry.room}</span>
                        <span className="room-row-sub">{entry.owner ? `${t("hostedBy")} ${entry.owner}` : t("unowned")} · {entry.peerCount} {t("playersCount")}</span>
                      </span>
                      <span className="room-row-cta">{t("joinRoom")}</span>
                    </li>
                  ))}
                </ul>
              );
            })()}
          </div>
        </div>
      </div>
    )}

    {inLobby && uploadModalOpen && (
      <div className="settings-backdrop game-modal-backdrop" onClick={() => { setUploadModalOpen(false); setUploadCustomName(""); setUploadError(""); }}>
        <div className="game-modal upload-modal" onClick={(event) => event.stopPropagation()}>
          <div className="game-modal-hero upload-modal-hero">
            <button className="icon-button game-modal-close" aria-label="Close" onClick={() => { setUploadModalOpen(false); setUploadCustomName(""); setUploadError(""); }}><IconClose /></button>
            <span className="game-modal-glyph">📤</span>
            <h2 className="game-modal-title">{t("uploadRom")}</h2>
          </div>

          <div className="game-modal-body">
            <div className="upload-modal-info">
              <p className="form-label">{t("uploadFormats")}</p>
              <div className="upload-modal-consoles">
                <div className="upload-console-chip"><span className="chip-label">NES</span><span className="chip-formats">.nes (max 8 MB)</span></div>
                <div className="upload-console-chip"><span className="chip-label">SNES</span><span className="chip-formats">.sfc, .smc (max 8 MB)</span></div>
                <div className="upload-console-chip"><span className="chip-label">PS1</span><span className="chip-formats">.bin, .iso, .img, .pbp, .chd (max 700 MB)</span></div>
              </div>
            </div>

            <div className="upload-modal-name">
              <label className="form-label" htmlFor="rom-custom-name">{t("customName")}</label>
              <input
                id="rom-custom-name"
                className="field"
                value={uploadCustomName}
                onChange={(e) => setUploadCustomName(e.target.value)}
                placeholder={t("customNamePlaceholder")}
                aria-label={t("customName")}
              />
            </div>

            <label
              className={`upload-drop upload-modal-drop${dragActive ? " drag-active" : ""}${uploading ? " uploading" : ""}${uploadDone ? " upload-done" : ""}`}
              onDragOver={(event) => { event.preventDefault(); if (!uploading) setDragActive(true); }}
              onDragLeave={() => setDragActive(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragActive(false);
                const file = event.dataTransfer.files?.[0];
                if (file && !uploading) void uploadRom(file);
              }}
            >
              <input
                type="file"
                accept=".nes,.sfc,.smc,.bin,.iso,.img,.pbp,.chd"
                disabled={uploading || !authToken}
                onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadRom(file); event.target.value = ""; }}
                aria-label={t("uploadRom")}
              />
              {uploading ? (
                <div className="upload-progress">
                  <div className="upload-progress-track"><div className="upload-progress-fill" style={{ width: `${uploadProgress}%` }} /></div>
                  <span className="upload-progress-pct">{uploadProgress}%</span>
                </div>
              ) : (
                <span>{uploadDone ? `✓ ${t("uploadDone")}` : t("chooseFileDrop")}</span>
              )}
            </label>
            {uploadError && <p className="form-error">{uploadError}</p>}
          </div>
        </div>
      </div>
    )}

    {!inLobby && <>
      <div className="room-layout">
        <div className={`${isFullscreen ? "player-stage pseudo-fullscreen" : "player-stage"} ${isTouchDevice && !hudVisible ? "hud-hidden" : ""}`} ref={stageWrapRef} onClick={() => { if (isTouchDevice) flashHud(); }}>
          <div className={`player-topbar overlay-bar ${isTouchDevice && !hudVisible ? "hud-hidden" : ""}`}>
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
            <button
              className="player-pill muted room-code-pill"
              onClick={() => {
                void navigator.clipboard.writeText(room);
                setRoomCopied(true);
                playClickSound();
                window.setTimeout(() => setRoomCopied(false), 2000);
              }}
              title={t("copyRoomCode")}
            >
              {roomCopied ? `✓ ${t("roomCodeCopied")}` : room}
            </button>
            {authUsername === roomOwner && (
              <button className="btn-danger" onClick={closeRoom} disabled={closingRoom}>
                {closingRoom ? t("closing") : t("closeRoom")}
              </button>
            )}
            <button
              className={`icon-button ${crtEffect ? "active-toggle" : ""}`}
              aria-label={t("crtEffect")}
              title={t("crtEffect")}
              onClick={() => { setCrtEffect((v) => !v); playClickSound(); }}
            >
              <IconTv active={crtEffect} />
            </button>
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
          <div className={`stage stage-${scale === "fit" ? "fit" : "fixed"} ${crtEffect ? "crt-active" : ""}`}>
            <div
              className={[
                "stage-canvas",
                draggingCanvas ? "dragging" : "",
                canvasLocked ? "locked" : "",
              ].filter(Boolean).join(" ")}
              style={{ transform: `translate(${canvasOffset.x}px, ${canvasOffset.y}px) scale(${canvasZoom})` }}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onPointerCancel={onCanvasPointerUp}
            >
              <video
                ref={videoRef}
                autoPlay
                playsInline
                controls={false}
                disablePictureInPicture
                controlsList="nodownload nofullscreen noremoteplayback noplaybackrate"
                onContextMenu={(event) => event.preventDefault()}
                onLoadedMetadata={() => { if (videoRef.current) setIntrinsicSize({ w: videoRef.current.videoWidth, h: videoRef.current.videoHeight }); }}
                style={{
                  WebkitTouchCallout: "none" as any,
                  WebkitUserSelect: "none" as any,
                  ...(scale !== "fit" && intrinsicSize ? { width: intrinsicSize.w * Number(scale), height: "auto" } : {}),
                }}
              />
            </div>
            {mediaState !== "Receiving media" && <div className="placeholder">{translate(lang, (mediaKeys[mediaState] as any) ?? "waitingForGameServer")}</div>}
            {canvasHintVisible && !canvasLocked && mediaState === "Receiving media" && (
              <div className="canvas-hint">
                <IconMove /> {t("canvasDragHint")}
              </div>
            )}
            {canvasToast && <div className="canvas-toast">{canvasToast}</div>}
          </div>
          <TouchControls sendInput={sendInput} layout={touchLayout} size={touchSize} />
          <button className="mobile-panel-fab" onClick={(e) => { e.stopPropagation(); setMobilePanelOpen(true); }} aria-label={t("players")}>
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
            <div className="chat-reactions-row">
              {["👏", "🔥", "👾", "🕹️", "🎮", "🏆", "😂"].map((emoji) => (
                <button
                  key={emoji}
                  className="quick-reaction-btn"
                  onClick={() => {
                    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
                    socketRef.current.send(JSON.stringify({ type: "chat", room, payload: { text: emoji } }));
                    playChatSound();
                  }}
                >
                  {emoji}
                </button>
              ))}
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
                  {[["fit", t("fitScreen")], ["1", intrinsicSize ? `${intrinsicSize.w}×${intrinsicSize.h}` : "1×"],
                    ["2", intrinsicSize ? `${intrinsicSize.w * 2}×${intrinsicSize.h * 2}` : "2×"],
                    ["3", intrinsicSize ? `${intrinsicSize.w * 3}×${intrinsicSize.h * 3}` : "3×"]].map(([value, label]) => (
                    <button key={value} className={scale === value ? "scale-option active" : "scale-option"} onClick={() => setScale(value)}>{label}</button>
                  ))}
                </div>

                <p className="settings-label" style={{ marginTop: 14 }}>{t("screenPosition")}</p>
                <span className="lobby-card-hint">{canvasLocked ? t("screenPositionLockedHint") : t("screenPositionHint")}</span>
                <div className="volume-row">
                  <span className="volume-value" style={{ minWidth: 40 }}>{Math.round(canvasZoom * 100)}%</span>
                  <input
                    className="volume-slider"
                    type="range"
                    min={50}
                    max={200}
                    value={Math.round(canvasZoom * 100)}
                    onChange={(event) => setCanvasZoom(Number(event.target.value) / 100)}
                    aria-label={t("zoom")}
                    disabled={canvasLocked}
                  />
                  <button className="btn-ghost" onClick={resetCanvasPosition} disabled={canvasLocked}>{t("recenter")}</button>
                </div>
                <button className={canvasLocked ? "scale-option active canvas-lock-btn" : "scale-option canvas-lock-btn"} onClick={toggleCanvasLock}>
                  <IconPin locked={canvasLocked} /> {canvasLocked ? t("unlockPosition") : t("lockPosition")}
                </button>

                <p className="settings-label" style={{ marginTop: 14 }}>{t("crtEffect")}</p>
                <span className="lobby-card-hint">{t("crtEffectHint")}</span>
                <button
                  className={crtEffect ? "scale-option active canvas-lock-btn" : "scale-option canvas-lock-btn"}
                  onClick={() => { setCrtEffect((v) => !v); playClickSound(); }}
                >
                  <IconTv active={crtEffect} /> {crtEffect ? "CRT Enabled" : "CRT Disabled"}
                </button>
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

                <p className="settings-label" style={{ marginTop: 14 }}>{t("soundFx")}</p>
                <span className="lobby-card-hint">{t("soundFxHint")}</span>
                <button
                  className={soundFxEnabled ? "scale-option active canvas-lock-btn" : "scale-option canvas-lock-btn"}
                  onClick={() => {
                    const next = !soundFxEnabled;
                    setSoundEnabled(next);
                    setSoundFxEnabledState(next);
                    if (next) playClickSound();
                  }}
                >
                  <IconSoundFx enabled={soundFxEnabled} /> {soundFxEnabled ? "Sound FX On" : "Sound FX Off"}
                </button>
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

            {settingsTab === "controls" && (
              <p className="console-detected">{t("controlsForConsole")} <span className="console-detected-name">{CONSOLES.find((c) => c.id === activeConsole)?.label ?? activeConsole.toUpperCase()}</span></p>
            )}

            {settingsTab === "controls" && !isTouchDevice && (
              <div className="settings-section">
                <p className="settings-label">{t("keyboardBindings")} · P{playerNumber ?? 1}</p>
                <ul className="keybind-list">
                  {activeConsoleButtons.map((button) => (
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

            {settingsTab === "controls" && (
              <div className="settings-section">
                <p className="settings-label">
                  <span className={gamepadConnected ? "gamepad-dot connected" : "gamepad-dot"} />
                  {t("gamepad")} · P{playerNumber ?? 1}
                </p>
                {gamepadConnected ? (
                  <ul className="keybind-list">
                    {activeConsoleButtons.map((button) => (
                      <li key={button} className="keybind-row">
                        <span className="keybind-name">{button}</span>
                        <button className="keybind-key" onClick={() => setRebindingGamepad(button)}>
                          {rebindingGamepad === button ? t("pressAButton") : `#${gamepadBindings[button]}`}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="lobby-card-hint">{t("gamepadHint")}</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>}
  </main>;
}
