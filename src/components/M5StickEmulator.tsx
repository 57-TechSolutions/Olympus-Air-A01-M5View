import React, { useState, useEffect, useRef } from "react";
import { 
  Play, 
  RotateCcw, 
  Camera, 
  Wifi, 
  Zap, 
  Activity, 
  Sparkles,
  Maximize2,
  Volume2,
  VolumeX,
  Layers,
  CheckCircle2,
  Clock,
  Download,
  Ratio,
  HelpCircle,
  AlertTriangle,
  Sliders,
  HardDrive,
  Search,
  Bluetooth,
  RotateCw,
  Power,
  Crosshair
} from "lucide-react";
import { playM5Beep, playShutterSound } from "../utils/audio";
import { GeneratorConfig } from "../data/arduinoCode";

interface PacketLog {
  id: string;
  timestamp: string;
  type: "WIFI" | "BT" | "HTTP_GET" | "HTTP_RES" | "TCP_STREAM" | "ACTION";
  summary: string;
  detail: string;
  status?: string;
  color: string;
}

interface CapturedPhoto {
  id: string;
  timestamp: string;
  title: string;
  imageUrl: string;
  aperture: string;
  iso: string;
  shutter: string;
  aspect: string;
  sizeKb: number;
}

interface SimulatedAp {
  ssid: string;
  rssi: number;
  channel: number;
  isAir: boolean;
  isOpen: boolean;
}

interface SavedWifiCreds {
  ssid: string;
  pass: string;
  channel: number;
}

interface SimulatedBtDevice {
  name: string;
  mac: string;
  rssi: number;
  isAir: boolean;
}

interface SavedBtCreds {
  name: string;
  mac: string;
  pin: string;
}

interface M5StickEmulatorProps {
  config: GeneratorConfig;
  onSelectCapture?: (photo: CapturedPhoto) => void;
}

export type AspectRatioMode = "16:9" | "4:3" | "3:2" | "1:1";
export type ShootingModePreset = "AUTO" | "A_WIDE" | "S_60";
export type LensPreset = "15mm_1.7" | "25mm_1.8" | "12_40_2.8" | "14_42_3.5";
export type GridOverlayMode = "OFF" | "3RDS" | "4x4" | "DIAG" | "GOLD";
export type DriveMode = "SINGLE" | "CONT" | "TIMER_2S" | "TIMER_10S";
export type SeqSpeedMode = "HIGH" | "LOW";
export type AirSoundLevel = "OFF" | "LOW" | "MID" | "HIGH";
export type PeakColor = "RED" | "YELLOW" | "GREEN" | "CYAN" | "WHITE";
export type PeakThickness = "1PX" | "2PX" | "3PX";
export type PeakSensitivity = "LOW" | "MID" | "HIGH";
export type PeakSource = "320x240" | "160x120";
export type BtnAMode = "SHUTTER" | "PEAK";
export type WakeKeyMode = "BTN B" | "BTN A" | "A+B";
export type HudElementKey =
  | "fps"
  | "status"
  | "aspect"
  | "res"
  | "battery"
  | "mode"
  | "shutter"
  | "aperture"
  | "iso"
  | "drive"
  | "remain"
  | "afWarn"
  | "clock"
  | "hints";

const HUD_ELEMENT_ORDER: { key: HudElementKey; label: string }[] = [
  { key: "fps", label: "FPS" },
  { key: "status", label: "Status" },
  { key: "aspect", label: "Aspect" },
  { key: "res", label: "Res" },
  { key: "battery", label: "Battery" },
  { key: "mode", label: "Mode" },
  { key: "shutter", label: "Shutter" },
  { key: "aperture", label: "Aperture" },
  { key: "iso", label: "ISO" },
  { key: "drive", label: "Drive/Tag" },
  { key: "remain", label: "Remain" },
  { key: "afWarn", label: "AF/Exp W" },
  { key: "clock", label: "Clock" },
  { key: "hints", label: "Btn Hints" },
];

const DEFAULT_HUD_VISIBILITY: Record<HudElementKey, boolean> = {
  fps: true,
  status: true,
  aspect: true,
  res: true,
  battery: true,
  mode: true,
  shutter: true,
  aperture: true,
  iso: true,
  drive: true,
  remain: true,
  afWarn: true,
  clock: true,
  hints: true,
};

const GRID_MODE_ORDER: GridOverlayMode[] = ["OFF", "3RDS", "4x4", "DIAG", "GOLD"];
const DRIVE_MODE_ORDER: DriveMode[] = ["SINGLE", "CONT", "TIMER_2S", "TIMER_10S"];
const AIR_SOUND_ORDER: AirSoundLevel[] = ["OFF", "LOW", "MID", "HIGH"];
const PEAK_COLOR_ORDER: PeakColor[] = ["RED", "YELLOW", "GREEN", "CYAN", "WHITE"];
const PEAK_COLOR_SHORT: Record<PeakColor, string> = {
  RED: "RED",
  YELLOW: "YEL",
  GREEN: "GRN",
  CYAN: "CYN",
  WHITE: "WHT",
};
const PEAK_COLOR_RGB: Record<PeakColor, [number, number, number]> = {
  RED: [255, 36, 36],
  YELLOW: [255, 232, 24],
  GREEN: [36, 255, 72],
  CYAN: [24, 248, 255],
  WHITE: [255, 255, 255],
};
const PEAK_COLOR_TEXT_CLS: Record<PeakColor, string> = {
  RED: "text-red-400",
  YELLOW: "text-yellow-300",
  GREEN: "text-emerald-400",
  CYAN: "text-cyan-300",
  WHITE: "text-white",
};
const PEAK_THICK_ORDER: PeakThickness[] = ["1PX", "2PX", "3PX"];
const PEAK_SENS_ORDER: PeakSensitivity[] = ["LOW", "MID", "HIGH"];
const PEAK_SENS_THRESH_320: Record<PeakSensitivity, number> = { LOW: 156, MID: 126, HIGH: 96 };
const PEAK_SENS_THRESH_160: Record<PeakSensitivity, number> = { LOW: 138, MID: 111, HIGH: 84 };
const PEAK_SRC_ORDER: PeakSource[] = ["320x240", "160x120"];
const BTNA_MODE_ORDER: BtnAMode[] = ["SHUTTER", "PEAK"];
const WAKE_KEY_ORDER: WakeKeyMode[] = ["BTN B", "BTN A", "A+B"];

interface HelpLineItem {
  text: string;
  color: string;
}

const HELP_SECTIONS_DATA: { title: string; color: string; bullets: string[] }[] = [
  {
    title: "[BUTTONS: LIVE VIEW]",
    color: "text-cyan-300",
    bullets: [
      "[A] Tap: Shutter (or Focus Peak if BtnA Mode = PEAK)",
      "[A] Hold: Cont burst (CONT Drive) / cancel timer",
      "1x[B]: Aspect 16:9 / 4:3 / 3:2 / 1:1",
      "2x[B]: Mode iAUTO / A:MAX / S:1/60",
      "3x[B]: Toggle Diagnostics HUD",
      "4x[B]: Lock/Unlock Stick+Cam Gyro",
      "5x[B]: Deep Sleep Air+Stick (Live, Boot, Wi-Fi, BT)",
      "Hold[B]: Open Quick Menu (>=600ms)",
      "Hold A+B: Deep Sleep Air+Stick",
      "Pwr Btn: HW Reset (not sleep wake)",
    ],
  },
  {
    title: "[CUSTOMIZABLE KEYS]",
    color: "text-yellow-300",
    bullets: [
      "BtnA Mode: SHUTTER or PEAK toggle (use Air shutter when PEAK)",
      "Wake Key: BTN B (default, pocket-safe), BTN A, or A+B",
      "Stick Rot: AUTO / 90D / 270D / LOCK",
      "Cam Gyro: AUTO 180 / 180D / LOCK",
      "Peak Setup>: ON, 5 Colors, 1-3px, L/M/H Sens, 320/160",
      "HUD Setup>: Toggle 14 HUD texts + All",
    ],
  },
  {
    title: "[MENUS & SETUP UI]",
    color: "text-orange-300",
    bullets: [
      "Quick Menu: [B] Next, [A] Set/Open",
      "Hold[B]: Exits menu/submenu before release",
      "Wi-Fi/BT Scan: [B] Step, [A] Pick, 5x[B] Sleep",
      "Passkey: [B] +1 (Hold fast), [A] Next",
    ],
  },
  {
    title: "[NOTABLE FEATURES]",
    color: "text-emerald-400",
    bullets: [
      "Deep Sleep RTC: Keeps Stick clock ticking across sleep",
      "Clock Sync: Shutter stopwatch + /get_imglist.cgi (2015! alert)",
      "BLE Wake: 6-digit BT PIN wakes Air on boot (unplugged)",
      "Fast Wi-Fi: Static .100 + NVS channel + 520 retry",
      "Zero-Flicker: Triple UDP + vpCanvas + 320x240 Peaking",
    ],
  },
];

function wrapHelpBullet(src: string, maxChars: number, color: string): HelpLineItem[] {
  const out: HelpLineItem[] = [];
  let start = 0;
  let first = true;
  while (start < src.length) {
    const prefix = first ? "" : "  ";
    const avail = Math.max(6, maxChars - prefix.length);
    if (src.length - start <= avail) {
      out.push({ text: prefix + src.slice(start), color });
      break;
    }
    const cut = start + avail;
    let sp = -1;
    for (let i = cut; i > start; i--) {
      if (src[i] === " ") {
        sp = i;
        break;
      }
    }
    if (sp > start) {
      out.push({ text: prefix + src.slice(start, sp), color });
      start = sp + 1;
      while (start < src.length && src[start] === " ") start++;
    } else {
      out.push({ text: prefix + src.slice(start, cut), color });
      start = cut;
    }
    first = false;
  }
  return out;
}

function buildEmulatorHelpPages(isPortrait: boolean): HelpLineItem[][] {
  const maxChars = isPortrait ? 21 : 38;
  const maxLines = isPortrait ? 14 : 8;
  const pages: HelpLineItem[][] = [];
  let cur: HelpLineItem[] = [];

  for (const sec of HELP_SECTIONS_DATA) {
    if (cur.length > 0 && cur.length + 2 > maxLines) {
      pages.push(cur);
      cur = [];
    }
    if (cur.length > 0 && cur.length < maxLines) {
      cur.push({ text: "", color: "text-transparent" });
      if (cur.length + 2 > maxLines) {
        pages.push(cur);
        cur = [];
      }
    }
    cur.push({ text: sec.title.slice(0, maxChars), color: sec.color });
    for (const b of sec.bullets) {
      const wrapped = wrapHelpBullet(`* ${b}`, maxChars, "text-slate-200");
      for (const line of wrapped) {
        if (cur.length >= maxLines) {
          pages.push(cur);
          cur = [];
        }
        cur.push(line);
      }
    }
  }
  if (cur.length > 0) pages.push(cur);
  return pages;
}

const AIR_SOUND_OPC_TOKENS: Record<AirSoundLevel, string> = {
  OFF: "OFF",
  LOW: "LOW",
  MID: "MIDDLE",
  HIGH: "HIGH",
};
const DRIVE_MODE_LABELS: Record<DriveMode, string> = {
  SINGLE: "SINGLE",
  CONT: "CONT",
  TIMER_2S: "TMR 2s",
  TIMER_10S: "TMR 10s",
};
const DRIVE_MODE_SHORT: Record<DriveMode, string> = {
  SINGLE: "SGL",
  CONT: "CNT",
  TIMER_2S: "2S",
  TIMER_10S: "10S",
};

const LENS_SPECS: Record<LensPreset, { label: string; widest: string }> = {
  "15mm_1.7": { label: "15mm f/1.7", widest: "1.7" },
  "25mm_1.8": { label: "25mm f/1.8", widest: "1.8" },
  "12_40_2.8": { label: "12-40 f/2.8", widest: "2.8" },
  "14_42_3.5": { label: "14-42 f/3.5", widest: "3.5" },
};

const EMULATOR_STORAGE_KEY = "olympus_air_m5_settings_v1";
const EMULATOR_WIFI_STORAGE_KEY = "olympus_air_m5_wifi_v1";
const EMULATOR_BT_STORAGE_KEY = "olympus_air_m5_bt_v1";

export type CameraBodyAngle = 0 | 90 | 180 | 270;

export type StickRotMode = "LOCK" | "GYRO" | "L-FLIP";
export type CamGyroMode = "AUTO" | "180D" | "LOCK";

interface SavedEmulatorSettings {
  aspectRatio?: AspectRatioMode;
  shootMode?: ShootingModePreset;
  orientation?: "landscape" | "portrait";
  flipped180?: boolean;
  gyroEnabled?: boolean;
  stickRotMode?: StickRotMode;
  camGyroAuto?: boolean;
  camGyroMode?: CamGyroMode;
  dualGyroLocked?: boolean;
  priorStickRotMode?: StickRotMode;
  priorCamGyroMode?: CamGyroMode;
  brightnessLevel?: number;
  gridMode?: GridOverlayMode;
  driveMode?: DriveMode;
  seqSpeed?: SeqSpeedMode;
  soundEnabled?: boolean;
  airSoundLevel?: AirSoundLevel;
  clockInvalid2015?: boolean;
  airClockReset2015?: boolean;
  peakEnabled?: boolean;
  peakColor?: PeakColor;
  peakThickness?: PeakThickness;
  peakSensitivity?: PeakSensitivity;
  peakSource?: PeakSource;
  btnAMode?: BtnAMode;
  wakeKeyMode?: WakeKeyMode;
  hudVisibility?: Partial<Record<HudElementKey, boolean>>;
}

interface SavedBtStorageState {
  wakeOnBoot: boolean;
  device: SavedBtCreds | null;
}

function loadSavedEmulatorSettings(): SavedEmulatorSettings {
  try {
    const raw = window.localStorage.getItem(EMULATOR_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as SavedEmulatorSettings;
  } catch {
    return {};
  }
}

function loadSavedWifiCreds(fallbackConfig: GeneratorConfig): SavedWifiCreds | null {
  try {
    const raw = window.localStorage.getItem(EMULATOR_WIFI_STORAGE_KEY);
    if (raw === "NONE") return null;
    if (raw) {
      const parsed = JSON.parse(raw) as SavedWifiCreds;
      if (parsed?.ssid) return parsed;
    }
  } catch {
    // ignore storage errors
  }
  return {
    ssid: fallbackConfig.wifiSsid || "AIR-A01-12345678",
    pass: fallbackConfig.wifiPass || "12345678",
    channel: 6,
  };
}

function loadSavedBtStorage(): SavedBtStorageState {
  try {
    const raw = window.localStorage.getItem(EMULATOR_BT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as SavedBtStorageState;
      return {
        wakeOnBoot: Boolean(parsed?.wakeOnBoot),
        device: parsed?.device?.mac ? parsed.device : null,
      };
    }
  } catch {
    // ignore storage errors
  }
  return { wakeOnBoot: false, device: null };
}

export const M5StickEmulator: React.FC<M5StickEmulatorProps> = ({ config }) => {
  const initialSavedRef = useRef<SavedEmulatorSettings | null>(null);
  if (initialSavedRef.current === null) {
    initialSavedRef.current = loadSavedEmulatorSettings();
  }
  const saved = initialSavedRef.current;

  const initialWifiRef = useRef<SavedWifiCreds | null | undefined>(undefined);
  if (initialWifiRef.current === undefined) {
    initialWifiRef.current = loadSavedWifiCreds(config);
  }

  const initialBtRef = useRef<SavedBtStorageState | null>(null);
  if (initialBtRef.current === null) {
    initialBtRef.current = loadSavedBtStorage();
  }

  // Device State
  const [powerOn, setPowerOn] = useState(true);
  const [orientation, setOrientation] = useState<"landscape" | "portrait">(
    saved.orientation === "landscape" || saved.orientation === "portrait"
      ? saved.orientation
      : config.rotation === 3 || config.rotation === 1
      ? "landscape"
      : "portrait"
  );
  const [statePhase, setStatePhase] = useState<
    | "idle"
    | "bt_wake"
    | "bt_scan"
    | "bt_passkey"
    | "wifi_searching_saved"
    | "wifi_scan"
    | "wifi_passkey"
    | "connecting_wifi"
    | "cgi_mode"
    | "cgi_rec"
    | "cgi_stream"
    | "streaming"
  >("idle");

  // Wi-Fi Onboarding & Saved NVS Search State
  const [savedWifi, setSavedWifi] = useState<SavedWifiCreds | null>(initialWifiRef.current ?? null);
  const [airOnline, setAirOnline] = useState(true);
  const [apList, setApList] = useState<SimulatedAp[]>([]);
  const [apScanning, setApScanning] = useState(false);
  const [apSelectedIdx, setApSelectedIdx] = useState(0);
  const [selectedApForPass, setSelectedApForPass] = useState<SimulatedAp | null>(null);
  const [passDigits, setPassDigits] = useState<number[]>([1, 2, 3, 4, 5, 6, 7, 8]);
  const [passCursor, setPassCursor] = useState<number>(0); // 0..7 digits, 8=CONFIRM, 9=EDIT, 10=BACK
  const [searchAttempt, setSearchAttempt] = useState(1);

  // Bluetooth BLE Wake-Up & 6-Digit Passkey State
  const [btWakeOnBoot, setBtWakeOnBoot] = useState<boolean>(initialBtRef.current.wakeOnBoot);
  const [savedBt, setSavedBt] = useState<SavedBtCreds | null>(initialBtRef.current.device);
  const [btList, setBtList] = useState<SimulatedBtDevice[]>([]);
  const [btScanning, setBtScanning] = useState(false);
  const [btSelectedIdx, setBtSelectedIdx] = useState(0);
  const [selectedBtForPass, setSelectedBtForPass] = useState<SimulatedBtDevice | null>(null);
  const [btPassDigits, setBtPassDigits] = useState<number[]>([0, 0, 0, 0, 0, 0]);
  const [btPassCursor, setBtPassCursor] = useState<number>(0); // 0..5 digits, 6=CONFIRM, 7=EDIT, 8=BACK

  // Camera Body Orientation & Auto-Flip Compensation (AUTO=RTP EXIF 180-deg only, 180D=Manual upside-down flip, LOCK=0 deg)
  const [airBodyRot, setAirBodyRot] = useState<CameraBodyAngle>(0);
  const [camGyroMode, setCamGyroMode] = useState<CamGyroMode>(
    saved.camGyroMode && ["AUTO", "180D", "LOCK"].includes(saved.camGyroMode)
      ? saved.camGyroMode
      : typeof saved.camGyroAuto === "boolean"
      ? (saved.camGyroAuto ? "AUTO" : "LOCK")
      : "AUTO"
  );
  const [dualGyroLocked, setDualGyroLocked] = useState<boolean>(Boolean(saved.dualGyroLocked));
  const [priorStickRotMode, setPriorStickRotMode] = useState<StickRotMode>(
    saved.priorStickRotMode && ["LOCK", "GYRO", "L-FLIP"].includes(saved.priorStickRotMode)
      ? saved.priorStickRotMode
      : "GYRO"
  );
  const [priorCamGyroMode, setPriorCamGyroMode] = useState<CamGyroMode>(
    saved.priorCamGyroMode && ["AUTO", "180D", "LOCK"].includes(saved.priorCamGyroMode)
      ? saved.priorCamGyroMode
      : "AUTO"
  );
  const camGyroAuto = camGyroMode === "AUTO";
  const [lockedCamRot, setLockedCamRot] = useState<CameraBodyAngle>(0);
  const effectiveCamRot: CameraBodyAngle =
    camGyroMode === "AUTO" ? (airBodyRot === 180 ? 180 : 0) : camGyroMode === "180D" ? 180 : lockedCamRot;

  const [soundEnabled, setSoundEnabled] = useState<boolean>(
    typeof saved.soundEnabled === "boolean" ? saved.soundEnabled : true
  );
  const [airSoundLevel, setAirSoundLevel] = useState<AirSoundLevel>(
    saved.airSoundLevel && AIR_SOUND_ORDER.includes(saved.airSoundLevel) ? saved.airSoundLevel : "MID"
  );
  const [btnAPressed, setBtnAPressed] = useState(false);
  const [btnBPressed, setBtnBPressed] = useState(false);
  const [isShutterFlashing, setIsShutterFlashing] = useState(false);
  const [bannerMessage, setBannerMessage] = useState("Init...");
  const [statusColor, setStatusColor] = useState<"green" | "yellow" | "red">("yellow");
  const [fps, setFps] = useState(0);

  // Dual Battery & Storage Telemetry
  const [m5BatteryVoltage] = useState(4.12);
  const [airBatteryLevel] = useState("FULL");
  const [remainingShots, setRemainingShots] = useState(1420);

  // Aspect Ratio State: 16:9 (default), 4:3, 3:2, 1:1
  const [aspectRatio, setAspectRatio] = useState<AspectRatioMode>(
    saved.aspectRatio && ["16:9", "4:3", "3:2", "1:1"].includes(saved.aspectRatio)
      ? saved.aspectRatio
      : (config.defaultAspectRatio as AspectRatioMode) || "16:9"
  );

  // Shooting Mode & Lens State
  const [shootMode, setShootMode] = useState<ShootingModePreset>(
    saved.shootMode && ["AUTO", "A_WIDE", "S_60"].includes(saved.shootMode)
      ? saved.shootMode
      : config.defaultShootingMode || "AUTO"
  );
  const [attachedLens, setAttachedLens] = useState<LensPreset>("15mm_1.7");

  // Exposure Warning / Exposure Metering Warning State (RTP Ext ID 16)
  const [exposureWarning, setExposureWarning] = useState<boolean>(false);

  const [logs, setLogs] = useState<PacketLog[]>([]);
  const [capturedPhotos, setCapturedPhotos] = useState<CapturedPhoto[]>([]);
  const [selectedScene, setSelectedScene] = useState<"street" | "nature" | "studio" | "chart">("street");
  const [gridMode, setGridMode] = useState<GridOverlayMode>(
    saved.gridMode && GRID_MODE_ORDER.includes(saved.gridMode) ? saved.gridMode : "3RDS"
  );
  const [driveMode, setDriveMode] = useState<DriveMode>(
    saved.driveMode && DRIVE_MODE_ORDER.includes(saved.driveMode) ? saved.driveMode : "SINGLE"
  );
  const [seqSpeed, setSeqSpeed] = useState<SeqSpeedMode>(
    saved.seqSpeed === "LOW" ? "LOW" : "HIGH"
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIdx, setMenuIdx] = useState(0);
  const [menuStatusBadge, setMenuStatusBadge] = useState<string>("");
  const [peakSubmenuOpen, setPeakSubmenuOpen] = useState(false);
  const [peakSubmenuIdx, setPeakSubmenuIdx] = useState(1);
  const [peakSubmenuBadge, setPeakSubmenuBadge] = useState<string>("");
  const [hudSubmenuOpen, setHudSubmenuOpen] = useState(false);
  const [hudSubmenuIdx, setHudSubmenuIdx] = useState(1);
  const [hudSubmenuBadge, setHudSubmenuBadge] = useState<string>("");
  const [helpScreenOpen, setHelpScreenOpen] = useState(false);
  const [helpPage, setHelpPage] = useState(0);
  const [selfTimerSec, setSelfTimerSec] = useState<number | null>(null);
  const [contBurstActive, setContBurstActive] = useState(false);
  const [showDiagHud, setShowDiagHud] = useState(false);

  // Focus Peaking, HUD Text Elements, Button A Mode & Deep Sleep Wake Key Settings (Persisted in NVS / localStorage)
  const [peakEnabled, setPeakEnabled] = useState<boolean>(Boolean(saved.peakEnabled));
  const [peakColor, setPeakColor] = useState<PeakColor>(
    saved.peakColor && PEAK_COLOR_ORDER.includes(saved.peakColor) ? saved.peakColor : "RED"
  );
  const [peakThickness, setPeakThickness] = useState<PeakThickness>(
    saved.peakThickness && PEAK_THICK_ORDER.includes(saved.peakThickness) ? saved.peakThickness : "1PX"
  );
  const [peakSensitivity, setPeakSensitivity] = useState<PeakSensitivity>(
    saved.peakSensitivity && PEAK_SENS_ORDER.includes(saved.peakSensitivity) ? saved.peakSensitivity : "MID"
  );
  const [peakSource, setPeakSource] = useState<PeakSource>(
    saved.peakSource && PEAK_SRC_ORDER.includes(saved.peakSource) ? saved.peakSource : "320x240"
  );
  const [btnAMode, setBtnAMode] = useState<BtnAMode>(
    saved.btnAMode && BTNA_MODE_ORDER.includes(saved.btnAMode) ? saved.btnAMode : "SHUTTER"
  );
  const [wakeKeyMode, setWakeKeyMode] = useState<WakeKeyMode>(
    saved.wakeKeyMode && WAKE_KEY_ORDER.includes(saved.wakeKeyMode) ? saved.wakeKeyMode : "BTN B"
  );
  const [hudVisibility, setHudVisibility] = useState<Record<HudElementKey, boolean>>({
    ...DEFAULT_HUD_VISIBILITY,
    ...(saved.hudVisibility || {}),
  });
  const hudEnabledCount = HUD_ELEMENT_ORDER.filter((item) => hudVisibility[item.key]).length;
  const [focusSharpness, setFocusSharpness] = useState<number>(100); // Simulated optical focus ring (0=defocused, 100=razor sharp)
  const [deepSleepReason, setDeepSleepReason] = useState<string>("");

  // Persistent M5StickS3 RTC / Clock Synced via Shutter Stopwatch + /get_imglist.cgi
  const [clockSynced, setClockSynced] = useState<boolean>(false);
  const [clockSyncPending, setClockSyncPending] = useState<boolean>(true);
  const [clockInvalid2015, setClockInvalid2015] = useState<boolean>(Boolean(saved.clockInvalid2015));
  const [airClockReset2015, setAirClockReset2015] = useState<boolean>(Boolean(saved.airClockReset2015));
  const [clockOffsetMs, setClockOffsetMs] = useState<number>(0);
  const [clockLastSyncYear, setClockLastSyncYear] = useState<number>(
    saved.clockInvalid2015 ? 2015 : new Date().getFullYear()
  );
  const [clockLastSyncFile, setClockLastSyncFile] = useState<string>("");
  const [clockLastStopwatchMs, setClockLastStopwatchMs] = useState<number>(0);
  const [showClock2015Alert, setShowClock2015Alert] = useState<boolean>(false);
  const [clockTickNow, setClockTickNow] = useState<number>(() => Date.now());
  const clock2015TimerRef = useRef<NodeJS.Timeout | null>(null);
  const burstStopwatchStartRef = useRef<number>(0);

  const m5BatteryPct = Math.round(Math.min(100, Math.max(0, ((m5BatteryVoltage - 3.3) / 0.9) * 100)));

  const widestF = LENS_SPECS[attachedLens].widest;
  const sceneExposure = (() => {
    if (shootMode === "A_WIDE") {
      const shutter =
        selectedScene === "street"
          ? "1/640"
          : selectedScene === "nature"
          ? "1/1000"
          : selectedScene === "studio"
          ? "1/160"
          : "1/320";
      const iso = selectedScene === "studio" ? "I:200" : "I:100";
      const isoFull = selectedScene === "studio" ? "ISO 200" : "ISO 100";
      return {
        mode: `A:${widestF}`,
        shutter,
        aperture: `F${widestF}`,
        iso,
        shutterFull: `${shutter}s`,
        apertureFull: `f/${widestF}`,
        isoFull,
      };
    }
    if (shootMode === "S_60") {
      const ap =
        selectedScene === "street"
          ? "F8.0"
          : selectedScene === "nature"
          ? "F11"
          : selectedScene === "studio"
          ? `F${widestF}`
          : "F11";
      const apFull =
        selectedScene === "street"
          ? "f/8.0"
          : selectedScene === "nature"
          ? "f/11"
          : selectedScene === "studio"
          ? `f/${widestF}`
          : "f/11";
      const iso = selectedScene === "studio" ? "I:400" : "I:100";
      const isoFull = selectedScene === "studio" ? "ISO 400" : "ISO 100";
      return {
        mode: "S:1/60",
        shutter: "1/60",
        aperture: ap,
        iso,
        shutterFull: "1/60s",
        apertureFull: apFull,
        isoFull,
      };
    }
    // Standard Automatic (iAUTO)
    return selectedScene === "street"
      ? { mode: "iAUTO", shutter: "1/250", aperture: "F2.8", iso: "I:200", shutterFull: "1/250s", apertureFull: "f/2.8", isoFull: "ISO 200" }
      : selectedScene === "nature"
      ? { mode: "iAUTO", shutter: "1/500", aperture: "F4.0", iso: "I:100", shutterFull: "1/500s", apertureFull: "f/4.0", isoFull: "ISO 100" }
      : selectedScene === "studio"
      ? { mode: "iAUTO", shutter: "1/125", aperture: `F${widestF}`, iso: "I:400", shutterFull: "1/125s", apertureFull: `f/${widestF}`, isoFull: "ISO 400" }
      : { mode: "iAUTO", shutter: "1/160", aperture: "F5.6", iso: "I:200", shutterFull: "1/160s", apertureFull: "f/5.6", isoFull: "ISO 200" };
  })();

  const activeWindowRes =
    orientation === "portrait"
      ? aspectRatio === "16:9"
        ? "132x74"
        : aspectRatio === "4:3"
        ? "132x99"
        : aspectRatio === "3:2"
        ? "132x88"
        : "99x99"
      : aspectRatio === "16:9"
      ? "160x90"
      : aspectRatio === "4:3"
      ? "160x120"
      : aspectRatio === "3:2"
      ? "160x107"
      : "120x120";

  // Memory & Packet Loss Diagnostics metrics (ESP32-S3-PICO-1-N8R8: internal SRAM + 8MB OPI PSRAM)
  const [freeHeapKb] = useState(312);
  const [minHeapKb] = useState(284);
  const [freePsramKb] = useState(8192);
  const [rxPacketsCount] = useState(1420);
  const [droppedPacketsCount] = useState(0);
  const [validFramesCount] = useState(84);
  const [corruptFramesCount] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const peakOffscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const animTimeRef = useRef<number>(0);

  const [brightnessLevel, setBrightnessLevel] = useState<number>(
    typeof saved.brightnessLevel === "number" && saved.brightnessLevel >= 0 && saved.brightnessLevel <= 2
      ? saved.brightnessLevel
      : 0
  ); // 0=100%, 1=60%, 2=30%
  const [isAfLocking, setIsAfLocking] = useState<boolean>(false);
  const [stickRotMode, setStickRotMode] = useState<StickRotMode>(
    saved.stickRotMode && ["LOCK", "GYRO", "L-FLIP"].includes(saved.stickRotMode)
      ? saved.stickRotMode
      : saved.gyroEnabled
      ? "GYRO"
      : "LOCK"
  );
  const gyroEnabled = stickRotMode !== "LOCK";
  const [flipped180, setFlipped180] = useState<boolean>(
    typeof saved.flipped180 === "boolean"
      ? saved.flipped180
      : config.rotation === 1 || config.rotation === 2
  );

  // Button A & Button B hold / repeat / multi-click timers (pure 2-button UI)
  const btnAShotHandledRef = useRef<boolean>(false);

  const btnBTimerRef = useRef<NodeJS.Timeout | null>(null);
  const btnBLongTriggeredRef = useRef<boolean>(false);
  const btnBMultiTimerRef = useRef<NodeJS.Timeout | null>(null);
  const btnBClickCountRef = useRef<number>(0);
  const btnBPressStartRef = useRef<number>(0);
  const btnBRepeatTimerRef = useRef<NodeJS.Timeout | null>(null);
  const rapidBCountRef = useRef<number>(0);
  const rapidBLastMsRef = useRef<number>(0);
  const selfTimerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const burstIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Active boot/search timers so cancelling to Wi-Fi Setup aborts old timeouts cleanly
  const bootTimersRef = useRef<NodeJS.Timeout[]>([]);
  const clearBootTimers = () => {
    bootTimersRef.current.forEach((t) => clearTimeout(t));
    bootTimersRef.current = [];
  };

  // Persist camera settings across power cycles
  useEffect(() => {
    try {
      window.localStorage.setItem(
        EMULATOR_STORAGE_KEY,
        JSON.stringify({
          aspectRatio,
          shootMode,
          orientation,
          flipped180,
          gyroEnabled,
          stickRotMode,
          camGyroAuto,
          camGyroMode,
          dualGyroLocked,
          priorStickRotMode,
          priorCamGyroMode,
          brightnessLevel,
          gridMode,
          driveMode,
          seqSpeed,
          soundEnabled,
          airSoundLevel,
          clockInvalid2015,
          airClockReset2015,
          peakEnabled,
          peakColor,
          peakThickness,
          peakSensitivity,
          peakSource,
          btnAMode,
          wakeKeyMode,
          hudVisibility,
        })
      );
    } catch {
      // Ignore storage quota errors
    }
  }, [aspectRatio, shootMode, orientation, flipped180, gyroEnabled, stickRotMode, camGyroAuto, camGyroMode, dualGyroLocked, priorStickRotMode, priorCamGyroMode, brightnessLevel, gridMode, driveMode, seqSpeed, soundEnabled, airSoundLevel, clockInvalid2015, airClockReset2015, peakEnabled, peakColor, peakThickness, peakSensitivity, peakSource, btnAMode, wakeKeyMode, hudVisibility]);

  // 1-second RTC tick for persistent clock badge across all screens
  useEffect(() => {
    if (!powerOn) return;
    setClockTickNow(Date.now());
    const id = setInterval(() => {
      setClockTickNow(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [powerOn]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        EMULATOR_WIFI_STORAGE_KEY,
        savedWifi ? JSON.stringify(savedWifi) : "NONE"
      );
    } catch {
      // ignore
    }
  }, [savedWifi]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        EMULATOR_BT_STORAGE_KEY,
        JSON.stringify({ wakeOnBoot: btWakeOnBoot, device: savedBt })
      );
    } catch {
      // ignore
    }
  }, [btWakeOnBoot, savedBt]);

  // Sync only when CodeWorkbench config values explicitly change after mount
  const prevConfigRef = useRef({
    rotation: config.rotation,
    defaultAspectRatio: config.defaultAspectRatio,
    defaultShootingMode: config.defaultShootingMode,
    wifiSsid: config.wifiSsid,
    wifiPass: config.wifiPass,
  });

  useEffect(() => {
    if (prevConfigRef.current.rotation !== config.rotation) {
      prevConfigRef.current.rotation = config.rotation;
      setOrientation(config.rotation === 3 || config.rotation === 1 ? "landscape" : "portrait");
      setFlipped180(config.rotation === 1 || config.rotation === 2);
    }
  }, [config.rotation]);

  useEffect(() => {
    if (
      prevConfigRef.current.wifiSsid !== config.wifiSsid ||
      prevConfigRef.current.wifiPass !== config.wifiPass
    ) {
      prevConfigRef.current.wifiSsid = config.wifiSsid;
      prevConfigRef.current.wifiPass = config.wifiPass;
      setSavedWifi({
        ssid: config.wifiSsid,
        pass: config.wifiPass,
        channel: 6,
      });
    }
  }, [config.wifiSsid, config.wifiPass]);

  useEffect(() => {
    if (prevConfigRef.current.defaultAspectRatio !== config.defaultAspectRatio) {
      prevConfigRef.current.defaultAspectRatio = config.defaultAspectRatio;
      if (
        config.defaultAspectRatio &&
        (config.defaultAspectRatio === "16:9" ||
          config.defaultAspectRatio === "4:3" ||
          config.defaultAspectRatio === "3:2" ||
          config.defaultAspectRatio === "1:1")
      ) {
        setAspectRatio(config.defaultAspectRatio);
      } else {
        setAspectRatio("16:9");
      }
    }
  }, [config.defaultAspectRatio]);

  useEffect(() => {
    if (prevConfigRef.current.defaultShootingMode !== config.defaultShootingMode) {
      prevConfigRef.current.defaultShootingMode = config.defaultShootingMode;
      if (config.defaultShootingMode) {
        setShootMode(config.defaultShootingMode);
      }
    }
  }, [config.defaultShootingMode]);

  const addLog = (
    type: PacketLog["type"],
    summary: string,
    detail: string,
    color: string,
    status?: string
  ) => {
    const newLog: PacketLog = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toLocaleTimeString("en-US", { hour12: false, fractionalSecondDigits: 3 }),
      type,
      summary,
      detail,
      color,
      status,
    };
    setLogs((prev) => [newLog, ...prev.slice(0, 49)]);
  };

  // Trigger All-AP 2.4GHz Wi-Fi Scan (first run or user [A] Setup)
  const enterWifiScanWizard = () => {
    clearBootTimers();
    setShowDiagHud(false);
    setStatePhase("wifi_scan");
    setBannerMessage("WiFi Setup");
    setStatusColor("yellow");
    setFps(0);
    setApScanning(true);
    setApSelectedIdx(0);
    setApList([]);
    addLog("WIFI", "WiFi.scanNetworks(all)", "Scanning all nearby 2.4GHz APs (sorting AIR-* first, then RSSI)", "text-sky-400");

    const t = setTimeout(() => {
      const defaultAirSsid =
        config.wifiSsid && config.wifiSsid !== "AIR-A01-12345678"
          ? config.wifiSsid
          : "AIR-A01-94821044";
      const candidates: SimulatedAp[] = [
        { ssid: defaultAirSsid, rssi: -41, channel: 6, isAir: true, isOpen: false },
        { ssid: "AIR-A01-12345678", rssi: -54, channel: 1, isAir: true, isOpen: false },
        { ssid: "Studio-Guest-24G", rssi: -62, channel: 11, isAir: false, isOpen: false },
        { ssid: "Phone-Hotspot", rssi: -71, channel: 6, isAir: false, isOpen: false },
      ];
      // Deduplicate keeping first (strongest)
      const deduped: SimulatedAp[] = [];
      candidates.forEach((ap) => {
        if (!deduped.some((d) => d.ssid === ap.ssid)) deduped.push(ap);
      });
      setApList(deduped);
      setApScanning(false);
      addLog("WIFI", `Scan Complete: ${deduped.length} APs found`, "Use [B] to step APs & [A] to select", "text-emerald-400");
    }, 550);
    bootTimersRef.current.push(t);
  };

  // Trigger Bluetooth BLE Scan Wizard (AIR-* BLE sorted first + 6-digit passkey entry)
  const enterBtScanWizard = () => {
    clearBootTimers();
    setShowDiagHud(false);
    setStatePhase("bt_scan");
    setBannerMessage("BT Setup");
    setStatusColor("yellow");
    setFps(0);
    setBtScanning(true);
    setBtSelectedIdx(0);
    setBtList([]);
    addLog("BT", "BLEDevice::init() -> BLEScan->start(4s)", "Scanning nearby BLE devices (AIR-* cameras sorted first)", "text-sky-400");

    const t = setTimeout(() => {
      const candidates: SimulatedBtDevice[] = [
        { name: "AIR-A01-94821044", mac: "E4:90:7E:A1:42:08", rssi: -46, isAir: true },
        { name: "AIR-A01-12345678", mac: "E4:90:7E:A1:11:3A", rssi: -59, isAir: true },
        { name: "Studio-Beacon-BLE", mac: "3C:61:05:2D:88:19", rssi: -72, isAir: false },
      ];
      setBtList(candidates);
      setBtScanning(false);
      addLog("BT", `BLE Scan Complete: ${candidates.length} devices`, "Use [B] to step devices & [A] to enter 6-digit passkey", "text-emerald-400");
    }, 550);
    bootTimersRef.current.push(t);
  };

  // Start Searching Saved Air loop (stays searching forever until found OR user presses Button A)
  const enterSearchingSavedAir = (creds: SavedWifiCreds) => {
    clearBootTimers();
    setShowDiagHud(false);
    setStatePhase("wifi_searching_saved");
    setBannerMessage("Searching Air");
    setStatusColor("yellow");
    setFps(0);
    setSearchAttempt(1);
    addLog(
      "WIFI",
      `Searching Saved Air: ${creds.ssid}`,
      `Alternating CH:${creds.channel} fast probe & full scan (Static IP .100). Press [A] for Wi-Fi Setup`,
      "text-amber-400"
    );
  };

  useEffect(() => {
    if (!powerOn || statePhase !== "wifi_searching_saved" || !savedWifi) return;
    const interval = setInterval(() => {
      setSearchAttempt((prev) => prev + 1);
      if (airOnline) {
        addLog(
          "WIFI",
          `Found Saved Air '${savedWifi.ssid}'!`,
          `Connecting with CH:${savedWifi.channel} + Static IP 192.168.0.100`,
          "text-emerald-400"
        );
        startFastConnectSequence(savedWifi);
      }
    }, 2400);
    return () => clearInterval(interval);
  }, [powerOn, statePhase, airOnline, savedWifi]);

  // Fast Static-IP + Channel-Cached Connect & airview Handshake
  const startFastConnectSequence = (creds: SavedWifiCreds) => {
    clearBootTimers();
    setShowDiagHud(false);
    setStatePhase("connecting_wifi");
    setBannerMessage("Fast Connect");
    setStatusColor("yellow");
    setFps(0);

    addLog(
      "WIFI",
      `WiFi.begin('${creds.ssid}', ch=${creds.channel})`,
      "Static IP 192.168.0.100 (No DHCP) | persistent(false) | setSleep(false)",
      "text-sky-400"
    );

    const t1 = setTimeout(() => {
      addLog("WIFI", "GOT_IP (Fast Static .100)", `Associated in ~240ms on CH:${creds.channel} | Gateway: ${config.cameraIp}`, "text-emerald-400", "200 OK");
      setStatePhase("cgi_mode");
      setBannerMessage("CGI: Mode");
      addLog("HTTP_GET", "GET /get_connectmode.cgi", `User-Agent + X-Protocol: OlympusCameraKit (50ms min gap)`, "text-amber-400");

      const t2 = setTimeout(() => {
        addLog("HTTP_RES", "200 OK [get_connectmode]", '<connectmode>standalone</connectmode>', "text-emerald-400");
        setStatePhase("cgi_rec");
        setBannerMessage("CGI: REC");
        addLog("HTTP_GET", `GET /switch_cameramode.cgi?mode=rec -> changelvqty=${config.liveViewQuality}`, "HTTP 520 retry guard armed | 50ms inter-call gap", "text-amber-400");

        const t3 = setTimeout(() => {
          addLog("HTTP_RES", "200 OK [mode=rec + changelvqty]", `<response><result>ok</result></response> | Queued AirVol=${AIR_SOUND_OPC_TOKENS[airSoundLevel]} (${driveMode})`, "text-emerald-400");
          setStatePhase("cgi_stream");
          setBannerMessage("CGI: Stream");
          addLog("TCP_STREAM", `AsyncUDP Listening :${config.streamPort}`, "Binding ping-pong buffers before startliveview", "text-cyan-400");
          addLog("HTTP_GET", `GET /exec_takemisc.cgi?com=startliveview&port=${config.streamPort}`, "Starting stream immediately (First-Frame Gate defers camprop writes)", "text-amber-400");

          const t4 = setTimeout(() => {
            addLog("TCP_STREAM", "First RTP Video Frame Received!", "First-Frame Gate satisfied (+150ms) -> unlocking set_camprop sync", "text-emerald-400");
            addLog("HTTP_GET", `POST ASPECT_RATIO=${aspectRatio} & TAKEMODE=${shootMode}`, "TAKEMODE com=get confirm poll (~350ms) | BATTERY_LEVEL synced", "text-cyan-400");
            setStatePhase("streaming");
            setBannerMessage("LIVE");
            setStatusColor("green");
            setFps(26.8);
          }, 320);
          bootTimersRef.current.push(t4);
        }, 280);
        bootTimersRef.current.push(t3);
      }, 240);
      bootTimersRef.current.push(t2);
    }, 340);
    bootTimersRef.current.push(t1);
  };

  // Run the boot sequence respecting optional BT Auto-Wake -> saved Wi-Fi NVS credentials
  const proceedPostBtBoot = (forceAirOnline = false) => {
    if (!savedWifi) {
      enterWifiScanWizard();
      return;
    }
    if (!airOnline && !forceAirOnline) {
      enterSearchingSavedAir(savedWifi);
      return;
    }
    startFastConnectSequence(savedWifi);
  };

  const startBootSequence = () => {
    clearBootTimers();
    if (deepSleepReason) {
      addLog(
        "ACTION",
        clockSynced ? "Deep Sleep Wake -> ESP32-S3 RTC Preserved" : "Deep Sleep Wake (RTC Pending First Shot)",
        clockSynced
          ? `Woke cleanly (${deepSleepReason}) | RTC_DATA_ATTR restored time(nullptr) -> ${clockHms}`
          : `Woke cleanly (${deepSleepReason}) | RTC_DATA_ATTR active; shoots once to sync clock`,
        "text-cyan-400"
      );
      setDeepSleepReason("");
    }
    if (btWakeOnBoot && savedBt) {
      setShowDiagHud(false);
      setStatePhase("bt_wake");
      setBannerMessage("BT Wake Air");
      setStatusColor("yellow");
      setFps(0);
      addLog(
        "BT",
        `BT Auto-Wake -> ${savedBt.name} (${savedBt.mac})`,
        `BLE bond PIN:${savedBt.pin} | Probing 128-bit wake GATT (or AIR_BLE_WAKE_UUIDs) before BLEDevice::deinit(true)`,
        "text-cyan-400"
      );
      addLog("HTTP_GET", "GET /get_commandlist.cgi", "Inspected firmware command capabilities & BLE pwoff support -> cached in NVS", "text-cyan-400", "200 OK");
      const tWake = setTimeout(() => {
        setAirOnline(true);
        addLog(
          "BT",
          "BLE BOND OK + GATT Trace Saved to NVS",
          "Logged SMP status, 128-bit GATT UUIDs, CCCD notifications -> Connect USB or Quick Menu 'Dump Trace' to inspect",
          "text-emerald-400"
        );
        proceedPostBtBoot(true);
      }, 600);
      bootTimersRef.current.push(tWake);
      return;
    }
    proceedPostBtBoot(false);
  };

  useEffect(() => {
    if (powerOn) {
      setMenuOpen(false);
      setPeakSubmenuOpen(false);
      setHudSubmenuOpen(false);
      setSelfTimerSec(null);
      setContBurstActive(false);
      startBootSequence();
    } else {
      clearBootTimers();
      if (selfTimerIntervalRef.current) clearInterval(selfTimerIntervalRef.current);
      if (burstIntervalRef.current) clearInterval(burstIntervalRef.current);
      setMenuOpen(false);
      setPeakSubmenuOpen(false);
      setHudSubmenuOpen(false);
      setHelpScreenOpen(false);
      setSelfTimerSec(null);
      setContBurstActive(false);
      setStatePhase("idle");
      setBannerMessage("Deep Sleep");
      setFps(0);
    }
    return () => {
      clearBootTimers();
      if (selfTimerIntervalRef.current) clearInterval(selfTimerIntervalRef.current);
      if (burstIntervalRef.current) clearInterval(burstIntervalRef.current);
    };
  }, [powerOn, config.streamPort]);

  const QUICK_MENU_COUNT = 22;
  const PEAK_SUBMENU_COUNT = 6;
  const HUD_SUBMENU_COUNT = 16;
  const currentHelpPages = buildEmulatorHelpPages(orientation === "portrait");
  const safeHelpPage = Math.min(helpPage, Math.max(0, currentHelpPages.length - 1));

  // Format persistent StickS3 RTC strings
  const stickClockDateObj = new Date(clockTickNow + clockOffsetMs);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const clockHm = clockSynced
    ? `${pad2(stickClockDateObj.getHours())}:${pad2(stickClockDateObj.getMinutes())}`
    : "--:--";
  const clockHms = clockSynced
    ? `${pad2(stickClockDateObj.getHours())}:${pad2(stickClockDateObj.getMinutes())}:${pad2(stickClockDateObj.getSeconds())}`
    : "--:--:--";
  const clockYmd = clockSynced
    ? `${stickClockDateObj.getFullYear()}-${pad2(stickClockDateObj.getMonth() + 1)}-${pad2(stickClockDateObj.getDate())}`
    : "----/--/--";
  const clockMd = clockSynced
    ? `${pad2(stickClockDateObj.getMonth() + 1)}-${pad2(stickClockDateObj.getDate())}`
    : "CLK*";

  const dismissClock2015Alert = () => {
    if (clock2015TimerRef.current) {
      clearTimeout(clock2015TimerRef.current);
      clock2015TimerRef.current = null;
    }
    setShowClock2015Alert(false);
  };

  const renderClockBadge = (compact = false) => {
    if (clockInvalid2015) {
      return (
        <span
          className="px-1 py-[1px] rounded bg-red-600 text-white font-bold text-[6.5px] leading-none tabular-nums animate-pulse"
          title="Air A01 RTC returned year 2015! Set camera time via phone app and press shutter to re-sync."
        >
          {compact ? "2015!" : "2015!INV"}
        </span>
      );
    }
    if (clockSynced) {
      return (
        <span
          className="text-cyan-300 font-bold text-[6.8px] leading-none tabular-nums"
          title={`StickS3 RTC (${clockYmd} ${clockHms}) synced via /get_imglist.cgi (+${clockLastStopwatchMs}ms)`}
        >
          {compact ? clockHm : clockHms}
        </span>
      );
    }
    return (
      <span
        className="text-slate-400 font-semibold text-[6.8px] leading-none tabular-nums"
        title="Clock awaits first shutter press -> /get_imglist.cgi sync"
      >
        {compact ? "--:--" : "CLK:--:--"}
      </span>
    );
  };

  // Sync StickS3 RTC from Olympus Air A01 /get_imglist.cgi after shutter release + stopwatch
  const runClockSyncFromImageList = (stopwatchStartMs: number, fileNameHint = "P001.JPG") => {
    const elapsedMs = Math.max(24, Math.round(performance.now() - stopwatchStartMs));
    addLog(
      "HTTP_GET",
      "GET /get_imglist.cgi?DIR=/DCIM -> /DCIM/100OLYMP",
      `Stopwatch elapsed: ${elapsedMs}ms | Querying latest timestamped photo to set StickS3 RTC`,
      "text-cyan-400"
    );

    if (airClockReset2015) {
      const target2015Ms = new Date(2015, 0, 1, 0, 4, 12).getTime() + elapsedMs;
      setClockOffsetMs(target2015Ms - Date.now());
      setClockSynced(true);
      setClockLastSyncYear(2015);
      setClockLastSyncFile(fileNameHint);
      setClockLastStopwatchMs(elapsedMs);
      setClockInvalid2015(true);
      setClockSyncPending(true);
      setShowClock2015Alert(true);

      if (clock2015TimerRef.current) clearTimeout(clock2015TimerRef.current);
      clock2015TimerRef.current = setTimeout(() => {
        setShowClock2015Alert(false);
        clock2015TimerRef.current = null;
      }, 2800);

      if (soundEnabled) {
        playM5Beep(880, 130);
        setTimeout(() => playM5Beep(660, 180), 140);
        setTimeout(() => playM5Beep(880, 140), 340);
      }

      addLog(
        "ACTION",
        "CLOCK INVALID (YEAR 2015 DETECTED)!",
        `${fileNameHint} timestamp=2015-01-01 00:04:12 + ${elapsedMs}ms -> Air A01 lost its RTC! Set Air time via phone app & shoot again to re-sync.`,
        "text-red-400",
        "2015!"
      );
      return;
    }

    const nowMs = Date.now();
    const photoDt = new Date(nowMs - elapsedMs);
    const photoStr = `${photoDt.getFullYear()}-${pad2(photoDt.getMonth() + 1)}-${pad2(photoDt.getDate())} ${pad2(photoDt.getHours())}:${pad2(photoDt.getMinutes())}:${pad2(photoDt.getSeconds())}`;
    const syncedDt = new Date(nowMs);
    const syncedStr = `${syncedDt.getFullYear()}-${pad2(syncedDt.getMonth() + 1)}-${pad2(syncedDt.getDate())} ${pad2(syncedDt.getHours())}:${pad2(syncedDt.getMinutes())}:${pad2(syncedDt.getSeconds())}`;

    setClockOffsetMs(0);
    setClockSynced(true);
    setClockLastSyncYear(syncedDt.getFullYear());
    setClockLastSyncFile(fileNameHint);
    setClockLastStopwatchMs(elapsedMs);
    setClockInvalid2015(false);
    setClockSyncPending(false);
    dismissClock2015Alert();

    if (soundEnabled) {
      setTimeout(() => playM5Beep(2400, 35), 40);
      setTimeout(() => playM5Beep(3200, 50), 90);
    }

    addLog(
      "HTTP_RES",
      `[CLOCK] Synced M5.Rtc -> ${syncedStr}`,
      `Latest=${fileNameHint} (${photoStr}) + stopwatch ${elapsedMs}ms -> StickS3 clock active persistently`,
      "text-emerald-400",
      "RTC OK"
    );
  };

  // Button B step handler for Submenus, Quick Menu, Wi-Fi / BT Scans, and Passkey Setup
  const handleButtonBStep = () => {
    if (peakSubmenuOpen) {
      if (soundEnabled) playM5Beep(2300, 18);
      setPeakSubmenuIdx((prev) => (prev + 1) % PEAK_SUBMENU_COUNT);
      setPeakSubmenuBadge("");
      return;
    }

    if (hudSubmenuOpen) {
      if (soundEnabled) playM5Beep(2300, 18);
      setHudSubmenuIdx((prev) => (prev + 1) % HUD_SUBMENU_COUNT);
      setHudSubmenuBadge("");
      return;
    }

    if (helpScreenOpen) {
      if (safeHelpPage + 1 < currentHelpPages.length) {
        if (soundEnabled) playM5Beep(2300, 20);
        setHelpPage(safeHelpPage + 1);
      } else {
        if (soundEnabled) playM5Beep(1400, 25);
      }
      return;
    }

    if (menuOpen) {
      if (soundEnabled) playM5Beep(2300, 18);
      setMenuIdx((prev) => (prev + 1) % QUICK_MENU_COUNT);
      return;
    }

    if (statePhase === "wifi_scan") {
      if (soundEnabled) playM5Beep(2300, 18);
      const extraItems = savedWifi ? 2 : 1;
      const totalItems = apList.length + extraItems;
      if (totalItems > 0) {
        setApSelectedIdx((prev) => (prev + 1) % totalItems);
      }
      return;
    }

    if (statePhase === "bt_scan") {
      if (soundEnabled) playM5Beep(2300, 18);
      const extraItems = savedBt ? 3 : 2;
      const totalItems = btList.length + extraItems;
      if (totalItems > 0) {
        setBtSelectedIdx((prev) => (prev + 1) % totalItems);
      }
      return;
    }

    if (statePhase === "wifi_passkey") {
      if (soundEnabled) playM5Beep(2500, 18);
      if (passCursor < 8) {
        setPassDigits((prev) => {
          const next = [...prev];
          next[passCursor] = (next[passCursor] + 1) % 10;
          return next;
        });
      } else {
        setPassCursor((prev) => {
          const next = prev + 1;
          return next > 10 ? 8 : next;
        });
      }
      return;
    }

    if (statePhase === "bt_passkey") {
      if (soundEnabled) playM5Beep(2500, 18);
      if (btPassCursor < 6) {
        setBtPassDigits((prev) => {
          const next = [...prev];
          next[btPassCursor] = (next[btPassCursor] + 1) % 10;
          return next;
        });
      } else {
        setBtPassCursor((prev) => {
          const next = prev + 1;
          return next > 8 ? 6 : next;
        });
      }
    }
  };

  // Helper to capture one frame from canvas into MicroSD gallery
  const captureCanvasPhoto = () => {
    if (!canvasRef.current) return;
    const rawCanvas = canvasRef.current;
    const w = rawCanvas.width;
    const h = rawCanvas.height;

    const cropCanvas = document.createElement("canvas");
    let sX = 0, sY = 0, sW = w, sH = h;

    if (aspectRatio === "16:9") {
      sH = Math.round((w * 9) / 16);
      sY = Math.round((h - sH) / 2);
    } else if (aspectRatio === "3:2") {
      sH = Math.round((w * 2) / 3);
      sY = Math.round((h - sH) / 2);
    } else if (aspectRatio === "1:1") {
      sW = h;
      sX = Math.round((w - sW) / 2);
    }

    cropCanvas.width = sW;
    cropCanvas.height = sH;
    const cropCtx = cropCanvas.getContext("2d");
    if (cropCtx) {
      cropCtx.drawImage(rawCanvas, sX, sY, sW, sH, 0, 0, sW, sH);
    }

    const photoUrl = cropCanvas.toDataURL("image/jpeg", 0.94);
    setCapturedPhotos((prev) => {
      const newPhoto: CapturedPhoto = {
        id: Math.random().toString(36).substring(2, 9),
        timestamp: new Date().toLocaleTimeString(),
        title: `AIR_P${String(prev.length + 1).padStart(4, "0")}.JPG`,
        imageUrl: photoUrl,
        aperture: sceneExposure.apertureFull,
        iso: sceneExposure.isoFull,
        shutter: sceneExposure.shutterFull,
        aspect: aspectRatio,
        sizeKb: Math.round(14000 + Math.random() * 2000),
      };
      return [newPhoto, ...prev];
    });
    setRemainingShots((prev) => Math.max(0, prev - 1));
  };

  const fireSingleSnapshot = () => {
    if (statePhase !== "streaming" || isAfLocking) return;

    setIsAfLocking(true);
    setBannerMessage("AF...");

    if (soundEnabled) {
      playM5Beep(2800, 30);
      setTimeout(() => playM5Beep(3500, 50), 60);
    }

    addLog("HTTP_GET", "GET /exec_takemotion.cgi?com=takeready&point=0160x0120", "Locking AF/AE (User-Agent + X-Protocol: OlympusCameraKit, 50ms gap)", "text-amber-400");

    setTimeout(() => {
      if (soundEnabled) {
        playShutterSound();
      }

      setIsShutterFlashing(true);
      setBannerMessage("SNAP..");
      const shutterStopwatchStartMs = performance.now();
      const shouldSyncClock = clockSyncPending || clockInvalid2015 || !clockSynced;
      addLog(
        "ACTION",
        "GET /exec_takemotion.cgi?com=newstarttake",
        shouldSyncClock
          ? "Triggering 16MP shutter + starting RTC stopwatch for /get_imglist.cgi clock sync"
          : "Triggering 16MP shutter release (HTTPClient timeout: 7000ms)",
        "text-rose-400"
      );

      setTimeout(() => {
        setIsShutterFlashing(false);
        setBannerMessage("SAVED!");
        const fileLabel = `P${String(capturedPhotos.length + 1).padStart(4, "0")}.JPG`;
        addLog("HTTP_RES", "200 OK [newstarttake -> newstoptake(urgent) -> startliveview]", `<response><result>ok</result><file>DCIM/100OLYMP/${fileLabel}</file></response>`, "text-emerald-400");
        captureCanvasPhoto();

        if (shouldSyncClock) {
          runClockSyncFromImageList(shutterStopwatchStartMs, fileLabel);
        }

        setTimeout(() => {
          setIsAfLocking(false);
          setBannerMessage("SAVED! OK");
          setTimeout(() => {
            setBannerMessage("LIVE");
          }, 1000);
        }, 150);
      }, 220);
    }, 160);
  };

  const stopContinuousBurst = () => {
    if (burstIntervalRef.current) {
      clearInterval(burstIntervalRef.current);
      burstIntervalRef.current = null;
    }
    setContBurstActive(false);
    setBannerMessage("SAVED!");
    if (soundEnabled) playM5Beep(1800, 45);
    addLog("HTTP_GET", "GET /exec_takemotion.cgi?com=newstoptake (urgent)", "Released [A] -> Stopped Continuous Burst -> resuming startliveview", "text-emerald-400");
    if (clockSyncPending || clockInvalid2015 || !clockSynced) {
      const startMs = burstStopwatchStartRef.current || performance.now() - 250;
      runClockSyncFromImageList(startMs, `P${String(Math.max(1, capturedPhotos.length)).padStart(4, "0")}.JPG`);
    }
    setTimeout(() => {
      if (statePhase === "streaming") setBannerMessage("LIVE");
    }, 900);
  };

  const startContinuousBurst = () => {
    if (contBurstActive || statePhase !== "streaming") return;
    burstStopwatchStartRef.current = performance.now();
    setContBurstActive(true);
    setBannerMessage("BURST!");
    if (soundEnabled) playM5Beep(3100, 35);
    const intervalMs = seqSpeed === "HIGH" ? 180 : 380;
    addLog("ACTION", `Hold [A] / HW Shutter Continuous Burst (${seqSpeed})`, `TAKE_DRIVE/DRIVE_MODE verified via desclist | Seq=${seqSpeed} -> rapid continuous cycle`, "text-rose-400");
    // Capture first frame promptly on hold
    if (soundEnabled) playShutterSound();
    setIsShutterFlashing(true);
    setTimeout(() => setIsShutterFlashing(false), 70);
    captureCanvasPhoto();

    burstIntervalRef.current = setInterval(() => {
      if (soundEnabled) playShutterSound();
      setIsShutterFlashing(true);
      setTimeout(() => setIsShutterFlashing(false), 70);
      captureCanvasPhoto();
    }, intervalMs);
  };

  const cancelSelfTimer = () => {
    if (selfTimerIntervalRef.current) {
      clearInterval(selfTimerIntervalRef.current);
      selfTimerIntervalRef.current = null;
    }
    setSelfTimerSec(null);
    setBannerMessage("CANCL");
    if (soundEnabled) playM5Beep(1400, 60);
    addLog("ACTION", "Self-Timer Cancelled", "Timer aborted before shutter release", "text-amber-400");
    setTimeout(() => {
      if (statePhase === "streaming") setBannerMessage("LIVE");
    }, 800);
  };

  const startSelfTimer = (seconds: number) => {
    if (selfTimerIntervalRef.current) clearInterval(selfTimerIntervalRef.current);
    let rem = seconds;
    setSelfTimerSec(rem);
    setBannerMessage(`T-${rem}s`);
    if (soundEnabled) playM5Beep(2300, 30);
    addLog("ACTION", `Self-Timer Started (${seconds}s)`, "Counting down on StickS3 (press [A] or [B] to cancel)", "text-amber-400");

    selfTimerIntervalRef.current = setInterval(() => {
      rem--;
      if (rem <= 0) {
        if (selfTimerIntervalRef.current) {
          clearInterval(selfTimerIntervalRef.current);
          selfTimerIntervalRef.current = null;
        }
        setSelfTimerSec(null);
        fireSingleSnapshot();
      } else {
        setSelfTimerSec(rem);
        setBannerMessage(`T-${rem}s`);
        if (soundEnabled) playM5Beep(rem <= 2 ? 3200 : 2300, rem <= 2 ? 50 : 28);
      }
    }, 1000);
  };

  const toggleQuickMenu = () => {
    setMenuOpen((prev) => {
      const next = !prev;
      if (next) {
        if (selfTimerIntervalRef.current) {
          clearInterval(selfTimerIntervalRef.current);
          selfTimerIntervalRef.current = null;
          setSelfTimerSec(null);
        }
        if (contBurstActive) stopContinuousBurst();
        setMenuIdx(0);
        setMenuStatusBadge("");
        setPeakSubmenuOpen(false);
        setHudSubmenuOpen(false);
        setHelpScreenOpen(false);
        if (soundEnabled) playM5Beep(2900, 40);
        addLog(
          "ACTION",
          `Hold [B] (>=600ms) -> Open Camera Menu (${statePhase === "streaming" ? "LIVE" : "OFFLINE"})`,
          statePhase === "streaming"
            ? "Applies Air A01 & Focus Peaking props live; exits back to Live View instantaneously (~0ms)"
            : "Offline mode: Adjust Focus Peaking, HUD Text, BtnA Mode, Wake Key, Rotation, Sound (saved to NVS)",
          "text-orange-400"
        );
      } else {
        setPeakSubmenuOpen(false);
        setHudSubmenuOpen(false);
        setHelpScreenOpen(false);
        setMenuStatusBadge("");
        if (soundEnabled) playM5Beep(2000, 35);
        addLog(
          "ACTION",
          statePhase === "streaming" ? "Menu -> Instant Resume Live View (~0ms)" : "Menu -> Return",
          statePhase === "streaming"
            ? "Unpaused UDP frame assembly without mode=standalone reset (zero 2-3s delay)"
            : "Returned cleanly to Boot / Wi-Fi screen",
          "text-emerald-400"
        );
      }
      return next;
    });
  };

  const executePeakSubmenuSelection = () => {
    if (peakSubmenuIdx === 0) {
      if (soundEnabled) playM5Beep(2200, 30);
      setPeakSubmenuOpen(false);
      setPeakSubmenuBadge("");
    } else if (peakSubmenuIdx === 1) {
      const nextPeak = !peakEnabled;
      setPeakEnabled(nextPeak);
      setPeakSubmenuBadge(nextPeak ? "OK:ON" : "OK:OFF");
      if (soundEnabled) playM5Beep(nextPeak ? 3000 : 1800, 30);
      addLog(
        "ACTION",
        `Focus Peaking -> ${nextPeak ? "ON" : "OFF"}`,
        nextPeak
          ? `Edge detector armed (${peakSource}, ${peakColor}, ${peakThickness}, ${peakSensitivity})`
          : "Focus Peaking overlay disabled (decoder returns to 160x120 scale=2)",
        "text-cyan-400"
      );
    } else if (peakSubmenuIdx === 2) {
      const nextCol = PEAK_COLOR_ORDER[(PEAK_COLOR_ORDER.indexOf(peakColor) + 1) % PEAK_COLOR_ORDER.length];
      setPeakColor(nextCol);
      setPeakSubmenuBadge(`OK:${PEAK_COLOR_SHORT[nextCol]}`);
      if (soundEnabled) playM5Beep(2600, 25);
      addLog("ACTION", `Peak Color -> ${nextCol}`, `Saved Focus Peaking highlight color (${nextCol}) to NVS`, "text-cyan-400");
    } else if (peakSubmenuIdx === 3) {
      const nextThk = PEAK_THICK_ORDER[(PEAK_THICK_ORDER.indexOf(peakThickness) + 1) % PEAK_THICK_ORDER.length];
      setPeakThickness(nextThk);
      setPeakSubmenuBadge(`OK:${nextThk}`);
      if (soundEnabled) playM5Beep(2600, 25);
      addLog("ACTION", `Peak Thickness -> ${nextThk}`, `Saved Focus Peaking stroke width (${nextThk}) to NVS`, "text-cyan-400");
    } else if (peakSubmenuIdx === 4) {
      const nextSns = PEAK_SENS_ORDER[(PEAK_SENS_ORDER.indexOf(peakSensitivity) + 1) % PEAK_SENS_ORDER.length];
      setPeakSensitivity(nextSns);
      setPeakSubmenuBadge(`OK:${nextSns}`);
      if (soundEnabled) playM5Beep(2600, 25);
      addLog("ACTION", `Peak Sensitivity -> ${nextSns}`, `Gradient threshold -> ${nextSns} (saved to NVS)`, "text-cyan-400");
    } else if (peakSubmenuIdx === 5) {
      const nextSrc = PEAK_SRC_ORDER[(PEAK_SRC_ORDER.indexOf(peakSource) + 1) % PEAK_SRC_ORDER.length];
      setPeakSource(nextSrc);
      setPeakSubmenuBadge(`OK:${nextSrc === "320x240" ? "320" : "160"}`);
      if (soundEnabled) playM5Beep(2600, 25);
      addLog(
        "ACTION",
        `Peak Source -> ${nextSrc}`,
        nextSrc === "320x240"
          ? "Uses TJpgDec scale=1 320x240 luma buffer (~75KB) for maximum critical-focus edge acuity"
          : "Uses fast 160x120 scale=2 luma buffer (~19KB) for maximum frame rate",
        "text-cyan-400"
      );
    }
  };

  const executeHudSubmenuSelection = () => {
    if (hudSubmenuIdx === 0) {
      if (soundEnabled) playM5Beep(2200, 30);
      setHudSubmenuOpen(false);
      setHudSubmenuBadge("");
    } else if (hudSubmenuIdx === 1) {
      const allCurrentlyOn = hudEnabledCount === HUD_ELEMENT_ORDER.length;
      const nextAllOn = !allCurrentlyOn;
      const nextMap: Record<HudElementKey, boolean> = { ...DEFAULT_HUD_VISIBILITY };
      HUD_ELEMENT_ORDER.forEach((el) => {
        nextMap[el.key] = nextAllOn;
      });
      setHudVisibility(nextMap);
      setHudSubmenuBadge(nextAllOn ? "ALL ON" : "ALL OFF");
      if (soundEnabled) playM5Beep(nextAllOn ? 3000 : 1800, 30);
      addLog(
        "ACTION",
        `HUD Elements -> ${nextAllOn ? "ALL ON (14/14)" : "ALL OFF (0/14)"}`,
        nextAllOn
          ? "Restored all on-screen Live View telemetry text elements"
          : "Disabled all on-screen Live View telemetry text elements (clean viewfinder)",
        "text-cyan-400"
      );
    } else {
      const entry = HUD_ELEMENT_ORDER[hudSubmenuIdx - 2];
      if (!entry) return;
      const nextVal = !hudVisibility[entry.key];
      setHudVisibility((prev) => ({ ...prev, [entry.key]: nextVal }));
      setHudSubmenuBadge(nextVal ? "OK:ON" : "OK:OFF");
      if (soundEnabled) playM5Beep(nextVal ? 2900 : 1800, 25);
      addLog(
        "ACTION",
        `HUD [${entry.label}] -> ${nextVal ? "ON" : "OFF"}`,
        `Saved Live View '${entry.label}' text visibility to NVS`,
        nextVal ? "text-emerald-400" : "text-amber-400"
      );
    }
  };

  const executeMenuSelection = () => {
    const isConnected = statePhase === "streaming";
    const inWifiWizard = statePhase === "wifi_scan" || statePhase === "wifi_passkey";
    const inBtWizard = statePhase === "bt_scan" || statePhase === "bt_passkey";

    if (menuIdx === 0) {
      if (soundEnabled) playM5Beep(2200, 30);
      setMenuStatusBadge("");
      setMenuOpen(false);
      addLog(
        "ACTION",
        isConnected ? "Menu -> Instant Resume Live View (~0ms)" : "Menu -> Back",
        isConnected
          ? "Resumed live UDP display directly without mode=standalone round-trip"
          : "Returned to Boot / Setup screen with NVS preferences saved",
        "text-emerald-400"
      );
    } else if (menuIdx === 1) {
      const nextPeak = !peakEnabled;
      setPeakEnabled(nextPeak);
      setMenuStatusBadge(nextPeak ? "OK:ON" : "OK:OFF");
      if (soundEnabled) playM5Beep(nextPeak ? 3000 : 1800, 30);
      addLog(
        "ACTION",
        `Focus Peaking -> ${nextPeak ? "ON" : "OFF"}`,
        nextPeak
          ? `Enabled every-frame ${peakSource} peaking (${peakColor}, ${peakThickness}, ${peakSensitivity})`
          : "Disabled Focus Peaking overlay",
        "text-cyan-400"
      );
    } else if (menuIdx === 2) {
      if (soundEnabled) playM5Beep(2800, 30);
      setPeakSubmenuIdx(1);
      setPeakSubmenuBadge("");
      setPeakSubmenuOpen(true);
    } else if (menuIdx === 3) {
      const nextBtnA: BtnAMode = btnAMode === "SHUTTER" ? "PEAK" : "SHUTTER";
      setBtnAMode(nextBtnA);
      setMenuStatusBadge(`OK:${nextBtnA}`);
      if (soundEnabled) playM5Beep(2600, 25);
      addLog(
        "ACTION",
        `BtnA Mode -> ${nextBtnA}`,
        nextBtnA === "PEAK"
          ? "Button A tap now toggles Focus Peaking ON/OFF only (use Air A01 physical shutter; Hold A+B still sleeps)"
          : "Button A restored to Shutter / Self-Timer / Continuous Burst",
        "text-amber-400"
      );
    } else if (menuIdx === 4) {
      const nextGrid = GRID_MODE_ORDER[(GRID_MODE_ORDER.indexOf(gridMode) + 1) % GRID_MODE_ORDER.length];
      setGridMode(nextGrid);
      setMenuStatusBadge(`OK:${nextGrid}`);
      if (soundEnabled) playM5Beep(2600, 25);
      addLog("ACTION", `Grid Overlay -> ${nextGrid}`, "Saved viewfinder composition grid to NVS (composited via vpCanvas)", "text-cyan-400");
    } else if (menuIdx === 5) {
      const nextDrive = DRIVE_MODE_ORDER[(DRIVE_MODE_ORDER.indexOf(driveMode) + 1) % DRIVE_MODE_ORDER.length];
      setDriveMode(nextDrive);
      if (soundEnabled) playM5Beep(2600, 25);
      if (isConnected) {
        setMenuStatusBadge(`OK:${DRIVE_MODE_SHORT[nextDrive]}`);
        addLog("HTTP_GET", `POST /set_camprop.cgi (TAKE_DRIVE/DRIVE_MODE -> ${nextDrive === "CONT" ? "CONT" : "SINGLE"}) + com=get`, `Applied immediately on Air A01 (HW shutter & [A] ready): ${DRIVE_MODE_LABELS[nextDrive]}`, "text-orange-400", "200 OK");
      } else {
        setMenuStatusBadge("QUEUED");
        addLog("ACTION", `Drive Mode -> ${DRIVE_MODE_LABELS[nextDrive]} (QUEUED)`, "Saved to NVS offline; applies automatically on Air A01 connect", "text-emerald-400");
      }
    } else if (menuIdx === 6) {
      const nextSeq: SeqSpeedMode = seqSpeed === "HIGH" ? "LOW" : "HIGH";
      setSeqSpeed(nextSeq);
      if (soundEnabled) playM5Beep(2600, 25);
      if (isConnected) {
        setMenuStatusBadge(nextSeq === "LOW" ? "A-PACED" : "HW FIXED");
        addLog(
          "ACTION",
          `Seq Speed -> ${nextSeq} (${nextSeq === "LOW" ? "A-PACED" : "HW FIXED"})`,
          "Air A01 OPC exposes fixed ~10fps burst for HW shutter (no arbitrary 6fps/LOW enum); LOW paces Hold-[A] loop",
          "text-cyan-400"
        );
      } else {
        setMenuStatusBadge("QUEUED");
        addLog("ACTION", `Seq Speed -> ${nextSeq} (QUEUED)`, "Saved to NVS offline; controls Hold-[A] burst cadence", "text-emerald-400");
      }
    } else if (menuIdx === 7) {
      const nextSnd = !soundEnabled;
      setSoundEnabled(nextSnd);
      setMenuStatusBadge(nextSnd ? "OK:ON" : "OK:OFF");
      if (nextSnd) playM5Beep(2600, 25);
      addLog("ACTION", `Stick Sound -> ${nextSnd ? "ON" : "OFF"}`, `ES8311 + AW8737 speaker cues ${nextSnd ? "enabled" : "muted"} (saved to NVS)`, "text-emerald-400");
    } else if (menuIdx === 8) {
      const nextAirSnd = AIR_SOUND_ORDER[(AIR_SOUND_ORDER.indexOf(airSoundLevel) + 1) % AIR_SOUND_ORDER.length];
      setAirSoundLevel(nextAirSnd);
      if (soundEnabled) playM5Beep(2600, 25);
      if (isConnected) {
        setMenuStatusBadge(`OK:${nextAirSnd}`);
        addLog(
          "HTTP_GET",
          `POST /set_camprop.cgi?propname=SOUND_VOLUME_LEVEL (${AIR_SOUND_OPC_TOKENS[nextAirSnd]}) + com=get`,
          `Applied live on Air A01 (${AIR_SOUND_OPC_TOKENS[nextAirSnd]}) — OPC writes are volatile across cold reboot; StickS3 re-syncs from NVS`,
          "text-cyan-400",
          "200 OK"
        );
      } else {
        setMenuStatusBadge("QUEUED");
        addLog(
          "ACTION",
          `Air Sound -> ${nextAirSnd} (QUEUED)`,
          `Saved to StickS3 NVS offline; sends SOUND_VOLUME_LEVEL=${AIR_SOUND_OPC_TOKENS[nextAirSnd]} immediately upon REC handshake`,
          "text-emerald-400"
        );
      }
    } else if (menuIdx === 9) {
      const nextBri = (brightnessLevel + 1) % 3;
      setBrightnessLevel(nextBri);
      const pct = nextBri === 0 ? 100 : nextBri === 1 ? 60 : 30;
      setMenuStatusBadge(`OK:${pct}%`);
      if (soundEnabled) playM5Beep(2600, 25);
      addLog("ACTION", `Display Brightness -> ${pct}%`, `ST7789P3 PWM backlight set to ${pct}% (saved)`, "text-amber-400");
    } else if (menuIdx === 10) {
      toggleGyroRotate();
    } else if (menuIdx === 11) {
      toggleCamGyro();
    } else if (menuIdx === 12) {
      if (soundEnabled) playM5Beep(2800, 30);
      setHudSubmenuIdx(1);
      setHudSubmenuBadge("");
      setHudSubmenuOpen(true);
    } else if (menuIdx === 13) {
      const nextWake = !btWakeOnBoot;
      setBtWakeOnBoot(nextWake);
      if (soundEnabled) playM5Beep(2600, 25);
      if (nextWake && !savedBt) {
        setMenuStatusBadge("NO PAIR");
        addLog("BT", "BT Wake -> ON (Unpaired)", "Enabled BT Wake flag — open 'BT Setup' below to pair your Air A01 + 6-digit PIN", "text-amber-400");
      } else {
        setMenuStatusBadge(nextWake ? "OK:ON" : "OK:OFF");
        addLog(
          "BT",
          `BT Wake on Boot -> ${nextWake ? "ON" : "OFF"}`,
          nextWake
            ? `StickS3 will auto-wake paired '${savedBt?.name}' via BLE before Wi-Fi on power-on`
            : "Skipped BLE wake on boot; connects directly over Wi-Fi",
          "text-cyan-400"
        );
      }
    } else if (menuIdx === 14) {
      if (soundEnabled) playM5Beep(2800, 35);
      setMenuStatusBadge("");
      setMenuOpen(false);
      if (inBtWizard) {
        addLog("BT", "Menu -> Return to Active BT Setup", "Closed menu back into BLE scan / 6-digit PIN screen", "text-sky-400");
      } else {
        addLog("BT", "Menu -> Bluetooth Setup Wizard", "Scanning BLE devices (AIR-* first) for 6-digit passkey wake pairing", "text-sky-400");
        enterBtScanWizard();
      }
    } else if (menuIdx === 15) {
      if (soundEnabled) playM5Beep(2800, 35);
      setMenuStatusBadge("");
      setMenuOpen(false);
      if (inWifiWizard) {
        addLog("ACTION", "Menu -> Return to Active Wi-Fi Setup", "Closed menu back into Wi-Fi AP/Passkey screen", "text-sky-400");
      } else {
        addLog("ACTION", "Menu -> Restart Wi-Fi Setup", "Stopping liveview & opening All-AP Wi-Fi Setup Wizard", "text-sky-400");
        enterWifiScanWizard();
      }
    } else if (menuIdx === 16) {
      setClockSyncPending(true);
      if (soundEnabled) playM5Beep(2800, 35);
      setMenuStatusBadge("NEXT SHT");
      addLog(
        "ACTION",
        "Menu -> Sync Clock Armed",
        "Next [A] / shutter press starts stopwatch -> /get_imglist.cgi + elapsed -> sets M5.Rtc (flags 2015! if Air RTC lost)",
        "text-cyan-400"
      );
    } else if (menuIdx === 17) {
      const nextWakeKey = WAKE_KEY_ORDER[(WAKE_KEY_ORDER.indexOf(wakeKeyMode) + 1) % WAKE_KEY_ORDER.length];
      setWakeKeyMode(nextWakeKey);
      setMenuStatusBadge(`OK:${nextWakeKey}`);
      if (soundEnabled) playM5Beep(2600, 25);
      addLog(
        "ACTION",
        `Wake Key -> ${nextWakeKey}`,
        nextWakeKey === "BTN B"
          ? "Deep Sleep wakes ONLY via side Button B (GPIO 12); Button A wake OFF (pocket-safe)"
          : nextWakeKey === "BTN A"
          ? "Deep Sleep wakes via front Button A (GPIO 11) only; Button B wake OFF"
          : "Deep Sleep wakes via Button A (GPIO 11) OR Button B (GPIO 12)",
        "text-emerald-400"
      );
    } else if (menuIdx === 18) {
      if (soundEnabled) playM5Beep(2800, 30);
      setHelpPage(0);
      setHelpScreenOpen(true);
      addLog("ACTION", "Menu -> Help & Button Reference", "Opened paginated guide ([A] Page Up, [B] Page Down, Hold [B] Back)", "text-cyan-400");
    } else if (menuIdx === 19) {
      if (soundEnabled) playM5Beep(2900, 35);
      setMenuStatusBadge("SENT");
      addLog(
        "BT",
        "[TRACE-BEGIN] Dumped NVS Trace to 115200 USB Serial",
        `SMP:${savedBt ? "BOND OK" : "UNPAIRED"} | CG:${camGyroMode} | PK:${peakEnabled ? peakColor : "OFF"}/${peakSource} | HUD:${hudEnabledCount}/14 | A:${btnAMode} | WK:${wakeKeyMode} | CLK:${clockYmd} ${clockHms} [TRACE-END]`,
        "text-emerald-400"
      );
    } else if (menuIdx === 20) {
      triggerPowerOffStickOnly();
    } else if (menuIdx === 21) {
      triggerPowerOffWithAir();
    }
  };

  // Short Button A click action
  const handleButtonAShort = () => {
    if (!powerOn) return;
    rapidBCountRef.current = 0;

    if (showClock2015Alert) {
      dismissClock2015Alert();
      return;
    }

    if (peakSubmenuOpen) {
      executePeakSubmenuSelection();
      return;
    }

    if (hudSubmenuOpen) {
      executeHudSubmenuSelection();
      return;
    }

    if (helpScreenOpen) {
      if (safeHelpPage > 0) {
        if (soundEnabled) playM5Beep(2600, 20);
        setHelpPage(safeHelpPage - 1);
      } else {
        if (soundEnabled) playM5Beep(1400, 25);
      }
      return;
    }

    if (menuOpen) {
      executeMenuSelection();
      return;
    }

    if (statePhase === "wifi_searching_saved") {
      if (soundEnabled) playM5Beep(2800, 35);
      addLog("ACTION", "[A] Open Wi-Fi Setup", "Switching from Saved Air Search to All-AP Scanner", "text-orange-400");
      enterWifiScanWizard();
      return;
    }

    if (statePhase === "bt_scan") {
      const extraIdxRescan = btList.length;
      const extraIdxForget = savedBt ? btList.length + 1 : -1;
      const extraIdxBack = savedBt ? btList.length + 2 : btList.length + 1;

      if (btSelectedIdx === extraIdxRescan) {
        if (soundEnabled) playM5Beep(2600, 30);
        enterBtScanWizard();
        return;
      }
      if (savedBt && btSelectedIdx === extraIdxForget) {
        if (soundEnabled) playM5Beep(1700, 40);
        setSavedBt(null);
        setBtWakeOnBoot(false);
        setBtSelectedIdx(0);
        addLog("BT", "Cleared Paired BLE Device", "Removed saved BT MAC/PIN & disabled BT Wake in NVS", "text-amber-400");
        return;
      }
      if (btSelectedIdx === extraIdxBack) {
        if (soundEnabled) playM5Beep(2000, 30);
        addLog("BT", "Exited BT Setup -> Returning", "Closed BLE Setup Wizard cleanly", "text-slate-300");
        proceedPostBtBoot(false);
        return;
      }

      const chosen = btList[btSelectedIdx];
      if (!chosen) return;
      if (soundEnabled) playM5Beep(3000, 40);
      const seedPin =
        savedBt && savedBt.mac === chosen.mac && /^\d{6}$/.test(savedBt.pin)
          ? savedBt.pin
          : "000000";
      setBtPassDigits(seedPin.split("").map((c) => Number(c)));
      setBtPassCursor(0);
      setSelectedBtForPass(chosen);
      setStatePhase("bt_passkey");
      addLog("BT", `Selected BLE '${chosen.name}' (${chosen.mac})`, "Enter 6-digit numerical BT passkey ([B] +1, [A] next)", "text-sky-400");
      return;
    }

    if (statePhase === "bt_passkey") {
      if (btPassCursor < 6) {
        if (soundEnabled) playM5Beep(2700, 25);
        setBtPassCursor((prev) => prev + 1);
      } else if (btPassCursor === 6 && selectedBtForPass) {
        const pinCode = btPassDigits.join("");
        if (soundEnabled) playM5Beep(3200, 60);
        const nextBt: SavedBtCreds = {
          name: selectedBtForPass.name,
          mac: selectedBtForPass.mac,
          pin: pinCode,
        };
        setSavedBt(nextBt);
        setBtWakeOnBoot(true);
        setAirOnline(true);
        addLog(
          "BT",
          `BLE Bonded '${nextBt.name}' (PIN:${pinCode}) -> BT Wake ON`,
          "Saved MAC + 6-digit passkey to NVS, probed 128-bit wake GATT, & enabled boot auto-wake",
          "text-emerald-400"
        );
        proceedPostBtBoot(true);
      } else if (btPassCursor === 7) {
        if (soundEnabled) playM5Beep(2300, 25);
        setBtPassCursor(0);
      } else {
        if (soundEnabled) playM5Beep(1700, 30);
        enterBtScanWizard();
      }
      return;
    }

    if (statePhase === "wifi_scan") {
      if (apSelectedIdx === apList.length) {
        if (soundEnabled) playM5Beep(2600, 30);
        enterWifiScanWizard();
        return;
      }
      if (savedWifi && apSelectedIdx === apList.length + 1) {
        if (soundEnabled) playM5Beep(2200, 30);
        enterSearchingSavedAir(savedWifi);
        return;
      }
      const chosen = apList[apSelectedIdx];
      if (!chosen) return;
      if (soundEnabled) playM5Beep(3000, 40);
      if (chosen.isOpen) {
        const nextCreds: SavedWifiCreds = { ssid: chosen.ssid, pass: "", channel: chosen.channel };
        setSavedWifi(nextCreds);
        setAirOnline(true);
        startFastConnectSequence(nextCreds);
        return;
      }
      const seedStr =
        savedWifi && savedWifi.ssid === chosen.ssid && /^\d{8}$/.test(savedWifi.pass)
          ? savedWifi.pass
          : /^\d{8}$/.test(config.wifiPass) && chosen.ssid === config.wifiSsid
          ? config.wifiPass
          : "00000000";
      setPassDigits(seedStr.split("").map((c) => Number(c)));
      setPassCursor(0);
      setSelectedApForPass(chosen);
      setStatePhase("wifi_passkey");
      addLog("WIFI", `Selected AP '${chosen.ssid}'`, "Press [B] to increment digits 0->9 and [A] to confirm", "text-sky-400");
      return;
    }

    if (statePhase === "wifi_passkey") {
      if (passCursor < 8) {
        if (soundEnabled) playM5Beep(2700, 25);
        setPassCursor((prev) => prev + 1);
      } else if (passCursor === 8 && selectedApForPass) {
        const enteredCode = passDigits.join("");
        if (soundEnabled) playM5Beep(3200, 60);
        const nextCreds: SavedWifiCreds = {
          ssid: selectedApForPass.ssid,
          pass: enteredCode,
          channel: selectedApForPass.channel,
        };
        setSavedWifi(nextCreds);
        setAirOnline(true);
        addLog("WIFI", `Confirmed Passkey for ${selectedApForPass.ssid}`, `Saved 8-digit key & CH:${selectedApForPass.channel} to NVS`, "text-emerald-400");
        startFastConnectSequence(nextCreds);
      } else if (passCursor === 9) {
        if (soundEnabled) playM5Beep(2300, 25);
        setPassCursor(0);
      } else {
        if (soundEnabled) playM5Beep(1700, 30);
        enterWifiScanWizard();
      }
      return;
    }

    if (statePhase !== "streaming") return;

    if (btnAMode === "PEAK") {
      const nextPeak = !peakEnabled;
      setPeakEnabled(nextPeak);
      if (soundEnabled) playM5Beep(nextPeak ? 3000 : 1800, 28);
      setBannerMessage(nextPeak ? "PK:ON" : "PK:OFF");
      addLog(
        "ACTION",
        `[A] Focus Peaking -> ${nextPeak ? "ON" : "OFF"}`,
        "BtnA Mode = PEAK (tap toggles peaking only; use Air A01 physical shutter button)",
        "text-cyan-400"
      );
      setTimeout(() => {
        if (statePhase === "streaming") setBannerMessage("LIVE");
      }, 900);
      return;
    }

    if (selfTimerSec !== null) {
      cancelSelfTimer();
    } else if (driveMode === "CONT") {
      startContinuousBurst();
    } else if (driveMode === "TIMER_2S") {
      startSelfTimer(2);
    } else if (driveMode === "TIMER_10S") {
      startSelfTimer(10);
    } else {
      fireSingleSnapshot();
    }
  };

  const wakeFromDeepSleep = (sourceLabel: string) => {
    if (powerOn) return;
    if (soundEnabled) playM5Beep(2800, 35);
    setDeepSleepReason(sourceLabel);
    setPowerOn(true);
  };

  const handlePowerButtonPress = () => {
    dismissClock2015Alert();
    rapidBCountRef.current = 0;
    addLog(
      "ACTION",
      "Power Button -> Hardware PMIC Reset",
      powerOn
        ? "Recessed side Power Button resets M5StickS3 cleanly"
        : `Pushing Power Button while sleeping hardware-resets M5StickS3 (use Wake Key '${wakeKeyMode}' to wake with RTC alive)`,
      "text-amber-400"
    );
    setClockSynced(false);
    setClockSyncPending(true);
    setPowerOn(false);
    setTimeout(() => setPowerOn(true), 250);
  };

  const handleButtonADown = () => {
    if (!powerOn) {
      const btnAAllowed = wakeKeyMode === "BTN A" || wakeKeyMode === "A+B";
      if (btnAAllowed) {
        wakeFromDeepSleep("Button A (GPIO 11)");
      } else {
        addLog(
          "ACTION",
          `[SLEEP] Button A Ignored (Wake Key: ${wakeKeyMode})`,
          `Pocket-safe lock: Button A wake is OFF. Press ${wakeKeyMode} to wake.`,
          "text-amber-400"
        );
      }
      return;
    }
    if (btnAPressed) return;
    setBtnAPressed(true);
    btnAShotHandledRef.current = false;

    if (!menuOpen && !peakSubmenuOpen && !hudSubmenuOpen && !helpScreenOpen && statePhase === "streaming") {
      btnAShotHandledRef.current = true;
      handleButtonAShort();
    }
  };

  const handleButtonAUp = (cancelled = false) => {
    if (!btnAPressed) return;
    setBtnAPressed(false);
    if (contBurstActive) {
      stopContinuousBurst();
    }
    const alreadyHandled = btnAShotHandledRef.current;
    btnAShotHandledRef.current = false;
    if (cancelled || !powerOn || alreadyHandled) return;
    handleButtonAShort();
  };

  // Cycle Olympus Air aspect ratios helper (16:9 default -> 4:3 -> 3:2 -> 1:1 via OPC "6:6")
  const cycleAspectRatio = () => {
    const list: AspectRatioMode[] = ["16:9", "4:3", "3:2", "1:1"];
    const nextIdx = (list.indexOf(aspectRatio) + 1) % list.length;
    const nextRatio = list[nextIdx];
    const opcToken = nextRatio === "1:1" ? "6:6" : nextRatio;
    setAspectRatio(nextRatio);

    if (soundEnabled) {
      playM5Beep(2400, 35);
    }

    setBannerMessage(`[${nextRatio}]`);
    addLog("HTTP_GET", `POST /set_camprop.cgi?propname=ASPECT_RATIO (${opcToken})`, `Synced camera ASPECT_RATIO (${nextRatio} -> OPC "${opcToken}") & fit-to-window frame`, "text-orange-400");

    setTimeout(() => {
      if (statePhase === "streaming") {
        setBannerMessage("LIVE");
      }
    }, 1000);
  };

  // Apply shooting mode (AUTO, Aperture Priority widest aperture, Shutter Priority 1/60)
  const applyEmulatorShootMode = (nextMode: ShootingModePreset) => {
    setShootMode(nextMode);
    if (soundEnabled) {
      playM5Beep(2900, 50);
    }

    if (nextMode === "AUTO") {
      setBannerMessage("iAUTO");
      addLog("HTTP_GET", "POST /set_camprop.cgi?propname=TAKEMODE (iAUTO)", "Confirmed TAKEMODE=iAuto via 100ms com=get poll", "text-emerald-400");
    } else if (nextMode === "A_WIDE") {
      setBannerMessage(`A:${widestF}`);
      addLog("HTTP_GET", "POST /set_camprop.cgi?propname=TAKEMODE (A)", `200 <notset/> -> confirmed TAKEMODE=A -> widest F${widestF} (${LENS_SPECS[attachedLens].label})`, "text-cyan-400");
      addLog("HTTP_RES", `POST /set_camprop.cgi?propname=APERTURE (${widestF})`, `<result>ok</result> Widest lens aperture F${widestF} locked`, "text-emerald-400");
    } else {
      setBannerMessage("S:1/60");
      addLog("HTTP_GET", "POST /set_camprop.cgi?propname=TAKEMODE (S)", "200 <notset/> -> confirmed TAKEMODE=S -> setting 1/60 slowest speed", "text-orange-400");
      addLog("HTTP_RES", "POST /set_camprop.cgi?propname=SHUTTER (60)", "<result>ok</result> Shutter speed set to 1/60s", "text-emerald-400");
    }

    setTimeout(() => {
      if (statePhase === "streaming") {
        setBannerMessage("LIVE");
      }
    }, 1000);
  };

  const cycleShootingMode = () => {
    const order: ShootingModePreset[] = ["AUTO", "A_WIDE", "S_60"];
    const next = order[(order.indexOf(shootMode) + 1) % order.length];
    applyEmulatorShootMode(next);
  };

  const toggleDiagnosticsHud = () => {
    setShowDiagHud((prev) => {
      const next = !prev;
      if (soundEnabled) {
        playM5Beep(3000, 65);
      }
      addLog("ACTION", "Button B 3× Click", `${next ? "Opened" : "Closed"} Full Diagnostics HUD`, "text-purple-400");
      return next;
    });
  };

  // Button B: Setup step, Submenu/Menu nav, 1x=Aspect, 2x=Mode, 3x=Diag, 4x=GyroLock, 5x=Deep Sleep (Live/Wi-Fi/BT), Hold=Menu
  const handleButtonBDown = () => {
    if (!powerOn) {
      const btnBAllowed = wakeKeyMode === "BTN B" || wakeKeyMode === "A+B";
      if (btnBAllowed) {
        wakeFromDeepSleep("Button B (GPIO 12)");
      } else {
        addLog(
          "ACTION",
          `[SLEEP] Button B Ignored (Wake Key: ${wakeKeyMode})`,
          `Deep Sleep awaits ${wakeKeyMode} wake trigger`,
          "text-amber-400"
        );
      }
      return;
    }
    if (btnBPressed) return;
    if (showClock2015Alert) {
      dismissClock2015Alert();
      return;
    }
    setBtnBPressed(true);
    btnBPressStartRef.current = Date.now();
    btnBLongTriggeredRef.current = false;

    if (!menuOpen && !peakSubmenuOpen && !hudSubmenuOpen && !helpScreenOpen && ((statePhase === "wifi_passkey" && passCursor < 8) || (statePhase === "bt_passkey" && btPassCursor < 6))) {
      btnBTimerRef.current = setTimeout(() => {
        btnBRepeatTimerRef.current = setInterval(() => {
          handleButtonBStep();
        }, 140);
      }, 420);
      return;
    }

    const canOpenQuickMenu =
      menuOpen ||
      peakSubmenuOpen ||
      hudSubmenuOpen ||
      helpScreenOpen ||
      statePhase === "streaming" ||
      statePhase === "wifi_searching_saved" ||
      statePhase === "wifi_scan" ||
      (statePhase === "wifi_passkey" && passCursor >= 8) ||
      statePhase === "bt_scan" ||
      (statePhase === "bt_passkey" && btPassCursor >= 6);

    if (canOpenQuickMenu) {
      btnBTimerRef.current = setTimeout(() => {
        btnBTimerRef.current = null;
        btnBLongTriggeredRef.current = true;
        rapidBCountRef.current = 0;
        if (btnBMultiTimerRef.current) {
          clearTimeout(btnBMultiTimerRef.current);
          btnBMultiTimerRef.current = null;
        }
        btnBClickCountRef.current = 0;
        if (peakSubmenuOpen) {
          if (soundEnabled) playM5Beep(2000, 35);
          setPeakSubmenuOpen(false);
          setPeakSubmenuBadge("");
        } else if (hudSubmenuOpen) {
          if (soundEnabled) playM5Beep(2000, 35);
          setHudSubmenuOpen(false);
          setHudSubmenuBadge("");
        } else if (helpScreenOpen) {
          if (soundEnabled) playM5Beep(2000, 35);
          setHelpScreenOpen(false);
        } else {
          toggleQuickMenu();
        }
      }, 600);
    }
  };

  const recordNonLiveBtnBClickAndCheck5x = () => {
    const now = Date.now();
    if (now - rapidBLastMsRef.current > 500) {
      rapidBCountRef.current = 0;
    }
    rapidBCountRef.current += 1;
    rapidBLastMsRef.current = now;
    if (rapidBCountRef.current >= 5) {
      rapidBCountRef.current = 0;
      addLog("ACTION", "Button B 5× Click (Wi-Fi/Setup Screen)", "Entered Deep Sleep cleanly while keeping RTC alive", "text-rose-400");
      triggerPowerOffWithAir();
      return true;
    }
    return false;
  };

  const handleButtonBUp = (cancelled = false) => {
    if (!btnBPressed) return;
    setBtnBPressed(false);

    if (btnBTimerRef.current) {
      clearTimeout(btnBTimerRef.current);
      btnBTimerRef.current = null;
    }
    if (btnBRepeatTimerRef.current) {
      clearInterval(btnBRepeatTimerRef.current);
      btnBRepeatTimerRef.current = null;
    }

    if (cancelled || !powerOn || btnBLongTriggeredRef.current) return;

    if (menuOpen || peakSubmenuOpen || hudSubmenuOpen || helpScreenOpen) {
      rapidBCountRef.current = 0;
      handleButtonBStep();
      return;
    }

    const duration = Date.now() - btnBPressStartRef.current;

    if (statePhase === "wifi_scan" || statePhase === "wifi_passkey" || statePhase === "bt_scan" || statePhase === "bt_passkey") {
      const inDigitEntry = (statePhase === "wifi_passkey" && passCursor < 8) || (statePhase === "bt_passkey" && btPassCursor < 6);
      const limitMs = inDigitEntry ? 420 : 600;
      if (duration < limitMs) {
        if (recordNonLiveBtnBClickAndCheck5x()) return;
        handleButtonBStep();
      }
      return;
    }

    if (statePhase !== "streaming") {
      if (duration < 600) {
        recordNonLiveBtnBClickAndCheck5x();
      }
      return;
    }

    if (selfTimerSec !== null) {
      cancelSelfTimer();
      return;
    }

    if (duration < 600) {
      btnBClickCountRef.current += 1;
      if (btnBMultiTimerRef.current) {
        clearTimeout(btnBMultiTimerRef.current);
        btnBMultiTimerRef.current = null;
      }
      if (btnBClickCountRef.current >= 5) {
        btnBClickCountRef.current = 0;
        addLog("ACTION", "Button B 5× Click", "Shuts down Air A01 + puts M5StickS3 into Deep Sleep (RTC preserved)", "text-rose-400");
        triggerPowerOffWithAir();
      } else {
        btnBMultiTimerRef.current = setTimeout(() => {
          const clicks = btnBClickCountRef.current;
          btnBClickCountRef.current = 0;
          btnBMultiTimerRef.current = null;
          if (clicks === 1) {
            cycleAspectRatio();
          } else if (clicks === 2) {
            cycleShootingMode();
          } else if (clicks === 3) {
            toggleDiagnosticsHud();
          } else if (clicks === 4) {
            toggleDualGyroLock();
          }
        }, 360);
      }
    }
  };

  const toggleDualGyroLock = () => {
    if (!dualGyroLocked) {
      const prevStick = stickRotMode;
      const prevCam = camGyroMode;
      setPriorStickRotMode(prevStick);
      setPriorCamGyroMode(prevCam);
      setDualGyroLocked(true);
      setStickRotMode("LOCK");
      setCamGyroMode("LOCK");
      setLockedCamRot(0);
      if (soundEnabled) playM5Beep(1800, 65);
      setBannerMessage("GYRO:LCK");
      addLog(
        "ACTION",
        "Button B 4× Click -> Locked Both Gyros",
        `Stick Rot -> LOCK & Cam Gyro -> LOCK (saved prior modes: Stick=${prevStick}, Cam=${prevCam})`,
        "text-amber-400"
      );
    } else {
      let nextStick: StickRotMode = priorStickRotMode;
      let nextCam: CamGyroMode = priorCamGyroMode;
      if (nextStick === "LOCK" && nextCam === "LOCK") {
        nextStick = "GYRO";
        nextCam = "AUTO";
      }
      setStickRotMode(nextStick);
      setCamGyroMode(nextCam);
      setDualGyroLocked(false);
      if (soundEnabled) playM5Beep(3100, 65);
      setBannerMessage("GYRO:ON");
      addLog(
        "ACTION",
        "Button B 4× Click -> Restored Both Gyros",
        `Restored prior modes cleanly: Stick=${nextStick}, Cam=${nextCam}`,
        "text-emerald-400"
      );
    }
    setTimeout(() => {
      if (statePhase === "streaming") setBannerMessage("LIVE");
    }, 1000);
  };

  const toggleGyroRotate = () => {
    const order: StickRotMode[] = ["LOCK", "GYRO", "L-FLIP"];
    const next = order[(order.indexOf(stickRotMode) + 1) % order.length];
    setStickRotMode(next);
    setDualGyroLocked(false);
    setMenuStatusBadge(`OK:${next}`);
    if (soundEnabled) playM5Beep(next === "LOCK" ? 1600 : 3200, 70);
    setBannerMessage(next);
    addLog(
      "ACTION",
      `Menu -> Stick Rot (${next})`,
      next === "GYRO"
        ? "BMI270 4-way auto-rotate enabled (M5.Imu.update + StickS3 axis mapping)"
        : next === "L-FLIP"
        ? "BMI270 Landscape 180° auto-flip enabled (stays horizontal when tilted)"
        : "StickS3 orientation locked",
      "text-purple-400"
    );
    setTimeout(() => {
      if (statePhase === "streaming") setBannerMessage("LIVE");
    }, 1000);
  };

  const toggleCamGyro = () => {
    const order: CamGyroMode[] = ["AUTO", "180D", "LOCK"];
    const next = order[(order.indexOf(camGyroMode) + 1) % order.length];
    setCamGyroMode(next);
    setDualGyroLocked(false);
    if (next === "LOCK") {
      setLockedCamRot(0);
    }
    setMenuStatusBadge(`OK:${next}`);
    if (soundEnabled) playM5Beep(next === "LOCK" ? 1700 : 3100, 50);
    addLog(
      "ACTION",
      `Cam Gyro -> ${next}`,
      next === "AUTO"
        ? "180°-only auto-flip from OPC RTP EXIF (funcId=1: 1 <-> 3; ignores 90°/270°)"
        : next === "180D"
        ? "Manual 180° upside-down live-view flip active inside vpCanvas"
        : "Locked camera live view at 0°",
      "text-cyan-400"
    );
  };

  const triggerPowerOffWithAir = () => {
    if (!powerOn) {
      setAirOnline(true);
      wakeFromDeepSleep("Simulator Wake All");
      return;
    }
    if (soundEnabled) {
      playM5Beep(1200, 120);
    }
    addLog("ACTION", "Deep Sleep (Air Off + StickS3 Sleep)", `Saved NVS + RTC (${clockSynced ? clockHms : "pending"}) | Arming Wake Key: ${wakeKeyMode}`, "text-amber-400");
    addLog("HTTP_GET", "GET /switch_cameramode.cgi?mode=standalone", "Flushing Air Sound & Drive props in standalone mode before shutdown", "text-cyan-400");
    addLog("HTTP_GET", "GET /exec_pwoff.cgi?mode=withble", `Shutting down Air A01 -> esp_deep_sleep_start() (Wake Key: ${wakeKeyMode})`, "text-rose-400", "200 OK");
    setAirOnline(false);
    setPowerOn(false);
  };

  const triggerPowerOffStickOnly = () => {
    if (!powerOn) {
      wakeFromDeepSleep("Simulator Wake S3");
      return;
    }
    if (soundEnabled) {
      playM5Beep(1500, 90);
    }
    addLog("ACTION", "Deep Sleep: Stick Only (Keep Air ON)", `Saved NVS & kept Air A01 ON | RTC preserved (${clockSynced ? clockHms : "pending"})`, "text-cyan-400");
    addLog("HTTP_GET", "GET /exec_takemisc.cgi?com=stopliveview -> mode=standalone", "esp_deep_sleep_start() active (Wake Key: " + wakeKeyMode + ")", "text-cyan-400", "200 OK");
    setAirOnline(true);
    setPowerOn(false);
  };

  // Canvas Live Video Stream Simulator with Aspect Ratio Framing + Real-Time Focus Peaking (320x240 or 160x120)
  useEffect(() => {
    if (!canvasRef.current || statePhase !== "streaming") {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    let running = true;

    const drawSimulatedScene = (
      targetCtx: CanvasRenderingContext2D,
      tw: number,
      th: number,
      t: number,
      blurPx: number,
      netRotDeg: number
    ) => {
      targetCtx.save();
      targetCtx.filter = blurPx > 0.05 ? `blur(${blurPx.toFixed(2)}px)` : "none";
      targetCtx.fillStyle = "#111827";
      targetCtx.fillRect(0, 0, tw, th);

      targetCtx.save();
      if (netRotDeg !== 0) {
        targetCtx.translate(tw / 2, th / 2);
        targetCtx.rotate((netRotDeg * Math.PI) / 180);
        if (netRotDeg === 90 || netRotDeg === 270) {
          const s = Math.min(tw / th, th / tw);
          targetCtx.scale(s, s);
        }
        targetCtx.translate(-tw / 2, -th / 2);
      }

      const sx = tw / 160;
      const sy = th / 120;

      if (selectedScene === "street") {
        const sky = targetCtx.createLinearGradient(0, 0, 0, th);
        sky.addColorStop(0, "#1e293b");
        sky.addColorStop(0.4, "#334155");
        sky.addColorStop(0.7, "#64748b");
        sky.addColorStop(1, "#94a3b8");
        targetCtx.fillStyle = sky;
        targetCtx.fillRect(0, 0, tw, th);

        targetCtx.fillStyle = "rgba(254, 240, 138, 0.45)";
        targetCtx.beginPath();
        targetCtx.arc(tw * 0.75, th * 0.28, 22 * sx, 0, Math.PI * 2);
        targetCtx.fill();

        targetCtx.fillStyle = "#1e293b";
        targetCtx.fillRect(tw * 0.1, th * 0.45, 30 * sx, th * 0.55);
        targetCtx.fillRect(tw * 0.25, th * 0.35, 45 * sx, th * 0.65);
        targetCtx.fillRect(tw * 0.5, th * 0.4, 38 * sx, th * 0.6);
        targetCtx.fillRect(tw * 0.72, th * 0.3, 50 * sx, th * 0.7);

        // Crisp architectural window accents (ideal for 320x240 vs 160x120 focus peaking comparison)
        targetCtx.fillStyle = "#cbd5e1";
        for (let wy = 0; wy < 3; wy++) {
          targetCtx.fillRect(tw * 0.28, th * (0.42 + wy * 0.09), 6 * sx, 4 * sy);
          targetCtx.fillRect(tw * 0.76, th * (0.37 + wy * 0.09), 7 * sx, 4 * sy);
        }

        const carX = ((t * 40) % (160 + 60) - 30) * sx;
        targetCtx.fillStyle = "#0f172a";
        targetCtx.fillRect(carX, th * 0.72, 44 * sx, 14 * sy);
        targetCtx.beginPath();
        targetCtx.arc(carX + 10 * sx, th * 0.86, 4 * sx, 0, Math.PI * 2);
        targetCtx.arc(carX + 34 * sx, th * 0.86, 4 * sx, 0, Math.PI * 2);
        targetCtx.fill();
      } else if (selectedScene === "nature") {
        const bg = targetCtx.createLinearGradient(0, 0, 0, th);
        bg.addColorStop(0, "#064e3b");
        bg.addColorStop(0.5, "#047857");
        bg.addColorStop(1, "#022c22");
        targetCtx.fillStyle = bg;
        targetCtx.fillRect(0, 0, tw, th);

        const bloomScale = 1 + Math.sin(t * 1.5) * 0.05;
        targetCtx.save();
        targetCtx.translate(tw / 2, th / 2);
        targetCtx.scale(bloomScale * sx, bloomScale * sy);
        for (let i = 0; i < 6; i++) {
          targetCtx.rotate((Math.PI * 2) / 6);
          targetCtx.fillStyle = i % 2 === 0 ? "#f43f5e" : "#fb7185";
          targetCtx.beginPath();
          targetCtx.ellipse(0, 20, 10, 22, 0, 0, Math.PI * 2);
          targetCtx.fill();
        }
        targetCtx.fillStyle = "#facc15";
        targetCtx.beginPath();
        targetCtx.arc(0, 0, 9, 0, Math.PI * 2);
        targetCtx.fill();
        targetCtx.restore();
      } else if (selectedScene === "studio") {
        const rad = targetCtx.createRadialGradient(tw / 2, th / 2, 10 * sx, tw / 2, th / 2, tw * 0.7);
        rad.addColorStop(0, "#475569");
        rad.addColorStop(1, "#0f172a");
        targetCtx.fillStyle = rad;
        targetCtx.fillRect(0, 0, tw, th);

        targetCtx.fillStyle = "#e2e8f0";
        targetCtx.beginPath();
        targetCtx.arc(tw / 2, th * 0.38, 22 * sx, 0, Math.PI * 2);
        targetCtx.fill();
        targetCtx.beginPath();
        targetCtx.ellipse(tw / 2, th * 0.78, 36 * sx, 28 * sy, 0, 0, Math.PI * 2);
        targetCtx.fill();
      } else {
        const barWidth = tw / 7;
        const colors = ["#FFFFFF", "#FFFF00", "#00FFFF", "#00FF00", "#FF00FF", "#FF0000", "#0000FF"];
        colors.forEach((col, idx) => {
          targetCtx.fillStyle = col;
          targetCtx.fillRect(idx * barWidth, 0, barWidth, th * 0.7);
        });
        targetCtx.fillStyle = "#1e293b";
        targetCtx.fillRect(0, th * 0.7, tw, th * 0.3);
      }

      targetCtx.restore();
      targetCtx.restore();
    };

    const renderStream = () => {
      if (!running) return;
      animTimeRef.current += 0.03;
      const t = animTimeRef.current;

      const w = canvas.width;
      const h = canvas.height;
      const blurBase = ((100 - focusSharpness) / 100) * 3.0;
      const netRotDeg = ((airBodyRot - effectiveCamRot) % 360 + 360) % 360;

      // Render base scene onto 160x120 vpCanvas
      drawSimulatedScene(ctx, w, h, t, blurBase, netRotDeg);

      // Compute active aspect crop region (matches firmware getActiveAspectCrop)
      const cx0 = aspectRatio === "1:1" ? 20 : 0;
      const cy0 = aspectRatio === "16:9" ? 15 : aspectRatio === "3:2" ? 7 : 0;
      const cw = aspectRatio === "1:1" ? 120 : w;
      const ch = aspectRatio === "16:9" ? 90 : aspectRatio === "3:2" ? 106 : h;

      // Centered Camera Framing Preview Letterbox Bars (before peaking)
      if (aspectRatio === "16:9") {
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, w, 15);
        ctx.fillRect(0, h - 15, w, 15);
      } else if (aspectRatio === "3:2") {
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, w, 7);
        ctx.fillRect(0, h - 7, w, 7);
      } else if (aspectRatio === "1:1") {
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, 20, h);
        ctx.fillRect(w - 20, 0, 20, h);
      }

      // Real-Time Focus Peaking Pass (runs every frame strictly inside active crop before grid & AF reticle)
      if (peakEnabled) {
        const [pr, pg, pb] = PEAK_COLOR_RGB[peakColor];
        const thickMode = peakThickness === "1PX" ? 1 : peakThickness === "2PX" ? 2 : 3;
        const dispData = ctx.getImageData(0, 0, w, h);
        const dp = dispData.data;

        const stampPeak = (px: number, py: number) => {
          const offsets: ReadonlyArray<[number, number]> =
            thickMode === 1
              ? [[0, 0]]
              : thickMode === 2
              ? [
                  [0, 0],
                  [1, 0],
                  [0, 1],
                ]
              : [
                  [0, 0],
                  [1, 0],
                  [-1, 0],
                  [0, 1],
                  [0, -1],
                ];
          for (let k = 0; k < offsets.length; k++) {
            const ox = px + offsets[k][0];
            const oy = py + offsets[k][1];
            if (ox >= cx0 && ox < cx0 + cw && oy >= cy0 && oy < cy0 + ch) {
              const i4 = (oy * w + ox) * 4;
              dp[i4] = pr;
              dp[i4 + 1] = pg;
              dp[i4 + 2] = pb;
              dp[i4 + 3] = 255;
            }
          }
        };

        if (peakSource === "320x240") {
          let scratch = peakOffscreenCanvasRef.current;
          if (!scratch) {
            scratch = document.createElement("canvas");
            scratch.width = 320;
            scratch.height = 240;
            peakOffscreenCanvasRef.current = scratch;
          }
          const sCtx = scratch.getContext("2d", { willReadFrequently: true });
          if (sCtx) {
            drawSimulatedScene(sCtx, 320, 240, t, blurBase * 2, netRotDeg);
            const srcData = sCtx.getImageData(0, 0, 320, 240).data;
            const thresh = PEAK_SENS_THRESH_320[peakSensitivity];
            const yStart = Math.max(1, cy0 * 2);
            const yEnd = Math.min(239, (cy0 + ch) * 2 - 1);
            const xStart = Math.max(1, cx0 * 2);
            const xEnd = Math.min(319, (cx0 + cw) * 2 - 1);

            const lumaAt320 = (x: number, y: number) => {
              const idx = (y * 320 + x) * 4;
              return (srcData[idx] + (srcData[idx + 1] << 1) + srcData[idx + 2]) >> 2;
            };

            for (let y = yStart; y < yEnd; y++) {
              for (let x = xStart; x < xEnd; x++) {
                const gx = Math.abs(lumaAt320(x + 1, y) - lumaAt320(x - 1, y));
                const gy = Math.abs(lumaAt320(x, y + 1) - lumaAt320(x, y - 1));
                if (gx + gy >= thresh) {
                  stampPeak(x >> 1, y >> 1);
                }
              }
            }
          }
        } else {
          const thresh = PEAK_SENS_THRESH_160[peakSensitivity];
          const snapCopy = new Uint8Array(w * h);
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const idx = (y * w + x) * 4;
              snapCopy[y * w + x] = (dp[idx] + (dp[idx + 1] << 1) + dp[idx + 2]) >> 2;
            }
          }
          const yStart = Math.max(1, cy0);
          const yEnd = Math.min(h - 1, cy0 + ch - 1);
          const xStart = Math.max(1, cx0);
          const xEnd = Math.min(w - 1, cx0 + cw - 1);
          for (let y = yStart; y < yEnd; y++) {
            const row = y * w;
            for (let x = xStart; x < xEnd; x++) {
              const gx = Math.abs(snapCopy[row + x + 1] - snapCopy[row + x - 1]);
              const gy = Math.abs(snapCopy[row + w + x] - snapCopy[row - w + x]);
              if (gx + gy >= thresh) {
                stampPeak(x, y);
              }
            }
          }
        }

        ctx.putImageData(dispData, 0, 0);
      }

      // Aspect border & exposure warning frame
      if (aspectRatio === "16:9") {
        ctx.strokeStyle = exposureWarning ? "#ef4444" : "rgba(148, 163, 184, 0.7)";
        ctx.lineWidth = exposureWarning ? 2 : 1;
        ctx.strokeRect(exposureWarning ? 1 : 0.5, exposureWarning ? 15 : 14.5, exposureWarning ? w - 2 : w - 1, exposureWarning ? 90 : 91);
      } else if (aspectRatio === "3:2") {
        ctx.strokeStyle = exposureWarning ? "#ef4444" : "rgba(148, 163, 184, 0.7)";
        ctx.lineWidth = exposureWarning ? 2 : 1;
        ctx.strokeRect(exposureWarning ? 1 : 0.5, exposureWarning ? 7 : 6.5, exposureWarning ? w - 2 : w - 1, exposureWarning ? 106 : 107);
      } else if (aspectRatio === "1:1") {
        ctx.strokeStyle = exposureWarning ? "#ef4444" : "rgba(148, 163, 184, 0.7)";
        ctx.lineWidth = exposureWarning ? 2 : 1;
        ctx.strokeRect(exposureWarning ? 21 : 20.5, 1, exposureWarning ? 118 : 119, h - 2);
      } else if (exposureWarning) {
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, w - 2, h - 2);
      }

      // Overlays: Camera Grid Overlays (aligned to active aspect crop) & AF Reticle
      if (gridMode !== "OFF") {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (gridMode === "3RDS") {
          ctx.moveTo(cx0 + cw / 3, cy0);
          ctx.lineTo(cx0 + cw / 3, cy0 + ch);
          ctx.moveTo(cx0 + (2 * cw) / 3, cy0);
          ctx.lineTo(cx0 + (2 * cw) / 3, cy0 + ch);
          ctx.moveTo(cx0, cy0 + ch / 3);
          ctx.lineTo(cx0 + cw, cy0 + ch / 3);
          ctx.moveTo(cx0, cy0 + (2 * ch) / 3);
          ctx.lineTo(cx0 + cw, cy0 + (2 * ch) / 3);
        } else if (gridMode === "4x4") {
          for (let i = 1; i <= 3; i++) {
            ctx.moveTo(cx0 + (cw * i) / 4, cy0);
            ctx.lineTo(cx0 + (cw * i) / 4, cy0 + ch);
            ctx.moveTo(cx0, cy0 + (ch * i) / 4);
            ctx.lineTo(cx0 + cw, cy0 + (ch * i) / 4);
          }
        } else if (gridMode === "DIAG") {
          ctx.moveTo(cx0, cy0);
          ctx.lineTo(cx0 + cw, cy0 + ch);
          ctx.moveTo(cx0 + cw, cy0);
          ctx.lineTo(cx0, cy0 + ch);
          ctx.moveTo(cx0 + cw / 2, cy0);
          ctx.lineTo(cx0 + cw / 2, cy0 + ch);
          ctx.moveTo(cx0, cy0 + ch / 2);
          ctx.lineTo(cx0 + cw, cy0 + ch / 2);
        } else if (gridMode === "GOLD") {
          ctx.moveTo(cx0 + cw * 0.382, cy0);
          ctx.lineTo(cx0 + cw * 0.382, cy0 + ch);
          ctx.moveTo(cx0 + cw * 0.618, cy0);
          ctx.lineTo(cx0 + cw * 0.618, cy0 + ch);
          ctx.moveTo(cx0, cy0 + ch * 0.382);
          ctx.lineTo(cx0 + cw, cy0 + ch * 0.382);
          ctx.moveTo(cx0, cy0 + ch * 0.618);
          ctx.lineTo(cx0 + cw, cy0 + ch * 0.618);
        }
        ctx.stroke();
      }

      // Center AF Reticle: standby crosshair normally, bright green AF Lock box on StickS3 [A] focus/burst
      const cx = w / 2;
      const cy = h / 2;
      const afLocked = isAfLocking || contBurstActive;
      const retSize = afLocked ? 14 : 10;
      if (afLocked) {
        ctx.strokeStyle = "#22c55e";
        ctx.lineWidth = 2;
        ctx.strokeRect(cx - retSize, cy - retSize, retSize * 2, retSize * 2);
      } else {
        ctx.strokeStyle = "rgba(226, 232, 240, 0.5)";
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(cx - retSize, cy - retSize + 4);
        ctx.lineTo(cx - retSize, cy - retSize);
        ctx.lineTo(cx - retSize + 4, cy - retSize);

        ctx.moveTo(cx + retSize - 4, cy - retSize);
        ctx.lineTo(cx + retSize, cy - retSize);
        ctx.lineTo(cx + retSize, cy - retSize + 4);

        ctx.moveTo(cx - retSize, cy + retSize - 4);
        ctx.lineTo(cx - retSize, cy + retSize);
        ctx.lineTo(cx - retSize + 4, cy + retSize);

        ctx.moveTo(cx + retSize - 4, cy + retSize);
        ctx.lineTo(cx + retSize, cy + retSize);
        ctx.lineTo(cx + retSize, cy + retSize - 4);
        ctx.stroke();
      }

      ctx.fillStyle = afLocked ? "#22c55e" : "rgba(226, 232, 240, 0.7)";
      ctx.beginPath();
      ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
      ctx.fill();

      // Live EXIF HUD banner inside viewport
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(aspectRatio === "1:1" ? 23 : 4, h - 16, 114, 12);
      ctx.fillStyle = "#f8fafc";
      ctx.font = "8px monospace";
      ctx.fillText(`${sceneExposure.aperture} ${sceneExposure.shutter} [${aspectRatio}]`, aspectRatio === "1:1" ? 26 : 7, h - 7);

      animFrameRef.current = requestAnimationFrame(renderStream);
    };

    renderStream();

    return () => {
      running = false;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [statePhase, selectedScene, gridMode, aspectRatio, shootMode, attachedLens, exposureWarning, orientation, showDiagHud, menuOpen, peakSubmenuOpen, isAfLocking, contBurstActive, airBodyRot, effectiveCamRot, peakEnabled, peakColor, peakThickness, peakSensitivity, peakSource, focusSharpness]);

  const displayWidth = orientation === "landscape" ? 240 : 135;
  const displayHeight = orientation === "landscape" ? 135 : 240;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* LEFT COLUMN: Physical M5StickS3 Emulator */}
      <div className="lg:col-span-6 bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col items-center">
        {/* Hardware Status Strip */}
        <div className="w-full flex items-center justify-between pb-4 mb-4 border-b border-slate-800 text-xs text-slate-400">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-slate-200">M5StickS3</span>
            <span aria-hidden="true">·</span>
            <span>ESP32-S3-PICO-1-N8R8</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">1.14&quot; ST7789P3</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSoundEnabled(!soundEnabled)}
              title={soundEnabled ? "Mute ES8311 speaker cues" : "Unmute ES8311 speaker cues"}
              className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
            >
              {soundEnabled ? <Volume2 className="w-4 h-4 text-emerald-400" /> : <VolumeX className="w-4 h-4" />}
            </button>
            <button
              onClick={() => {
                dismissClock2015Alert();
                setClockSynced(false);
                setClockSyncPending(true);
                setPowerOn(false);
                setTimeout(() => setPowerOn(true), 250);
              }}
              className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors text-xs"
            >
              <RotateCcw className="w-3 h-3" />
              Reset
            </button>
          </div>
        </div>

        {/* Physical Device Shell */}
        <div className="relative my-4 select-none">
          {/* M5StickS3 Exterior Casing (Rotates 180deg cleanly on Tilt 180°, while inner LCD counter-rotates to stay upright just like M5.Display.setRotation) */}
          <div 
            className={`relative transition-all duration-300 rounded-[22px] p-4 shadow-2xl border-2 border-slate-700/80 ${
              orientation === "landscape"
                ? "w-[390px] h-[220px] bg-gradient-to-br from-slate-700 via-slate-800 to-zinc-900"
                : "w-[220px] h-[390px] bg-gradient-to-br from-slate-700 via-slate-800 to-zinc-900"
            }`}
            style={{
              transform: flipped180 ? "rotate(180deg)" : "none",
              boxShadow: "0 20px 40px -10px rgba(0, 0, 0, 0.65), inset 0 2px 4px rgba(255, 255, 255, 0.14), inset 0 -3px 6px rgba(0,0,0,0.5)"
            }}
          >
            {/* Side Button B (GPIO 12): Top Edge in normal Landscape (UP in Wi-Fi setup), flips to Bottom when rotated 180° */}
            <button
              onMouseDown={handleButtonBDown}
              onMouseUp={() => handleButtonBUp(false)}
              onMouseLeave={() => handleButtonBUp(true)}
              onTouchStart={(e) => {
                e.preventDefault();
                handleButtonBDown();
              }}
              onTouchEnd={(e) => {
                e.preventDefault();
                handleButtonBUp(false);
              }}
              className={`absolute cursor-pointer transition-all ${
                orientation === "landscape"
                  ? "-top-3 right-16 w-16 h-3.5 rounded-t-md bg-zinc-900 border border-slate-600 shadow-sm"
                  : "-right-3 top-20 w-3.5 h-16 rounded-r-md bg-zinc-900 border border-slate-600 shadow-sm"
              } ${btnBPressed ? "brightness-150 scale-95 ring-1 ring-orange-400" : "hover:bg-slate-700"}`}
              title={
                helpScreenOpen
                  ? "Button B (GPIO 12): Short = Page Down | Hold (>=600ms) = Back to Menu"
                  : menuOpen || peakSubmenuOpen || hudSubmenuOpen
                  ? "Button B (GPIO 12): Short = Next Item | Hold (>=600ms) = Back / Exit"
                  : statePhase === "wifi_searching_saved"
                  ? "Button B (GPIO 12): 5x = Deep Sleep | Hold (>=600ms) = Quick Menu"
                  : statePhase === "wifi_scan" || statePhase === "bt_scan"
                  ? "Button B (GPIO 12): Short = Next Item | 5x = Deep Sleep | Hold = Menu"
                  : statePhase === "wifi_passkey" || statePhase === "bt_passkey"
                  ? "Button B (GPIO 12): Increment digit | 5x = Deep Sleep | Action row Hold = Menu"
                  : "Button B (GPIO 12): 1x=Aspect | 2x=Mode | 3x=Diag | 4x=GyroLock | 5x=Off Air+Stick | Hold=Menu"
              }
            >
              <span className="sr-only">Button B</span>
            </button>

            {/* Recessed Hardware Power / Reset Button */}
            <button
              type="button"
              onClick={handlePowerButtonPress}
              className={`absolute cursor-pointer transition-colors ${
                orientation === "landscape"
                  ? "-left-2.5 top-16 w-2.5 h-9 rounded-l-md bg-zinc-800 border border-slate-600 hover:bg-orange-600 hover:border-orange-400"
                  : "-bottom-2.5 left-16 w-9 h-2.5 rounded-b-md bg-zinc-800 border border-slate-600 hover:bg-orange-600 hover:border-orange-400"
              }`}
              title="Recessed Side Power Button (Hardware Reset — use Wake Key BTN B / BTN A / A+B to wake with RTC alive)"
            >
              <span className="sr-only">Power Button</span>
            </button>

            {/* Silk-screen Device Branding */}
            <div className={`absolute text-slate-300 font-extrabold tracking-wider text-[11px] opacity-90 ${
              orientation === "landscape" ? "top-2 left-6" : "top-2 left-1/2 -translate-x-1/2"
            }`}>
              M5STICKS3
            </div>

            {/* Internal Dark Bezel surrounding LCD and Button A */}
            <div className={`w-full h-full rounded-[14px] bg-slate-950 p-2.5 flex shadow-inner border border-black/40 ${
              orientation === "landscape" ? "flex-row items-center gap-3" : "flex-col items-center gap-3"
            }`}>
              {/* LCD Screen Glass Area (counter-rotates 180deg when casing is flipped 180deg so UI stays upright) */}
              <div 
                className="relative overflow-hidden bg-black rounded-md border border-slate-800 shadow-md flex-shrink-0 transition-all"
                style={{ 
                  width: displayWidth, 
                  height: displayHeight,
                  transform: flipped180 ? "rotate(180deg)" : "none",
                  filter: brightnessLevel === 0 ? "brightness(1)" : brightnessLevel === 1 ? "brightness(0.65)" : "brightness(0.38)"
                }}
              >
                {/* Screen Content */}
                {powerOn ? (
                  showClock2015Alert ? (
                    /* FULL-LCD YEAR-2015 INVALID CLOCK ALERT OVERLAY */
                    <div className="w-full h-full flex flex-col justify-between bg-[#5a0a0e] text-white font-mono select-none border border-red-500">
                      <div className="h-[20px] bg-red-600 px-1.5 flex items-center justify-between text-[7.5px] font-black">
                        <span>{orientation === "portrait" ? "! AIR CLOCK 2015 !" : "! OLYMPUS AIR CLOCK INVALID !"}</span>
                      </div>
                      <div className="flex-1 p-2 flex flex-col justify-center space-y-1 text-[7.5px] leading-tight">
                        <div className="text-yellow-300 font-bold">
                          Photo year read: {clockLastSyncYear}
                        </div>
                        <div className="text-white truncate">
                          {clockLastSyncFile || "P001.JPG"} (+{clockLastStopwatchMs}ms)
                        </div>
                        <div className="text-cyan-300 pt-1 font-semibold">
                          {orientation === "portrait"
                            ? "Air lost date/time! Set via phone app, then shoot to sync."
                            : "Air A01 lost its date/time! Re-sync Air time with phone app, then shoot to sync RTC."}
                        </div>
                      </div>
                      <div className="h-[18px] bg-red-600 px-1.5 flex items-center justify-between text-[7px] font-bold">
                        <span>[A]/[B] Dismiss</span>
                        <span>2015!</span>
                      </div>
                    </div>
                  ) : peakSubmenuOpen ? (
                    /* FOCUS PEAKING SUBMENU (6 Items: < Back, Peaking, Color, Thick, Sens, Source) */
                    (() => {
                      const subItems = [
                        { label: "< Back", val: "", color: "text-cyan-300" },
                        { label: "Peaking", val: peakEnabled ? "ON" : "OFF", color: peakEnabled ? "text-emerald-400" : "text-slate-200" },
                        { label: "Color", val: peakColor, color: PEAK_COLOR_TEXT_CLS[peakColor] },
                        { label: "Thick", val: peakThickness, color: "text-slate-200" },
                        { label: "Sens", val: peakSensitivity, color: "text-slate-200" },
                        { label: "Source", val: peakSource, color: "text-cyan-300" },
                      ];
                      const maxVisible = orientation === "portrait" ? 10 : 5;
                      let scrollStart = 0;
                      if (subItems.length > maxVisible && peakSubmenuIdx >= maxVisible - 1) {
                        scrollStart = Math.min(peakSubmenuIdx - maxVisible + 2, subItems.length - maxVisible);
                      }
                      const visibleRows = subItems.slice(scrollStart, scrollStart + maxVisible);

                      return (
                        <div className="w-full h-full flex flex-col justify-between bg-black text-white font-mono select-none">
                          <div className="h-[19px] bg-[#0f172a] border-b border-slate-700 px-1.5 flex items-center justify-between text-[8px] font-bold">
                            <span className="text-cyan-300">
                              {orientation === "portrait" ? "PEAK SETUP" : "FOCUS PEAKING SETUP"}
                            </span>
                            {peakSubmenuBadge && (
                              <span className="text-emerald-400 text-[7px] font-bold tabular-nums">
                                {peakSubmenuBadge}
                              </span>
                            )}
                          </div>
                          <div className={`flex-1 px-1 py-0.5 flex flex-col ${orientation === "portrait" ? "gap-[1px]" : "gap-0.5"} overflow-hidden`}>
                            {visibleRows.map((item, r) => {
                              const idx = scrollStart + r;
                              const isSel = idx === peakSubmenuIdx;
                              return (
                                <div
                                  key={item.label}
                                  className={`px-1 ${orientation === "portrait" ? "py-[1px] text-[7px]" : "py-0.5 text-[7.5px]"} rounded-sm flex items-center justify-between leading-tight ${
                                    isSel ? "bg-orange-600 text-white font-bold" : item.color
                                  }`}
                                >
                                  <span className="truncate">
                                    {isSel ? ">" : " "}
                                    {item.label}
                                  </span>
                                  {item.val && <span className="shrink-0 ml-1">{item.val}</span>}
                                </div>
                              );
                            })}
                          </div>
                          <div className="h-[16px] bg-slate-900 border-t border-slate-700 px-1 flex items-center justify-between text-[6.6px] text-orange-400 font-bold">
                            <span>{orientation === "portrait" ? "B:N A:S HB:Bk" : "[B]Next [A]Set HB:Back"}</span>
                            {renderClockBadge(orientation === "portrait")}
                          </div>
                        </div>
                      );
                    })()
                  ) : hudSubmenuOpen ? (
                    /* ON-SCREEN HUD TEXT ELEMENTS SUBMENU (16 Items) */
                    (() => {
                      const allHudVal =
                        hudEnabledCount === HUD_ELEMENT_ORDER.length
                          ? "ALL ON"
                          : hudEnabledCount === 0
                          ? "ALL OFF"
                          : `${hudEnabledCount}/14`;
                      const hudSubItems = [
                        { label: "< Back", val: "", color: "text-cyan-300" },
                        {
                          label: "All HUD",
                          val: allHudVal,
                          color:
                            hudEnabledCount === HUD_ELEMENT_ORDER.length
                              ? "text-emerald-400"
                              : hudEnabledCount === 0
                              ? "text-orange-400"
                              : "text-yellow-300",
                        },
                        ...HUD_ELEMENT_ORDER.map((el) => ({
                          label: el.label,
                          val: hudVisibility[el.key] ? "ON" : "OFF",
                          color: hudVisibility[el.key] ? "text-emerald-400" : "text-slate-500",
                        })),
                      ];
                      const maxVisible = orientation === "portrait" ? 10 : 5;
                      let scrollStart = 0;
                      if (hudSubItems.length > maxVisible && hudSubmenuIdx >= maxVisible - 1) {
                        scrollStart = Math.min(hudSubmenuIdx - maxVisible + 2, hudSubItems.length - maxVisible);
                      }
                      const visibleRows = hudSubItems.slice(scrollStart, scrollStart + maxVisible);

                      return (
                        <div className="w-full h-full flex flex-col justify-between bg-black text-white font-mono select-none">
                          <div className="h-[19px] bg-[#0f172a] border-b border-slate-700 px-1.5 flex items-center justify-between text-[8px] font-bold">
                            <span className="text-cyan-300">
                              {orientation === "portrait" ? "HUD SETUP" : "ON-SCREEN HUD TEXT"}
                            </span>
                            {hudSubmenuBadge && (
                              <span className="text-emerald-400 text-[7px] font-bold tabular-nums">
                                {hudSubmenuBadge}
                              </span>
                            )}
                          </div>
                          <div className={`flex-1 px-1 py-0.5 flex flex-col ${orientation === "portrait" ? "gap-[1px]" : "gap-0.5"} overflow-hidden`}>
                            {visibleRows.map((item, r) => {
                              const idx = scrollStart + r;
                              const isSel = idx === hudSubmenuIdx;
                              return (
                                <div
                                  key={item.label}
                                  className={`px-1 ${orientation === "portrait" ? "py-[1px] text-[7px]" : "py-0.5 text-[7.5px]"} rounded-sm flex items-center justify-between leading-tight ${
                                    isSel ? "bg-orange-600 text-white font-bold" : item.color
                                  }`}
                                >
                                  <span className="truncate">
                                    {isSel ? ">" : " "}
                                    {item.label}
                                  </span>
                                  {item.val && <span className="shrink-0 ml-1">{item.val}</span>}
                                </div>
                              );
                            })}
                          </div>
                          <div className="h-[16px] bg-slate-900 border-t border-slate-700 px-1 flex items-center justify-between text-[6.6px] text-orange-400 font-bold">
                            <span>{orientation === "portrait" ? "B:N A:S HB:Bk" : "[B]Next [A]Set HB:Back"}</span>
                            {renderClockBadge(orientation === "portrait")}
                          </div>
                        </div>
                      );
                    })()
                  ) : helpScreenOpen ? (
                    /* PAGINATED HELP & BUTTON REFERENCE SCREEN ([A] Page Up, [B] Page Down, Hold[B] Back) */
                    (() => {
                      const pageLines = currentHelpPages[safeHelpPage] || [];
                      return (
                        <div className="w-full h-full flex flex-col justify-between bg-black text-white font-mono select-none">
                          <div className="h-[19px] bg-[#0f172a] border-b border-slate-700 px-1.5 flex items-center justify-between text-[7.5px] font-bold">
                            <span className="text-cyan-300 truncate">
                              {orientation === "portrait" ? "HELP & KEYS" : "HELP: BUTTONS & FEATURES"}
                            </span>
                            <span className="text-yellow-300 text-[7px] font-bold tabular-nums shrink-0 ml-1">
                              Pg {safeHelpPage + 1}/{Math.max(1, currentHelpPages.length)}
                            </span>
                          </div>
                          <div
                            className={`flex-1 px-1 py-0.5 flex flex-col overflow-hidden ${
                              orientation === "portrait" ? "gap-[2px] text-[6.3px]" : "gap-[1px] text-[6.8px]"
                            } leading-tight`}
                          >
                            {pageLines.map((line, idx) => (
                              <div
                                key={`${safeHelpPage}-${idx}`}
                                className={`whitespace-pre truncate ${line.color} ${
                                  line.text.startsWith("[") ? "font-bold" : ""
                                } min-h-[8px]`}
                              >
                                {line.text || " "}
                              </div>
                            ))}
                          </div>
                          <div className="h-[16px] bg-slate-900 border-t border-slate-700 px-1 flex items-center justify-between text-[6.5px] text-orange-400 font-bold">
                            <span>{orientation === "portrait" ? "A:Up B:Dn HB:Bk" : "[A]PgUp [B]PgDn HB:Back"}</span>
                            {renderClockBadge(orientation === "portrait")}
                          </div>
                        </div>
                      );
                    })()
                  ) : menuOpen ? (
                    /* HOLD-B QUICK CAMERA & SYSTEM MENU (22 Items: Works on Boot, Wi-Fi, BT & Live View) */
                    (() => {
                      const briPct = brightnessLevel === 0 ? 100 : brightnessLevel === 1 ? 60 : 30;
                      const isOnline = statePhase === "streaming";
                      const inWifiWizard = statePhase === "wifi_scan" || statePhase === "wifi_passkey";
                      const inBtWizard = statePhase === "bt_scan" || statePhase === "bt_passkey";
                      const syncMenuVal = clockInvalid2015
                        ? "2015!"
                        : clockSyncPending
                        ? "NEXT SHT"
                        : clockSynced
                        ? clockHm
                        : "ARMED";
                      const hudSummaryVal =
                        hudEnabledCount === HUD_ELEMENT_ORDER.length
                          ? "ALL"
                          : hudEnabledCount === 0
                          ? "OFF"
                          : `${hudEnabledCount}/14`;
                      const menuItems = [
                        { label: isOnline ? "< Back to Live" : "< Back", val: "", color: "text-cyan-300" },
                        { label: "Focus Peak", val: peakEnabled ? "ON" : "OFF", color: peakEnabled ? PEAK_COLOR_TEXT_CLS[peakColor] : "text-slate-200" },
                        { label: "Peak Setup >", val: `${PEAK_COLOR_SHORT[peakColor]} ${peakThickness}`, color: "text-cyan-300" },
                        { label: "BtnA Mode", val: btnAMode, color: btnAMode === "PEAK" ? "text-yellow-300" : "text-slate-200" },
                        { label: "Grid", val: gridMode, color: "text-slate-200" },
                        { label: "Drive", val: DRIVE_MODE_LABELS[driveMode], color: "text-slate-200" },
                        { label: "Seq Spd", val: seqSpeed, color: "text-slate-200" },
                        { label: "Stick Snd", val: soundEnabled ? "ON" : "OFF", color: "text-slate-200" },
                        { label: "Air Sound", val: airSoundLevel, color: "text-slate-200" },
                        { label: "Bright", val: `${briPct}%`, color: "text-slate-200" },
                        { label: "Stick Rot", val: stickRotMode, color: "text-slate-200" },
                        { label: "Cam Gyro", val: camGyroMode, color: "text-cyan-200" },
                        { label: "HUD Setup >", val: hudSummaryVal, color: "text-cyan-300" },
                        { label: "BT Wake", val: btWakeOnBoot ? (savedBt ? "ON" : "PAIR") : "OFF", color: "text-sky-300" },
                        { label: "BT Setup", val: inBtWizard ? "BACK" : "SCAN", color: "text-sky-300" },
                        { label: "Wi-Fi Setup", val: inWifiWizard ? "BACK" : "SCAN", color: "text-amber-300" },
                        { label: "Sync Clock", val: syncMenuVal, color: clockInvalid2015 ? "text-red-400 font-bold" : "text-cyan-300" },
                        { label: "Wake Key", val: wakeKeyMode, color: "text-emerald-300" },
                        { label: "Help >", val: "GUIDE", color: "text-cyan-300" },
                        { label: "Dump Trace", val: "USB", color: "text-emerald-300" },
                        { label: "Sleep: Stick Only", val: isOnline ? "AIR ON" : "SLEEP", color: "text-orange-300" },
                        { label: "Sleep: Air + Stick", val: "ALL", color: "text-red-400" },
                      ];
                      const maxVisible = orientation === "portrait" ? 10 : 5;
                      let scrollStart = 0;
                      if (menuItems.length > maxVisible && menuIdx >= maxVisible - 1) {
                        scrollStart = Math.min(menuIdx - maxVisible + 2, menuItems.length - maxVisible);
                      }
                      const visibleRows = menuItems.slice(scrollStart, scrollStart + maxVisible);

                      return (
                        <div className="w-full h-full flex flex-col justify-between bg-black text-white font-mono select-none">
                          <div className="h-[19px] bg-[#0f172a] border-b border-slate-700 px-1.5 flex items-center justify-between text-[8px] font-bold">
                            <span className="text-cyan-300">
                              {orientation === "portrait" ? "CAMERA MENU" : "OLYMPUS AIR MENU"}
                            </span>
                            {menuStatusBadge && (
                              <span className="text-emerald-400 text-[7px] font-bold tabular-nums">
                                {menuStatusBadge}
                              </span>
                            )}
                          </div>
                          <div className={`flex-1 px-1 py-0.5 flex flex-col ${orientation === "portrait" ? "gap-[1px]" : "gap-0.5"} overflow-hidden`}>
                            {visibleRows.map((item, r) => {
                              const idx = scrollStart + r;
                              const isSel = idx === menuIdx;
                              return (
                                <div
                                  key={item.label}
                                  className={`px-1 ${orientation === "portrait" ? "py-[1px] text-[7px]" : "py-0.5 text-[7.5px]"} rounded-sm flex items-center justify-between leading-tight ${
                                    isSel ? "bg-orange-600 text-white font-bold" : item.color
                                  }`}
                                >
                                  <span className="truncate">
                                    {isSel ? ">" : " "}
                                    {item.label}
                                  </span>
                                  {item.val && <span className="shrink-0 ml-1">{item.val}</span>}
                                </div>
                              );
                            })}
                          </div>
                          <div className="h-[16px] bg-slate-900 border-t border-slate-700 px-1 flex items-center justify-between text-[6.6px] text-orange-400 font-bold">
                            <span>{orientation === "portrait" ? "B:Nxt A:OK" : "[B]Next [A]Set HB:Exit"}</span>
                            {renderClockBadge(orientation === "portrait")}
                          </div>
                        </div>
                      );
                    })()
                  ) : statePhase === "bt_wake" ? (
                    /* BLUETOOTH BOOT AUTO-WAKE SPLASH SCREEN */
                    <div className="w-full h-full flex flex-col justify-between bg-[#080f1c] text-white font-mono select-none">
                      <div className="h-[18px] bg-[#0f172a] border-b border-slate-700 px-1.5 flex items-center justify-between text-[8px] font-bold">
                        <span className="text-sky-300">WAKING AIR BLE</span>
                        <span className="text-emerald-400 text-[7px] tabular-nums">
                          {m5BatteryPct}% {m5BatteryVoltage.toFixed(1)}V
                        </span>
                      </div>
                      <div className="p-2 flex-1 flex flex-col items-center justify-center text-center space-y-1 text-[8px]">
                        <div className="w-4 h-4 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
                        <div className="text-sky-300 font-bold truncate max-w-full">{savedBt?.name || "AIR-A01"}</div>
                        <div className="text-slate-400 text-[7px]">{savedBt?.mac}</div>
                        <div className="text-emerald-400 text-[7px]">Bond PIN: {savedBt?.pin || "000000"}</div>
                        <div className="text-amber-300 text-[7px]">Sending BLE wake signal...</div>
                      </div>
                      <div className="h-[15px] bg-[#0f172a] border-t border-slate-800 px-1.5 flex items-center justify-between text-[6.5px] text-slate-400">
                        <span>{clockInvalid2015 ? "CLK INVALID!" : clockSynced ? clockYmd : "RTC PENDING"}</span>
                        {renderClockBadge(orientation === "portrait")}
                      </div>
                    </div>
                  ) : statePhase === "bt_scan" ? (
                    /* BLUETOOTH BLE DEVICE SCANNER SCREEN */
                    (() => {
                      const extraItems = savedBt ? 3 : 2;
                      const totalItems = btList.length + extraItems;
                      const maxVisible = orientation === "portrait" ? 8 : 5;
                      let scrollStart = 0;
                      if (totalItems > maxVisible && btSelectedIdx >= maxVisible - 1) {
                        scrollStart = Math.min(btSelectedIdx - maxVisible + 2, totalItems - maxVisible);
                      }
                      const rows: number[] = [];
                      for (let r = 0; r < maxVisible && scrollStart + r < totalItems; r++) {
                        rows.push(scrollStart + r);
                      }

                      return (
                        <div className="w-full h-full flex flex-col justify-between bg-black text-white font-mono select-none">
                          <div className="h-[18px] bg-[#0f172a] border-b border-slate-700 px-1.5 flex items-center justify-between text-[8px] font-bold text-sky-300">
                            <span>
                              {btScanning && btList.length === 0
                                ? "SCANNING BLE..."
                                : orientation === "portrait"
                                ? `BT DEV (${btList.length})`
                                : `SELECT BLE DEV (${btList.length})`}
                            </span>
                            <span className="text-[7px] text-emerald-400 tabular-nums">
                              {m5BatteryPct}% {m5BatteryVoltage.toFixed(1)}V
                            </span>
                          </div>

                          <div className="flex-1 px-1 py-1 overflow-hidden flex flex-col gap-0.5">
                            {btScanning && btList.length === 0 ? (
                              <div className="flex-1 flex flex-col items-center justify-center text-center space-y-1 text-[8px]">
                                <div className="w-4 h-4 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
                                <div className="text-sky-300 font-semibold">Scanning 2.4GHz BLE</div>
                                <div className="text-slate-400">Olympus Air Wake...</div>
                              </div>
                            ) : (
                              rows.map((idx) => {
                                const isSel = idx === btSelectedIdx;
                                if (idx < btList.length) {
                                  const dev = btList[idx];
                                  return (
                                    <div
                                      key={dev.mac}
                                      className={`px-1 py-0.5 rounded-sm flex items-center justify-between text-[7.5px] leading-tight ${
                                        isSel
                                          ? "bg-orange-600 text-white font-bold"
                                          : dev.isAir
                                          ? "text-emerald-400"
                                          : "text-slate-300"
                                      }`}
                                    >
                                      <span className="truncate max-w-[165px]">
                                        {isSel ? ">" : " "}
                                        {dev.name}
                                      </span>
                                      <span className="shrink-0 ml-1 tabular-nums">{dev.rssi}dB</span>
                                    </div>
                                  );
                                }
                                if (idx === btList.length) {
                                  return (
                                    <div
                                      key="bt_rescan"
                                      className={`px-1 py-0.5 rounded-sm text-[7.5px] font-semibold ${
                                        isSel ? "bg-orange-600 text-white" : "text-cyan-300"
                                      }`}
                                    >
                                      {isSel ? "> [RESCAN BLE]" : "  [RESCAN BLE]"}
                                    </div>
                                  );
                                }
                                if (savedBt && idx === btList.length + 1) {
                                  return (
                                    <div
                                      key="bt_forget"
                                      className={`px-1 py-0.5 rounded-sm text-[7.5px] font-semibold ${
                                        isSel ? "bg-orange-600 text-white" : "text-amber-300"
                                      }`}
                                    >
                                      {isSel ? "> [FORGET PAIRED BT]" : "  [FORGET PAIRED BT]"}
                                    </div>
                                  );
                                }
                                return (
                                  <div
                                    key="bt_back"
                                    className={`px-1 py-0.5 rounded-sm text-[7.5px] font-semibold ${
                                      isSel ? "bg-orange-600 text-white" : "text-slate-300"
                                    }`}
                                  >
                                    {isSel ? "> [< BACK]" : "  [< BACK]"}
                                  </div>
                                );
                              })
                            )}
                          </div>

                          <div className="h-[16px] bg-slate-900 border-t border-slate-700 px-1 flex items-center justify-between text-[6.6px] text-orange-400 font-bold">
                            <span>{orientation === "portrait" ? "B:Nxt A:Sel" : "[B]Next [A]Sel HB:Mnu"}</span>
                            {renderClockBadge(orientation === "portrait")}
                          </div>
                        </div>
                      );
                    })()
                  ) : statePhase === "bt_passkey" ? (
                    /* 6-DIGIT NUMERIC BLUETOOTH PASSKEY PICKER SCREEN */
                    <div className="w-full h-full flex flex-col justify-between bg-black text-white font-mono select-none">
                      <div className="h-[18px] bg-[#0f172a] border-b border-slate-700 px-1.5 flex items-center justify-between text-[8px] font-bold">
                        <span className="text-sky-300 truncate max-w-[115px]">
                          BT: {selectedBtForPass?.name}
                        </span>
                        <span className="text-emerald-400 text-[7px] shrink-0 tabular-nums">
                          {m5BatteryPct}% {m5BatteryVoltage.toFixed(1)}V
                        </span>
                      </div>

                      <div className="flex-1 px-1.5 py-1 flex flex-col justify-between">
                        <div className="text-[7.5px] text-slate-300">
                          {btPassCursor < 6 ? "6-Digit BT Passkey:" : "Pair & Enable BT Wake?"}
                        </div>

                        {/* 6 Digit Boxes */}
                        <div
                          className={
                            orientation === "portrait"
                              ? "grid grid-cols-3 gap-1 my-1"
                              : "grid grid-cols-6 gap-1.5 my-0.5"
                          }
                        >
                          {btPassDigits.map((d, i) => {
                            const active = i === btPassCursor;
                            const confirmed = i < btPassCursor;
                            return (
                              <div
                                key={i}
                                className={`flex items-center justify-center rounded border font-bold ${
                                  orientation === "portrait" ? "h-8 text-[14px]" : "h-8 text-[14px]"
                                } ${
                                  active
                                    ? "bg-orange-600 border-yellow-300 text-white"
                                    : confirmed
                                    ? "bg-slate-900 border-emerald-500 text-emerald-400"
                                    : "bg-slate-900 border-slate-600 text-slate-100"
                                }`}
                              >
                                {d}
                              </div>
                            );
                          })}
                        </div>

                        {/* Action Pills: CONFIRM (6), EDIT (7), BACK (8) */}
                        <div
                          className={
                            orientation === "portrait"
                              ? "flex flex-col gap-1 text-[7.5px] font-bold"
                              : "grid grid-cols-12 gap-1 text-[7.5px] font-bold"
                          }
                        >
                          <div
                            className={`rounded border px-1.5 py-1 text-center ${
                              orientation === "portrait" ? "" : "col-span-6"
                            } ${
                              btPassCursor === 6
                                ? "bg-emerald-600 border-white text-white"
                                : "bg-slate-900 border-emerald-600/80 text-emerald-300"
                            }`}
                          >
                            {orientation === "portrait" ? "PAIR & SAVE BT" : "CONFIRM CODE"}
                          </div>
                          <div
                            className={`rounded border px-1 py-1 text-center ${
                              orientation === "portrait" ? "" : "col-span-3"
                            } ${
                              btPassCursor === 7
                                ? "bg-orange-600 border-yellow-300 text-white"
                                : "bg-slate-900 border-slate-600 text-slate-200"
                            }`}
                          >
                            {orientation === "portrait" ? "EDIT DIGITS" : "EDIT"}
                          </div>
                          <div
                            className={`rounded border px-1 py-1 text-center ${
                              orientation === "portrait" ? "" : "col-span-3"
                            } ${
                              btPassCursor === 8
                                ? "bg-red-600 border-white text-white"
                                : "bg-slate-900 border-slate-600 text-slate-200"
                            }`}
                          >
                            {orientation === "portrait" ? "BACK TO BLE" : "BACK"}
                          </div>
                        </div>
                      </div>

                      <div className="h-[16px] bg-slate-900 border-t border-slate-700 px-1 flex items-center justify-between text-[6.6px] text-orange-400 font-bold">
                        <span>
                          {btPassCursor < 6 ? "[B]+1 [A]Ok" : "[B]Mv [A]Ok"}
                        </span>
                        {renderClockBadge(orientation === "portrait")}
                      </div>
                    </div>
                  ) : statePhase === "wifi_searching_saved" ? (
                    /* SEARCHING FOR SAVED AIR SCREEN */
                    <div className="w-full h-full flex flex-col justify-between bg-[#080f1c] text-white font-mono select-none">
                      <div className="h-[18px] bg-[#0f172a] border-b border-slate-700 px-1.5 flex items-center justify-between text-[8px] font-bold">
                        <span className="text-cyan-300">
                          {orientation === "portrait" ? "SEARCHING AIR" : "SEARCHING SAVED AIR"}
                        </span>
                        <span className="text-emerald-400 text-[7px] tabular-nums">
                          {m5BatteryPct}% {m5BatteryVoltage.toFixed(1)}V
                        </span>
                      </div>
                      <div className="p-2 flex-1 flex flex-col justify-center space-y-1 text-[8px] leading-tight">
                        <div className="text-slate-300">Target AP:</div>
                        <div className="text-orange-400 font-bold text-[9px] truncate">
                          {savedWifi?.ssid || "NONE"}
                        </div>
                        <div className="text-slate-400 pt-0.5">
                          Fast CH:{savedWifi?.channel || "?"} · Try #{searchAttempt}
                        </div>
                        <div className="text-emerald-400 text-[7.5px]">
                          Static IP .100 (No DHCP)
                        </div>
                        <div className="text-[7px] text-amber-300/90 pt-0.5">
                          {airOnline ? "Air AP detected, handshaking..." : "Waiting for Air A01 Wi-Fi..."}
                        </div>
                      </div>
                      <div className="p-1.5 space-y-1">
                        <button
                          type="button"
                          onClick={handleButtonAShort}
                          className="w-full py-1 rounded bg-orange-600 hover:bg-orange-500 text-white font-bold text-[8.5px] text-center shadow cursor-pointer"
                        >
                          {orientation === "portrait" ? "[A] Wi-Fi Setup" : "[A] Open Wi-Fi Setup"}
                        </button>
                        <div className="flex items-center justify-between text-[6.6px] text-amber-300/90 font-bold px-0.5">
                          <span>{orientation === "portrait" ? `HB:Mnu(${airSoundLevel})` : `Hold[B]:Menu (${airSoundLevel})`}</span>
                          {renderClockBadge(orientation === "portrait")}
                        </div>
                      </div>
                    </div>
                  ) : statePhase === "wifi_scan" ? (
                    /* ALL-AP WI-FI SCANNER SCREEN */
                    (() => {
                      const extraItems = savedWifi ? 2 : 1;
                      const totalItems = apList.length + extraItems;
                      const maxVisible = orientation === "portrait" ? 8 : 5;
                      let scrollStart = 0;
                      if (totalItems > maxVisible && apSelectedIdx >= maxVisible - 1) {
                        scrollStart = Math.min(apSelectedIdx - maxVisible + 2, totalItems - maxVisible);
                      }
                      const rows: number[] = [];
                      for (let r = 0; r < maxVisible && scrollStart + r < totalItems; r++) {
                        rows.push(scrollStart + r);
                      }

                      return (
                        <div className="w-full h-full flex flex-col justify-between bg-black text-white font-mono select-none">
                          <div className="h-[18px] bg-[#0f172a] border-b border-slate-700 px-1.5 flex items-center justify-between text-[8px] font-bold text-cyan-300">
                            <span>
                              {apScanning && apList.length === 0
                                ? "SCANNING APs..."
                                : orientation === "portrait"
                                ? `WIFI (${apList.length})`
                                : `SELECT WIFI AP (${apList.length})`}
                            </span>
                            <span className="text-[7px] text-emerald-400 tabular-nums">
                              {m5BatteryPct}% {m5BatteryVoltage.toFixed(1)}V
                            </span>
                          </div>

                          <div className="flex-1 px-1 py-1 overflow-hidden flex flex-col gap-0.5">
                            {apScanning && apList.length === 0 ? (
                              <div className="flex-1 flex flex-col items-center justify-center text-center space-y-1 text-[8px]">
                                <div className="w-4 h-4 rounded-full border-2 border-yellow-400 border-t-transparent animate-spin" />
                                <div className="text-yellow-300 font-semibold">Scanning 2.4GHz channels</div>
                                <div className="text-slate-400">All nearby APs...</div>
                              </div>
                            ) : (
                              rows.map((idx) => {
                                const isSel = idx === apSelectedIdx;
                                if (idx < apList.length) {
                                  const ap = apList[idx];
                                  return (
                                    <div
                                      key={ap.ssid}
                                      className={`px-1 py-0.5 rounded-sm flex items-center justify-between text-[7.5px] leading-tight ${
                                        isSel
                                          ? "bg-orange-600 text-white font-bold"
                                          : ap.isAir
                                          ? "text-emerald-400"
                                          : "text-slate-300"
                                      }`}
                                    >
                                      <span className="truncate max-w-[165px]">
                                        {isSel ? ">" : " "}
                                        {ap.ssid}
                                      </span>
                                      <span className="shrink-0 ml-1 tabular-nums">{ap.rssi}dB</span>
                                    </div>
                                  );
                                }
                                if (idx === apList.length) {
                                  return (
                                    <div
                                      key="rescan"
                                      className={`px-1 py-0.5 rounded-sm text-[7.5px] font-semibold ${
                                        isSel ? "bg-orange-600 text-white" : "text-cyan-300"
                                      }`}
                                    >
                                      {isSel ? "> [RESCAN ALL APs]" : "  [RESCAN ALL APs]"}
                                    </div>
                                  );
                                }
                                return (
                                  <div
                                    key="search_saved"
                                    className={`px-1 py-0.5 rounded-sm text-[7.5px] font-semibold ${
                                      isSel ? "bg-orange-600 text-white" : "text-amber-300"
                                    }`}
                                  >
                                    {isSel ? "> [SEARCH SAVED AIR]" : "  [SEARCH SAVED AIR]"}
                                  </div>
                                );
                              })
                            )}
                          </div>

                          <div className="h-[16px] bg-slate-900 border-t border-slate-700 px-1 flex items-center justify-between text-[6.6px] text-orange-400 font-bold">
                            <span>{orientation === "portrait" ? "B:Nxt A:Sel" : "[B]Next [A]Sel HB:Mnu"}</span>
                            {renderClockBadge(orientation === "portrait")}
                          </div>
                        </div>
                      );
                    })()
                  ) : statePhase === "wifi_passkey" ? (
                    /* 8-DIGIT NUMERIC PASSKEY PICKER SCREEN */
                    <div className="w-full h-full flex flex-col justify-between bg-black text-white font-mono select-none">
                      <div className="h-[18px] bg-[#0f172a] border-b border-slate-700 px-1.5 flex items-center justify-between text-[8px] font-bold">
                        <span className="text-cyan-300 truncate max-w-[115px]">
                          KEY: {selectedApForPass?.ssid}
                        </span>
                        <span className="text-emerald-400 text-[7px] shrink-0 tabular-nums">
                          {m5BatteryPct}% {m5BatteryVoltage.toFixed(1)}V
                        </span>
                      </div>

                      <div className="flex-1 px-1.5 py-1 flex flex-col justify-between">
                        <div className="text-[7.5px] text-slate-300">
                          {passCursor < 8 ? "8-Digit Air Passkey:" : "Confirm 8-Digit Passkey?"}
                        </div>

                        {/* 8 Digit Boxes */}
                        <div
                          className={
                            orientation === "portrait"
                              ? "grid grid-cols-4 gap-1 my-1"
                              : "grid grid-cols-8 gap-1 my-0.5"
                          }
                        >
                          {passDigits.map((d, i) => {
                            const active = i === passCursor;
                            const confirmed = i < passCursor;
                            return (
                              <div
                                key={i}
                                className={`flex items-center justify-center rounded border font-bold ${
                                  orientation === "portrait" ? "h-7 text-[13px]" : "h-8 text-[13px]"
                                } ${
                                  active
                                    ? "bg-orange-600 border-yellow-300 text-white"
                                    : confirmed
                                    ? "bg-slate-900 border-emerald-500 text-emerald-400"
                                    : "bg-slate-900 border-slate-600 text-slate-100"
                                }`}
                              >
                                {d}
                              </div>
                            );
                          })}
                        </div>

                        {/* Action Pills: CONFIRM (8), EDIT (9), BACK (10) */}
                        <div
                          className={
                            orientation === "portrait"
                              ? "flex flex-col gap-1 text-[7.5px] font-bold"
                              : "grid grid-cols-12 gap-1 text-[7.5px] font-bold"
                          }
                        >
                          <div
                            className={`rounded border px-1.5 py-1 text-center ${
                              orientation === "portrait" ? "" : "col-span-6"
                            } ${
                              passCursor === 8
                                ? "bg-emerald-600 border-white text-white"
                                : "bg-slate-900 border-emerald-600/80 text-emerald-300"
                            }`}
                          >
                            {orientation === "portrait" ? "CONFIRM PASSCODE" : "CONFIRM CODE"}
                          </div>
                          <div
                            className={`rounded border px-1 py-1 text-center ${
                              orientation === "portrait" ? "" : "col-span-3"
                            } ${
                              passCursor === 9
                                ? "bg-orange-600 border-yellow-300 text-white"
                                : "bg-slate-900 border-slate-600 text-slate-200"
                            }`}
                          >
                            {orientation === "portrait" ? "EDIT DIGITS" : "EDIT"}
                          </div>
                          <div
                            className={`rounded border px-1 py-1 text-center ${
                              orientation === "portrait" ? "" : "col-span-3"
                            } ${
                              passCursor === 10
                                ? "bg-red-600 border-white text-white"
                                : "bg-slate-900 border-slate-600 text-slate-200"
                            }`}
                          >
                            {orientation === "portrait" ? "BACK TO APs" : "BACK"}
                          </div>
                        </div>
                      </div>

                      <div className="h-[16px] bg-slate-900 border-t border-slate-700 px-1 flex items-center justify-between text-[6.6px] text-orange-400 font-bold">
                        <span>
                          {passCursor < 8 ? "[B]+1 [A]Ok" : "[B]Mv [A]Ok"}
                        </span>
                        {renderClockBadge(orientation === "portrait")}
                      </div>
                    </div>
                  ) : (
                  <div className="w-full h-full flex flex-col bg-black text-white font-mono select-none relative">
                    {/* Shutter Flash Overlay */}
                    {isShutterFlashing && (
                      <div className="absolute inset-0 bg-white z-50 animate-pulse pointer-events-none" />
                    )}

                    {/* 1. TOP BANNER (Landscape 14px single-row / Portrait 24px 2-row) */}
                    {orientation === "portrait" ? (
                      <div className="h-6 w-full bg-slate-900 border-b border-slate-800 px-1 py-0.5 flex flex-col justify-between text-[7px] flex-shrink-0 z-10 leading-none">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1 truncate max-w-[54px]">
                            {hudVisibility.fps && (
                              <>
                                <span
                                  className={`inline-block w-1.5 h-1.5 rounded-full ${
                                    statusColor === "green" ? "bg-emerald-400 animate-pulse" : "bg-amber-400"
                                  }`}
                                />
                                <span className="truncate font-semibold text-emerald-400">
                                  {fps > 0 ? `${fps.toFixed(1)}F` : bannerMessage}
                                </span>
                              </>
                            )}
                          </div>
                          {hudVisibility.aspect ? (
                            <div className="text-orange-400 font-bold px-1 rounded bg-orange-950/60 border border-orange-700/40 text-[6.5px]">
                              [{aspectRatio}]
                            </div>
                          ) : (
                            <span />
                          )}
                          {hudVisibility.status ? (
                            <span className={`font-bold text-[6.5px] ${exposureWarning || clockInvalid2015 ? "text-red-400 animate-pulse" : "text-amber-300"}`}>
                              {clockInvalid2015 ? "2015!" : exposureWarning ? "EXP!" : statePhase === "streaming" ? "LIVE" : "INIT"}
                            </span>
                          ) : (
                            <span />
                          )}
                        </div>
                        <div className="flex items-center justify-between text-[6.5px] text-slate-200">
                          {hudVisibility.battery ? (
                            <div className="flex items-center gap-1.5">
                              <span className="text-sky-300 font-semibold">A:{airBatteryLevel}</span>
                              <span className="text-emerald-400 font-semibold">S:{m5BatteryVoltage.toFixed(1)}V</span>
                            </div>
                          ) : (
                            <span />
                          )}
                          {hudVisibility.clock ? renderClockBadge(true) : <span />}
                        </div>
                      </div>
                    ) : (
                      <div className="h-3.5 w-full bg-slate-900 border-b border-slate-800 px-1 flex items-center justify-between text-[7.5px] flex-shrink-0 z-10 leading-none">
                        {/* Left: FPS */}
                        <div className="flex items-center gap-1 truncate min-w-[44px] max-w-[70px]">
                          {hudVisibility.fps && (
                            <>
                              <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                                statusColor === "green" ? "bg-emerald-400 animate-pulse" : "bg-amber-400"
                              }`} />
                              <span className="truncate font-semibold text-emerald-400">
                                {fps > 0 ? `${fps.toFixed(1)}FPS` : bannerMessage}
                              </span>
                            </>
                          )}
                        </div>

                        {/* Center: Current Aspect Ratio & Status / Exposure Warning */}
                        <div className="flex items-center gap-1">
                          {hudVisibility.aspect && (
                            <div className="text-orange-400 font-bold px-1 py-0.5 rounded bg-orange-950/60 border border-orange-700/40 text-[7px]">
                              [{aspectRatio}]
                            </div>
                          )}
                          {hudVisibility.status && (
                            <span className={`font-bold text-[7px] ${exposureWarning || clockInvalid2015 ? "text-red-400 animate-pulse" : "text-amber-300"}`}>
                              {clockInvalid2015 ? "2015!" : exposureWarning ? "EXP!" : statePhase === "streaming" ? "LIVE" : "INIT"}
                            </span>
                          )}
                        </div>

                        {/* Upper Right Corner: DUAL BATTERY (Olympus Air & M5StickS3) */}
                        <div className="flex items-center gap-1.5 text-slate-200 font-mono text-[7px] min-w-[66px] justify-end">
                          {hudVisibility.battery && (
                            <>
                              <span className="text-sky-300 font-semibold" title="Olympus Air Battery Level (OPC BATTERY_LEVEL)">
                                AIR:{airBatteryLevel}
                              </span>
                              <span className="text-slate-400" aria-hidden="true">·</span>
                              <span className="text-emerald-400 font-semibold" title="M5StickS3 Battery Voltage (M5.Power)">
                                S3:{m5BatteryVoltage.toFixed(1)}V
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    )}

                    {/* 2. CENTER / PORTRAIT VIEWPORT & TELEMETRY */}
                    <div
                      className="w-full relative flex-1 bg-black flex overflow-hidden"
                      style={{ height: displayHeight - (orientation === "portrait" ? 24 : 14) }}
                    >
                      {showDiagHud ? (
                        /* Comprehensive Diagnostics HUD (adapts cleanly to Portrait 135x240 vs Landscape 240x135) */
                        orientation === "portrait" ? (
                          <div className="w-full h-full bg-slate-950 p-1 flex flex-col justify-between text-[6.8px] font-mono leading-tight text-slate-200">
                            <div className="bg-cyan-900/60 text-cyan-200 px-1 py-0.5 rounded font-bold text-[6.8px] flex justify-between items-center">
                              <span>S3 &amp; AIR DIAG</span>
                              {renderClockBadge(true)}
                            </div>
                            <div className="space-y-1 my-0.5">
                              <div className="text-emerald-400 font-semibold">RAM:{freeHeapKb}K Min:{minHeapKb}K</div>
                              <div className="text-slate-300">PSRAM:{freePsramKb}K Max:240K</div>
                              <div className="text-cyan-300">Pkts:{rxPacketsCount} Drop:{droppedPacketsCount}</div>
                              <div className="text-yellow-300">OK:{validFramesCount} Bad:{corruptFramesCount}</div>
                              <div className="text-yellow-200">{fps.toFixed(1)}FPS {clockYmd}</div>
                              <div className="text-slate-300">CamO:{airBodyRot}° {camGyroMode} {dualGyroLocked ? "GLCK" : `BT:${btWakeOnBoot ? "ON" : "OF"}`}</div>
                              <div className={clockInvalid2015 ? "text-red-400 font-bold" : "text-cyan-300"}>
                                {clockInvalid2015 ? "CLK:2015 INVALID!" : `CLK:${clockHms}`}
                              </div>
                              <div className="text-cyan-300">PK:{peakEnabled ? PEAK_COLOR_SHORT[peakColor] : "OFF"}/{peakSource === "320x240" ? "320" : "160"} WK:{wakeKeyMode}</div>
                              <div className={exposureWarning ? "text-red-400 font-bold" : "text-emerald-400"}>
                                Rem:{remainingShots} {stickRotMode} A:{btnAMode === "PEAK" ? "PK" : "SH"}
                              </div>
                            </div>
                            <div className="text-[6.2px] text-slate-400 bg-slate-900 px-1 py-0.5 rounded flex justify-between">
                              <span>3x[B]:Live</span>
                              <span>5B:Slp</span>
                            </div>
                          </div>
                        ) : (
                          <div className="w-full h-full bg-slate-950 p-1 flex flex-col justify-between text-[7px] font-mono leading-tight text-slate-200">
                            <div className="bg-cyan-900/60 text-cyan-200 px-1 py-0.5 rounded font-bold text-[7px] flex justify-between items-center">
                              <span>OLYMPUS AIR &amp; M5STICKS3 DIAG</span>
                              {renderClockBadge(false)}
                            </div>

                            <div className="space-y-0.5 my-0.5">
                              <div className="text-emerald-400 font-semibold">
                                RAM: {freeHeapKb}K | Min: {minHeapKb}K | PSRAM: {freePsramKb}K
                              </div>
                              <div className="text-slate-300">
                                CamRot: {airBodyRot}° ({camGyroMode}{dualGyroLocked ? " GLCK" : ""}) | Mode: {sceneExposure.mode}
                              </div>
                              <div className="text-cyan-300">
                                PK: {peakEnabled ? `${PEAK_COLOR_SHORT[peakColor]}/${peakSource === "320x240" ? "320" : "160"}` : "OFF"} | A:{btnAMode === "PEAK" ? "PK" : "SHT"} | WK:{wakeKeyMode}
                              </div>
                              <div className={clockInvalid2015 ? "text-red-400 font-bold" : "text-cyan-200"}>
                                {clockInvalid2015
                                  ? `CLK: ${clockYmd} (2015 INVALID!)`
                                  : `CLK: ${clockYmd} ${clockHms} (+${clockLastStopwatchMs}ms)`}
                              </div>
                              <div className="text-slate-400">
                                Pkts: {rxPacketsCount} | {fps.toFixed(1)}FPS | BT:{btWakeOnBoot ? "ON" : "OF"} | Rem:{remainingShots}
                              </div>
                              <div className={exposureWarning ? "text-red-400 font-bold" : "text-purple-300"}>
                                Air: {airBatteryLevel} | S3: {m5BatteryVoltage}V | ExpW: {exposureWarning ? "1 (WARN)" : "0"}
                              </div>
                            </div>

                            <div className="text-[6.5px] text-slate-400 bg-slate-900 px-1 py-0.5 rounded flex justify-between">
                              <span>3x[B]:Live | 5x[B]:Sleep All</span>
                              <span>1x[B]:{aspectRatio} HB:Menu</span>
                            </div>
                          </div>
                        )
                      ) : statePhase === "streaming" ? (
                        orientation === "portrait" ? (
                          /* PORTRAIT VIEWFINDER UI (135x216 below 24px banner): Upper 132x99 Preview + Lower Telemetry Dashboard */
                          <div className="w-full h-full flex flex-col items-center bg-black">
                            {/* Upper 132x99 Active Viewport */}
                            <div
                              className={`w-[132px] h-[99px] mt-[1px] relative bg-slate-900 flex-shrink-0 overflow-hidden ${
                                exposureWarning
                                  ? "border-2 border-red-500 shadow-[inset_0_0_8px_rgba(239,68,68,0.65)]"
                                  : "border border-slate-700/60"
                              }`}
                            >
                              <canvas
                                ref={canvasRef}
                                width={160}
                                height={120}
                                className="w-full h-full object-fill block"
                              />
                                {isAfLocking && (
                                  <div className="absolute inset-0 border-2 border-emerald-400/80 pointer-events-none flex items-center justify-center">
                                    <span className="bg-emerald-950/80 text-emerald-300 text-[7px] font-bold px-1.5 py-0.5 rounded">
                                      AF LOCKED
                                    </span>
                                  </div>
                                )}
                                {selfTimerSec !== null && (
                                  <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                                    <span className="bg-red-600 border border-white text-white text-sm font-black px-2.5 py-0.5 rounded-md shadow">
                                      {selfTimerSec}
                                    </span>
                                  </div>
                                )}
                                {contBurstActive && (
                                  <div className="absolute top-1 right-1 pointer-events-none">
                                    <span className="bg-red-600 text-white text-[6.5px] font-bold px-1 py-0.5 rounded animate-pulse">
                                      BURST
                                    </span>
                                  </div>
                                )}
                              </div>

                              {/* Lower Portrait Telemetry Dashboard (135x115) */}
                              <div className="w-full flex-1 bg-slate-950 border-t border-slate-800/80 px-1.5 py-1 flex flex-col justify-between text-[7px] font-mono select-none leading-tight">
                                <div className="space-y-1">
                                  <div className="flex items-center justify-between min-h-[10px]">
                                    {hudVisibility.mode ? (
                                      <span
                                        className={`font-bold ${
                                          shootMode === "A_WIDE"
                                            ? "text-cyan-300"
                                            : shootMode === "S_60"
                                            ? "text-orange-400"
                                            : "text-emerald-400"
                                        }`}
                                      >
                                        {sceneExposure.mode}
                                      </span>
                                    ) : (
                                      <span />
                                    )}
                                    {hudVisibility.remain && (
                                      <span
                                        className={`font-bold ${
                                          remainingShots < 10
                                            ? "text-red-400"
                                            : remainingShots < 50
                                            ? "text-amber-300"
                                            : "text-emerald-400"
                                        }`}
                                      >
                                        REM:{remainingShots}
                                      </span>
                                    )}
                                  </div>

                                  <div className="flex items-center justify-between text-[7px] min-h-[10px]">
                                    <span className="text-white font-bold">{hudVisibility.shutter ? sceneExposure.shutter : ""}</span>
                                    <span className="text-cyan-400 font-bold">{hudVisibility.aperture ? sceneExposure.aperture : ""}</span>
                                    <span className="text-amber-300 font-bold">{hudVisibility.iso ? sceneExposure.iso : ""}</span>
                                  </div>
                                </div>

                                <div className="border-t border-slate-800/80 pt-1 flex items-center justify-between text-[6.8px] min-h-[12px]">
                                  <span className="text-orange-400 font-bold">{hudVisibility.aspect ? aspectRatio : ""}</span>
                                  <span className="text-slate-400">{hudVisibility.res ? activeWindowRes : ""}</span>
                                  {hudVisibility.afWarn ? (
                                    <span className={exposureWarning ? "text-red-400 font-bold" : "text-emerald-400 font-bold"}>
                                      {exposureWarning ? "EXP:!!" : "AF:CTR"}
                                    </span>
                                  ) : (
                                    <span />
                                  )}
                                </div>

                                <div className="border-t border-slate-800/80 pt-1 space-y-0.5 text-[6.5px]">
                                  <div className="flex items-center justify-between min-h-[9px]">
                                    <span className="text-emerald-400 font-bold">{hudVisibility.drive ? DRIVE_MODE_SHORT[driveMode] : ""}</span>
                                    {hudVisibility.hints && (
                                      <span className={btnAMode === "PEAK" ? `${PEAK_COLOR_TEXT_CLS[peakColor]} font-bold` : "text-white font-bold"}>
                                        {btnAMode === "PEAK" ? "[A]PEAK" : "[A]SNAP"}
                                      </span>
                                    )}
                                    {hudVisibility.hints ? (
                                      <span className="text-amber-300 font-bold">HB:MENU</span>
                                    ) : (
                                      <span />
                                    )}
                                  </div>
                                  <div className="flex items-center justify-between min-h-[9px]">
                                    <span className="text-cyan-400 font-bold">{hudVisibility.hints ? "[B]ASP" : ""}</span>
                                    <span className="text-orange-400 font-bold">{hudVisibility.hints ? "2B:MOD" : ""}</span>
                                    {hudVisibility.drive ? (
                                      <span className={peakEnabled ? `${PEAK_COLOR_TEXT_CLS[peakColor]} font-bold` : "text-slate-400"}>
                                        PK:{peakEnabled ? PEAK_COLOR_SHORT[peakColor] : "OFF"}
                                      </span>
                                    ) : (
                                      <span />
                                    )}
                                  </div>
                                  <div className="flex items-center justify-between text-slate-400 min-h-[9px]">
                                    <span>{hudVisibility.drive ? `GRD:${gridMode}` : ""}</span>
                                    <span>{hudVisibility.hints ? "A+B:SLP" : ""}</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          ) : (
                            /* LANDSCAPE VIEWFINDER UI (240x121): Left Rail + 160x120 Viewport + Right Rail */
                            <div className="w-full h-full flex flex-row items-stretch">
                              {/* Left Telemetry Rail (40px): Live Exposure Triangle + Aspect + Peak + Drive */}
                              <div className="w-10 bg-slate-950 border-r border-slate-800/80 flex flex-col justify-between p-1 text-[7px] font-mono select-none flex-shrink-0 leading-tight">
                                <div className="space-y-0.5 min-h-[42px]">
                                  <div
                                    className={`font-bold min-h-[9px] ${
                                      shootMode === "A_WIDE"
                                        ? "text-cyan-300"
                                        : shootMode === "S_60"
                                        ? "text-orange-400"
                                        : "text-emerald-400"
                                    }`}
                                    title="Shooting Mode (TAKEMODE)"
                                  >
                                    {hudVisibility.mode ? sceneExposure.mode : ""}
                                  </div>
                                  <div className="text-white font-bold min-h-[9px]" title="Live Shutter Speed (ACTUAL_SHUTTER)">
                                    {hudVisibility.shutter ? sceneExposure.shutter : ""}
                                  </div>
                                  <div className="text-cyan-400 font-bold min-h-[9px]" title="Live Aperture (ACTUAL_APERTURE)">
                                    {hudVisibility.aperture ? sceneExposure.aperture : ""}
                                  </div>
                                  <div className="text-amber-300 font-bold min-h-[9px]" title="Live ISO (ACTUAL_ISO)">
                                    {hudVisibility.iso ? sceneExposure.iso : ""}
                                  </div>
                                </div>
                                <div className="min-h-[18px]">
                                  <div className="text-orange-400 font-bold min-h-[9px]">{hudVisibility.aspect ? aspectRatio : ""}</div>
                                  <div className="text-slate-400 text-[6px] min-h-[8px]">{hudVisibility.res ? activeWindowRes : ""}</div>
                                </div>
                                <div className="min-h-[18px]">
                                  <div className={`min-h-[9px] ${peakEnabled ? `${PEAK_COLOR_TEXT_CLS[peakColor]} font-bold text-[6.2px]` : "text-emerald-400 font-bold"}`}>
                                    {hudVisibility.drive
                                      ? peakEnabled
                                        ? `PK:${PEAK_COLOR_SHORT[peakColor]}`
                                        : `${DRIVE_MODE_SHORT[driveMode]} ${gridMode !== "OFF" ? "G" : ""}`
                                      : ""}
                                  </div>
                                  <div className={`min-h-[8px] ${btnAMode === "PEAK" ? `${peakEnabled ? PEAK_COLOR_TEXT_CLS[peakColor] : "text-cyan-300"} font-bold text-[6px]` : "text-white font-bold text-[6px]"}`}>
                                    {hudVisibility.hints ? (btnAMode === "PEAK" ? "[A]PK" : driveMode === "CONT" ? "[A]CNT" : "[A]SHT") : ""}
                                  </div>
                                </div>
                              </div>

                              {/* Center Active Viewport (160x120) */}
                              <div
                                className={`w-[160px] h-[120px] relative bg-slate-900 flex-shrink-0 overflow-hidden ${
                                  exposureWarning
                                    ? "border-2 border-red-500 shadow-[inset_0_0_8px_rgba(239,68,68,0.65)]"
                                    : "border border-slate-700/60"
                                }`}
                              >
                                <canvas
                                  ref={canvasRef}
                                  width={160}
                                  height={120}
                                  className="w-full h-full object-cover block"
                                />
                                {isAfLocking && (
                                  <div className="absolute inset-0 border-2 border-emerald-400/80 pointer-events-none flex items-center justify-center">
                                    <span className="bg-emerald-950/80 text-emerald-300 text-[7.5px] font-bold px-1.5 py-0.5 rounded">
                                      AF LOCKED
                                    </span>
                                  </div>
                                )}
                                {selfTimerSec !== null && (
                                  <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                                    <span className="bg-red-600 border border-white text-white text-base font-black px-3 py-1 rounded-md shadow">
                                      {selfTimerSec}
                                    </span>
                                  </div>
                                )}
                                {contBurstActive && (
                                  <div className="absolute top-1 right-1 pointer-events-none">
                                    <span className="bg-red-600 text-white text-[7px] font-bold px-1.5 py-0.5 rounded animate-pulse">
                                      BURST [HOLD A]
                                    </span>
                                  </div>
                                )}
                              </div>

                              {/* Right Telemetry Rail (40px): Remaining Capacity + Controls + Persistent Clock */}
                              <div className="w-10 bg-slate-950 border-l border-slate-800/80 flex flex-col justify-between p-1 text-[6.3px] font-mono select-none flex-shrink-0 leading-tight text-right">
                                <div className="min-h-[18px]">
                                  {hudVisibility.remain && (
                                    <>
                                      <div className="text-slate-400 font-bold">REM</div>
                                      <div
                                        className={`font-bold text-[7px] ${
                                          remainingShots < 10
                                            ? "text-red-400"
                                            : remainingShots < 50
                                            ? "text-amber-300"
                                            : "text-emerald-400"
                                        }`}
                                        title="Remaining Photo Storage Capacity (RTP Ext ID 5: maxtakenum)"
                                      >
                                        {remainingShots}
                                      </div>
                                    </>
                                  )}
                                </div>
                                <div className="space-y-0.5 min-h-[34px]">
                                  <div className="text-cyan-400 font-bold min-h-[7px]">{hudVisibility.hints ? "[B]ASP" : ""}</div>
                                  <div className="text-orange-400 font-bold min-h-[7px]">{hudVisibility.hints ? "2B:MOD" : ""}</div>
                                  <div className="text-slate-400 min-h-[7px]">{hudVisibility.hints ? "3B:DIG" : ""}</div>
                                  <div className={`min-h-[7px] ${exposureWarning ? "text-red-400 font-bold" : "text-emerald-400 font-bold"}`}>
                                    {hudVisibility.afWarn ? (exposureWarning ? "EXP:!!" : "AF:CTR") : ""}
                                  </div>
                                </div>
                                {hudVisibility.clock ? (
                                  clockInvalid2015 ? (
                                    <div
                                      className="bg-red-600 text-white font-bold rounded px-0.5 py-[1px] text-center animate-pulse leading-tight"
                                      title="Air A01 clock reads 2015! Set via phone app and press shutter to re-sync."
                                    >
                                      <div>2015!</div>
                                      <div>SYNC!</div>
                                    </div>
                                  ) : (
                                    <div className="leading-tight">
                                      <div className={clockSynced ? "text-cyan-300 font-bold tabular-nums" : "text-slate-400 tabular-nums"}>
                                        {clockHm}
                                      </div>
                                      <div className="text-slate-400 text-[5.8px] tabular-nums">{clockMd}</div>
                                    </div>
                                  )
                                ) : (
                                  <div className="min-h-[16px]" />
                                )}
                                <div className="min-h-[16px]">
                                  <div className="text-amber-300 font-bold min-h-[7px]">{hudVisibility.hints ? "HB:MNU" : ""}</div>
                                  <div className="text-slate-400 min-h-[7px]">{hudVisibility.hints ? "AB:SLP" : ""}</div>
                                </div>
                              </div>
                            </div>
                          )
                        ) : (
                          <div className="p-3 text-center flex flex-col items-center justify-center text-[10px] space-y-1.5 bg-blue-950/80 w-full h-full">
                            <div className="w-5 h-5 rounded-full border-2 border-yellow-400 border-t-transparent animate-spin mb-1" />
                            <div className="text-white font-bold uppercase tracking-wider text-[11px]">OLYMPUS AIR A01</div>
                            <div className="text-cyan-300 font-semibold text-[10px]">{bannerMessage}</div>
                            <div className="text-emerald-400 text-[9px] font-mono">Static .100 · UDP {config.streamPort}</div>
                            <div className="text-emerald-300/90 text-[8.5px] font-mono pt-0.5 flex items-center gap-2">
                              <span>BAT: {m5BatteryPct}%</span>
                              {renderClockBadge(false)}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                ) : (
                  <div className="w-full h-full bg-slate-950 flex flex-col items-center justify-center text-slate-400 text-[8.5px] font-mono gap-1 px-2 text-center">
                    <span className="text-amber-300 font-bold">DEEP SLEEP</span>
                    <span className="text-cyan-300 tabular-nums">
                      RTC ALIVE · {clockSynced ? clockHms : "PENDING"}
                      {clockInvalid2015 ? " (2015!)" : ""}
                    </span>
                    <span className="text-emerald-400 font-semibold">WAKE: {wakeKeyMode}</span>
                    <span className={airOnline ? "text-emerald-400/80 text-[7.5px]" : "text-slate-500 text-[7.5px]"}>
                      {airOnline ? "AIR STILL ON" : "AIR OFF"}
                    </span>
                  </div>
                )}
              </div>

              {/* Physical Front Button A ("M5" Tactile Button) */}
              <div className="flex-1 flex flex-col items-center justify-center">
                <button
                  onMouseDown={handleButtonADown}
                  onMouseUp={() => handleButtonAUp(false)}
                  onMouseLeave={() => handleButtonAUp(true)}
                  onTouchStart={(e) => {
                    e.preventDefault();
                    handleButtonADown();
                  }}
                  onTouchEnd={(e) => {
                    e.preventDefault();
                    handleButtonAUp(false);
                  }}
                  disabled={
                    powerOn &&
                    !menuOpen &&
                    !peakSubmenuOpen &&
                    !hudSubmenuOpen &&
                    !helpScreenOpen &&
                    !["streaming", "wifi_searching_saved", "wifi_scan", "wifi_passkey", "bt_scan", "bt_passkey"].includes(statePhase)
                  }
                  className={`relative group rounded-xl bg-gradient-to-b from-slate-800 to-slate-900 border-2 border-slate-700 shadow-md flex items-center justify-center transition-transform cursor-pointer ${
                    orientation === "landscape" ? "w-16 h-14" : "w-20 h-12"
                  } ${btnAPressed ? "scale-95 brightness-125 border-orange-500 ring-2 ring-orange-500/50" : "hover:border-slate-500"} ${
                    powerOn &&
                    !menuOpen &&
                    !peakSubmenuOpen &&
                    !hudSubmenuOpen &&
                    !helpScreenOpen &&
                    !["streaming", "wifi_searching_saved", "wifi_scan", "wifi_passkey", "bt_scan", "bt_passkey"].includes(statePhase)
                      ? "opacity-50 cursor-not-allowed"
                      : ""
                  }`}
                  style={{ transform: flipped180 ? "rotate(180deg)" : "none" }}
                  title={
                    !powerOn
                      ? wakeKeyMode === "BTN A" || wakeKeyMode === "A+B"
                        ? "Button A (GPIO 11): Press to wake from Deep Sleep"
                        : `Button A Disabled in Deep Sleep (Wake Key = ${wakeKeyMode})`
                      : helpScreenOpen
                      ? "Button A: Previous Help Page (Page Up)"
                      : menuOpen || peakSubmenuOpen || hudSubmenuOpen
                      ? "Button A: Change/Select Highlighted Menu Item"
                      : statePhase === "wifi_searching_saved"
                      ? "Button A: Open All-AP Wi-Fi Setup"
                      : statePhase === "wifi_scan" || statePhase === "bt_scan"
                      ? "Button A: Select Highlighted Item"
                      : statePhase === "wifi_passkey" || statePhase === "bt_passkey"
                      ? "Button A: Confirm Digit / Passkey"
                      : btnAMode === "PEAK"
                      ? "Front M5 Button A (GPIO 11): Tap toggles Focus Peaking ON/OFF"
                      : driveMode === "CONT"
                      ? "Front M5 Button A (GPIO 11): Hold for Continuous Burst"
                      : "Front M5 Button A (GPIO 11): Single Shot / Self-Timer"
                  }
                >
                  <div className="flex flex-col items-center">
                    <span className="text-orange-500 font-black text-sm tracking-widest font-mono">M5</span>
                    <span className="text-[9px] text-slate-400 tracking-tight">BTN A</span>
                  </div>
                </button>
                <span
                  className="text-[9px] text-slate-500 mt-1 font-mono text-center"
                  style={{ transform: flipped180 ? "rotate(180deg)" : "none" }}
                >
                  {!powerOn
                    ? wakeKeyMode === "BTN A" || wakeKeyMode === "A+B"
                      ? "WAKE STICK"
                      : "WAKE: OFF"
                    : helpScreenOpen
                    ? "PAGE UP"
                    : menuOpen || peakSubmenuOpen || hudSubmenuOpen
                    ? "OK / CHANGE"
                    : statePhase === "wifi_searching_saved"
                    ? "WIFI SETUP"
                    : statePhase === "wifi_scan" || statePhase === "bt_scan"
                    ? "SELECT"
                    : statePhase === "wifi_passkey" || statePhase === "bt_passkey"
                    ? "CONFIRM"
                    : btnAMode === "PEAK"
                    ? peakEnabled
                      ? "PEAK: ON"
                      : "PEAK: OFF"
                    : driveMode === "CONT"
                    ? "HOLD: BURST"
                    : "SHUTTER (1x)"}
                </span>
              </div>
            </div>

            {/* Bottom/Edge Hat2-Bus Pinout Label indicator */}
            <div className={`absolute text-[8px] font-mono text-slate-400/80 tracking-tighter ${
              orientation === "landscape" ? "bottom-1 left-8" : "bottom-1 left-6"
            }`}>
              HAT2: G0 · G1 · G8 · BAT · 5V · GND
            </div>
          </div>
        </div>

        {/* Viewfinder Controls & Aspect Ratio / Shooting Mode Switcher */}
        <div className="w-full mt-2 pt-4 border-t border-slate-800 space-y-3">
          {/* Wi-Fi & Bluetooth BLE Wake Onboarding Bar */}
          <div className="flex flex-wrap items-center justify-between text-xs gap-2 pb-2 border-b border-slate-800/70">
            <span className="text-slate-400 font-medium flex items-center gap-1.5">
              <Wifi className="w-3.5 h-3.5 text-sky-400" />
              Wi-Fi &amp; Bluetooth Wake
            </span>
            <div className="flex items-center gap-1.5 flex-wrap justify-end">
              <button
                onClick={() => {
                  setPowerOn(true);
                  enterWifiScanWizard();
                }}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors flex items-center gap-1 ${
                  statePhase === "wifi_scan" || statePhase === "wifi_passkey"
                    ? "bg-orange-600 text-white"
                    : "bg-slate-800 hover:bg-slate-700 text-orange-300"
                }`}
                title="Test First-Boot All-AP Wi-Fi Scanner & 8-digit passkey entry"
              >
                <Search className="w-3 h-3" />
                Wi-Fi Scan
              </button>
              <button
                onClick={() => {
                  setPowerOn(true);
                  enterBtScanWizard();
                }}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors flex items-center gap-1 ${
                  statePhase === "bt_scan" || statePhase === "bt_passkey"
                    ? "bg-sky-600 text-white"
                    : "bg-slate-800 hover:bg-slate-700 text-sky-300"
                }`}
                title="Open Bluetooth BLE Scanner & 6-Digit Numerical Passkey Setup"
              >
                <Bluetooth className="w-3 h-3" />
                BT Setup
              </button>
              <button
                onClick={() => {
                  const next = !btWakeOnBoot;
                  setBtWakeOnBoot(next);
                  addLog("BT", `BT Wake -> ${next ? "ON" : "OFF"}`, next && savedBt ? `Paired: ${savedBt.name}` : "Run BT Setup to pair Air A01 + 6-digit PIN", "text-sky-400");
                }}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  btWakeOnBoot
                    ? "bg-cyan-600 text-white font-semibold"
                    : "bg-slate-800 hover:bg-slate-700 text-slate-300"
                }`}
                title={savedBt ? `BT Wake (${savedBt.name} PIN:${savedBt.pin})` : "Toggle BT Auto-Wake on boot"}
              >
                BT Wake: {btWakeOnBoot ? "ON" : "OFF"}
              </button>
              <button
                onClick={() => {
                  const nextOnline = !airOnline;
                  setAirOnline(nextOnline);
                  if (!nextOnline) {
                    setPowerOn(true);
                    const creds = savedWifi || {
                      ssid: config.wifiSsid || "AIR-A01-12345678",
                      pass: config.wifiPass || "12345678",
                      channel: 6,
                    };
                    setSavedWifi(creds);
                    enterSearchingSavedAir(creds);
                  } else if (savedWifi) {
                    startFastConnectSequence(savedWifi);
                  }
                }}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  !airOnline
                    ? "bg-amber-600 text-white font-semibold"
                    : "bg-slate-800 hover:bg-slate-700 text-emerald-300"
                }`}
                title="Toggle Olympus Air A01 powered off/on to test persistent 'Searching Saved Air' loop + [A] Wi-Fi Setup"
              >
                {airOnline ? "Air AP: Online" : "Air AP: Offline"}
              </button>
              <button
                onClick={() => {
                  const nextReset = !airClockReset2015;
                  setAirClockReset2015(nextReset);
                  setClockSyncPending(true);
                  addLog(
                    "ACTION",
                    `Sim Air RTC -> ${nextReset ? "2015 RESET (LOST)" : "VALID (NOW)"}`,
                    nextReset
                      ? "Armed 2015 RTC test: next [A] shutter press will read a 2015 photo via /get_imglist.cgi & trigger invalid clock alert"
                      : "Air clock valid: next [A] shutter press will sync StickS3 RTC to current time + stopwatch elapsed",
                    nextReset ? "text-red-400" : "text-emerald-400"
                  );
                }}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors flex items-center gap-1 ${
                  airClockReset2015
                    ? "bg-red-600 text-white font-semibold"
                    : "bg-slate-800 hover:bg-slate-700 text-cyan-300"
                }`}
                title="Toggle simulated Olympus Air A01 RTC state (Valid Current Time vs Factory-Reset 2015) and arm next-shutter /get_imglist.cgi sync"
              >
                <Clock className="w-3 h-3" />
                {airClockReset2015 ? "Air Clock: 2015" : "Air Clock: Valid"}
              </button>
              <button
                onClick={() => {
                  setSavedWifi(null);
                  setPowerOn(true);
                  addLog("WIFI", "Cleared Saved NVS Credentials", "Simulating unconfigured first boot -> All-AP Scan", "text-amber-400");
                  enterWifiScanWizard();
                }}
                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
                title="Clear saved NVS Wi-Fi credentials to simulate factory first boot"
              >
                Forget Wi-Fi
              </button>
            </div>
          </div>

          {/* Physical Olympus Air A01 Orientation & Camera Gyro Auto-Flip */}
          <div className="flex flex-wrap items-center justify-between text-xs gap-2 pb-2 border-b border-slate-800/70">
            <span className="text-slate-400 font-medium flex items-center gap-1.5">
              <RotateCw className="w-3.5 h-3.5 text-cyan-400" />
              Air A01 Orientation (Cam Gyro: {camGyroMode})
            </span>
            <div className="flex items-center gap-1 bg-slate-800 p-1 rounded-lg">
              {([0, 180, 90, 270] as const).map((deg) => (
                <button
                  key={deg}
                  onClick={() => {
                    setAirBodyRot(deg);
                    addLog(
                      "TCP_STREAM",
                      `RTP Ext funcId=1 -> Air Body ${deg}°`,
                      camGyroMode === "AUTO"
                        ? (deg === 180 || deg === 0
                            ? `180°-Only AUTO compensated (${deg}° -> upright in vpCanvas)`
                            : `Portrait ${deg}° ignored by 180°-only AUTO clamp (prevents cropped frame/bars)`)
                        : camGyroMode === "180D"
                        ? `Cam Gyro 180D manual flip active (view inverted 180°)`
                        : `Cam Gyro LOCKED at 0° (raw ${deg}° feed displayed)`,
                      "text-cyan-400"
                    );
                  }}
                  className={`px-2 py-0.5 text-xs rounded font-medium transition-colors ${
                    airBodyRot === deg
                      ? "bg-cyan-600 text-white shadow-sm font-bold"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                  title={deg === 180 ? "Flip Olympus Air A01 upside down (180°) for ergonomic shutter finger reach" : `Tilt Air A01 to ${deg}° (90°/270° ignored in 180°-only AUTO)`}
                >
                  {deg === 180 ? "180° Upside Down" : `${deg}°`}
                </button>
              ))}
              <button
                onClick={toggleCamGyro}
                className={`px-2 py-0.5 text-xs rounded font-medium transition-colors ${
                  camGyroMode === "AUTO"
                    ? "bg-emerald-600/80 text-white"
                    : camGyroMode === "180D"
                    ? "bg-cyan-600 text-white font-semibold"
                    : "bg-amber-600 text-white font-semibold"
                }`}
                title="Cycle Menu 'Cam Gyro' (AUTO -> 180D manual flip -> LOCK)"
              >
                Gyro: {camGyroMode}
              </button>
            </div>
          </div>

          {/* Aspect Ratio Selector bar (16:9 -> 4:3 -> 3:2 -> 1:1) */}
          <div className="flex items-center justify-between text-xs gap-2">
            <span className="text-slate-400 font-medium flex items-center gap-1.5">
              <Ratio className="w-3.5 h-3.5 text-orange-400" />
              Aspect Ratio (1× Button B)
            </span>
            <div className="flex items-center gap-1 bg-slate-800 p-1 rounded-lg">
              {(["16:9", "4:3", "3:2", "1:1"] as const).map((ratio) => (
                <button
                  key={ratio}
                  onClick={() => {
                    setAspectRatio(ratio);
                    if (soundEnabled) playM5Beep(2400, 35);
                    setBannerMessage(`[${ratio}]`);
                    setTimeout(() => { if (statePhase === "streaming") setBannerMessage("LIVE"); }, 1000);
                  }}
                  className={`px-2 py-0.5 text-xs rounded font-medium transition-colors ${
                    aspectRatio === ratio
                      ? "bg-orange-500 text-white shadow-sm font-bold"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {ratio}
                </button>
              ))}
            </div>
          </div>

          {/* Shooting Mode Selector + Lens Preset */}
          <div className="flex flex-wrap items-center justify-between text-xs gap-2">
            <span className="text-slate-400 font-medium flex items-center gap-1.5">
              <Sliders className="w-3.5 h-3.5 text-cyan-400" />
              Shooting Mode (Hold Button B)
            </span>
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-1 bg-slate-800 p-1 rounded-lg">
                <button
                  onClick={() => applyEmulatorShootMode("AUTO")}
                  className={`px-2 py-0.5 text-xs rounded font-medium transition-colors ${
                    shootMode === "AUTO"
                      ? "bg-emerald-600 text-white shadow-sm font-bold"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                  title="Standard Automatic Mode (iAUTO)"
                >
                  Auto
                </button>
                <button
                  onClick={() => applyEmulatorShootMode("A_WIDE")}
                  className={`px-2 py-0.5 text-xs rounded font-medium transition-colors ${
                    shootMode === "A_WIDE"
                      ? "bg-cyan-600 text-white shadow-sm font-bold"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                  title={`Aperture Priority locked to widest lens aperture (F${widestF})`}
                >
                  A (F{widestF})
                </button>
                <button
                  onClick={() => applyEmulatorShootMode("S_60")}
                  className={`px-2 py-0.5 text-xs rounded font-medium transition-colors ${
                    shootMode === "S_60"
                      ? "bg-orange-600 text-white shadow-sm font-bold"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                  title="Shutter Priority set to 1/60 slowest shutter speed"
                >
                  S (1/60)
                </button>
              </div>
              <select
                value={attachedLens}
                onChange={(e) => setAttachedLens(e.target.value as LensPreset)}
                aria-label="Simulated MFT Lens"
                className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-[11px] text-slate-200 font-mono focus:outline-none focus:border-cyan-500"
                title="Simulated attached Micro Four Thirds lens (determines widest F-stop in A mode)"
              >
                {(Object.keys(LENS_SPECS) as LensPreset[]).map((key) => (
                  <option key={key} value={key}>
                    {LENS_SPECS[key].label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Focus Peaking & Deep Sleep Wake Test Controls */}
          <div className="flex flex-col gap-2 text-xs pb-2 border-b border-slate-800/70">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-slate-400 font-medium flex items-center gap-1.5">
                <Crosshair className="w-3.5 h-3.5 text-emerald-400" />
                Focus Peaking ({peakSource})
              </span>
              <div className="flex items-center gap-1.5 flex-wrap justify-end">
                <button
                  onClick={() => {
                    const next = !peakEnabled;
                    setPeakEnabled(next);
                    if (soundEnabled) playM5Beep(next ? 3000 : 1800, 25);
                  }}
                  className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                    peakEnabled ? "bg-emerald-600 text-white font-semibold" : "bg-slate-800 hover:bg-slate-700 text-slate-300"
                  }`}
                >
                  Peak: {peakEnabled ? "ON" : "OFF"}
                </button>
                <select
                  value={peakColor}
                  onChange={(e) => setPeakColor(e.target.value as PeakColor)}
                  aria-label="Focus Peaking Color"
                  className="bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-200 font-mono"
                >
                  {PEAK_COLOR_ORDER.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <select
                  value={peakThickness}
                  onChange={(e) => setPeakThickness(e.target.value as PeakThickness)}
                  aria-label="Focus Peaking Thickness"
                  className="bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-200 font-mono"
                >
                  {PEAK_THICK_ORDER.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <select
                  value={peakSensitivity}
                  onChange={(e) => setPeakSensitivity(e.target.value as PeakSensitivity)}
                  aria-label="Focus Peaking Sensitivity"
                  className="bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-200 font-mono"
                >
                  {PEAK_SENS_ORDER.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <button
                  onClick={() => setPeakSource(peakSource === "320x240" ? "160x120" : "320x240")}
                  className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 font-mono text-[11px] transition-colors"
                  title="Switch Focus Peaking Luma Resolution (320x240 high detail vs 160x120 fast mode)"
                >
                  {peakSource}
                </button>
                <button
                  onClick={() => setBtnAMode(btnAMode === "SHUTTER" ? "PEAK" : "SHUTTER")}
                  className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                    btnAMode === "PEAK" ? "bg-amber-600 text-white font-semibold" : "bg-slate-800 hover:bg-slate-700 text-slate-300"
                  }`}
                  title="Assign Button A tap to Shutter or Focus Peaking ON/OFF toggle"
                >
                  [A]: {btnAMode}
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                <span>Sim Lens Focus:</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={focusSharpness}
                  onChange={(e) => setFocusSharpness(Number(e.target.value))}
                  aria-label="Simulated Lens Focus Sharpness"
                  className="w-28 accent-emerald-400 cursor-pointer"
                />
                <span className="font-mono text-slate-200 tabular-nums w-8">{focusSharpness}%</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-slate-400 flex items-center gap-1">
                  <Power className="w-3 h-3 text-orange-400" />
                  Wake Key:
                </span>
                <select
                  value={wakeKeyMode}
                  onChange={(e) => setWakeKeyMode(e.target.value as WakeKeyMode)}
                  aria-label="Deep Sleep Wake Key"
                  className="bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-emerald-300 font-mono"
                >
                  {WAKE_KEY_ORDER.map((wk) => (
                    <option key={wk} value={wk}>{wk}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Diagnostics & Scene Controls */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400 font-medium">Camera Scene Mock</span>
            <div className="flex items-center gap-1 bg-slate-800 p-1 rounded-lg">
              {(["street", "nature", "studio", "chart"] as const).map((sc) => (
                <button
                  key={sc}
                  onClick={() => setSelectedScene(sc)}
                  className={`px-2.5 py-1 text-xs rounded font-medium capitalize transition-colors ${
                    selectedScene === sc ? "bg-orange-500 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {sc}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between text-xs gap-2">
            <span className="text-slate-400 font-medium shrink-0">2-Button &amp; Menu Tests</span>
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <button
                onClick={cycleAspectRatio}
                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
                title="Simulate 1x clicking Button B"
              >
                1×[B] Aspect
              </button>
              <button
                onClick={cycleShootingMode}
                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-orange-300 text-xs font-medium transition-colors"
                title="Simulate 2x clicking Button B to cycle shooting modes"
              >
                2×[B] Mode
              </button>
              <button
                onClick={toggleDiagnosticsHud}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  showDiagHud ? "bg-cyan-600 text-white" : "bg-slate-800 hover:bg-slate-700 text-cyan-300"
                }`}
                title="Simulate 3x clicking Button B to toggle Diagnostics HUD"
              >
                3×[B] {showDiagHud ? "Exit Diag" : "Diag"}
              </button>
              <button
                onClick={toggleDualGyroLock}
                disabled={statePhase !== "streaming"}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  dualGyroLocked ? "bg-amber-600 text-white font-semibold" : "bg-slate-800 hover:bg-slate-700 text-amber-300"
                } ${statePhase !== "streaming" ? "opacity-50 cursor-not-allowed" : ""}`}
                title="Simulate 4× clicking Button B to lock BOTH Stick Rot + Cam Gyro (and restore prior modes on 2nd 4× click)"
              >
                4×[B] {dualGyroLocked ? "Unlock Gyro" : "Lock Gyros"}
              </button>
              <button
                onClick={toggleQuickMenu}
                disabled={!powerOn || !["streaming", "wifi_searching_saved", "wifi_scan", "wifi_passkey", "bt_scan", "bt_passkey"].includes(statePhase)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  menuOpen ? "bg-orange-600 text-white" : "bg-slate-800 hover:bg-slate-700 text-orange-300"
                } ${!powerOn || !["streaming", "wifi_searching_saved", "wifi_scan", "wifi_passkey", "bt_scan", "bt_passkey"].includes(statePhase) ? "opacity-50 cursor-not-allowed" : ""}`}
                title="Simulate holding Button B (>=600ms) to open/close the 22-item Quick Menu (works on Boot/Wi-Fi/BT/Live View)"
              >
                Hold [B]: {menuOpen ? "Close Menu" : "Menu"}
              </button>
              <button
                onClick={() => {
                  addLog("ACTION", "Button B 5× Click", "Shuts down Air A01 + puts M5StickS3 into Deep Sleep (RTC preserved)", "text-rose-400");
                  triggerPowerOffWithAir();
                }}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  !powerOn && !airOnline ? "bg-emerald-600 text-white" : "bg-slate-800 hover:bg-rose-900/70 text-rose-300"
                }`}
                title="Simulate 5× clicking Button B to shut down Air A01 and enter Deep Sleep on M5StickS3"
              >
                {powerOn ? "5×[B] Sleep All" : "Wake All"}
              </button>
              <button
                onClick={() => {
                  setExposureWarning((prev) => {
                    const next = !prev;
                    addLog(
                      "TCP_STREAM",
                      `RTP Ext ID 16 (expphotowarning): ${next ? "WARNING ACTIVE" : "CLEARED"}`,
                      next
                        ? "Exposure / Metering warning received -> red box drawn around preview window"
                        : "Exposure warning cleared -> normal preview frame restored",
                      next ? "text-red-400" : "text-emerald-400"
                    );
                    return next;
                  });
                }}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors flex items-center gap-1 ${
                  exposureWarning ? "bg-red-600 text-white font-semibold" : "bg-slate-800 hover:bg-slate-700 text-red-300"
                }`}
                title="Simulate receiving an Exposure / Exposure Metering Warning (RTP Ext ID 16)"
              >
                <AlertTriangle className="w-3 h-3" />
                {exposureWarning ? "Exp Warn: ON" : "Test Exp Warn"}
              </button>
              <button
                onClick={() => {
                  const nextOrient = orientation === "landscape" ? "portrait" : "landscape";
                  if (stickRotMode === "LOCK") {
                    setStickRotMode("GYRO");
                    setDualGyroLocked(false);
                  }
                  setOrientation(nextOrient);
                  setFlipped180(false);
                  addLog(
                    "ACTION",
                    `IMU Gyro Turn -> ${nextOrient.toUpperCase()}`,
                    `Switched M5StickS3 UI to ${nextOrient === "portrait" ? "Portrait (135x240, rot=0)" : "Landscape (240x135, rot=1)"} & saved to NVS`,
                    "text-cyan-400"
                  );
                }}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  orientation === "portrait" ? "bg-cyan-600 text-white" : "bg-slate-800 hover:bg-slate-700 text-cyan-300"
                }`}
                title="Simulate rotating the M5Stick vertical (Portrait) or horizontal (Landscape)"
              >
                {orientation === "portrait" ? "Turn Horizontal" : "Turn Vertical"}
              </button>
              <button
                onClick={triggerPowerOffStickOnly}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  !powerOn && airOnline ? "bg-emerald-600 text-white" : "bg-slate-800 hover:bg-cyan-900/70 text-cyan-300"
                }`}
                title="Menu -> Sleep: Stick Only (enters Deep Sleep keeping RTC alive and Olympus Air A01 ON)"
              >
                {powerOn ? "Sleep: Stick Only" : "Wake S3"}
              </button>
              <button
                onClick={triggerPowerOffWithAir}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  !powerOn && !airOnline ? "bg-emerald-600 text-white" : "bg-slate-800 hover:bg-rose-900/70 text-rose-300"
                }`}
                title="Simulate Hold [A+B] (>=650ms) or Menu -> Sleep: Air + Stick"
              >
                {powerOn ? "Hold [A+B]: Sleep All" : "Wake All"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT COLUMN: Protocol Inspector & MicroSD Gallery */}
      <div className="lg:col-span-6 space-y-6">
        {/* Connection & Handshake Flow Stepper */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <Activity className="w-4 h-4 text-cyan-400" />
              Fast Handshake &amp; Optimization Pipeline
            </h3>
            <span className="text-xs font-mono text-emerald-400">AIR: {airBatteryLevel} · S3: {m5BatteryVoltage}V</span>
          </div>

          <div className="space-y-2 text-xs">
            {/* Step 0: BT Wake + Wi-Fi Fast Connect / Onboarding */}
            <div className={`p-2.5 rounded-lg border flex items-center justify-between ${
              ["idle", "bt_wake", "bt_scan", "bt_passkey", "wifi_scan", "wifi_passkey", "wifi_searching_saved"].includes(statePhase)
                ? "bg-amber-950/20 border-amber-700/40 text-amber-300"
                : "bg-emerald-950/20 border-emerald-800/40 text-emerald-300"
            }`}>
              <div className="flex items-center gap-2">
                <span className="font-mono font-bold text-slate-400">0.</span>
                <span>
                  {statePhase === "bt_wake"
                    ? `BLE Auto-Wake '${savedBt?.name}'`
                    : statePhase === "bt_scan" || statePhase === "bt_passkey"
                    ? "On-Device BLE Scan & 6-Digit PIN Picker"
                    : statePhase === "wifi_scan" || statePhase === "wifi_passkey"
                    ? "On-Device All-AP Scan & 8-Digit Key Picker"
                    : statePhase === "wifi_searching_saved"
                    ? `Searching '${savedWifi?.ssid || "Saved Air"}' (NVS)`
                    : `Fast Connect (${savedWifi?.ssid || config.wifiSsid})`}
                </span>
              </div>
              <span className="font-mono text-[11px] text-slate-400">
                {btWakeOnBoot ? "BT Wake ON · " : ""}Static .100 · CH:{savedWifi?.channel || "?"}
              </span>
            </div>

            {/* Step 1 */}
            <div className={`p-2.5 rounded-lg border flex items-center justify-between ${
              ["idle", "bt_wake", "bt_scan", "bt_passkey", "wifi_searching_saved", "wifi_scan", "wifi_passkey", "connecting_wifi"].includes(statePhase)
                ? "bg-slate-950/40 border-slate-800/60 text-slate-500"
                : "bg-emerald-950/20 border-emerald-800/40 text-emerald-300"
            }`}>
              <div className="flex items-center gap-2">
                <span className="font-mono font-bold text-slate-400">1.</span>
                <span>get_connectmode → mode=rec → changelvqty</span>
              </div>
              <span className="font-mono text-[11px] text-slate-400">X-Protocol · 50ms Gap · 520 Retry</span>
            </div>

            {/* Step 2 */}
            <div className={`p-2.5 rounded-lg border flex items-center justify-between ${
              statePhase === "streaming" || statePhase === "cgi_stream"
                ? "bg-emerald-950/20 border-emerald-800/40 text-emerald-300"
                : "bg-slate-950/40 border-slate-800/60 text-slate-500"
            }`}>
              <div className="flex items-center gap-2">
                <span className="font-mono font-bold text-slate-400">2.</span>
                <span>GET /exec_takemisc.cgi?com=startliveview&port={config.streamPort}</span>
              </div>
              <span className="font-mono text-[11px] text-slate-400">Port {config.streamPort} (AsyncUDP)</span>
            </div>

            {/* Step 3: First-Frame Gate */}
            <div className={`p-2.5 rounded-lg border flex items-center justify-between ${
              statePhase === "streaming"
                ? "bg-emerald-950/20 border-emerald-800/40 text-emerald-300"
                : "bg-slate-950/40 border-slate-800/60 text-slate-500"
            }`}>
              <div className="flex items-center gap-2">
                <span className="font-mono font-bold text-slate-400">3.</span>
                <span>First-Frame Gate (+150ms) → ASPECT_RATIO &amp; TAKEMODE</span>
              </div>
              <span className="font-mono text-[11px] text-slate-400">100ms com=get Poll</span>
            </div>

            {/* Step 4: Shutter trigger API */}
            <div className="p-2.5 rounded-lg border bg-orange-950/20 border-orange-800/40 text-orange-300 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-mono font-bold text-orange-400">[A]</span>
                <span>takeready → newstarttake → newstoptake</span>
              </div>
              <span className="font-mono text-[11px] text-orange-300 font-semibold">
                Urgent Stop · OlympusCameraKit
              </span>
            </div>
          </div>
        </div>

        {/* Real-time Network & CGI Packet Log */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col h-64">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              Live Packet & Serial Monitor
            </h3>
            <button
              onClick={() => setLogs([])}
              className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
            >
              Clear Log
            </button>
          </div>

          <div className="flex-1 overflow-y-auto pt-2 space-y-1.5 font-mono text-xs pr-1">
            {logs.length === 0 ? (
              <div className="text-slate-500 py-6 text-center">No packet logs yet. Turn on device to initiate.</div>
            ) : (
              logs.map((log) => (
                <div key={log.id} className="p-1.5 rounded bg-slate-950/70 border border-slate-800/50 flex flex-col gap-0.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className={`font-semibold ${log.color}`}>
                      [{log.type}] {log.summary}
                    </span>
                    <span className="text-slate-500 text-[10px]">{log.timestamp}</span>
                  </div>
                  <div className="text-slate-400 text-[11px] truncate">{log.detail}</div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Camera MicroSD Snapshot Gallery with Aspect Ratio Badge */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-orange-400" />
              Camera MicroSD Storage ({capturedPhotos.length} Captured)
            </h3>
            <span className="text-xs font-mono text-emerald-400 bg-emerald-950/50 border border-emerald-800/50 px-2 py-0.5 rounded">
              {remainingShots.toLocaleString()} Remaining
            </span>
          </div>

          {capturedPhotos.length === 0 ? (
            <div className="py-6 border border-dashed border-slate-800 rounded-lg text-center text-xs text-slate-500">
              No photos captured yet. Click the front <strong className="text-slate-300">"M5" Button A</strong> to snap a photo!
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3 max-h-48 overflow-y-auto pr-1">
              {capturedPhotos.map((photo) => (
                <div 
                  key={photo.id}
                  className="group relative rounded-lg overflow-hidden border border-slate-800 bg-slate-950"
                >
                  <img
                    src={photo.imageUrl}
                    alt={photo.title}
                    referrerPolicy="no-referrer"
                    className="w-full h-20 object-cover"
                  />
                  <div className="p-1.5 bg-slate-900 text-[10px]">
                    <div className="font-mono text-slate-200 truncate flex items-center justify-between">
                      <span>{photo.title}</span>
                      <span className="text-[9px] text-orange-400 font-bold bg-orange-950/60 px-1 rounded">
                        {photo.aspect}
                      </span>
                    </div>
                    <div className="text-slate-400 text-[9px] flex items-center justify-between mt-0.5">
                      <span>{photo.shutter}</span>
                      <a
                        href={photo.imageUrl}
                        download={photo.title}
                        className="text-cyan-400 hover:text-cyan-300 flex items-center gap-0.5"
                        title="Download Photo"
                      >
                        <Download className="w-3 h-3" />
                      </a>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
