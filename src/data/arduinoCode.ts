/**
 * Production-ready Arduino C++ code and configuration for M5StickS3 (ESP32-S3) + Olympus Air A01
 * Hardware: M5StickS3 (ESP32-S3-PICO-1-N8R8 + 8MB Flash + 8MB OPI PSRAM + 1.14" ST7789P3 135x240 + BMI270 + ES8311)
 * Framework: M5Unified (>=0.2.12) + M5GFX (>=0.2.18) + TJpg_Decoder (>=1.1.0)
 *
 * Optimizations & Protocol Resilience (learned from stanelie/airview & CAMERA_NOTES.md):
 *   - Ultra-Fast Wi-Fi Boot: Static IP (192.168.0.100, skips ~1s DHCP), NVS Wi-Fi channel cache (skips 13-ch scan,
 *     auto-clears on WIFI_REASON_NO_AP_FOUND), WiFi.persistent(false) (no flash stalls during WPA2 EAPOL), WiFi.setSleep(false)
 *   - Embedded HTTP Server Protection: 50ms inter-call throttle (HTTP_MIN_GAP_MS, urgent bypass on newstoptake),
 *     User-Agent + X-Protocol: OlympusCameraKit headers, Keep-Alive handshake, HTTP 520 mid-transition retry
 *   - Black-Screen Prevention (First-Frame Gate): Starts liveview first and waits for first valid RTP frame + 150ms
 *     before sending post-stream set_camprop.cgi calls (ASPECT_RATIO / TAKEMODE)
 *   - Reliable TAKEMODE Confirm: Handles HTTP 200 <notset/> trigger and polls com=get every 100ms until confirmed (~350-550ms)
 *   - Triple-Buffered Zero-Flicker Liveview: 3-slot AsyncUDP ring buffer (SRAM + PSRAM) composited into an
 *     offscreen M5Canvas viewport sprite (JPEG + grids + AF reticle) pushed atomically via pushSprite()
 *   - Hardware + Hold-[A] Continuous Shooting: Auto-discovers TAKE_DRIVE / DRIVE_MODE & CONTINUOUS_SHOOTING_VELOCITY
 *     via com=desc&propname=desclist so both the Air A01 physical shutter and Hold-[A] burst work reliably
 *   - Instant Quick Menu & Boot/Live Controls: Hold [B] works on Boot/Wi-Fi Search/Setup AND Live View;
 *     5x[B] Deep Sleep works on Boot, Wi-Fi/BT Search/Setup, AND Live View; look-ahead scrolling previews next row
 *   - Live View Camera Gyro Auto-Flip & Lock: Parses Olympus RTP Extension funcId=1 (EXIF 1/3/6/8) so
 *     turning the Air A01 upside down (180 deg) for thumb/finger reach flips the live view inside vpCanvas
 *     to compensate, with a Cam Gyro (AUTO/LOCK) toggle right inside the Hold-[B] Menu
 *   - Bluetooth BLE Auto-Wake Setup: On-device BLE scanner + 6-digit passkey picker + BT Wake (ON/OFF)
 *     toggle to wake a paired Air A01 over BLE when StickS3 powers on before fast Static-IP Wi-Fi connect
 *   - 2-Button UI (BtnA GPIO 11 & BtnB GPIO 12 — configurable Wake Key: BTN B / BTN A / A+B):
 *     - Wi-Fi & BT Setup: Scanners (AIR-* first) + 8-digit Wi-Fi / 6-digit BT numeric passkey pickers (5x[B] sleeps)
 *     - [A] Mode (Menu selectable): SHUTTER (1-shot / Hold burst) OR PEAK (Tap toggles Focus Peaking ON/OFF)
 *     - [B] Multi-Action: 1x Aspect Ratio | 2x Shooting Mode | 3x Diag HUD | 4x GyroLock | 5x Deep Sleep | Hold Menu
 *     - Hold [A+B] (>=650ms): Instant Air A01 + StickS3 Deep Sleep (keeps internal RTC alive!)
 *   - Real-Time Focus Peaking (Every Frame, 320x240 Luma or 160x120 Fast):
 *     - Dedicated Peak Setup Submenu: ON/OFF, Color (Red/Yellow/Green/Cyan/White), Thickness (1/2/3px), Sensitivity, Source
 *   - Persistent Clock / RTC Sync via Shutter Stopwatch & Deep Sleep:
 *     - On shutter press, starts a stopwatch (millis()) and queries /get_imglist.cgi for newest photo timestamp,
 *       adds elapsed stopwatch time, sets ESP32-S3 clock persistently across Deep Sleep cycles, and alerts if year == 2015
 */

export interface GeneratorConfig {
  wifiSsid: string;
  wifiPass: string;
  autoScanAir: boolean;
  cameraIp: string;
  streamPort: number;
  rotation: number; // 1 or 3 for Landscape (240x135), 0 or 2 for Portrait (135x240)
  jpegScale: number; // 2 = 1/2 scale (160x120 for 320x240 stream)
  bufferSize: number; // in bytes, e.g. 65536
  debugSerial: boolean;
  liveViewQuality: string; // "0320x0240" | "0640x0480"
  defaultAspectRatio: string; // "16:9" | "4:3" | "3:2" | "1:1"
  defaultShootingMode: "AUTO" | "A_WIDE" | "S_60";
}

export const DEFAULT_CONFIG: GeneratorConfig = {
  wifiSsid: "AIR-A01-12345678",
  wifiPass: "12345678",
  autoScanAir: true,
  cameraIp: "192.168.0.10",
  streamPort: 5555,
  rotation: 1, // Landscape (240x135) aligned to StickS3 physical buttons (180 deg from rot=3)
  jpegScale: 2, // 1/2 scale: 320x240 -> 160x120 (fits 240x135 screen cleanly)
  bufferSize: 65536, // 64KB
  debugSerial: true,
  liveViewQuality: "0320x0240",
  defaultAspectRatio: "16:9",
  defaultShootingMode: "AUTO",
};

const ASPECT_INDEX_MAP: Record<string, number> = {
  "16:9": 0,
  "4:3": 1,
  "3:2": 2,
  "1:1": 3,
};

const SHOOT_INDEX_MAP: Record<string, number> = {
  AUTO: 0,
  A_WIDE: 1,
  S_60: 2,
};

export function generateArduinoSketch(cfg: GeneratorConfig): string {
  const defaultAspectIdx = ASPECT_INDEX_MAP[cfg.defaultAspectRatio] ?? 0;
  const defaultShootIdx = SHOOT_INDEX_MAP[cfg.defaultShootingMode] ?? 0;
  // Auto-fit scale if 640x480 stream is selected with scale=2 (would be 320x240 > 160x120 viewport)
  const effectiveScale = cfg.liveViewQuality === "0640x0480" && cfg.jpegScale < 4 ? 4 : cfg.jpegScale;
  // Two static slots for tear-free AsyncUDP ping-pong buffering (~72KB total for 320x240, ~96KB for 640x0480)
  const slotSize = cfg.liveViewQuality === "0640x0480" ? 49152 : 36864;

  return `/**
 * ============================================================================
 * Project:      Olympus Air A01 Live Viewfinder for M5StickS3 (ESP32-S3)
 * Hardware:     M5StickS3 (ESP32-S3-PICO-1-N8R8, 8MB Flash, 8MB OPI PSRAM,
 *               1.14" ST7789P3 TFT LCD 135x240, M5PM1 PMIC, BMI270 6-axis IMU,
 *               ES8311 Audio Codec + AW8737 1W Speaker)
 * Target:       Olympus Air A01 Micro Four Thirds Open Platform Camera (OPC)
 * License:      MIT
 * ============================================================================
 *
 * Fast Boot & Resilience Architecture (informed by stanelie/airview & CAMERA_NOTES):
 *   1. INSTANT WI-FI CONNECT (Static IP + Channel Cache + RAM-Only Driver):
 *      - Assigns static IP (.100 on CAMERA_IP subnet) BEFORE WiFi.begin() to skip ~1s DHCP.
 *      - Caches last connected Wi-Fi channel in NVS ("olympus_wifi") to skip full
 *        13-channel scanning on warm boots; clears hint on WIFI_REASON_NO_AP_FOUND (201).
 *      - Uses WiFi.persistent(false) & WiFi.setSleep(false) so flash writes never stall WPA2 EAPOL.
 *
 *   2. 2-BUTTON UI, FOCUS PEAKING & POCKET-SAFE DEEP SLEEP WAKE:
 *      - Designed around BtnA (GPIO 11) & BtnB (GPIO 12); recessed Power Button hardware-resets M5StickS3.
 *      - Wi-Fi AP Scanner: BtnB steps through nearby 2.4GHz APs ("AIR-*" first), BtnA selects (5x[B] sleeps).
 *      - 8-Digit Passkey Picker: BtnB increments digits 0->9 (hold to fast-step), BtnA confirms (5x[B] sleeps).
 *      - Uses an offscreen M5Canvas sprite buffer so button presses never flicker or flash black.
 *      - Focus Peaking: Decodes existing 0320x0240 Wi-Fi stream at scale=1 (320x240) when Peak = ON & Source = 320x240,
 *        running a branchless integer gradient detector every frame with 5 colors, 1-3px thickness, and 3 low-noise sensitivities.
 *
 *   3. HOLD-B QUICK MENU, PEAK SUBMENU & DEEP SLEEP (RTC PRESERVED):
 *      - Live Viewfinder:
 *        * [A] SHUTTER mode: 1-shot in SINGLE; Continuous burst in CONT; 2s/10s Timer. PEAK mode: tap toggles Focus Peaking.
 *        * [B] 1x: Aspect Ratio | 2x: Shooting Mode | 3x: Diagnostics HUD | 4x: GyroLock | 5x: Deep Sleep | Hold: Camera Menu
 *      - Hold [A+B] (>=650ms) OR 5x[B] (Wi-Fi/BT/Live) OR Quick Menu Sleep: enters ESP32-S3 Deep Sleep so the internal RTC stays alive,
 *        waking via the configured RTC GPIO Wake Key (default: BTN B GPIO 12 to avoid pocket BtnA wakes; or BTN A / A+B).
 *
 *   4. TRIPLE-BUFFERED COMPOSITED LIVEVIEW & OLYMPUS OPC RESILIENCE:
 *      - Uses 3 AsyncUDP frame slots + offscreen vpCanvas sprite so grids & AF reticles never flicker
 *        over live video like VHS tearing; uses short connect timeouts on background polls.
 *      - Sends BOTH User-Agent: OlympusCameraKit AND X-Protocol: OlympusCameraKit.
 *      - Enforces HTTP_MIN_GAP_MS = 50 between HTTP calls (with urgent bypass on newstoptake).
 *      - Uses HTTP Keep-Alive across handshake with automatic HTTP 520 mid-transition retry.
 *      - First-Frame Stream Gate: starts liveview first, waits for frame #1 + 150ms, then discovers
 *        properties via get_camprop.cgi?com=desc&propname=desclist and syncs NVS preferences.
 *
 * Required Libraries (Arduino Library Manager):
 *   1. "M5Unified" by M5Stack (v0.2.12+ — installs M5GFX v0.2.18+)
 *   2. "TJpg_Decoder" by Bodmer (v1.1.0+)
 *
 * Arduino IDE Board Settings (M5Stack Board Manager v3.2.5+):
 *   - Board: "M5StickS3" (or "ESP32S3 Dev Module")
 *   - USB CDC On Boot: "Enabled"
 *   - Flash Size: "8MB (64Mb)" | PSRAM: "OPI PSRAM"
 * ============================================================================
 */

#include <M5Unified.h>
#include <WiFi.h>
#include <AsyncUDP.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <TJpg_Decoder.h>
#include <BLEDevice.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>
#include <BLEClient.h>
#include <BLESecurity.h>
#if defined(__has_include)
  #if __has_include(<esp_arduino_version.h>)
    #include <esp_arduino_version.h>
  #endif
#endif
#include <esp_timer.h>
#include <esp_wifi.h>
#include <esp_sleep.h>
#include <driver/rtc_io.h>
#include <time.h>
#include <sys/time.h>
#include <vector>

// M5StickS3 RTC-Capable Wake Pins (ESP32-S3 EXT1 supports GPIOs 0-21; Power Button resets board in hardware)
static const gpio_num_t PIN_BTN_A_GPIO = GPIO_NUM_11;
static const gpio_num_t PIN_BTN_B_GPIO = GPIO_NUM_12;

// Optional Custom Olympus Air A01 BLE Wake GATT UUIDs (leave empty "" to auto-probe vendor 128-bit writable GATT)
// Note: Olympus kept the exact 128-bit wake UUID proprietary inside OLYCameraKit/OA.Central; if captured via nRF Connect, paste here:
static const char* AIR_BLE_WAKE_SERVICE_UUID = "";
static const char* AIR_BLE_WAKE_CHAR_UUID    = "";

// ----------------------------------------------------------------------------
// Configuration Parameters (Fallback / Default Values)
// ----------------------------------------------------------------------------
const char* DEFAULT_TARGET_SSID     = "${cfg.wifiSsid}";
const char* DEFAULT_TARGET_PASSWORD = "${cfg.wifiPass}";
const bool  AUTO_SCAN_SSID          = ${cfg.autoScanAir ? "true" : "false"};

const char* CAMERA_IP        = "${cfg.cameraIp}";
const uint16_t STREAM_PORT   = ${cfg.streamPort};

// Olympus Air A01 Open Platform Camera (OPC) HTTP CGI Endpoints
const char* OPC_USER_AGENT   = "OlympusCameraKit";
const char* URL_CONNECT_MODE = "http://${cfg.cameraIp}/get_connectmode.cgi";
const char* URL_SWITCH_REC   = "http://${cfg.cameraIp}/switch_cameramode.cgi?mode=rec";
const char* URL_CHANGE_LVQTY = "http://${cfg.cameraIp}/exec_takemisc.cgi?com=changelvqty&lvqty=${cfg.liveViewQuality}";
const char* URL_SWITCH_STDBY = "http://${cfg.cameraIp}/switch_cameramode.cgi?mode=standalone";
const char* URL_SWITCH_PLAY  = "http://${cfg.cameraIp}/switch_cameramode.cgi?mode=play";
const char* URL_POWER_OFF    = "http://${cfg.cameraIp}/exec_pwoff.cgi";
const char* URL_START_STREAM = "http://${cfg.cameraIp}/exec_takemisc.cgi?com=startliveview&port=${cfg.streamPort}";
const char* URL_STOP_STREAM  = "http://${cfg.cameraIp}/exec_takemisc.cgi?com=stopliveview";
const char* URL_TAKE_READY   = "http://${cfg.cameraIp}/exec_takemotion.cgi?com=takeready&point=0160x0120";
const char* URL_NEW_START    = "http://${cfg.cameraIp}/exec_takemotion.cgi?com=newstarttake";
const char* URL_NEW_STOP     = "http://${cfg.cameraIp}/exec_takemotion.cgi?com=newstoptake";
const char* URL_OLD_START    = "http://${cfg.cameraIp}/exec_takemotion.cgi?com=starttake";
const char* URL_OLD_STOP     = "http://${cfg.cameraIp}/exec_takemotion.cgi?com=stoptake";
const char* URL_BAT_LEVEL    = "http://${cfg.cameraIp}/get_camprop.cgi?com=get&propname=BATTERY_LEVEL";
const char* URL_BAT_DESC     = "http://${cfg.cameraIp}/get_camprop.cgi?com=desc&propname=BATTERY_LEVEL";
const char* URL_ASPECT_DESC  = "http://${cfg.cameraIp}/get_camprop.cgi?com=desc&propname=ASPECT_RATIO";
const char* URL_ASPECT_SET   = "http://${cfg.cameraIp}/set_camprop.cgi?com=set&propname=ASPECT_RATIO";
const char* URL_IMGLIST_BASE = "http://${cfg.cameraIp}/get_imglist.cgi?DIR=";

// HTTP burst protection from CAMERA_NOTES.md
static const uint32_t HTTP_MIN_GAP_MS = 50;
static int64_t        lastHttpDoneUs  = 0;

// Display Geometry & Ping-Pong Buffer Constants (135x240 ST7789P3)
#define LCD_ROTATION         ${cfg.rotation}    // 0/2 = Portrait (135x240), 1/3 = Landscape (240x135)
#define FRAME_SLOT_SIZE      ${slotSize}        // Per-slot JPEG buffer (allocated in setup)

// Viewport Positioning: Landscape (160x120 center) & Portrait (132x99 upper preview)
#define JPG_SCALE            ${effectiveScale}
#define VIEWPORT_X_OFFSET    40
#define VIEWPORT_Y_OFFSET    14
#define VIEWPORT_WIDTH       160
#define VIEWPORT_HEIGHT      120
#define BANNER_HEIGHT        14

#define PORTRAIT_VP_X        1
#define PORTRAIT_VP_Y        25
#define PORTRAIT_VP_WIDTH    132
#define PORTRAIT_VP_HEIGHT   99
#define PORTRAIT_BANNER_H    24

// Speaker safety cap on M5StickS3 250mAh battery (AW8737 amplifier <= 75% volume)
#define SPEAKER_SAFE_VOL     140 // ~55% of 255

// ----------------------------------------------------------------------------
// Olympus Air A01 Aspect Ratios (OPC uses "6:6" for 1:1 square on Air A01)
// ----------------------------------------------------------------------------
enum AspectRatioMode {
  ASPECT_16_9 = 0,
  ASPECT_4_3,
  ASPECT_3_2,
  ASPECT_1_1,
  ASPECT_COUNT
};

const char* ASPECT_NAMES[ASPECT_COUNT]                 = { "16:9", "4:3", "3:2", "1:1" };
static String cameraAspectTokens[ASPECT_COUNT]         = { "16:9", "4:3", "3:2", "6:6" };
static const char* cameraAspectAltTokens[ASPECT_COUNT] = { "16_09", "04_03", "03_02", "06_06" };
static uint8_t currentAspectIdx = ${defaultAspectIdx};

// ----------------------------------------------------------------------------
// Shooting Mode Presets (Button B Long Press >=600ms)
// ----------------------------------------------------------------------------
enum ShootingModePreset {
  SHOOT_AUTO = 0,
  SHOOT_A_WIDE,
  SHOOT_S_60,
  SHOOT_COUNT
};
const char* SHOOT_MODE_LABELS[SHOOT_COUNT] = { "AUTO", "A:MAX", "S:1/60" };
static uint8_t currentShootMode = ${defaultShootIdx};

// ----------------------------------------------------------------------------
// Camera Grid Overlays, Drive Modes & Sequential Speed (Hold-A Quick Menu)
// ----------------------------------------------------------------------------
enum GridOverlayMode {
  GRID_OFF = 0,
  GRID_THIRDS,
  GRID_SQUARE,
  GRID_DIAGONAL,
  GRID_GOLDEN,
  GRID_COUNT
};
const char* GRID_MODE_NAMES[GRID_COUNT] = { "OFF", "3RDS", "4x4", "DIAG", "GOLD" };
static uint8_t currentGridMode = GRID_THIRDS;

enum DriveMode {
  DRIVE_SINGLE = 0,
  DRIVE_CONT,
  DRIVE_TIMER_2S,
  DRIVE_TIMER_10S,
  DRIVE_COUNT
};
const char* DRIVE_MODE_NAMES[DRIVE_COUNT] = { "SINGLE", "CONT", "TMR 2s", "TMR 10s" };
const char* DRIVE_MODE_SHORT[DRIVE_COUNT] = { "SGL", "CNT", "2S", "10S" };
static uint8_t currentDriveMode = DRIVE_SINGLE;

enum SeqSpeedMode {
  SEQ_HIGH = 0,
  SEQ_LOW,
  SEQ_COUNT
};
const char* SEQ_SPEED_NAMES[SEQ_COUNT] = { "HIGH", "LOW" };
static uint8_t currentSeqSpeed = SEQ_HIGH;

// Drive Mode, Velocity & Olympus Air Sound Discovery State
static String  propDriveName      = "TAKE_DRIVE";
static String  driveEnumCache     = "";
static bool    driveDiscovered    = false;
static bool    driveContConfirmed = false;
static String  propSeqVelName     = "CONTINUOUS_SHOOTING_VELOCITY";
static String  seqVelEnumCache    = "";
static bool    seqVelAvailable    = false;
static bool    seqLowHwSupported  = false;
static bool    inWifiSetupScreen  = false;
static bool    inBtSetupScreen    = false;

// ----------------------------------------------------------------------------
// Focus Peaking, Button A Mode & Configurable Deep Sleep Wake Keys
// ----------------------------------------------------------------------------
enum PeakColorMode {
  PEAK_COL_RED = 0,
  PEAK_COL_YELLOW,
  PEAK_COL_GREEN,
  PEAK_COL_CYAN,
  PEAK_COL_WHITE,
  PEAK_COL_COUNT
};
const char*    PEAK_COLOR_NAMES[PEAK_COL_COUNT]  = { "RED", "YELLOW", "GREEN", "CYAN", "WHITE" };
const char*    PEAK_COLOR_SHORT[PEAK_COL_COUNT]  = { "RED", "YEL", "GRN", "CYN", "WHT" };
const uint16_t PEAK_COLOR_RGB565[PEAK_COL_COUNT] = { 0xF800, 0xFFE0, 0x07E0, 0x07FF, 0xFFFF };

enum PeakThickMode {
  PEAK_THICK_1PX = 0,
  PEAK_THICK_2PX,
  PEAK_THICK_3PX,
  PEAK_THICK_COUNT
};
const char* PEAK_THICK_NAMES[PEAK_THICK_COUNT] = { "1PX", "2PX", "3PX" };

enum PeakSensMode {
  PEAK_SENS_LOW = 0,
  PEAK_SENS_MID,
  PEAK_SENS_HIGH,
  PEAK_SENS_COUNT
};
const char*   PEAK_SENS_NAMES[PEAK_SENS_COUNT]     = { "LOW", "MID", "HIGH" };
// Former MID thresholds (156/138) are now LOW (lowest sensitivity); new MID (126/111) sits between LOW and HIGH (96/84)
const int32_t PEAK_SENS_THRESH_320[PEAK_SENS_COUNT] = { 156, 126, 96 };
const int32_t PEAK_SENS_THRESH_160[PEAK_SENS_COUNT] = { 138, 111, 84 };

enum PeakSourceMode {
  PEAK_SRC_320 = 0,
  PEAK_SRC_160,
  PEAK_SRC_COUNT
};
const char* PEAK_SOURCE_NAMES[PEAK_SRC_COUNT] = { "320x240", "160x120" };

enum BtnAMode {
  BTNA_SHUTTER = 0,
  BTNA_PEAK,
  BTNA_COUNT
};
const char* BTNA_MODE_NAMES[BTNA_COUNT] = { "SHUTTER", "PEAK" };

enum WakeKeyMode {
  WAKE_BTN_B = 0,   // Side Button B (GPIO 12) — default pocket-safe (BtnA wake OFF)
  WAKE_BTN_A,       // Front Button A (GPIO 11)
  WAKE_A_AND_B,     // Front Button A OR Side Button B
  WAKE_COUNT
};
const char* WAKE_KEY_NAMES[WAKE_COUNT] = { "BTN B", "BTN A", "A+B" };

static bool     peakEnabled           = false;
static uint8_t  peakColorIdx          = PEAK_COL_RED;
static uint8_t  peakThickness         = PEAK_THICK_1PX;
static uint8_t  peakSensitivity       = PEAK_SENS_MID;
static uint8_t  peakSource            = PEAK_SRC_320;
static uint8_t  btnAMode              = BTNA_SHUTTER;
static uint8_t  wakeKeyMode           = WAKE_BTN_B;

// On-Screen Live View HUD Text Visibility Bitmask (persisted in NVS "hud_mask")
enum HudElementBit {
  HUD_FPS = 0,     // Top banner FPS counter
  HUD_STATUS,      // Top banner status badge (LIVE / EXP! / 2015!)
  HUD_ASPECT,      // Top [16:9] + rail Aspect ratio label
  HUD_RES,         // Rail active viewport pixel resolution (e.g. 160x90)
  HUD_BATT,        // Top Air + S3 dual battery text
  HUD_MODE,        // Shooting mode (iAUTO / A:MAX / S:1/60)
  HUD_SHUTTER,     // Live shutter speed
  HUD_APERTURE,    // Live aperture
  HUD_ISO,         // Live ISO
  HUD_DRIVE,       // Drive / Grid / Peak / Rot tags (1x G P, GRD:..., ROT:...)
  HUD_REM,         // Remaining shots counter (REM)
  HUD_AF_WARN,     // AF:CTR / EXP:!! indicator
  HUD_CLOCK,       // Persistent RTC clock badge
  HUD_HINTS,       // Button hints ([A]SHT, [B]ASP, 2B:MOD, 3B:DIG, HB:MNU, AB:SLP)
  HUD_BIT_COUNT
};
static const uint16_t HUD_ALL_MASK = 0x3FFF;
static uint16_t hudMask = HUD_ALL_MASK;

static uint8_t* peakLuma320           = nullptr; // 320 * 240 = 76,800 B (allocated once in setup)
static uint8_t* peakLuma160           = nullptr; // 160 * 120 = 19,200 B (allocated once in setup)
static bool     peak320ActiveForFrame = false;
static uint16_t activeSrcJpgW         = 320;
static uint16_t activeSrcJpgH         = 240;

// Camera Gyro Auto-Orientation Compensation & Bluetooth Wake-On-Boot State
enum CamGyroMode {
  CAM_GYRO_AUTO = 0,
  CAM_GYRO_FLIP180,
  CAM_GYRO_LOCK,
  CAM_GYRO_COUNT
};
const char* CAM_GYRO_NAMES[CAM_GYRO_COUNT] = { "AUTO", "180D", "LOCK" };
static uint8_t   camGyroMode         = CAM_GYRO_AUTO; // AUTO: 180-deg upside-down auto-flip from Air EXIF/level; 180D: manual 180 flip; LOCK: 0 deg
static uint8_t   camActiveOrient     = 1;             // Active live-view orientation (1=0 deg upright, 3=180 deg upside down)
static uint8_t   lastCamActiveOrient = 1;

// 4x[B] Dual-Gyro Lock State (snapshots & restores prior Stick Rot + Cam Gyro modes)
static bool      dualGyroLocked      = false;
static uint8_t   priorStickRotMode   = 1; // STICK_ROT_GYRO
static uint8_t   priorCamGyroMode    = CAM_GYRO_AUTO;

// Air A01 /get_commandlist.cgi Capabilities (checked once per session)
static bool      opcCommandListChecked   = false;
static bool      opcSupportsWithBlePwoff = false;
static bool      opcSupportsLvInfo       = false;
static String    opcLvInfoQuery          = "";

// Persistent [TRACE] Capture Buffer (RAM + NVS "olympus_trace" for unplugged/boot replay over USB CDC)
static String       gTraceRamBuf          = "";
static String       gBleAsyncTraceBuf     = "";
static portMUX_TYPE bleTraceMux           = portMUX_INITIALIZER_UNLOCKED;
static String       serialCmdRxBuf        = "";
static bool         prevUsbSerialOpen     = false;
static bool         traceAutoDumpedHost   = false;
static uint32_t     rtpExtLoggedMask      = 0;
static uint32_t     rtpExtLastWord0[32]   = { 0 };
static uint8_t      rtpExtTraceCount      = 0;

struct ScannedBtEntry {
  String  name;
  String  mac;
  int32_t rssi;
  uint8_t addrType;
  bool    isAir;
};
static bool     btWakeOnBoot = false;
static bool     hasPairedBt  = false;
static String   savedBtName  = "";
static String   savedBtMac   = "";
static uint8_t  savedBtAddrType = 0;
static uint32_t savedBtPin   = 0;

static bool stickSoundEnabled = true;
static const uint8_t MAX_AIR_SOUND_OPTS = 8;
static String  propAirSoundName = "SOUND_VOLUME_LEVEL";
static String  airSoundTokens[MAX_AIR_SOUND_OPTS] = { "OFF", "LOW", "MIDDLE", "HIGH", "", "", "", "" };
static uint8_t airSoundCount      = 4;
static uint8_t currentAirSoundIdx = 2; // Default "MIDDLE" (MID)
static String  savedAirSoundToken = "";
static bool    airSoundDiscovered = false;
static bool    airSoundUserSet    = false;

// Shutter-Stopwatch RTC / Clock Sync State (populated from Air A01 /get_imglist.cgi, preserved across Deep Sleep)
static const uint32_t RTC_SYNC_MAGIC = 0x4F4C5935UL; // "OLY5"
RTC_DATA_ATTR uint32_t rtcSyncMagic        = 0;
RTC_DATA_ATTR bool     rtcClockSynced      = false;
RTC_DATA_ATTR bool     rtcClockInvalid2015 = false;
RTC_DATA_ATTR uint16_t rtcLastSyncYear     = 0;
RTC_DATA_ATTR uint32_t rtcLastStopwatchMs  = 0;
RTC_DATA_ATTR char     rtcLastSyncFile[24] = { 0 };

static bool     clockSynced               = false;
static bool     clockSyncPendingOnShutter = true;
static bool     clockInvalid2015          = false;
static uint16_t clockLastSyncYear         = 0;
static time_t   clockLastShownEpoch       = -1;
static String   clockLastSyncFile         = "";
static uint32_t clockLastStopwatchMs      = 0;

// Dynamic JPEG Fit-to-Window Geometry
static uint16_t lastJpgW       = 0;
static uint16_t lastJpgH       = 0;
static uint8_t  lastJpgScale   = JPG_SCALE;
static uint16_t dynamicDecW    = VIEWPORT_WIDTH;
static uint16_t dynamicDecH    = VIEWPORT_HEIGHT;
static int16_t  dynamicDrawX   = VIEWPORT_X_OFFSET;
static int16_t  dynamicDrawY   = VIEWPORT_Y_OFFSET;
static uint16_t dynamicMaxW    = VIEWPORT_WIDTH;
static uint16_t dynamicMaxH    = VIEWPORT_HEIGHT;
static uint32_t scaleStepX     = 65536;
static uint32_t scaleStepY     = 65536;

// ----------------------------------------------------------------------------
// Global Networking, M5Canvas Sprites & Triple-Buffered Frame Slots
// ----------------------------------------------------------------------------
static unsigned long abHoldStartMs = 0;
M5Canvas uiCanvas(&M5.Display);
M5Canvas vpCanvas(&M5.Display);
static bool vpCanvasActive = false;
AsyncUDP udp;
static portMUX_TYPE frameMux = portMUX_INITIALIZER_UNLOCKED;

static const uint8_t NUM_FRAME_SLOTS = 3;
static uint8_t          activeFrameSlots = 2;
static uint8_t*         frameBuf[NUM_FRAME_SLOTS] = { nullptr, nullptr, nullptr };
static uint8_t          rtpExtBuf[NUM_FRAME_SLOTS][384];
static volatile size_t  writeExtLen = 0;
static volatile size_t  readyExtLen = 0;
static volatile int8_t  readySlot   = -1;
static volatile size_t  readyLen    = 0;
static volatile int8_t  drawSlot    = -1;
static uint8_t          writeSlot   = 0;
static size_t           writeLen    = 0;
static volatile bool    pauseUdpAssembly = false;
static volatile unsigned long lastRxPacketMs = 0;

static int32_t  lastRtpSequence   = -1;
static bool     currentFrameValid = true;
static bool     frameInProgress   = false;

// Screen brightness & Orientation / BMI270 IMU Gyro Auto-Rotate State
enum StickRotMode {
  STICK_ROT_LOCK = 0,
  STICK_ROT_GYRO,
  STICK_ROT_LAND_FLIP,
  STICK_ROT_COUNT
};
const char* STICK_ROT_NAMES[STICK_ROT_COUNT] = { "LOCK", "GYRO", "L-FLIP" };
static uint8_t currentBrightnessLevel = 0;
static uint8_t currentRotation        = LCD_ROTATION;
static uint8_t stickRotMode           = STICK_ROT_LOCK;
static bool    imuReady               = false;
static unsigned long lastImuCheckMs   = 0;
static uint8_t imuPendingRot          = 255;
static uint8_t imuPendingCount        = 0;

// 2-Button State Trackers (BtnA GPIO 11 & BtnB GPIO 12)
static unsigned long btnADownTime       = 0;
static bool          btnAShotHandled    = false;
static bool          btnAComboCancelled = false;
static const unsigned long BTNA_COMBO_GUARD_MS = 45;

static unsigned long btnBDownTime       = 0;
static bool          btnBLongTriggered  = false;
static bool          btnBComboCancelled = false;
static uint8_t       btnBClickCount     = 0;
static unsigned long btnBLastReleaseMs  = 0;
static const unsigned long BTNB_MULTI_CLICK_MS = 360;
static uint8_t       gRapidBCount       = 0;
static unsigned long gRapidBLastMs      = 0;
static const unsigned long BTNB_WIFI_5X_WINDOW_MS = 500;

// Active Self-Timer & Continuous Burst State
static bool          selfTimerActive     = false;
static unsigned long selfTimerEndMs      = 0;
static int16_t       selfTimerLastSec    = -1;
static bool          contBurstActive     = false;
static bool          contBurstManualLoop = false;
static unsigned long contBurstStartMs    = 0;
static unsigned long contBurstLastShotMs = 0;

// Saved Wi-Fi Profile & Event Synchronization (NVS "olympus_wifi")
struct ScannedApEntry {
  String ssid;
  int32_t rssi;
  int32_t channel;
  bool isAir;
  bool isOpen;
};

static String   savedWifiSsid     = "";
static String   savedWifiPass     = "";
static uint8_t  savedWifiChannel  = 0;
static bool     hasSavedWifiCreds = false;
static uint8_t  sessionChannelHint = 0;
static bool     wifiEventsRegistered = false;

static volatile bool pendingChannelSave    = false;
static volatile uint8_t pendingChannelVal  = 0;
static volatile bool pendingChannelClear   = false;
static volatile int  lastDisconnectReason  = 0;

// Post-Stream First-Frame Gate (prevents black screen from set_camprop before frame 1)
static bool          pendingPostStreamSync = false;
static bool          sawFirstVideoFrame    = false;
static unsigned long firstVideoFrameMs     = 0;

// Diagnostic & Telemetry Variables
struct DebugState {
  String wifiStatus        = "Idle";
  String localIp           = "0.0.0.0";
  int    wifiRssi          = 0;
  int    cgi1Code          = 0;  // get_connectmode
  int    cgi2Code          = 0;  // switch_cameramode / changelvqty
  int    cgi3Code          = 0;  // startliveview
  int    readyCode         = 0;  // takeready
  int    lastShutterCode   = 0;  // newstarttake / starttake
  int    stopCode          = 0;  // newstoptake / stoptake
  int    aspectCode        = 0;  // set_camprop ASPECT_RATIO
  int    modeCode          = 0;  // set_camprop TAKEMODE
  bool   udpListening      = false;

  volatile unsigned long rxPackets      = 0;
  volatile unsigned long rxBytes        = 0;
  volatile unsigned long droppedPackets = 0;
  volatile unsigned long validFrames    = 0;
  volatile unsigned long corruptFrames  = 0;
  volatile size_t        lastFrameBytes = 0;
  volatile uint8_t       lastHdr0       = 0;
  volatile uint8_t       lastHdr1       = 0;
  volatile uint8_t       lastPayloadOff = 0;
  float                  currentFps     = 0.0;
  int                    lastDecodeCode = 0;

  String   airBatteryRaw     = "--";
  String   airBatteryStr     = "--";
  String   expModeStr        = "iAUTO";
  String   expShutterStr     = "--";
  String   expApertureStr    = "--";
  String   expIsoStr         = "--";
  String   targetWideFStr    = "";
  uint32_t minLensF10        = 0;
  int32_t  remainShots       = -1;
  String   remainShotsStr    = "--";
  bool     expWarning        = false;
  uint32_t expWarningRaw     = 0;
  uint8_t  camExifOrient     = 1; // RTP Ext funcId=1 EXIF orientation (1=0, 3=180, 6=90, 8=270)
  bool     hasRtpExt         = false;

  uint32_t freeHeapBytes   = 0;
  uint32_t minFreeHeapBytes= 0;
  uint32_t maxAllocHeap    = 0;
  uint32_t freePsramBytes  = 0;

  String  lastError        = "None";
  uint8_t displayMode      = 0; // 0 = Viewfinder, 1 = Full Diagnostics HUD
} diag;

static String propShutterName  = "SHUTTER";
static String propApertureName = "APERTURE";
static String propIsoName      = "ISO";
static String propModeName     = "TAKEMODE";
static bool   sessionReady     = false;
static bool   loggedExtOnce    = false;

Preferences nvsPrefs;

// Timers
unsigned long lastFrameTimer         = 0;
unsigned long frameCount             = 0;
unsigned long lastHudUpdate          = 0;
unsigned long lastBatteryCheck       = 0;
unsigned long lastStreamResumeMs     = 0;
unsigned long lastExposurePollMs     = 0;
uint8_t       exposurePollStep       = 0;

struct ImgListItem {
  String   fullPath;
  String   name;
  uint32_t sizeBytes;
  uint16_t attr;
  uint16_t fatDate;
  uint16_t fatTime;
  uint32_t sortKey;
  bool     isDir;
  bool     valid;
};

struct HelpLine {
  String   text;
  uint16_t color;
};

struct HelpPage {
  std::vector<HelpLine> lines;
};

struct HelpSectionDef {
  const char* title;
  uint16_t    titleColor;
  const char* bullets[10];
  int         bulletCount;
};

// Forward Declarations (ensures strict C++ compatibility in both Arduino IDE & PlatformIO)
bool ensureUiCanvas();
bool ensureVpCanvas(uint16_t vw, uint16_t vh);
void drawChromeUI();
void updateTopBanner();
void drawGridOverlayOnGfx(LovyanGFX* gfx, int16_t x0, int16_t y0, int16_t w, int16_t h);
void drawAfReticleOnGfx(LovyanGFX* gfx, int16_t cx, int16_t cy, bool active);
void drawSelfTimerOnGfx(LovyanGFX* gfx, int16_t cx, int16_t cy, uint16_t remSec);
void initDiagnosticsScreenLayout();
void updateDiagnosticsScreenData();
void showConnectingSplash(const String& step, const String& detail);
void onRtpPacket(AsyncUDPPacket& packet);
void performOlympusHandshakeCheck();
bool performOlympusHandshake();
void enterDeepSleepInternal(bool powerOffAir);
void shutdownCameraAndM5();
void shutdownM5OnlyKeepAir();
void flushSettingsToStandaloneMode(bool resumeRecAfter);
bool ensureAirConnectedForSession(bool allowSetupOnMiss);
bool runWifiSetupWizard(bool canReturnToSearch);
void updateCameraBatteryStatus(bool backgroundPoll = false);
void discoverBatteryPropEnum();
void discoverCameraAspectTokens();
bool setCameraAspectRatio(uint8_t idx);
void discoverExposurePropNames();
bool applyShootingMode(uint8_t modeIdx);
void discoverCameraPropertiesFromDesclist();
void discoverDrivePropOptions();
bool applyDriveModeToCamera(uint8_t driveIdx, uint8_t seqIdx, String* statusOut = nullptr, bool isSeqSpeedChange = false);
void startContinuousBurst();
void stopContinuousBurst();
void triggerSnapshot();
void discoverAirSoundOptions();
bool applyAirSoundToCamera(uint8_t idx, String* statusOut = nullptr);
void applyFocusPeakingToVpCanvas(int16_t relX, int16_t relY, int16_t ovW, int16_t ovH, uint16_t vw, uint16_t vh, uint16_t srcW, uint16_t srcH);
void drawFocusPeakSubmenuScreen(int selectedIdx, const String& statusBadge = "");
void runFocusPeakSubmenu();
void drawHudSubmenuScreen(int selectedIdx, const String& statusBadge = "");
void runHudSubmenu();
static void appendWrappedHelpLines(std::vector<HelpLine>& out, const String& src, int maxChars, uint16_t col);
static void buildHelpPages(bool port, std::vector<HelpPage>& pages);
void drawHelpScreen(int pageIdx, const std::vector<HelpPage>& pages);
void runHelpScreen();
void drawQuickMenuScreen(int selectedIdx, const String& statusBadge = "");
bool runQuickMenu(bool* wifiSetupRequestedOut = nullptr, bool* btSetupRequestedOut = nullptr);
void drawApListScreen(const std::vector<ScannedApEntry>& aps, int selectedIdx, bool scanningNow, bool canReturnToSearch);
void collectSortedScanResults(std::vector<ScannedApEntry>& outAps, int count);
bool runPasskeyPickerForAp(const ScannedApEntry& ap, String& outPasscode);
void loadBtCredsFromNvs();
void saveBtCredsToNvs(const String& name, const String& mac, uint8_t addrType, uint32_t pin6);
void clearBtCredsInNvs();
bool wakeAirViaBluetoothOnBoot();
bool runBtSetupWizard();
bool runBtPasskeyPicker(const ScannedBtEntry& dev, uint32_t& outPin6);
void performBleScanCollect(std::vector<ScannedBtEntry>& outDevs);
void drawBtListScreen(const std::vector<ScannedBtEntry>& devs, int selectedIdx, bool scanningNow);
void traceAppend(const String& line, bool flushNvs = false);
void saveTraceToNvs();
void loadTraceFromNvs();
void dumpTraceToSerial();
void serviceSerialTraceConsole();
void toggleDualGyroLock();
void inspectOpcCommandList();
void initStickClockOnBoot();
bool getStickLocalTime(struct tm* outTm);
String getClockTimeStr(bool includeSeconds = false);
String getClockDateStr();
void drawClockBadgeOnGfx(LovyanGFX* gfx, int16_t rightX, int16_t y, uint16_t normBg, bool compact = false);
void drawPersistentClockInViewfinder();
void showInvalidClock2015Alert(const String& fileLabel, uint16_t yr, const String& timeStr);
static bool parseImgListLine(const String& line, ImgListItem& out);
static bool queryImgListDir(const String& dirPath, ImgListItem& bestDir, ImgListItem& bestFile);
bool syncClockFromAirImageList(unsigned long stopwatchStartMs);

// ----------------------------------------------------------------------------
// Orientation, Audio, Offscreen M5Canvas & 2-Button Helpers
// ----------------------------------------------------------------------------
inline bool     isPortraitOrientation() { return (currentRotation == 0 || currentRotation == 2); }
inline int16_t  vpX()     { return isPortraitOrientation() ? PORTRAIT_VP_X      : VIEWPORT_X_OFFSET; }
inline int16_t  vpY()     { return isPortraitOrientation() ? PORTRAIT_VP_Y      : VIEWPORT_Y_OFFSET; }
inline uint16_t vpW()     { return isPortraitOrientation() ? PORTRAIT_VP_WIDTH  : VIEWPORT_WIDTH; }
inline uint16_t vpH()     { return isPortraitOrientation() ? PORTRAIT_VP_HEIGHT : VIEWPORT_HEIGHT; }
inline uint16_t bannerH() { return isPortraitOrientation() ? PORTRAIT_BANNER_H  : BANNER_HEIGHT; }

inline bool hudEnabled(uint8_t bit) { return ((hudMask >> bit) & 1U) != 0; }
static uint8_t hudEnabledCount() {
  uint8_t c = 0;
  for (uint8_t i = 0; i < HUD_BIT_COUNT; i++) {
    if (hudEnabled(i)) c++;
  }
  return c;
}

inline void playTone(uint16_t freq, uint32_t durationMs) {
  if (!stickSoundEnabled) return;
  if (M5.Speaker.isEnabled()) {
    M5.Speaker.tone((float)freq, durationMs);
  }
}

String formatAirSoundShort(const String& tok) {
  String u = tok;
  u.trim();
  u.toUpperCase();
  if (u == "MIDDLE" || u == "MEDIUM") return "MID";
  if (u.length() > 4) return u.substring(0, 4);
  return (u.length() > 0) ? u : "--";
}

inline float getM5BatteryVolts() {
  int32_t mv = M5.Power.getBatteryVoltage();
  if (mv <= 0) return 0.0f;
  return (float)mv / 1000.0f;
}

inline int getM5BatteryPercent(float volts) {
  int32_t lvl = M5.Power.getBatteryLevel();
  if (lvl >= 0 && lvl <= 100) return (int)lvl;
  if (volts <= 0.1f) return 0;
  int pct = (int)((volts - 3.30f) * 100.0f / (4.20f - 3.30f) + 0.5f);
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return pct;
}

bool ensureUiCanvas() {
  int16_t w = M5.Display.width();
  int16_t h = M5.Display.height();
  if (uiCanvas.width() == w && uiCanvas.height() == h && uiCanvas.getBuffer() != nullptr) {
    return true;
  }
  uiCanvas.deleteSprite();
  uiCanvas.setColorDepth(16);
  if (!uiCanvas.createSprite(w, h)) {
    uiCanvas.setColorDepth(8);
    if (!uiCanvas.createSprite(w, h)) {
      return false;
    }
  }
  uiCanvas.setTextWrap(false);
  return true;
}

bool ensureVpCanvas(uint16_t vw, uint16_t vh) {
  if (vpCanvas.width() == (int32_t)vw && vpCanvas.height() == (int32_t)vh && vpCanvas.getBuffer() != nullptr) {
    return true;
  }
  vpCanvas.deleteSprite();
  vpCanvas.setColorDepth(16);
  if (!vpCanvas.createSprite(vw, vh)) {
    return false;
  }
  // Match M5.Display endianness when TJpgDec outputs CPU-endian RGB565 pixels (TJpgDec swapBytes=false)
  vpCanvas.setSwapBytes(true);
  vpCanvas.setTextWrap(false);
  vpCanvas.fillSprite(TFT_BLACK);
  return true;
}

// Poll only the 2 reliable hardware buttons (BtnA GPIO 11, BtnB GPIO 12)
inline void pollAllButtons() {
  M5.update();
}

inline void resetGlobalBtnB5xCounter() {
  gRapidBCount = 0;
}

inline bool recordGlobalBtnBClickAndCheck5x() {
  unsigned long now = millis();
  if (now - gRapidBLastMs > BTNB_WIFI_5X_WINDOW_MS) {
    gRapidBCount = 0;
  }
  gRapidBCount++;
  gRapidBLastMs = now;
  if (gRapidBCount >= 5) {
    gRapidBCount = 0;
    return true;
  }
  return false;
}

inline bool checkComboShutdownTriggered() {
  if (M5.BtnA.isPressed() && M5.BtnB.isPressed()) {
    if (abHoldStartMs == 0) abHoldStartMs = millis();
    else if (millis() - abHoldStartMs >= 650) {
      abHoldStartMs = 0;
      return true;
    }
  } else {
    abHoldStartMs = 0;
  }
  return false;
}

bool pollImuAutoRotateIfEnabled() {
  if (stickRotMode == STICK_ROT_LOCK || !imuReady || (millis() - lastImuCheckMs < 45)) return false;
  lastImuCheckMs = millis();

  // M5Unified requires M5.Imu.update() before reading BMI270 data on M5StickS3
  if (!M5.Imu.update()) return false;
  auto imuData = M5.Imu.getImuData();
  float accX = imuData.accel.x;
  float accY = imuData.accel.y;
  float accZ = imuData.accel.z;
  (void)accZ;

  float absX = fabsf(accX);
  float absY = fabsf(accY);
  uint8_t targetRot = currentRotation;

  // M5Unified internally remaps M5StickS3 BMI270 axes to screen-aligned right-handed coordinates:
  //   - Short side = X axis -> Landscape rotations 1 (USB-C right, ax > 0) / 3 (USB-C left, ax < 0)
  //   - Long side  = Y axis -> Portrait rotations 0 (USB-C bottom, ay > 0) / 2 (USB-C top, ay < 0)
  if (stickRotMode == STICK_ROT_LAND_FLIP) {
    if (absX > 0.34f && (absX + 0.08f) >= absY) {
      targetRot = (accX >= 0.0f) ? 1 : 3;
    } else if (currentRotation != 1 && currentRotation != 3) {
      targetRot = 1;
    }
  } else {
    if (absX > absY + 0.14f && absX > 0.38f) {
      targetRot = (accX > 0.0f) ? 1 : 3;
    } else if (absY > absX + 0.14f && absY > 0.42f) {
      targetRot = (accY > 0.0f) ? 0 : 2;
    }
  }

  if (targetRot != currentRotation) {
    if (targetRot == imuPendingRot) {
      imuPendingCount++;
    } else {
      imuPendingRot   = targetRot;
      imuPendingCount = 1;
    }
    if (imuPendingCount >= 2) {
      imuPendingRot   = 255;
      imuPendingCount = 0;
      currentRotation = targetRot;
      M5.Display.setRotation(currentRotation);
      M5.Display.fillScreen(TFT_BLACK);
      lastJpgW = 0;
      lastJpgH = 0;
      if (vpCanvas.getBuffer() != nullptr) {
        vpCanvas.fillSprite(TFT_BLACK);
      }
      Serial.printf("[GYRO] Rotation -> %u (%s) ax=%.2f ay=%.2f az=%.2f\\n",
                    currentRotation, isPortraitOrientation() ? "PORTRAIT" : "LANDSCAPE",
                    accX, accY, accZ);
      return true;
    }
  } else {
    imuPendingRot   = 255;
    imuPendingCount = 0;
  }
  return false;
}

// ----------------------------------------------------------------------------
// NVS Persistence (Camera Settings + Saved Wi-Fi SSID / 8-Digit Key / Channel)
// ----------------------------------------------------------------------------
static const uint8_t NVS_ROT_SCHEMA_VER = 3;

void saveSettingsToNvs() {
  if (nvsPrefs.begin("olympus_vf", false)) {
    nvsPrefs.putUChar("aspect",    currentAspectIdx);
    nvsPrefs.putUChar("mode",      currentShootMode);
    nvsPrefs.putUChar("rot",       currentRotation);
    nvsPrefs.putUChar("rot_v",     NVS_ROT_SCHEMA_VER);
    nvsPrefs.putUChar("rot_mode",  stickRotMode);
    nvsPrefs.putBool("gyro",       (stickRotMode != STICK_ROT_LOCK));
    nvsPrefs.putUChar("bri",       currentBrightnessLevel);
    nvsPrefs.putUChar("grid",      currentGridMode);
    nvsPrefs.putUChar("drive",     currentDriveMode);
    nvsPrefs.putUChar("seq",       currentSeqSpeed);
    nvsPrefs.putBool("snd",        stickSoundEnabled);
    nvsPrefs.putUChar("cam_gmode", camGyroMode);
    nvsPrefs.putBool("cam_gyro",   (camGyroMode == CAM_GYRO_AUTO));
    nvsPrefs.putBool("dual_glock", dualGyroLocked);
    nvsPrefs.putUChar("p_srot",    priorStickRotMode);
    nvsPrefs.putUChar("p_cgmode",  priorCamGyroMode);
    nvsPrefs.putUChar("airsnd",    currentAirSoundIdx);
    nvsPrefs.putBool("airsnd_u",   airSoundUserSet);
    nvsPrefs.putBool("clk_2015",   clockInvalid2015);
    nvsPrefs.putBool("peak_en",    peakEnabled);
    nvsPrefs.putUChar("peak_col",  peakColorIdx);
    nvsPrefs.putUChar("peak_thk",  peakThickness);
    nvsPrefs.putUChar("peak_sns",  peakSensitivity);
    nvsPrefs.putUChar("peak_src",  peakSource);
    nvsPrefs.putUChar("btna_mode", btnAMode);
    nvsPrefs.putUChar("wake_key",  wakeKeyMode);
    nvsPrefs.putUShort("hud_mask", hudMask);
    if (currentAirSoundIdx < airSoundCount) {
      savedAirSoundToken = airSoundTokens[currentAirSoundIdx];
      nvsPrefs.putString("airsnd_tok", savedAirSoundToken);
    }
    nvsPrefs.end();
  }
}

void loadSettingsFromNvs() {
  if (nvsPrefs.begin("olympus_vf", true)) {
    uint8_t savedAspect   = nvsPrefs.getUChar("aspect", currentAspectIdx);
    uint8_t savedMode     = nvsPrefs.getUChar("mode",   currentShootMode);
    uint8_t savedRotVer   = nvsPrefs.getUChar("rot_v",  0);
    uint8_t savedRot      = nvsPrefs.getUChar("rot",    currentRotation);
    uint8_t savedRotMode  = nvsPrefs.getUChar("rot_mode", 255);
    bool    savedGyro     = nvsPrefs.getBool("gyro",    false);
    uint8_t savedBri      = nvsPrefs.getUChar("bri",    currentBrightnessLevel);
    uint8_t savedGrid     = nvsPrefs.getUChar("grid",   currentGridMode);
    uint8_t savedDrive    = nvsPrefs.getUChar("drive",  currentDriveMode);
    uint8_t savedSeq      = nvsPrefs.getUChar("seq",    currentSeqSpeed);
    bool    savedSnd      = nvsPrefs.getBool("snd",     stickSoundEnabled);
    uint8_t savedCamGMode = nvsPrefs.getUChar("cam_gmode", 255);
    bool    savedCamGyro  = nvsPrefs.getBool("cam_gyro", true);
    bool    savedDualLock = nvsPrefs.getBool("dual_glock", false);
    uint8_t savedPSRot    = nvsPrefs.getUChar("p_srot",    STICK_ROT_GYRO);
    uint8_t savedPCGMode  = nvsPrefs.getUChar("p_cgmode",  CAM_GYRO_AUTO);
    uint8_t savedAirSnd   = nvsPrefs.getUChar("airsnd", currentAirSoundIdx);
    bool    savedAirSndU  = nvsPrefs.getBool("airsnd_u", false);
    savedAirSoundToken    = nvsPrefs.getString("airsnd_tok", "");
    clockInvalid2015      = nvsPrefs.getBool("clk_2015", false);
    bool    savedPeakEn   = nvsPrefs.getBool("peak_en", false);
    uint8_t savedPeakCol  = nvsPrefs.getUChar("peak_col", PEAK_COL_RED);
    uint8_t savedPeakThk  = nvsPrefs.getUChar("peak_thk", PEAK_THICK_1PX);
    uint8_t savedPeakSns  = nvsPrefs.getUChar("peak_sns", PEAK_SENS_MID);
    uint8_t savedPeakSrc  = nvsPrefs.getUChar("peak_src", PEAK_SRC_320);
    uint8_t savedBtnAMode = nvsPrefs.getUChar("btna_mode", BTNA_SHUTTER);
    uint8_t savedWakeKey  = nvsPrefs.getUChar("wake_key", WAKE_BTN_B);
    uint16_t savedHudMask = nvsPrefs.getUShort("hud_mask", HUD_ALL_MASK);
    nvsPrefs.end();

    if (savedAspect < ASPECT_COUNT) currentAspectIdx = savedAspect;
    if (savedMode   < SHOOT_COUNT)  currentShootMode = savedMode;
    if (savedRotVer == NVS_ROT_SCHEMA_VER && savedRot <= 3) {
      currentRotation = savedRot;
    } else {
      currentRotation = LCD_ROTATION;
    }
    if (savedRotMode < STICK_ROT_COUNT) {
      stickRotMode = savedRotMode;
    } else {
      stickRotMode = savedGyro ? STICK_ROT_GYRO : STICK_ROT_LOCK;
    }
    if (savedCamGMode < CAM_GYRO_COUNT) {
      camGyroMode = savedCamGMode;
    } else {
      camGyroMode = savedCamGyro ? CAM_GYRO_AUTO : CAM_GYRO_LOCK;
    }
    dualGyroLocked    = savedDualLock;
    priorStickRotMode = (savedPSRot < STICK_ROT_COUNT) ? savedPSRot : STICK_ROT_GYRO;
    priorCamGyroMode  = (savedPCGMode < CAM_GYRO_COUNT) ? savedPCGMode : CAM_GYRO_AUTO;
    if (dualGyroLocked) {
      stickRotMode = STICK_ROT_LOCK;
      camGyroMode  = CAM_GYRO_LOCK;
    }
    camActiveOrient = (camGyroMode == CAM_GYRO_FLIP180) ? 3 : 1;

    if (savedBri   < 3)           currentBrightnessLevel = savedBri;
    if (savedGrid  < GRID_COUNT)  currentGridMode        = savedGrid;
    if (savedDrive < DRIVE_COUNT) currentDriveMode       = savedDrive;
    if (savedSeq   < SEQ_COUNT)   currentSeqSpeed        = savedSeq;
    stickSoundEnabled = savedSnd;
    airSoundUserSet   = savedAirSndU;
    if (savedAirSnd < airSoundCount) currentAirSoundIdx = savedAirSnd;

    peakEnabled     = savedPeakEn;
    peakColorIdx    = (savedPeakCol < PEAK_COL_COUNT) ? savedPeakCol : PEAK_COL_RED;
    peakThickness   = (savedPeakThk < PEAK_THICK_COUNT) ? savedPeakThk : PEAK_THICK_1PX;
    peakSensitivity = (savedPeakSns < PEAK_SENS_COUNT) ? savedPeakSns : PEAK_SENS_MID;
    peakSource      = (savedPeakSrc < PEAK_SRC_COUNT) ? savedPeakSrc : PEAK_SRC_320;
    btnAMode        = (savedBtnAMode < BTNA_COUNT) ? savedBtnAMode : BTNA_SHUTTER;
    wakeKeyMode     = (savedWakeKey < WAKE_COUNT) ? savedWakeKey : WAKE_BTN_B;
    hudMask         = (savedHudMask & HUD_ALL_MASK);

    if (currentShootMode == SHOOT_A_WIDE)      diag.expModeStr = "A:MAX";
    else if (currentShootMode == SHOOT_S_60)   diag.expModeStr = "S:1/60";
    else                                       diag.expModeStr = "iAUTO";
  }
}

// ----------------------------------------------------------------------------
// Persistent NVS Trace Buffer (Captures BLE GATT / OPC / RTP across reboots)
// ----------------------------------------------------------------------------
void saveTraceToNvs() {
  if (nvsPrefs.begin("olympus_trace", false)) {
    String toStore = gTraceRamBuf;
    if (toStore.length() > 3600) {
      toStore = toStore.substring(toStore.length() - 3600);
      int nl = toStore.indexOf('\\n');
      if (nl > 0 && nl < 200) toStore = toStore.substring(nl + 1);
    }
    nvsPrefs.putString("log", toStore);
    nvsPrefs.end();
  }
}

void loadTraceFromNvs() {
  if (nvsPrefs.begin("olympus_trace", true)) {
    gTraceRamBuf = nvsPrefs.getString("log", "");
    nvsPrefs.end();
  }
}

void traceAppend(const String& line, bool flushNvs) {
  Serial.println(line);
  gTraceRamBuf += line;
  gTraceRamBuf += "\\n";
  if (gTraceRamBuf.length() > 3600) {
    gTraceRamBuf = gTraceRamBuf.substring(gTraceRamBuf.length() - 3300);
    int nl = gTraceRamBuf.indexOf('\\n');
    if (nl > 0 && nl < 200) gTraceRamBuf = gTraceRamBuf.substring(nl + 1);
  }
  if (flushNvs) {
    saveTraceToNvs();
  }
}

void appendBleAsyncTrace(const String& line) {
  portENTER_CRITICAL(&bleTraceMux);
  if (gBleAsyncTraceBuf.length() < 2000) {
    gBleAsyncTraceBuf += line;
    gBleAsyncTraceBuf += "\\n";
  }
  portEXIT_CRITICAL(&bleTraceMux);
}

void flushBleAsyncTrace(bool flushNvs) {
  String chunk;
  portENTER_CRITICAL(&bleTraceMux);
  chunk = gBleAsyncTraceBuf;
  gBleAsyncTraceBuf = "";
  portEXIT_CRITICAL(&bleTraceMux);
  if (chunk.length() > 0) {
    int start = 0;
    while (start < (int)chunk.length()) {
      int nl = chunk.indexOf('\\n', start);
      String ln = (nl == -1) ? chunk.substring(start) : chunk.substring(start, nl);
      if (ln.length() > 0) traceAppend(ln, false);
      if (nl == -1) break;
      start = nl + 1;
    }
    if (flushNvs) saveTraceToNvs();
  } else if (flushNvs) {
    saveTraceToNvs();
  }
}

String formatBytesHexAscii(const uint8_t* buf, size_t len, size_t maxBytes = 24) {
  if (!buf || len == 0) return "<empty>";
  size_t show = (len < maxBytes) ? len : maxBytes;
  String h = "";
  String a = "";
  char tmp[4];
  for (size_t i = 0; i < show; i++) {
    snprintf(tmp, sizeof(tmp), "%02X", buf[i]);
    if (i > 0) h += ' ';
    h += tmp;
    char ch = (buf[i] >= 32 && buf[i] <= 126) ? (char)buf[i] : '.';
    a += ch;
  }
  if (len > maxBytes) h += "...";
  return h + " | '" + a + "'";
}

void dumpTraceToSerial() {
  flushBleAsyncTrace(false);
  Serial.println();
  Serial.println("[TRACE-BEGIN]");
  Serial.printf("[SYS] DualLock=%d StickRot=%s(prior=%s) CamGyro=%s(prior=%s) CamO=%u BT=%s Wake=%d Peak=%s(%s/%s/%s/%s) BtnA=%s SleepWake=%s\\n",
                dualGyroLocked ? 1 : 0,
                STICK_ROT_NAMES[stickRotMode], STICK_ROT_NAMES[priorStickRotMode],
                CAM_GYRO_NAMES[camGyroMode], CAM_GYRO_NAMES[priorCamGyroMode],
                (unsigned)camActiveOrient,
                hasPairedBt ? savedBtMac.c_str() : "NONE",
                btWakeOnBoot ? 1 : 0,
                peakEnabled ? "ON" : "OFF",
                PEAK_COLOR_NAMES[peakColorIdx], PEAK_THICK_NAMES[peakThickness],
                PEAK_SENS_NAMES[peakSensitivity], PEAK_SOURCE_NAMES[peakSource],
                BTNA_MODE_NAMES[btnAMode], WAKE_KEY_NAMES[wakeKeyMode]);
  if (gTraceRamBuf.length() == 0) {
    Serial.println("[TRACE] (No buffered BLE/OPC/RTP events yet — run Live View or BT Setup first)");
  } else {
    Serial.print(gTraceRamBuf);
    if (!gTraceRamBuf.endsWith("\\n")) Serial.println();
  }
  Serial.println("[TRACE-END]");
}

void serviceSerialTraceConsole() {
  bool serNow = (bool)Serial;
  if (serNow && !prevUsbSerialOpen) {
    prevUsbSerialOpen = true;
    if (!traceAutoDumpedHost && gTraceRamBuf.length() > 0) {
      traceAutoDumpedHost = true;
      delay(120);
      dumpTraceToSerial();
    }
  } else if (!serNow && prevUsbSerialOpen) {
    prevUsbSerialOpen = false;
  }

  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\\n' || c == '\\r') {
      serialCmdRxBuf.trim();
      serialCmdRxBuf.toUpperCase();
      if (serialCmdRxBuf.length() == 0 || serialCmdRxBuf == "TRACE" || serialCmdRxBuf == "DUMP") {
        dumpTraceToSerial();
      } else if (serialCmdRxBuf == "CLEAR") {
        gTraceRamBuf = "";
        saveTraceToNvs();
        Serial.println("[TRACE] Cleared NVS trace log.");
      }
      serialCmdRxBuf = "";
    } else if (serialCmdRxBuf.length() < 24) {
      serialCmdRxBuf += c;
    }
  }
}

void loadBtCredsFromNvs() {
  if (nvsPrefs.begin("olympus_bt", true)) {
    btWakeOnBoot    = nvsPrefs.getBool("bt_wake", false);
    savedBtName     = nvsPrefs.getString("bt_name", "");
    savedBtMac      = nvsPrefs.getString("bt_mac", "");
    savedBtAddrType = nvsPrefs.getUChar("bt_atype", 0);
    savedBtPin      = nvsPrefs.getULong("bt_pin", 0);
    nvsPrefs.end();
  }
  hasPairedBt = (savedBtMac.length() > 0);
  Serial.printf("[BT-NVS] wake=%d paired=%s (%s) pin=%06lu\\n",
                btWakeOnBoot ? 1 : 0,
                hasPairedBt ? savedBtName.c_str() : "<NONE>",
                savedBtMac.c_str(),
                (unsigned long)savedBtPin);
}

void saveBtCredsToNvs(const String& name, const String& mac, uint8_t addrType, uint32_t pin6) {
  savedBtName     = name;
  savedBtMac      = mac;
  savedBtAddrType = addrType;
  savedBtPin      = pin6 % 1000000UL;
  hasPairedBt     = (mac.length() > 0);
  if (nvsPrefs.begin("olympus_bt", false)) {
    nvsPrefs.putBool("bt_wake", btWakeOnBoot);
    nvsPrefs.putString("bt_name", savedBtName);
    nvsPrefs.putString("bt_mac", savedBtMac);
    nvsPrefs.putUChar("bt_atype", savedBtAddrType);
    nvsPrefs.putULong("bt_pin", savedBtPin);
    nvsPrefs.end();
  }
  Serial.printf("[BT-NVS] Saved BT '%s' [%s] wake=%d\\n", savedBtName.c_str(), savedBtMac.c_str(), btWakeOnBoot ? 1 : 0);
}

void clearBtCredsInNvs() {
  savedBtName     = "";
  savedBtMac      = "";
  savedBtAddrType = 0;
  savedBtPin      = 0;
  hasPairedBt     = false;
  btWakeOnBoot    = false;
  if (nvsPrefs.begin("olympus_bt", false)) {
    nvsPrefs.putBool("bt_wake", false);
    nvsPrefs.putString("bt_name", "");
    nvsPrefs.putString("bt_mac", "");
    nvsPrefs.putUChar("bt_atype", 0);
    nvsPrefs.putULong("bt_pin", 0);
    nvsPrefs.end();
  }
}

void loadWifiCredsFromNvs() {
  if (nvsPrefs.begin("olympus_wifi", true)) {
    savedWifiSsid    = nvsPrefs.getString("ssid", "");
    savedWifiPass    = nvsPrefs.getString("pass", "");
    savedWifiChannel = nvsPrefs.getUChar("ch", 0);
    nvsPrefs.end();
  }
  hasSavedWifiCreds  = (savedWifiSsid.length() > 0);
  sessionChannelHint = savedWifiChannel;
  Serial.printf("[WIFI-NVS] Loaded saved='%s' ch=%u (configured=%d)\\n",
                hasSavedWifiCreds ? savedWifiSsid.c_str() : "<NONE>",
                (unsigned)savedWifiChannel, hasSavedWifiCreds ? 1 : 0);
}

void saveWifiCredsToNvs(const String& ssid, const String& pass, uint8_t ch) {
  savedWifiSsid      = ssid;
  savedWifiPass      = pass;
  savedWifiChannel   = ch;
  sessionChannelHint = ch;
  hasSavedWifiCreds  = (ssid.length() > 0);
  if (nvsPrefs.begin("olympus_wifi", false)) {
    nvsPrefs.putString("ssid", ssid);
    nvsPrefs.putString("pass", pass);
    nvsPrefs.putUChar("ch", ch);
    nvsPrefs.end();
  }
  Serial.printf("[WIFI-NVS] Saved SSID='%s' ch=%u\\n", ssid.c_str(), (unsigned)ch);
}

void processPendingChannelNvsUpdates() {
  if (pendingChannelClear) {
    pendingChannelClear = false;
    sessionChannelHint  = 0;
    if (savedWifiChannel != 0) {
      savedWifiChannel = 0;
      if (nvsPrefs.begin("olympus_wifi", false)) {
        nvsPrefs.putUChar("ch", 0);
        nvsPrefs.end();
      }
      Serial.println("[WIFI] Cleared stale channel cache after NO_AP_FOUND");
    }
  }
  if (pendingChannelSave) {
    pendingChannelSave = false;
    uint8_t ch = pendingChannelVal;
    if (ch > 0 && ch != savedWifiChannel) {
      savedWifiChannel   = ch;
      sessionChannelHint = ch;
      if (nvsPrefs.begin("olympus_wifi", false)) {
        nvsPrefs.putUChar("ch", ch);
        nvsPrefs.end();
      }
      Serial.printf("[WIFI] Cached active channel %u to NVS\\n", (unsigned)ch);
    }
  }
}

// ----------------------------------------------------------------------------
// Static IP + Wi-Fi Event Hooks (airview speedups)
// ----------------------------------------------------------------------------
void applyAirStaticIp() {
  IPAddress gw;
  if (!gw.fromString(CAMERA_IP)) {
    gw = IPAddress(192, 168, 0, 10);
  }
  IPAddress localIp(gw[0], gw[1], gw[2], (gw[3] == 100) ? 101 : 100);
  IPAddress subnet(255, 255, 255, 0);
  if (!WiFi.config(localIp, gw, subnet)) {
    Serial.println("[WIFI] WiFi.config static IP warning");
  }
}

void onWiFiStationEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
    uint8_t ch = (uint8_t)WiFi.channel();
    if (ch > 0) {
      pendingChannelVal  = ch;
      pendingChannelSave = true;
    }
  } else if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
    lastDisconnectReason = info.wifi_sta_disconnected.reason;
    if (lastDisconnectReason == 201 /* WIFI_REASON_NO_AP_FOUND */) {
      pendingChannelClear = true;
    }
  }
}

void initWifiFastDriver() {
  if (!wifiEventsRegistered) {
    WiFi.onEvent(onWiFiStationEvent);
    wifiEventsRegistered = true;
  }
  WiFi.persistent(false);
  WiFi.setAutoReconnect(false);
  WiFi.mode(WIFI_STA);
  // Keep radio continuously awake (WIFI_PS_NONE) so high-rate UDP video never stalls
  WiFi.setSleep(false);
}

// ----------------------------------------------------------------------------
// Helper: Reset RTP Reassembly State Cleanly
// ----------------------------------------------------------------------------
void resetRtpAssembler() {
  portENTER_CRITICAL(&frameMux);
  readySlot         = -1;
  readyLen          = 0;
  readyExtLen       = 0;
  lastRtpSequence   = -1;
  writeLen          = 0;
  writeExtLen       = 0;
  frameInProgress   = false;
  currentFrameValid = true;
  portEXIT_CRITICAL(&frameMux);
}

// ----------------------------------------------------------------------------
// HTTP Client Helpers with 50ms Gap Protection, X-Protocol & 520 Retry
// ----------------------------------------------------------------------------
void enforceHttpGap(bool urgent) {
  if (!urgent && lastHttpDoneUs > 0) {
    int64_t elapsedUs = esp_timer_get_time() - lastHttpDoneUs;
    int64_t minGapUs  = (int64_t)HTTP_MIN_GAP_MS * 1000LL;
    if (elapsedUs < minGapUs) {
      uint32_t waitMs = (uint32_t)((minGapUs - elapsedUs + 999LL) / 1000LL);
      delay(waitMs);
    }
  }
}

int opcHttpGet(const char* url, String& responseOut, uint32_t timeoutMs = 4000, bool urgent = false, uint32_t connectTimeoutMs = 2500) {
  enforceHttpGap(urgent);
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(connectTimeoutMs);
  http.setTimeout(timeoutMs); // HTTPClient::setTimeout takes MILLISECONDS!
  if (!http.begin(url)) {
    lastHttpDoneUs = esp_timer_get_time();
    return -100;
  }
  http.setUserAgent(OPC_USER_AGENT);
  http.addHeader("X-Protocol", OPC_USER_AGENT);
  http.addHeader("Connection", "close");

  int code = http.GET();
  if (code > 0) {
    responseOut = http.getString();
  } else {
    responseOut = http.errorToString(code);
  }
  http.end();
  lastHttpDoneUs = esp_timer_get_time();
  return code;
}

int opcHttpGetWith520Retry(const char* url, String& responseOut, uint32_t timeoutMs = 4000, uint32_t connectTimeoutMs = 2500) {
  int code = opcHttpGet(url, responseOut, timeoutMs, false, connectTimeoutMs);
  if (code == 520) {
    Serial.printf("[HTTP] 520 mid-transition on %s -> waiting 200ms and retrying...\\n", url);
    delay(200);
    code = opcHttpGet(url, responseOut, timeoutMs, false, connectTimeoutMs);
  }
  return code;
}

int opcHttpPostXml(const char* url, const String& xmlBody, String& responseOut, uint32_t timeoutMs = 3000) {
  enforceHttpGap(false);
  HTTPClient http;
  http.setReuse(false);
  http.setConnectTimeout(2500);
  http.setTimeout(timeoutMs);
  if (!http.begin(url)) {
    lastHttpDoneUs = esp_timer_get_time();
    return -100;
  }
  http.setUserAgent(OPC_USER_AGENT);
  http.addHeader("X-Protocol", OPC_USER_AGENT);
  http.addHeader("Content-Type", "text/xml; charset=utf-8");
  http.addHeader("Connection", "close");

  int code = http.POST(xmlBody);
  if (code > 0) {
    responseOut = http.getString();
  } else {
    responseOut = http.errorToString(code);
  }
  http.end();
  lastHttpDoneUs = esp_timer_get_time();
  if (code == 520) {
    delay(200);
    enforceHttpGap(false);
    HTTPClient http2;
    http2.setReuse(false);
    http2.setConnectTimeout(2500);
    http2.setTimeout(timeoutMs);
    if (http2.begin(url)) {
      http2.setUserAgent(OPC_USER_AGENT);
      http2.addHeader("X-Protocol", OPC_USER_AGENT);
      http2.addHeader("Content-Type", "text/xml; charset=utf-8");
      http2.addHeader("Connection", "close");
      code = http2.POST(xmlBody);
      responseOut = (code > 0) ? http2.getString() : http2.errorToString(code);
      http2.end();
      lastHttpDoneUs = esp_timer_get_time();
    }
  }
  return code;
}

// ----------------------------------------------------------------------------
// Olympus Air A01 Camera Aspect Ratio Control (OPC ASPECT_RATIO, 6:6 = 1:1)
// ----------------------------------------------------------------------------
void discoverCameraAspectTokens() {
  if (WiFi.status() != WL_CONNECTED) return;

  String resp;
  int code = opcHttpGetWith520Retry(URL_ASPECT_DESC, resp, 3000);
  Serial.printf("[ASPECT] desc -> HTTP %d: %s\\n", code, resp.substring(0, 220).c_str());
  if (code != 200) return;

  if (resp.indexOf("04_03") != -1 || resp.indexOf("16_09") != -1 || resp.indexOf("03_02") != -1) {
    cameraAspectTokens[ASPECT_4_3]  = "04_03";
    cameraAspectTokens[ASPECT_3_2]  = "03_02";
    cameraAspectTokens[ASPECT_16_9] = "16_09";
    if (resp.indexOf("01_01") != -1) cameraAspectTokens[ASPECT_1_1] = "01_01";
    else cameraAspectTokens[ASPECT_1_1] = "06_06";
  } else if (resp.indexOf("4_3") != -1 || resp.indexOf("16_9") != -1 || resp.indexOf("3_2") != -1) {
    cameraAspectTokens[ASPECT_4_3]  = "4_3";
    cameraAspectTokens[ASPECT_3_2]  = "3_2";
    cameraAspectTokens[ASPECT_16_9] = "16_9";
    if (resp.indexOf("1_1") != -1) cameraAspectTokens[ASPECT_1_1] = "1_1";
    else cameraAspectTokens[ASPECT_1_1] = "6_6";
  } else {
    cameraAspectTokens[ASPECT_4_3]  = "4:3";
    cameraAspectTokens[ASPECT_3_2]  = "3:2";
    cameraAspectTokens[ASPECT_16_9] = "16:9";
    if (resp.indexOf("1:1") != -1) cameraAspectTokens[ASPECT_1_1] = "1:1";
    else cameraAspectTokens[ASPECT_1_1] = "6:6";
  }
}

bool setCameraAspectRatio(uint8_t idx) {
  if (idx >= ASPECT_COUNT || WiFi.status() != WL_CONNECTED) return false;

  const char* candidates[6] = {
    cameraAspectTokens[idx].c_str(),
    cameraAspectAltTokens[idx],
    nullptr, nullptr, nullptr, nullptr
  };
  uint8_t candidateCount = 2;

  if (idx == ASPECT_1_1) {
    static const char* squareFallbacks[] = { "6:6", "06_06", "6_6", "1:1", "01_01", "1_1" };
    for (uint8_t j = 0; j < 6 && candidateCount < 6; j++) {
      bool dup = false;
      for (uint8_t k = 0; k < candidateCount; k++) {
        if (strcmp(candidates[k], squareFallbacks[j]) == 0) { dup = true; break; }
      }
      if (!dup) candidates[candidateCount++] = squareFallbacks[j];
    }
  }

  int code = 0;
  String resp;
  for (uint8_t i = 0; i < candidateCount; i++) {
    if (!candidates[i] || candidates[i][0] == '\\0') continue;
    String xml = String("<?xml version=\\"1.0\\"?><set><value>") + candidates[i] + "</value></set>";
    code = opcHttpPostXml(URL_ASPECT_SET, xml, resp, 2500);
    Serial.printf("[ASPECT] set %s -> HTTP %d: %s\\n", candidates[i], code, resp.substring(0, 80).c_str());
    if (code == 200) {
      cameraAspectTokens[idx] = candidates[i];
      break;
    }
  }

  diag.aspectCode = code;
  return (code == 200);
}

// ----------------------------------------------------------------------------
// Screen Backlight Management (M5GFX PWM on GPIO 38)
// ----------------------------------------------------------------------------
void applyScreenBrightness(uint8_t level) {
  uint8_t val = 255;
  uint8_t pct = 100;
  if (level == 1) { val = 153; pct = 60; }
  else if (level == 2) { val = 76; pct = 30; }

  M5.Display.setBrightness(val);
  Serial.printf("[POWER] Backlight set to %d%% (%u/255)\\n", pct, val);
}

void setMaxScreenBrightness() {
  currentBrightnessLevel = 0;
  applyScreenBrightness(0);
}

inline uint8_t rgb565ToLuma8(uint16_t c) {
  uint32_t r8 = (c >> 8) & 0xF8;
  uint32_t g8 = (c >> 3) & 0xFC;
  uint32_t b8 = (c << 3) & 0xF8;
  return (uint8_t)((r8 + (g8 << 1) + b8) >> 2);
}

// ----------------------------------------------------------------------------
// TJpg_Decoder Output Callback (Writes to Offscreen vpCanvas + Luma Buffer)
// ----------------------------------------------------------------------------
bool tft_output(int16_t x, int16_t y, uint16_t w, uint16_t h, uint16_t* bitmap) {
  if (x >= (int16_t)dynamicDecW || y >= (int16_t)dynamicDecH || w == 0 || h == 0) return true;

  // Capture full-res 8-bit luma BEFORE block clipping when 320x240 Focus Peaking is active
  if (peak320ActiveForFrame && peakLuma320 != nullptr && activeSrcJpgW <= 320 && activeSrcJpgH <= 240) {
    int32_t maxPx = (int32_t)activeSrcJpgW;
    int32_t maxPy = (int32_t)activeSrcJpgH;
    for (uint16_t row = 0; row < h; row++) {
      int32_t py = (int32_t)y + (int32_t)row;
      if (py < 0 || py >= maxPy) continue;
      const uint16_t* srcRow = &bitmap[row * w];
      uint8_t* lumaRow = &peakLuma320[py * maxPx];
      for (uint16_t col = 0; col < w; col++) {
        int32_t px = (int32_t)x + (int32_t)col;
        if (px < 0 || px >= maxPx) continue;
        lumaRow[px] = rgb565ToLuma8(srcRow[col]);
      }
    }
  }

  LovyanGFX* dstGfx = vpCanvasActive ? static_cast<LovyanGFX*>(&vpCanvas) : static_cast<LovyanGFX*>(&M5.Display);
  int16_t baseOffX  = vpCanvasActive ? (dynamicDrawX - vpX()) : dynamicDrawX;
  int16_t baseOffY  = vpCanvasActive ? (dynamicDrawY - vpY()) : dynamicDrawY;

  if (dynamicDecW == dynamicMaxW && dynamicDecH == dynamicMaxH) {
    uint16_t origW = w;
    if (x + (int16_t)w > (int16_t)dynamicMaxW) {
      w = dynamicMaxW - x;
      for (uint16_t row = 1; row < h; row++) {
        memmove(&bitmap[row * w], &bitmap[row * origW], w * sizeof(uint16_t));
      }
    }
    if (y + (int16_t)h > (int16_t)dynamicMaxH) {
      h = dynamicMaxH - y;
    }
    if (w == 0 || h == 0) return true;

    if (!peak320ActiveForFrame && peakEnabled && peakLuma160 != nullptr &&
        dynamicMaxW <= 160 && dynamicMaxH <= 120) {
      for (uint16_t row = 0; row < h; row++) {
        const uint16_t* srcRow = &bitmap[row * w];
        uint8_t* lumaRow = &peakLuma160[((int32_t)y + row) * (int32_t)dynamicMaxW + x];
        for (uint16_t col = 0; col < w; col++) {
          lumaRow[col] = rgb565ToLuma8(srcRow[col]);
        }
      }
    }

    int16_t drawX = x + baseOffX;
    int16_t drawY = y + baseOffY;
    if (drawX >= dstGfx->width() || drawY >= dstGfx->height()) return true;
    dstGfx->pushImage(drawX, drawY, w, h, bitmap);
    return true;
  }

  int32_t decW = (int32_t)dynamicDecW;
  int32_t decH = (int32_t)dynamicDecH;
  int32_t dstW = (int32_t)dynamicMaxW;
  int32_t dstH = (int32_t)dynamicMaxH;

  int32_t dxStart = ((int32_t)x * dstW + decW - 1) / decW;
  int32_t dxEnd   = (((int32_t)x + (int32_t)w) * dstW + decW - 1) / decW;
  int32_t dyStart = ((int32_t)y * dstH + decH - 1) / decH;
  int32_t dyEnd   = (((int32_t)y + (int32_t)h) * dstH + decH - 1) / decH;

  if (dxStart < 0) dxStart = 0;
  if (dyStart < 0) dyStart = 0;
  if (dxEnd > dstW) dxEnd = dstW;
  if (dyEnd > dstH) dyEnd = dstH;

  int32_t outW = dxEnd - dxStart;
  int32_t outH = dyEnd - dyStart;
  if (outW <= 0 || outH <= 0) return true;

  static uint16_t scaledBuf[32 * 32];
  static int16_t  sxLut[32];
  for (int32_t tx = 0; tx < outW; tx += 32) {
    int32_t chunkW = (outW - tx > 32) ? 32 : (outW - tx);
    uint32_t sxFp = (uint32_t)(dxStart + tx) * scaleStepX;
    for (int32_t col = 0; col < chunkW; col++) {
      int32_t sx = (int32_t)(sxFp >> 16) - x;
      if (sx < 0) sx = 0;
      if (sx >= (int32_t)w) sx = (int32_t)w - 1;
      sxLut[col] = (int16_t)sx;
      sxFp += scaleStepX;
    }
    for (int32_t ty = 0; ty < outH; ty += 32) {
      int32_t chunkH = (outH - ty > 32) ? 32 : (outH - ty);
      uint32_t syFp = (uint32_t)(dyStart + ty) * scaleStepY;
      for (int32_t row = 0; row < chunkH; row++) {
        int32_t sy = (int32_t)(syFp >> 16) - y;
        if (sy < 0) sy = 0;
        if (sy >= (int32_t)h) sy = (int32_t)h - 1;
        syFp += scaleStepY;
        const uint16_t* srcRow = &bitmap[sy * w];
        uint16_t* dstRow = &scaledBuf[row * chunkW];
        for (int32_t col = 0; col < chunkW; col++) {
          dstRow[col] = srcRow[sxLut[col]];
        }
        if (!peak320ActiveForFrame && peakEnabled && peakLuma160 != nullptr &&
            dstW <= 160 && dstH <= 120) {
          uint8_t* lumaRow = &peakLuma160[(dyStart + ty + row) * dstW + (dxStart + tx)];
          for (int32_t col = 0; col < chunkW; col++) {
            lumaRow[col] = rgb565ToLuma8(dstRow[col]);
          }
        }
      }
      dstGfx->pushImage(baseOffX + dxStart + tx, baseOffY + dyStart + ty, chunkW, chunkH, scaledBuf);
    }
  }
  return true;
}

// ----------------------------------------------------------------------------
// Viewport Frame & AF Reticle (Composited inside vpCanvas when active -> zero black-bar artifacts)
// ----------------------------------------------------------------------------
void drawOuterViewportFrame(bool warnActive) {
  int16_t vx = vpX();
  int16_t vy = vpY();
  uint16_t vw = vpW();
  uint16_t vh = vpH();
  uint16_t col = warnActive ? TFT_RED : M5.Display.color565(30, 41, 59);
  M5.Display.drawRect(vx - 1, vy - 1, vw + 2, vh + 2, col);
}

void drawActiveImageFrameOnGfx(LovyanGFX* gfx, int16_t x0, int16_t y0, int16_t w, int16_t h, bool warnActive) {
  if (w < 4 || h < 4) return;
  uint16_t col = warnActive ? TFT_RED : M5.Display.color565(71, 85, 105);
  int16_t bx = (x0 > 0) ? (x0 - 1) : 0;
  int16_t by = (y0 > 0) ? (y0 - 1) : 0;
  int16_t bw = (bx + w + 2 <= gfx->width())  ? (w + 2) : (gfx->width() - bx);
  int16_t bh = (by + h + 2 <= gfx->height()) ? (h + 2) : (gfx->height() - by);
  gfx->drawRect(bx, by, bw, bh, col);
  if (warnActive) {
    gfx->drawRect(x0, y0, w, h, TFT_RED);
  }
}

void drawAspectRatioMask() {
  drawOuterViewportFrame(false);
  if (!vpCanvasActive) {
    drawActiveImageFrameOnGfx(&M5.Display, dynamicDrawX, dynamicDrawY, (int16_t)dynamicMaxW, (int16_t)dynamicMaxH, false);
  }
}

void drawExposureWarningBox(bool active) {
  drawOuterViewportFrame(active);
  if (!vpCanvasActive) {
    drawActiveImageFrameOnGfx(&M5.Display, dynamicDrawX, dynamicDrawY, (int16_t)dynamicMaxW, (int16_t)dynamicMaxH, active);
  }
}

void drawAfReticleOnGfx(LovyanGFX* gfx, int16_t cx, int16_t cy, bool active) {
  int r  = 10;
  uint16_t color = active ? TFT_GREEN : TFT_DARKGREY;

  if (active) {
    gfx->drawRect(cx - r, cy - r, r * 2 + 1, r * 2 + 1, TFT_GREEN);
    gfx->drawRect(cx - r + 1, cy - r + 1, r * 2 - 1, r * 2 - 1, TFT_GREEN);
  } else {
    gfx->drawLine(cx - r, cy - r, cx - r + 4, cy - r, color);
    gfx->drawLine(cx - r, cy - r, cx - r, cy - r + 4, color);
    gfx->drawLine(cx + r, cy - r, cx + r - 4, cy - r, color);
    gfx->drawLine(cx + r, cy - r, cx + r, cy - r + 4, color);
    gfx->drawLine(cx - r, cy + r, cx - r + 4, cy + r, color);
    gfx->drawLine(cx - r, cy + r, cx - r, cy + r - 4, color);
    gfx->drawLine(cx + r, cy + r, cx + r - 4, cy + r, color);
    gfx->drawLine(cx + r, cy + r, cx + r, cy + r - 4, color);
  }
  gfx->drawPixel(cx, cy, color);
}

void drawAfReticle(bool active) {
  int16_t cx = dynamicDrawX + (int16_t)(dynamicMaxW / 2);
  int16_t cy = dynamicDrawY + (int16_t)(dynamicMaxH / 2);
  drawAfReticleOnGfx(&M5.Display, cx, cy, active);
}

void drawGridOverlayOnGfx(LovyanGFX* gfx, int16_t x0, int16_t y0, int16_t w, int16_t h) {
  if (currentGridMode == GRID_OFF || w < 16 || h < 16) return;
  uint16_t col = M5.Display.color565(185, 200, 220);

  if (currentGridMode == GRID_THIRDS) {
    gfx->drawFastVLine(x0 + w / 3,       y0, h, col);
    gfx->drawFastVLine(x0 + (w * 2) / 3, y0, h, col);
    gfx->drawFastHLine(x0, y0 + h / 3,       w, col);
    gfx->drawFastHLine(x0, y0 + (h * 2) / 3, w, col);
  } else if (currentGridMode == GRID_SQUARE) {
    for (int i = 1; i <= 3; i++) {
      gfx->drawFastVLine(x0 + (w * i) / 4, y0, h, col);
      gfx->drawFastHLine(x0, y0 + (h * i) / 4, w, col);
    }
  } else if (currentGridMode == GRID_DIAGONAL) {
    gfx->drawLine(x0, y0, x0 + w - 1, y0 + h - 1, col);
    gfx->drawLine(x0 + w - 1, y0, x0, y0 + h - 1, col);
    gfx->drawFastVLine(x0 + w / 2, y0, h, col);
    gfx->drawFastHLine(x0, y0 + h / 2, w, col);
  } else if (currentGridMode == GRID_GOLDEN) {
    int16_t x1 = x0 + (int16_t)((int32_t)w * 382 / 1000);
    int16_t x2 = x0 + (int16_t)((int32_t)w * 618 / 1000);
    int16_t y1 = y0 + (int16_t)((int32_t)h * 382 / 1000);
    int16_t y2 = y0 + (int16_t)((int32_t)h * 618 / 1000);
    gfx->drawFastVLine(x1, y0, h, col);
    gfx->drawFastVLine(x2, y0, h, col);
    gfx->drawFastHLine(x0, y1, w, col);
    gfx->drawFastHLine(x0, y2, w, col);
  }
}

void drawSelfTimerOnGfx(LovyanGFX* gfx, int16_t cx, int16_t cy, uint16_t remSec) {
  uint16_t pillBg = M5.Display.color565(220, 38, 38);
  gfx->fillRoundRect(cx - 22, cy - 14, 44, 28, 6, pillBg);
  gfx->drawRoundRect(cx - 22, cy - 14, 44, 28, 6, TFT_WHITE);
  gfx->setTextSize(2);
  gfx->setTextColor(TFT_WHITE, pillBg);
  if (remSec >= 10) {
    gfx->setCursor(cx - 11, cy - 7);
  } else {
    gfx->setCursor(cx - 5, cy - 7);
  }
  gfx->printf("%u", (unsigned)remSec);
  gfx->setTextSize(1);
}

// ----------------------------------------------------------------------------
// Viewfinder UI & Telemetry (Landscape 240x135 / Portrait 135x240)
// ----------------------------------------------------------------------------
void updateExposureRail() {
  if (diag.displayMode != 0) return;
  uint16_t railBg = M5.Display.color565(10, 15, 28);
  M5.Display.startWrite();
  M5.Display.setTextSize(1);

  uint16_t modeColor = M5.Display.color565(148, 163, 184);
  if (diag.expModeStr.startsWith("A")) modeColor = TFT_CYAN;
  else if (diag.expModeStr.startsWith("S")) modeColor = TFT_ORANGE;
  else if (diag.expModeStr.startsWith("i") || diag.expModeStr == "P") modeColor = TFT_GREEN;

  uint16_t remColor = TFT_GREEN;
  if (diag.remainShots >= 0 && diag.remainShots < 10) remColor = TFT_RED;
  else if (diag.remainShots >= 0 && diag.remainShots < 50) remColor = TFT_YELLOW;
  else if (diag.remainShots < 0) remColor = M5.Display.color565(148, 163, 184);

  if (isPortraitOrientation()) {
    if (hudEnabled(HUD_MODE)) {
      M5.Display.setTextColor(modeColor, railBg);
      M5.Display.setCursor(4, 131);
      M5.Display.printf("%-7s", diag.expModeStr.substring(0, 7).c_str());
    }

    if (hudEnabled(HUD_REM)) {
      M5.Display.setTextColor(remColor, railBg);
      M5.Display.setCursor(62, 131);
      M5.Display.printf("REM:%-6s", diag.remainShotsStr.substring(0, 6).c_str());
    }

    if (hudEnabled(HUD_SHUTTER)) {
      M5.Display.setTextColor(TFT_WHITE, railBg);
      M5.Display.setCursor(4, 144);
      M5.Display.printf("%-6s", diag.expShutterStr.substring(0, 6).c_str());
    }

    if (hudEnabled(HUD_APERTURE)) {
      M5.Display.setTextColor(TFT_CYAN, railBg);
      M5.Display.setCursor(50, 144);
      M5.Display.printf("%-5s", diag.expApertureStr.substring(0, 5).c_str());
    }

    if (hudEnabled(HUD_ISO)) {
      M5.Display.setTextColor(TFT_YELLOW, railBg);
      M5.Display.setCursor(88, 144);
      M5.Display.printf("%-6s", diag.expIsoStr.substring(0, 6).c_str());
    }

    if (hudEnabled(HUD_AF_WARN)) {
      M5.Display.setTextColor(diag.expWarning ? TFT_RED : TFT_GREEN, railBg);
      M5.Display.setCursor(92, 163);
      M5.Display.printf("%-6s", diag.expWarning ? "EXP:!!" : "AF:CTR");
    }
  } else {
    if (hudEnabled(HUD_MODE)) {
      M5.Display.setTextColor(modeColor, railBg);
      M5.Display.setCursor(3, 17);
      M5.Display.printf("%-6s", diag.expModeStr.substring(0, 6).c_str());
    }

    if (hudEnabled(HUD_SHUTTER)) {
      M5.Display.setTextColor(TFT_WHITE, railBg);
      M5.Display.setCursor(3, 31);
      M5.Display.printf("%-6s", diag.expShutterStr.substring(0, 6).c_str());
    }

    if (hudEnabled(HUD_APERTURE)) {
      M5.Display.setTextColor(TFT_CYAN, railBg);
      M5.Display.setCursor(3, 45);
      M5.Display.printf("%-6s", diag.expApertureStr.substring(0, 6).c_str());
    }

    if (hudEnabled(HUD_ISO)) {
      M5.Display.setTextColor(TFT_YELLOW, railBg);
      M5.Display.setCursor(3, 59);
      M5.Display.printf("%-6s", diag.expIsoStr.substring(0, 6).c_str());
    }

    if (hudEnabled(HUD_REM)) {
      M5.Display.setTextColor(remColor, railBg);
      M5.Display.setCursor(203, 27);
      M5.Display.printf("%-6s", diag.remainShotsStr.substring(0, 6).c_str());
    }

    if (hudEnabled(HUD_AF_WARN)) {
      M5.Display.setTextColor(diag.expWarning ? TFT_RED : TFT_GREEN, railBg);
      M5.Display.setCursor(203, 69);
      M5.Display.printf("%-6s", diag.expWarning ? "EXP:!!" : "AF:CTR");
    }
  }

  M5.Display.endWrite();
}

void drawChromeUI() {
  lastJpgW     = 0;
  lastJpgH     = 0;
  dynamicDrawX = vpX();
  dynamicDrawY = vpY();
  dynamicMaxW  = vpW();
  dynamicMaxH  = vpH();
  if (vpCanvas.getBuffer() != nullptr) {
    vpCanvas.fillSprite(TFT_BLACK);
  }
  M5.Display.startWrite();
  M5.Display.fillScreen(TFT_BLACK);

  uint16_t topH   = bannerH();
  uint16_t railBg = M5.Display.color565(10, 15, 28);
  M5.Display.fillRect(0, 0, M5.Display.width(), topH, M5.Display.color565(15, 23, 42));
  M5.Display.drawFastHLine(0, topH - 1, M5.Display.width(), M5.Display.color565(51, 65, 85));

  M5.Display.setTextSize(1);
  uint16_t modeColor = M5.Display.color565(148, 163, 184);
  if (diag.expModeStr.startsWith("A")) modeColor = TFT_CYAN;
  else if (diag.expModeStr.startsWith("S")) modeColor = TFT_ORANGE;
  else if (diag.expModeStr.startsWith("i") || diag.expModeStr == "P") modeColor = TFT_GREEN;

  uint16_t remColor = TFT_GREEN;
  if (diag.remainShots >= 0 && diag.remainShots < 10) remColor = TFT_RED;
  else if (diag.remainShots >= 0 && diag.remainShots < 50) remColor = TFT_YELLOW;
  else if (diag.remainShots < 0) remColor = M5.Display.color565(148, 163, 184);

  if (isPortraitOrientation()) {
    int16_t panelY = PORTRAIT_VP_Y + PORTRAIT_VP_HEIGHT + 2;
    M5.Display.fillRect(0, panelY, M5.Display.width(), M5.Display.height() - panelY, railBg);
    M5.Display.drawFastHLine(0, panelY, M5.Display.width(), M5.Display.color565(30, 41, 59));

    if (hudEnabled(HUD_MODE)) {
      M5.Display.setTextColor(modeColor, railBg);
      M5.Display.setCursor(4, 131);
      M5.Display.printf("%-7s", diag.expModeStr.substring(0, 7).c_str());
    }

    if (hudEnabled(HUD_REM)) {
      M5.Display.setTextColor(remColor, railBg);
      M5.Display.setCursor(62, 131);
      M5.Display.printf("REM:%-6s", diag.remainShotsStr.substring(0, 6).c_str());
    }

    if (hudEnabled(HUD_SHUTTER)) {
      M5.Display.setTextColor(TFT_WHITE, railBg);
      M5.Display.setCursor(4, 144);
      M5.Display.printf("%-6s", diag.expShutterStr.substring(0, 6).c_str());
    }

    if (hudEnabled(HUD_APERTURE)) {
      M5.Display.setTextColor(TFT_CYAN, railBg);
      M5.Display.setCursor(50, 144);
      M5.Display.printf("%-5s", diag.expApertureStr.substring(0, 5).c_str());
    }

    if (hudEnabled(HUD_ISO)) {
      M5.Display.setTextColor(TFT_YELLOW, railBg);
      M5.Display.setCursor(88, 144);
      M5.Display.printf("%-6s", diag.expIsoStr.substring(0, 6).c_str());
    }

    M5.Display.drawFastHLine(4, 157, M5.Display.width() - 8, M5.Display.color565(30, 41, 59));

    if (hudEnabled(HUD_ASPECT)) {
      M5.Display.setTextColor(TFT_ORANGE, railBg);
      M5.Display.setCursor(4, 163);
      M5.Display.print(ASPECT_NAMES[currentAspectIdx]);
    }

    if (hudEnabled(HUD_RES)) {
      M5.Display.setTextColor(M5.Display.color565(148, 163, 184), railBg);
      M5.Display.setCursor(38, 163);
      M5.Display.printf("%ux%u", (unsigned)dynamicMaxW, (unsigned)dynamicMaxH);
    }

    if (hudEnabled(HUD_AF_WARN)) {
      M5.Display.setTextColor(diag.expWarning ? TFT_RED : TFT_GREEN, railBg);
      M5.Display.setCursor(92, 163);
      M5.Display.print(diag.expWarning ? "EXP:!!" : "AF:CTR");
    }

    M5.Display.drawFastHLine(4, 176, M5.Display.width() - 8, M5.Display.color565(30, 41, 59));

    if (hudEnabled(HUD_DRIVE)) {
      M5.Display.setTextColor(TFT_GREEN, railBg);
      M5.Display.setCursor(4, 182);
      M5.Display.print(DRIVE_MODE_SHORT[currentDriveMode]);
    }

    if (hudEnabled(HUD_HINTS)) {
      M5.Display.setTextColor((btnAMode == BTNA_PEAK) ? (peakEnabled ? PEAK_COLOR_RGB565[peakColorIdx] : TFT_CYAN) : TFT_WHITE, railBg);
      M5.Display.setCursor(32, 182);
      M5.Display.print((btnAMode == BTNA_PEAK) ? "[A]PK  HB:MENU" : "[A]SNAP HB:MENU");

      M5.Display.setTextColor(TFT_CYAN, railBg);
      M5.Display.setCursor(4, 196);
      M5.Display.print("[B]ASP");

      M5.Display.setTextColor(TFT_ORANGE, railBg);
      M5.Display.setCursor(52, 196);
      M5.Display.print("2B:MOD");

      M5.Display.setTextColor(M5.Display.color565(148, 163, 184), railBg);
      M5.Display.setCursor(96, 196);
      M5.Display.print("3B:DIG");
    }

    if (hudEnabled(HUD_DRIVE)) {
      M5.Display.setTextColor(M5.Display.color565(203, 213, 225), railBg);
      M5.Display.setCursor(4, 212);
      M5.Display.printf("GRD:%-4s PK:%-3s", GRID_MODE_NAMES[currentGridMode],
                        peakEnabled ? PEAK_COLOR_SHORT[peakColorIdx] : "OFF");

      M5.Display.setTextColor(M5.Display.color565(148, 163, 184), railBg);
      M5.Display.setCursor(4, 225);
      M5.Display.printf("ROT:%-6s", STICK_ROT_NAMES[stickRotMode]);
    }

    if (hudEnabled(HUD_HINTS)) {
      M5.Display.setTextColor(M5.Display.color565(148, 163, 184), railBg);
      M5.Display.setCursor(70, 225);
      M5.Display.print("AB:SLP");
    }
  } else {
    M5.Display.fillRect(0, BANNER_HEIGHT, 40, M5.Display.height() - BANNER_HEIGHT, railBg);
    M5.Display.drawFastVLine(39, BANNER_HEIGHT, M5.Display.height() - BANNER_HEIGHT, M5.Display.color565(30, 41, 59));

    M5.Display.fillRect(200, BANNER_HEIGHT, 40, M5.Display.height() - BANNER_HEIGHT, railBg);
    M5.Display.drawFastVLine(200, BANNER_HEIGHT, M5.Display.height() - BANNER_HEIGHT, M5.Display.color565(30, 41, 59));

    if (hudEnabled(HUD_MODE)) {
      M5.Display.setTextColor(modeColor, railBg);
      M5.Display.setCursor(3, 17);
      M5.Display.printf("%-6s", diag.expModeStr.substring(0, 6).c_str());
    }

    if (hudEnabled(HUD_SHUTTER)) {
      M5.Display.setTextColor(TFT_WHITE, railBg);
      M5.Display.setCursor(3, 31);
      M5.Display.printf("%-6s", diag.expShutterStr.substring(0, 6).c_str());
    }

    if (hudEnabled(HUD_APERTURE)) {
      M5.Display.setTextColor(TFT_CYAN, railBg);
      M5.Display.setCursor(3, 45);
      M5.Display.printf("%-6s", diag.expApertureStr.substring(0, 6).c_str());
    }

    if (hudEnabled(HUD_ISO)) {
      M5.Display.setTextColor(TFT_YELLOW, railBg);
      M5.Display.setCursor(3, 59);
      M5.Display.printf("%-6s", diag.expIsoStr.substring(0, 6).c_str());
    }

    if (hudEnabled(HUD_ASPECT)) {
      M5.Display.setTextColor(TFT_ORANGE, railBg);
      M5.Display.setCursor(3, 76);
      M5.Display.print(ASPECT_NAMES[currentAspectIdx]);
    }

    if (hudEnabled(HUD_RES)) {
      M5.Display.setTextColor(M5.Display.color565(148, 163, 184), railBg);
      M5.Display.setCursor(3, 88);
      M5.Display.printf("%ux%u", (unsigned)dynamicMaxW, (unsigned)dynamicMaxH);
    }

    if (hudEnabled(HUD_DRIVE)) {
      M5.Display.setTextColor(peakEnabled ? PEAK_COLOR_RGB565[peakColorIdx] : TFT_GREEN, railBg);
      M5.Display.setCursor(3, 104);
      M5.Display.printf("%-3s %c%c", DRIVE_MODE_SHORT[currentDriveMode],
                        currentGridMode == GRID_OFF ? ' ' : 'G',
                        peakEnabled ? 'P' : ' ');
    }

    if (hudEnabled(HUD_HINTS)) {
      M5.Display.setTextColor((btnAMode == BTNA_PEAK) ? (peakEnabled ? PEAK_COLOR_RGB565[peakColorIdx] : TFT_CYAN) : TFT_WHITE, railBg);
      M5.Display.setCursor(2, 118);
      M5.Display.print((btnAMode == BTNA_PEAK) ? "[A]PK " : (currentDriveMode == DRIVE_CONT ? "[A]CNT" : "[A]SHT"));
    }

    if (hudEnabled(HUD_REM)) {
      M5.Display.setTextColor(M5.Display.color565(148, 163, 184), railBg);
      M5.Display.setCursor(203, 16);
      M5.Display.print("REM");

      M5.Display.setTextColor(remColor, railBg);
      M5.Display.setCursor(203, 25);
      M5.Display.printf("%-6s", diag.remainShotsStr.substring(0, 6).c_str());
    }

    if (hudEnabled(HUD_HINTS)) {
      M5.Display.setTextColor(TFT_CYAN, railBg);
      M5.Display.setCursor(203, 37);
      M5.Display.print("[B]ASP");

      M5.Display.setTextColor(TFT_ORANGE, railBg);
      M5.Display.setCursor(203, 47);
      M5.Display.print("2B:MOD");

      M5.Display.setTextColor(M5.Display.color565(148, 163, 184), railBg);
      M5.Display.setCursor(203, 57);
      M5.Display.print("3B:DIG");
    }

    if (hudEnabled(HUD_AF_WARN)) {
      M5.Display.setTextColor(diag.expWarning ? TFT_RED : TFT_GREEN, railBg);
      M5.Display.setCursor(203, 69);
      M5.Display.print(diag.expWarning ? "EXP:!!" : "AF:CTR");
    }

    if (hudEnabled(HUD_HINTS)) {
      M5.Display.setTextColor(TFT_YELLOW, railBg);
      M5.Display.setCursor(203, 105);
      M5.Display.print("HB:MNU");
      M5.Display.setTextColor(M5.Display.color565(148, 163, 184), railBg);
      M5.Display.setCursor(203, 117);
      M5.Display.print("AB:SLP");
    }
  }

  drawExposureWarningBox(diag.expWarning);
  M5.Display.endWrite();
  drawPersistentClockInViewfinder();
}

void drawPersistentClockInViewfinder() {
  if (diag.displayMode != 0) return;
  M5.Display.startWrite();
  M5.Display.setTextSize(1);

  if (isPortraitOrientation()) {
    uint16_t topBg = M5.Display.color565(15, 23, 42);
    M5.Display.fillRect(100, 12, 34, 10, topBg);
    if (hudEnabled(HUD_CLOCK)) {
      if (clockInvalid2015) {
        M5.Display.fillRoundRect(100, 12, 34, 10, 2, TFT_RED);
        M5.Display.setTextColor(TFT_WHITE, TFT_RED);
        M5.Display.setCursor(102, 13);
        M5.Display.print("2015!");
      } else if (clockSynced) {
        M5.Display.setTextColor(TFT_CYAN, topBg);
        M5.Display.setCursor(103, 13);
        M5.Display.print(getClockTimeStr(false));
      } else {
        M5.Display.setTextColor(M5.Display.color565(148, 163, 184), topBg);
        M5.Display.setCursor(103, 13);
        M5.Display.print("--:--");
      }
    }
  } else {
    uint16_t railBg = M5.Display.color565(10, 15, 28);
    M5.Display.fillRect(202, 79, 37, 22, railBg);
    if (hudEnabled(HUD_CLOCK)) {
      if (clockInvalid2015) {
        M5.Display.fillRoundRect(202, 80, 36, 19, 2, TFT_RED);
        M5.Display.setTextColor(TFT_WHITE, TFT_RED);
        M5.Display.setCursor(205, 81);
        M5.Display.print("2015!");
        M5.Display.setCursor(205, 90);
        M5.Display.print("SYNC!");
      } else if (clockSynced) {
        String hm = getClockTimeStr(false);
        String md = getClockDateStr();
        M5.Display.setTextColor(TFT_CYAN, railBg);
        M5.Display.setCursor(204, 81);
        M5.Display.print(hm);
        M5.Display.setTextColor(M5.Display.color565(148, 163, 184), railBg);
        M5.Display.setCursor(204, 91);
        M5.Display.print(md.substring(5, 10)); // MM-DD
      } else {
        M5.Display.setTextColor(M5.Display.color565(148, 163, 184), railBg);
        M5.Display.setCursor(204, 81);
        M5.Display.print("--:--");
        M5.Display.setCursor(204, 91);
        M5.Display.print("CLK* ");
      }
    }
  }
  M5.Display.endWrite();
}

void updateTopBanner() {
  uint16_t bg = M5.Display.color565(15, 23, 42);
  M5.Display.startWrite();
  M5.Display.setTextSize(1);

  float vbat = getM5BatteryVolts();

  if (isPortraitOrientation()) {
    if (hudEnabled(HUD_FPS)) {
      M5.Display.setCursor(2, 2);
      if (diag.validFrames > 0) {
        M5.Display.setTextColor(TFT_GREEN, bg);
        M5.Display.printf("%-8s", (String(diag.currentFps, 1) + "FPS").c_str());
      } else if (diag.rxPackets > 0) {
        M5.Display.setTextColor(TFT_CYAN, bg);
        M5.Display.printf("%-8lu", diag.rxPackets);
      } else {
        M5.Display.setTextColor(TFT_YELLOW, bg);
        M5.Display.printf("%-8s", diag.wifiStatus.substring(0, 8).c_str());
      }
    }

    if (hudEnabled(HUD_ASPECT)) {
      M5.Display.setTextColor(TFT_ORANGE, bg);
      M5.Display.setCursor(54, 2);
      M5.Display.printf("[%-4s]", ASPECT_NAMES[currentAspectIdx]);
    }

    if (hudEnabled(HUD_STATUS)) {
      M5.Display.setTextColor((diag.expWarning || clockInvalid2015) ? TFT_RED : TFT_YELLOW, bg);
      M5.Display.setCursor(96, 2);
      String statusShort = (diag.lastError == "None" || diag.lastError == "") ? "LIVE" : diag.lastError;
      if (clockInvalid2015 && (statusShort == "LIVE" || statusShort == "None")) {
        statusShort = "2015!";
      } else if (diag.expWarning && (statusShort == "LIVE" || statusShort == "None")) {
        statusShort = "EXP!";
      }
      M5.Display.printf("%-6s", statusShort.substring(0, 6).c_str());
    }

    if (hudEnabled(HUD_BATT)) {
      char batBuf[20];
      snprintf(batBuf, sizeof(batBuf), "A:%-4s S:%.1fV", diag.airBatteryStr.substring(0, 4).c_str(), vbat);
      M5.Display.setTextColor(TFT_WHITE, bg);
      M5.Display.setCursor(2, 13);
      M5.Display.printf("%-16s", batBuf);
    }
  } else {
    if (hudEnabled(HUD_FPS)) {
      M5.Display.setCursor(2, 3);
      if (diag.validFrames > 0) {
        M5.Display.setTextColor(TFT_GREEN, bg);
        M5.Display.printf("%-7s", (String(diag.currentFps, 1) + "FPS").c_str());
      } else if (diag.rxPackets > 0) {
        M5.Display.setTextColor(TFT_CYAN, bg);
        M5.Display.printf("%-7lu", diag.rxPackets);
      } else {
        M5.Display.setTextColor(TFT_YELLOW, bg);
        M5.Display.printf("%-7s", diag.wifiStatus.substring(0, 7).c_str());
      }
    }

    if (hudEnabled(HUD_ASPECT)) {
      M5.Display.setTextColor(TFT_ORANGE, bg);
      M5.Display.setCursor(48, 3);
      M5.Display.printf("[%-4s]", ASPECT_NAMES[currentAspectIdx]);
    }

    if (hudEnabled(HUD_STATUS)) {
      M5.Display.setTextColor((diag.expWarning || clockInvalid2015) ? TFT_RED : TFT_YELLOW, bg);
      M5.Display.setCursor(86, 3);
      String statusShort = (diag.lastError == "None" || diag.lastError == "") ? "LIVE" : diag.lastError;
      if (clockInvalid2015 && (statusShort == "LIVE" || statusShort == "None")) {
        statusShort = "2015!";
      } else if (diag.expWarning && (statusShort == "LIVE" || statusShort == "None")) {
        statusShort = "EXP!";
      }
      M5.Display.printf("%-6s", statusShort.substring(0, 6).c_str());
    }

    if (hudEnabled(HUD_BATT)) {
      char batBuf[24];
      snprintf(batBuf, sizeof(batBuf), "AIR:%-4s S3:%.1fV", diag.airBatteryStr.substring(0, 4).c_str(), vbat);
      M5.Display.setTextColor(TFT_WHITE, bg);
      M5.Display.setCursor(130, 3);
      M5.Display.printf("%-18s", batBuf);
    }
  }

  M5.Display.endWrite();
  drawPersistentClockInViewfinder();
}

// ----------------------------------------------------------------------------
// Flicker-Free Full Diagnostics HUD
// ----------------------------------------------------------------------------
void initDiagnosticsScreenLayout() {
  M5.Display.startWrite();
  M5.Display.fillScreen(TFT_BLACK);
  M5.Display.fillRect(0, 0, M5.Display.width(), 16, TFT_DARKCYAN);
  M5.Display.setTextSize(1);
  M5.Display.setTextColor(TFT_WHITE, TFT_DARKCYAN);
  M5.Display.setCursor(4, 4);
  M5.Display.print(isPortraitOrientation() ? "S3 & AIR DIAG" : "OLYMPUS AIR & S3 DIAG");
  drawClockBadgeOnGfx(&M5.Display, M5.Display.width() - 3, 4, TFT_DARKCYAN, isPortraitOrientation());

  int bY = M5.Display.height() - 14;
  M5.Display.fillRect(0, bY, M5.Display.width(), 14, TFT_NAVY);
  M5.Display.setTextColor(TFT_WHITE, TFT_NAVY);
  M5.Display.setCursor(4, bY + 3);
  M5.Display.print(isPortraitOrientation() ? "3x[B]:Live 5B:Slp" : "3x[B]:Live | 5x[B]:Sleep All | HB:Menu");
  M5.Display.endWrite();
}

void updateDiagnosticsScreenData() {
  diag.freeHeapBytes    = ESP.getFreeHeap();
  diag.minFreeHeapBytes = ESP.getMinFreeHeap();
  diag.maxAllocHeap     = ESP.getMaxAllocHeap();
  diag.freePsramBytes   = ESP.getFreePsram();
  float vbat = getM5BatteryVolts();

  char line[44];
  M5.Display.startWrite();
  M5.Display.setTextSize(1);
  M5.Display.fillRect(M5.Display.width() - 62, 1, 60, 14, TFT_DARKCYAN);
  drawClockBadgeOnGfx(&M5.Display, M5.Display.width() - 3, 4, TFT_DARKCYAN, isPortraitOrientation());

  if (isPortraitOrientation()) {
    M5.Display.setCursor(4, 22);
    M5.Display.setTextColor(TFT_GREEN, TFT_BLACK);
    snprintf(line, sizeof(line), "RAM:%uK Min:%uK", diag.freeHeapBytes / 1024, diag.minFreeHeapBytes / 1024);
    M5.Display.printf("%-21s", line);

    M5.Display.setCursor(4, 38);
    M5.Display.setTextColor(TFT_GREEN, TFT_BLACK);
    snprintf(line, sizeof(line), "PSRAM:%uK Max:%uK", diag.freePsramBytes / 1024, diag.maxAllocHeap / 1024);
    M5.Display.printf("%-21s", line);

    M5.Display.setCursor(4, 56);
    M5.Display.setTextColor(diag.droppedPackets > 0 ? TFT_RED : TFT_CYAN, TFT_BLACK);
    snprintf(line, sizeof(line), "Pkts:%lu Drop:%lu", diag.rxPackets, diag.droppedPackets);
    M5.Display.printf("%-21s", line);

    M5.Display.setCursor(4, 72);
    M5.Display.setTextColor(TFT_CYAN, TFT_BLACK);
    snprintf(line, sizeof(line), "Hdr:%02X/%02X CamO:%u", diag.lastHdr0, diag.lastHdr1, (unsigned)camActiveOrient);
    M5.Display.printf("%-21s", line);

    M5.Display.setCursor(4, 90);
    M5.Display.setTextColor(TFT_YELLOW, TFT_BLACK);
    snprintf(line, sizeof(line), "OK:%lu Bad:%lu", diag.validFrames, diag.corruptFrames);
    M5.Display.printf("%-21s", line);

    M5.Display.setCursor(4, 106);
    M5.Display.setTextColor(TFT_YELLOW, TFT_BLACK);
    snprintf(line, sizeof(line), "%.1fFPS JDR:%d %uB", diag.currentFps, diag.lastDecodeCode, (unsigned)diag.lastFrameBytes);
    M5.Display.printf("%-21s", line);

    M5.Display.setCursor(4, 124);
    M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
    snprintf(line, sizeof(line), "PK:%s/%s WK:%s", peakEnabled ? PEAK_COLOR_SHORT[peakColorIdx] : "OFF",
             (peakSource == PEAK_SRC_320) ? "320" : "160", WAKE_KEY_NAMES[wakeKeyMode]);
    M5.Display.printf("%-21s", line);

    M5.Display.setCursor(4, 140);
    M5.Display.setTextColor(TFT_ORANGE, TFT_BLACK);
    snprintf(line, sizeof(line), "Snap:%d/%d/%d A:%s", diag.readyCode, diag.lastShutterCode, diag.stopCode,
             (btnAMode == BTNA_PEAK) ? "PK" : "SH");
    M5.Display.printf("%-21s", line);

    M5.Display.setCursor(4, 156);
    M5.Display.setTextColor(TFT_ORANGE, TFT_BLACK);
    snprintf(line, sizeof(line), "Asp:%d Mod:%d %s", diag.aspectCode, diag.modeCode, diag.expModeStr.c_str());
    M5.Display.printf("%-21s", line);

    M5.Display.setCursor(4, 174);
    M5.Display.setTextColor(TFT_MAGENTA, TFT_BLACK);
    snprintf(line, sizeof(line), "Air:%s S3:%.2fV", diag.airBatteryStr.c_str(), vbat);
    M5.Display.printf("%-21s", line);

    M5.Display.setCursor(4, 190);
    M5.Display.setTextColor(diag.expWarning ? TFT_RED : TFT_MAGENTA, TFT_BLACK);
    snprintf(line, sizeof(line), "Rem:%s CG:%s %s", diag.remainShotsStr.c_str(),
             CAM_GYRO_NAMES[camGyroMode], dualGyroLocked ? "GLCK" : (diag.expWarning ? "EW:1" : "EW:0"));
    M5.Display.printf("%-21s", line);

    M5.Display.setCursor(4, 206);
    if (clockInvalid2015) {
      M5.Display.setTextColor(TFT_RED, TFT_BLACK);
      M5.Display.printf("%-21s", "CLK:2015 INVALID!");
    } else {
      M5.Display.setTextColor(TFT_CYAN, TFT_BLACK);
      snprintf(line, sizeof(line), "CLK:%s %s", getClockDateStr().c_str(), getClockTimeStr(true).c_str());
      M5.Display.printf("%-21s", line);
    }
  } else {
    M5.Display.setCursor(4, 20);
    M5.Display.setTextColor(TFT_GREEN, TFT_BLACK);
    snprintf(line, sizeof(line), "RAM:%uK Min:%uK PSRAM:%uK",
             diag.freeHeapBytes / 1024, diag.minFreeHeapBytes / 1024, diag.freePsramBytes / 1024);
    M5.Display.printf("%-39s", line);

    M5.Display.setCursor(4, 34);
    M5.Display.setTextColor(diag.droppedPackets > 0 ? TFT_RED : TFT_CYAN, TFT_BLACK);
    snprintf(line, sizeof(line), "Pkts:%lu Drop:%lu CamO:%u(%s)%s",
             diag.rxPackets, diag.droppedPackets, (unsigned)camActiveOrient,
             CAM_GYRO_NAMES[camGyroMode], dualGyroLocked ? " GLCK" : "");
    M5.Display.printf("%-39s", line);

    M5.Display.setCursor(4, 48);
    M5.Display.setTextColor(TFT_YELLOW, TFT_BLACK);
    snprintf(line, sizeof(line), "OK:%lu Bad:%lu %.1fFPS JDR:%d %uB",
             diag.validFrames, diag.corruptFrames, diag.currentFps, diag.lastDecodeCode, (unsigned)diag.lastFrameBytes);
    M5.Display.printf("%-39s", line);

    M5.Display.setCursor(4, 62);
    M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
    snprintf(line, sizeof(line), "PK:%s(%s) BtnA:%s Wake:%s",
             peakEnabled ? PEAK_COLOR_SHORT[peakColorIdx] : "OFF",
             (peakSource == PEAK_SRC_320) ? "320" : "160",
             (btnAMode == BTNA_PEAK) ? "PK" : "SHT",
             WAKE_KEY_NAMES[wakeKeyMode]);
    M5.Display.printf("%-39s", line);

    M5.Display.setCursor(4, 76);
    M5.Display.setTextColor(TFT_ORANGE, TFT_BLACK);
    snprintf(line, sizeof(line), "Snap:%d/%d/%d Asp:%d Mod:%d CH:%u",
             diag.readyCode, diag.lastShutterCode, diag.stopCode, diag.aspectCode, diag.modeCode, (unsigned)savedWifiChannel);
    M5.Display.printf("%-39s", line);

    M5.Display.setCursor(4, 90);
    M5.Display.setTextColor(TFT_MAGENTA, TFT_BLACK);
    snprintf(line, sizeof(line), "Air:%s S3:%.2fV Rem:%s BT:%s",
             diag.airBatteryStr.c_str(), vbat, diag.remainShotsStr.c_str(),
             btWakeOnBoot ? "ON" : "OFF");
    M5.Display.printf("%-39s", line);

    M5.Display.setCursor(4, 104);
    if (clockInvalid2015) {
      M5.Display.setTextColor(TFT_RED, TFT_BLACK);
      snprintf(line, sizeof(line), "IP:%s CLK:2015 INVALID RESYNC!", diag.localIp.c_str());
    } else {
      M5.Display.setTextColor(diag.expWarning ? TFT_RED : TFT_LIGHTGREY, TFT_BLACK);
      snprintf(line, sizeof(line), "IP:%s CLK:%s %s",
               diag.localIp.c_str(), getClockDateStr().c_str(), getClockTimeStr(true).c_str());
    }
    M5.Display.printf("%-39s", line);
  }

  M5.Display.endWrite();
}

void showConnectingSplash(const String& step, const String& detail) {
  int16_t w     = M5.Display.width();
  int16_t h     = M5.Display.height();
  bool    port  = isPortraitOrientation();
  uint16_t bg   = M5.Display.color565(10, 20, 35);
  uint16_t hdr  = M5.Display.color565(15, 23, 42);
  float   vbat  = getM5BatteryVolts();
  int     bpct  = getM5BatteryPercent(vbat);
  uint16_t bCol = (bpct <= 20) ? TFT_RED : (bpct <= 45 ? TFT_YELLOW : TFT_GREEN);

  bool useSprite = ensureUiCanvas();
  LovyanGFX* gfx = useSprite ? static_cast<LovyanGFX*>(&uiCanvas) : static_cast<LovyanGFX*>(&M5.Display);

  if (!useSprite) gfx->startWrite();
  gfx->fillScreen(bg);
  gfx->fillRect(0, 0, w, 18, hdr);
  gfx->drawFastHLine(0, 18, w, M5.Display.color565(51, 65, 85));
  gfx->setTextSize(1);
  gfx->setTextColor(TFT_CYAN, hdr);
  gfx->setCursor(4, 5);
  gfx->print(port ? "BOOT CONNECT" : "CONNECTING TO AIR A01");

  char batStr[16];
  snprintf(batStr, sizeof(batStr), "%d%% %.1fV", bpct, vbat);
  gfx->setTextColor(bCol, hdr);
  gfx->setCursor(w - (int16_t)(strlen(batStr) * 6) - 4, 5);
  gfx->print(batStr);

  int16_t sx = port ? 6 : 16;
  int16_t y0 = port ? 42 : 26;
  gfx->setTextColor(TFT_YELLOW, bg);
  gfx->setCursor(sx, y0);
  gfx->print(port ? "== OLYMPUS AIR A01 ==" : "=== OLYMPUS AIR A01 ===");

  gfx->setTextColor(TFT_WHITE, bg);
  gfx->setCursor(sx, y0 + 20);
  gfx->print(step.substring(0, port ? 21 : 36));

  gfx->setTextColor(TFT_CYAN, bg);
  gfx->setCursor(sx, y0 + 40);
  gfx->print(detail.substring(0, port ? 21 : 36));

  gfx->setTextColor(TFT_GREEN, bg);
  gfx->setCursor(sx, y0 + 62);
  gfx->printf("%s:%d | S3:%.2fV", CAMERA_IP, STREAM_PORT, vbat);

  int16_t footY = h - 16;
  uint16_t footBg = clockInvalid2015 ? TFT_RED : hdr;
  gfx->fillRect(0, footY, w, 16, footBg);
  gfx->drawFastHLine(0, footY, w, M5.Display.color565(51, 65, 85));
  gfx->setCursor(4, footY + 4);
  if (clockInvalid2015) {
    gfx->setTextColor(TFT_WHITE, TFT_RED);
    gfx->print(port ? "!2015 CLOCK INVALID!" : "! AIR CLOCK 2015 INVALID - RESYNC !");
  } else if (clockSynced) {
    gfx->setTextColor(TFT_CYAN, hdr);
    gfx->printf("CLK:%s %s", getClockDateStr().c_str(), getClockTimeStr(true).c_str());
  } else {
    gfx->setTextColor(M5.Display.color565(148, 163, 184), hdr);
    gfx->print(port ? "CLK:--:-- (SHT SYNC)" : "CLK:--:--:-- (SYNC ON NEXT SHUTTER)");
  }

  if (useSprite) {
    uiCanvas.pushSprite(0, 0);
  } else {
    gfx->endWrite();
  }
}

// ----------------------------------------------------------------------------
// Zero-Flicker On-Device Wi-Fi Setup Wizard & Search UI (2-Button: [B] + [A])
//   - Rendered to offscreen M5Canvas sprite to eliminate SPI TFT flicker
//   - Displays StickS3 Battery % & Voltage in the top banner on all boot screens
// ----------------------------------------------------------------------------
void drawSearchingSavedScreen(const String& ssid, uint8_t chHint, uint16_t attempt, unsigned long elapsedSec) {
  uint16_t bg     = M5.Display.color565(8, 15, 28);
  uint16_t hdrBg  = M5.Display.color565(15, 23, 42);
  uint16_t btnBg  = M5.Display.color565(234, 88, 12);
  int16_t  w      = M5.Display.width();
  int16_t  h      = M5.Display.height();
  bool     port   = isPortraitOrientation();

  float    vbat   = getM5BatteryVolts();
  int      bpct   = getM5BatteryPercent(vbat);
  uint16_t bCol   = (bpct <= 20) ? TFT_RED : (bpct <= 45 ? TFT_YELLOW : TFT_GREEN);

  bool useSprite = ensureUiCanvas();
  LovyanGFX* gfx = useSprite ? static_cast<LovyanGFX*>(&uiCanvas) : static_cast<LovyanGFX*>(&M5.Display);

  if (!useSprite) gfx->startWrite();
  gfx->fillScreen(bg);
  gfx->fillRect(0, 0, w, 18, hdrBg);
  gfx->drawFastHLine(0, 18, w, M5.Display.color565(51, 65, 85));
  gfx->setTextSize(1);
  gfx->setTextColor(TFT_CYAN, hdrBg);
  gfx->setCursor(4, 5);
  gfx->print(port ? "SEARCH AIR" : "SEARCHING SAVED AIR");

  char batStr[16];
  snprintf(batStr, sizeof(batStr), "%d%% %.1fV", bpct, vbat);
  gfx->setTextColor(bCol, hdrBg);
  gfx->setCursor(w - (int16_t)(strlen(batStr) * 6) - 4, 5);
  gfx->print(batStr);

  int16_t y = port ? 30 : 23;
  gfx->setTextColor(TFT_WHITE, bg);
  gfx->setCursor(8, y);
  gfx->print("Target AP:");
  gfx->setTextColor(TFT_ORANGE, bg);
  gfx->setCursor(8, y + 12);
  gfx->print(ssid.substring(0, port ? 20 : 34));

  gfx->setTextColor(TFT_LIGHTGREY, bg);
  gfx->setCursor(8, y + 27);
  if (chHint > 0) {
    gfx->printf("Fast CH:%u | Try #%u (%lus)", (unsigned)chHint, (unsigned)attempt, elapsedSec);
  } else {
    gfx->printf("Full Scan | Try #%u (%lus)", (unsigned)attempt, elapsedSec);
  }

  gfx->setTextColor(TFT_GREEN, bg);
  gfx->setCursor(8, y + 40);
  gfx->print("Static IP .100 (No DHCP)");

  int16_t boxY = h - (port ? 58 : 44);
  gfx->fillRoundRect(8, boxY, w - 16, port ? 28 : 20, 4, btnBg);
  gfx->setTextColor(TFT_WHITE, btnBg);
  gfx->setCursor(port ? 18 : 34, boxY + (port ? 10 : 6));
  gfx->print(port ? "[A] Wi-Fi Setup" : "[A] Open Wi-Fi Setup");

  int16_t footY = h - 16;
  uint16_t footBg = clockInvalid2015 ? TFT_RED : hdrBg;
  gfx->fillRect(0, footY, w, 16, footBg);
  gfx->drawFastHLine(0, footY, w, M5.Display.color565(51, 65, 85));
  gfx->setCursor(4, footY + 4);
  if (clockInvalid2015) {
    gfx->setTextColor(TFT_WHITE, TFT_RED);
    gfx->print(port ? "!2015 CLOCK INVALID!" : "! AIR CLOCK 2015 INVALID - RESYNC !");
  } else if (clockSynced) {
    gfx->setTextColor(TFT_CYAN, hdrBg);
    gfx->printf("CLK:%s %s", getClockDateStr().c_str(), getClockTimeStr(true).c_str());
  } else {
    gfx->setTextColor(M5.Display.color565(148, 163, 184), hdrBg);
    gfx->print(port ? "CLK:--:-- HB:Menu" : "CLK:--:--:-- | Hold [B]: Menu");
  }

  if (useSprite) {
    uiCanvas.pushSprite(0, 0);
  } else {
    gfx->endWrite();
  }
}

void drawApListScreen(const std::vector<ScannedApEntry>& aps, int selectedIdx, bool scanningNow, bool canReturnToSearch) {
  int16_t w    = M5.Display.width();
  int16_t h    = M5.Display.height();
  bool    port = isPortraitOrientation();

  float    vbat = getM5BatteryVolts();
  int      bpct = getM5BatteryPercent(vbat);
  uint16_t bCol = (bpct <= 20) ? TFT_RED : (bpct <= 45 ? TFT_YELLOW : TFT_GREEN);

  uint16_t bg     = TFT_BLACK;
  uint16_t hdrBg  = M5.Display.color565(15, 23, 42);
  uint16_t selBg  = M5.Display.color565(234, 88, 12);
  uint16_t footBg = M5.Display.color565(17, 24, 39);

  int extraItems = canReturnToSearch ? 2 : 1; // [RESCAN ALL APs], optional [SEARCH SAVED AIR]
  int totalItems = (int)aps.size() + extraItems;
  int maxVisible = port ? 8 : 5;
  int rowH       = port ? 20 : 18;
  int listTop    = 22;

  int scrollStart = 0;
  if (totalItems > maxVisible && selectedIdx >= maxVisible - 1) {
    scrollStart = selectedIdx - maxVisible + 2;
    int maxStart = totalItems - maxVisible;
    if (scrollStart > maxStart) scrollStart = maxStart;
  }

  bool useSprite = ensureUiCanvas();
  LovyanGFX* gfx = useSprite ? static_cast<LovyanGFX*>(&uiCanvas) : static_cast<LovyanGFX*>(&M5.Display);

  if (!useSprite) gfx->startWrite();
  gfx->fillScreen(bg);
  gfx->fillRect(0, 0, w, 19, hdrBg);
  gfx->drawFastHLine(0, 19, w, M5.Display.color565(51, 65, 85));
  gfx->setTextSize(1);
  gfx->setTextColor(TFT_CYAN, hdrBg);
  gfx->setCursor(4, 6);
  if (scanningNow && aps.empty()) {
    gfx->print("SCANNING APs...");
  } else {
    gfx->printf(port ? "APs (%d)" : "WIFI APs (%d)%s",
                (int)aps.size(), scanningNow ? ".." : "");
  }

  char batStr[16];
  snprintf(batStr, sizeof(batStr), "%d%% %.1fV", bpct, vbat);
  gfx->setTextColor(bCol, hdrBg);
  gfx->setCursor(w - (int16_t)(strlen(batStr) * 6) - 4, 6);
  gfx->print(batStr);

  if (scanningNow && aps.empty()) {
    gfx->setTextColor(TFT_YELLOW, bg);
    gfx->setCursor(10, h / 2 - 8);
    gfx->print("Scanning 2.4GHz channels");
    gfx->setTextColor(TFT_LIGHTGREY, bg);
    gfx->setCursor(10, h / 2 + 8);
    gfx->print("All nearby APs...");
  } else {
    for (int row = 0; row < maxVisible; row++) {
      int idx = scrollStart + row;
      if (idx >= totalItems) break;

      int16_t ry  = listTop + row * rowH;
      bool    sel = (idx == selectedIdx);
      uint16_t rowFill = sel ? selBg : bg;
      gfx->fillRect(2, ry, w - 4, rowH - 1, rowFill);

      gfx->setCursor(6, ry + 5);
      if (idx < (int)aps.size()) {
        const ScannedApEntry& ap = aps[idx];
        uint16_t txtColor = sel ? TFT_WHITE : (ap.isAir ? TFT_GREEN : TFT_LIGHTGREY);
        gfx->setTextColor(txtColor, rowFill);

        int maxSsidChars = port ? 13 : 24;
        String label = ap.ssid.substring(0, maxSsidChars);
        if (sel) {
          gfx->printf(">%-*s %3ddBm", maxSsidChars, label.c_str(), (int)ap.rssi);
        } else {
          gfx->printf(" %-*s %3ddBm", maxSsidChars, label.c_str(), (int)ap.rssi);
        }
      } else if (idx == (int)aps.size()) {
        gfx->setTextColor(sel ? TFT_WHITE : TFT_CYAN, rowFill);
        gfx->print(sel ? "> [RESCAN ALL APs]" : "  [RESCAN ALL APs]");
      } else {
        gfx->setTextColor(sel ? TFT_WHITE : TFT_YELLOW, rowFill);
        gfx->print(sel ? "> [SEARCH SAVED AIR]" : "  [SEARCH SAVED AIR]");
      }
    }
  }

  int16_t footY = h - 18;
  gfx->fillRect(0, footY, w, 18, footBg);
  gfx->drawFastHLine(0, footY, w, M5.Display.color565(51, 65, 85));
  gfx->setTextColor(TFT_ORANGE, footBg);
  gfx->setCursor(4, footY + 5);
  gfx->print(port ? "[B]Nxt [A]OK" : "[B]Next [A]Select");
  drawClockBadgeOnGfx(gfx, w - 3, footY + 5, footBg, port);

  if (useSprite) {
    uiCanvas.pushSprite(0, 0);
  } else {
    gfx->endWrite();
  }
}

void drawPasskeyEntryScreen(const String& ssid, const uint8_t digits[8], int cursorPos) {
  int16_t w    = M5.Display.width();
  int16_t h    = M5.Display.height();
  bool    port = isPortraitOrientation();

  float    vbat = getM5BatteryVolts();
  int      bpct = getM5BatteryPercent(vbat);
  uint16_t bCol = (bpct <= 20) ? TFT_RED : (bpct <= 45 ? TFT_YELLOW : TFT_GREEN);

  uint16_t bg     = TFT_BLACK;
  uint16_t hdrBg  = M5.Display.color565(15, 23, 42);
  uint16_t footBg = M5.Display.color565(17, 24, 39);
  uint16_t actBg  = M5.Display.color565(234, 88, 12);
  uint16_t doneBg = M5.Display.color565(22, 163, 74);

  bool useSprite = ensureUiCanvas();
  LovyanGFX* gfx = useSprite ? static_cast<LovyanGFX*>(&uiCanvas) : static_cast<LovyanGFX*>(&M5.Display);

  if (!useSprite) gfx->startWrite();
  gfx->fillScreen(bg);
  gfx->fillRect(0, 0, w, 18, hdrBg);
  gfx->drawFastHLine(0, 18, w, M5.Display.color565(51, 65, 85));
  gfx->setTextSize(1);
  gfx->setTextColor(TFT_CYAN, hdrBg);
  gfx->setCursor(4, 5);
  gfx->printf("KEY:%s", ssid.substring(0, port ? 9 : 20).c_str());

  char batStr[16];
  snprintf(batStr, sizeof(batStr), "%d%% %.1fV", bpct, vbat);
  gfx->setTextColor(bCol, hdrBg);
  gfx->setCursor(w - (int16_t)(strlen(batStr) * 6) - 4, 5);
  gfx->print(batStr);

  gfx->setTextColor(TFT_LIGHTGREY, bg);
  gfx->setCursor(6, port ? 26 : 24);
  gfx->print(cursorPos < 8 ? "8-Digit Air Passkey:" : "Confirm 8-Digit Passkey?");

  if (port) {
    int boxW = 26, boxH = 30, gap = 5;
    int startX = (w - (4 * boxW + 3 * gap)) / 2;
    for (int i = 0; i < 8; i++) {
      int row = i / 4;
      int col = i % 4;
      int bx  = startX + col * (boxW + gap);
      int by  = 46 + row * (boxH + 8);
      bool active    = (i == cursorPos);
      bool confirmed = (i < cursorPos);
      uint16_t fill   = active ? actBg : M5.Display.color565(15, 23, 42);
      uint16_t border = active ? TFT_YELLOW : (confirmed ? TFT_GREEN : M5.Display.color565(71, 85, 105));
      gfx->fillRoundRect(bx, by, boxW, boxH, 3, fill);
      gfx->drawRoundRect(bx, by, boxW, boxH, 3, border);
      gfx->setTextSize(2);
      gfx->setTextColor(active ? TFT_WHITE : (confirmed ? TFT_GREEN : TFT_WHITE), fill);
      gfx->setCursor(bx + 7, by + 7);
      gfx->printf("%u", (unsigned)digits[i]);
    }
    gfx->setTextSize(1);
  } else {
    int boxW = 24, boxH = 34, gap = 4;
    int startX = (w - (8 * boxW + 7 * gap)) / 2;
    int by = 40;
    for (int i = 0; i < 8; i++) {
      int bx = startX + i * (boxW + gap);
      bool active    = (i == cursorPos);
      bool confirmed = (i < cursorPos);
      uint16_t fill   = active ? actBg : M5.Display.color565(15, 23, 42);
      uint16_t border = active ? TFT_YELLOW : (confirmed ? TFT_GREEN : M5.Display.color565(71, 85, 105));
      gfx->fillRoundRect(bx, by, boxW, boxH, 3, fill);
      gfx->drawRoundRect(bx, by, boxW, boxH, 3, border);
      gfx->setTextSize(2);
      gfx->setTextColor(active ? TFT_WHITE : (confirmed ? TFT_GREEN : TFT_WHITE), fill);
      gfx->setCursor(bx + 6, by + 9);
      gfx->printf("%u", (unsigned)digits[i]);
    }
    gfx->setTextSize(1);
  }

  int16_t actY = port ? 132 : 84;
  if (port) {
    uint16_t cFill = (cursorPos == 8) ? doneBg : M5.Display.color565(15, 23, 42);
    gfx->fillRoundRect(8, actY, w - 16, 22, 4, cFill);
    gfx->drawRoundRect(8, actY, w - 16, 22, 4, (cursorPos == 8) ? TFT_WHITE : TFT_GREEN);
    gfx->setTextColor(TFT_WHITE, cFill);
    gfx->setCursor(16, actY + 7);
    gfx->print("CONFIRM PASSCODE");

    uint16_t eFill = (cursorPos == 9) ? actBg : M5.Display.color565(15, 23, 42);
    gfx->fillRoundRect(8, actY + 26, w - 16, 20, 4, eFill);
    gfx->setTextColor(TFT_WHITE, eFill);
    gfx->setCursor(22, actY + 32);
    gfx->print("EDIT DIGITS");

    uint16_t bFill = (cursorPos == 10) ? TFT_RED : M5.Display.color565(15, 23, 42);
    gfx->fillRoundRect(8, actY + 50, w - 16, 20, 4, bFill);
    gfx->setTextColor(TFT_WHITE, bFill);
    gfx->setCursor(22, actY + 56);
    gfx->print("BACK TO APs");
  } else {
    uint16_t cFill = (cursorPos == 8) ? doneBg : M5.Display.color565(15, 23, 42);
    gfx->fillRoundRect(8, actY, 108, 22, 4, cFill);
    gfx->drawRoundRect(8, actY, 108, 22, 4, (cursorPos == 8) ? TFT_WHITE : TFT_GREEN);
    gfx->setTextColor(TFT_WHITE, cFill);
    gfx->setCursor(16, actY + 7);
    gfx->print("CONFIRM CODE");

    uint16_t eFill = (cursorPos == 9) ? actBg : M5.Display.color565(15, 23, 42);
    gfx->fillRoundRect(122, actY, 54, 22, 4, eFill);
    gfx->setTextColor(TFT_WHITE, eFill);
    gfx->setCursor(134, actY + 7);
    gfx->print("EDIT");

    uint16_t bFill = (cursorPos == 10) ? TFT_RED : M5.Display.color565(15, 23, 42);
    gfx->fillRoundRect(182, actY, 50, 22, 4, bFill);
    gfx->setTextColor(TFT_WHITE, bFill);
    gfx->setCursor(194, actY + 7);
    gfx->print("BACK");
  }

  int16_t footY = h - 18;
  gfx->fillRect(0, footY, w, 18, footBg);
  gfx->drawFastHLine(0, footY, w, M5.Display.color565(51, 65, 85));
  gfx->setTextColor(TFT_ORANGE, footBg);
  gfx->setCursor(4, footY + 5);
  if (cursorPos < 8) {
    gfx->print(port ? "[B]+1 [A]Next" : "[B]:+1 Digit [A]Next");
  } else {
    gfx->print(port ? "[B]Mv [A]OK" : "[B]:Move [A]Confirm");
  }
  drawClockBadgeOnGfx(gfx, w - 3, footY + 5, footBg, port);

  if (useSprite) {
    uiCanvas.pushSprite(0, 0);
  } else {
    gfx->endWrite();
  }
}

void collectSortedScanResults(std::vector<ScannedApEntry>& outAps, int count) {
  outAps.clear();
  for (int i = 0; i < count; i++) {
    String ssid = WiFi.SSID(i);
    if (ssid.length() == 0) continue;

    int32_t rssi = WiFi.RSSI(i);
    int32_t ch   = WiFi.channel(i);
    bool isOpen  = (WiFi.encryptionType(i) == WIFI_AUTH_OPEN);
    bool isAir   = (ssid.startsWith("AIR-") || ssid.startsWith("air-") || ssid.startsWith("AIR_"));

    bool foundDup = false;
    for (size_t j = 0; j < outAps.size(); j++) {
      if (outAps[j].ssid == ssid) {
        if (rssi > outAps[j].rssi) {
          outAps[j].rssi    = rssi;
          outAps[j].channel = ch;
        }
        foundDup = true;
        break;
      }
    }
    if (!foundDup) {
      ScannedApEntry entry = { ssid, rssi, ch, isAir, isOpen };
      outAps.push_back(entry);
    }
  }

  for (size_t i = 0; i < outAps.size(); i++) {
    for (size_t j = i + 1; j < outAps.size(); j++) {
      bool swapNeeded = false;
      if (!outAps[i].isAir && outAps[j].isAir) {
        swapNeeded = true;
      } else if (outAps[i].isAir == outAps[j].isAir && outAps[j].rssi > outAps[i].rssi) {
        swapNeeded = true;
      }
      if (swapNeeded) {
        ScannedApEntry tmp = outAps[i];
        outAps[i] = outAps[j];
        outAps[j] = tmp;
      }
    }
  }
}

bool runPasskeyPickerForAp(const ScannedApEntry& ap, String& outPasscode) {
  uint8_t digits[8] = { 0, 0, 0, 0, 0, 0, 0, 0 };

  String seed = (ap.ssid == savedWifiSsid && savedWifiPass.length() == 8) ? savedWifiPass : String(DEFAULT_TARGET_PASSWORD);
  if (seed.length() == 8) {
    bool allDigits = true;
    for (int i = 0; i < 8; i++) {
      if (seed[i] < '0' || seed[i] > '9') { allDigits = false; break; }
    }
    if (allDigits && ap.ssid == savedWifiSsid) {
      for (int i = 0; i < 8; i++) digits[i] = (uint8_t)(seed[i] - '0');
    }
  }

  int cursorPos = 0; // 0..7 = digits, 8 = CONFIRM, 9 = EDIT, 10 = BACK
  unsigned long bHoldStartMs      = 0;
  unsigned long bLastRepeatMs     = 0;
  unsigned long lastClockTickMs   = millis();
  bool          bMenuTriggered    = false;
  resetGlobalBtnB5xCounter();
  drawPasskeyEntryScreen(ap.ssid, digits, cursorPos);

  while (true) {
    pollAllButtons();
    if (checkComboShutdownTriggered()) {
      resetGlobalBtnB5xCounter();
      inWifiSetupScreen = false;
      shutdownCameraAndM5();
    }

    bool redraw = pollImuAutoRotateIfEnabled();
    if (millis() - lastClockTickMs >= 1000) {
      lastClockTickMs = millis();
      redraw = true;
    }

    // Button B: digits <8 increment on tap or hold-repeat; action row (>=8) supports Hold-B (>=600ms) Menu; 5x[B] sleeps
    bool stepB = false;
    if (M5.BtnB.isPressed() && !M5.BtnA.isPressed()) {
      unsigned long nowMs = millis();
      if (bHoldStartMs == 0) {
        bHoldStartMs   = nowMs;
        bLastRepeatMs  = nowMs;
        bMenuTriggered = false;
        if (cursorPos < 8) {
          stepB = true;
        }
      } else if (cursorPos < 8) {
        if ((nowMs - bHoldStartMs >= 420) && (nowMs - bLastRepeatMs >= 140)) {
          stepB = true;
          bLastRepeatMs = nowMs;
        }
      } else if (!bMenuTriggered && (nowMs - bHoldStartMs >= 600)) {
        bMenuTriggered = true;
        resetGlobalBtnB5xCounter();
        runQuickMenu();
        bHoldStartMs = 0;
        redraw = true;
      }
    } else if (!M5.BtnB.isPressed() && bHoldStartMs != 0) {
      unsigned long durB = millis() - bHoldStartMs;
      bHoldStartMs = 0;
      if (!bMenuTriggered && durB >= 20 && durB < 500) {
        if (recordGlobalBtnBClickAndCheck5x()) {
          inWifiSetupScreen = false;
          shutdownCameraAndM5();
        }
        if (cursorPos >= 8) {
          stepB = true;
        }
      }
    } else if (!M5.BtnB.isPressed()) {
      bHoldStartMs = 0;
    }

    if (stepB) {
      playTone(2500, 18);
      if (cursorPos < 8) {
        digits[cursorPos] = (digits[cursorPos] + 1) % 10;
      } else {
        cursorPos++;
        if (cursorPos > 10) cursorPos = 8;
      }
      redraw = true;
    }

    if (M5.BtnA.wasPressed() && !M5.BtnB.isPressed()) {
      resetGlobalBtnB5xCounter();
      if (cursorPos < 8) {
        playTone(2700, 25);
        cursorPos++;
        redraw = true;
      } else if (cursorPos == 8) {
        outPasscode = "";
        for (int i = 0; i < 8; i++) {
          outPasscode += (char)('0' + digits[i]);
        }
        playTone(3200, 60);
        return true;
      } else if (cursorPos == 9) {
        playTone(2300, 25);
        cursorPos = 0;
        redraw = true;
      } else {
        playTone(1700, 30);
        return false;
      }
    }

    if (redraw) {
      drawPasskeyEntryScreen(ap.ssid, digits, cursorPos);
    }
    delay(15);
  }
}

// ----------------------------------------------------------------------------
// Zero-Flicker On-Device Bluetooth (BLE) Wake Setup & 6-Digit Passkey Picker
//   - Scans BLE peripherals (AIR-* first), bonds with 6-digit numeric passkey,
//     and wakes paired Air A01 on StickS3 boot when BT Wake = ON (before Wi-Fi).
//   - Olympus kept exact 128-bit wake GATT UUIDs proprietary in OLYCameraKit;
//     probe writes vendor writable characteristics (or uses custom AIR_BLE_WAKE_*).
// ----------------------------------------------------------------------------
static uint32_t gBleActivePasskey  = 0;
static bool     gBleAuthEventSeen  = false;
static bool     gBleAuthSuccess    = false;
static uint8_t  gBleAuthFailReason = 0;

void onBleGattNotify(BLERemoteCharacteristic* pChr, uint8_t* pData, size_t length, bool isNotify) {
  String uuid = pChr ? String(pChr->getUUID().toString().c_str()) : String("?");
  String line = String(isNotify ? "[BLE-NTF] chr=" : "[BLE-IND] chr=") + uuid +
                " len=" + String((unsigned)length) + " " + formatBytesHexAscii(pData, length);
  appendBleAsyncTrace(line);
}

class AirBleSecurityCallbacks : public BLESecurityCallbacks {
  uint32_t onPassKeyRequest() override {
    char buf[64];
    snprintf(buf, sizeof(buf), "[BLE-SMP] onPassKeyRequest -> supplying %06lu", (unsigned long)gBleActivePasskey);
    appendBleAsyncTrace(buf);
    return gBleActivePasskey;
  }
  void onPassKeyNotify(uint32_t pass_key) override {
    char buf[64];
    snprintf(buf, sizeof(buf), "[BLE-SMP] onPassKeyNotify: %06lu", (unsigned long)pass_key);
    appendBleAsyncTrace(buf);
  }
  bool onConfirmPIN(uint32_t pin) override {
    char buf[64];
    snprintf(buf, sizeof(buf), "[BLE-SMP] onConfirmPIN: %06lu -> YES", (unsigned long)pin);
    appendBleAsyncTrace(buf);
    return true;
  }
  bool onSecurityRequest() override {
    appendBleAsyncTrace("[BLE-SMP] onSecurityRequest -> ACCEPT");
    return true;
  }
#if defined(CONFIG_BLUEDROID_ENABLED)
  void onAuthenticationComplete(esp_ble_auth_cmpl_t auth_cmpl) override {
    gBleAuthEventSeen  = true;
    gBleAuthSuccess    = auth_cmpl.success;
    gBleAuthFailReason = auth_cmpl.fail_reason;
    char buf[80];
    snprintf(buf, sizeof(buf), "[BLE-SMP] AuthComplete: %s reason=0x%02X",
             auth_cmpl.success ? "OK" : "FAIL", (unsigned)auth_cmpl.fail_reason);
    appendBleAsyncTrace(buf);
  }
#endif
};

void drawBtListScreen(const std::vector<ScannedBtEntry>& devs, int selectedIdx, bool scanningNow) {
  int16_t w    = M5.Display.width();
  int16_t h    = M5.Display.height();
  bool    port = isPortraitOrientation();

  float    vbat = getM5BatteryVolts();
  int      bpct = getM5BatteryPercent(vbat);
  uint16_t bCol = (bpct <= 20) ? TFT_RED : (bpct <= 45 ? TFT_YELLOW : TFT_GREEN);

  uint16_t bg     = TFT_BLACK;
  uint16_t hdrBg  = M5.Display.color565(15, 23, 42);
  uint16_t selBg  = M5.Display.color565(234, 88, 12);
  uint16_t footBg = M5.Display.color565(17, 24, 39);

  int extraItems = hasPairedBt ? 3 : 2; // [RESCAN BLE], optional [FORGET BT], [< BACK]
  int totalItems = (int)devs.size() + extraItems;
  int maxVisible = port ? 8 : 5;
  int rowH       = port ? 20 : 18;
  int listTop    = 22;

  int scrollStart = 0;
  if (totalItems > maxVisible && selectedIdx >= maxVisible - 1) {
    scrollStart = selectedIdx - maxVisible + 2;
    int maxStart = totalItems - maxVisible;
    if (scrollStart > maxStart) scrollStart = maxStart;
  }

  bool useSprite = ensureUiCanvas();
  LovyanGFX* gfx = useSprite ? static_cast<LovyanGFX*>(&uiCanvas) : static_cast<LovyanGFX*>(&M5.Display);

  if (!useSprite) gfx->startWrite();
  gfx->fillScreen(bg);
  gfx->fillRect(0, 0, w, 19, hdrBg);
  gfx->drawFastHLine(0, 19, w, M5.Display.color565(51, 65, 85));
  gfx->setTextSize(1);
  gfx->setTextColor(TFT_CYAN, hdrBg);
  gfx->setCursor(4, 6);
  if (scanningNow && devs.empty()) {
    gfx->print("SCANNING BLE...");
  } else {
    gfx->printf(port ? "BT (%d)" : "BLE DEVICES (%d)", (int)devs.size());
  }

  char batStr[16];
  snprintf(batStr, sizeof(batStr), "%d%% %.1fV", bpct, vbat);
  gfx->setTextColor(bCol, hdrBg);
  gfx->setCursor(w - (int16_t)(strlen(batStr) * 6) - 4, 6);
  gfx->print(batStr);

  if (scanningNow && devs.empty()) {
    gfx->setTextColor(TFT_YELLOW, bg);
    gfx->setCursor(10, h / 2 - 8);
    gfx->print("Scanning BLE beacons...");
    gfx->setTextColor(TFT_LIGHTGREY, bg);
    gfx->setCursor(10, h / 2 + 8);
    gfx->print("AIR-A01 devices first");
  } else {
    for (int row = 0; row < maxVisible; row++) {
      int idx = scrollStart + row;
      if (idx >= totalItems) break;

      int16_t ry  = listTop + row * rowH;
      bool    sel = (idx == selectedIdx);
      uint16_t rowFill = sel ? selBg : bg;
      gfx->fillRect(2, ry, w - 4, rowH - 1, rowFill);

      gfx->setCursor(6, ry + 5);
      if (idx < (int)devs.size()) {
        const ScannedBtEntry& d = devs[idx];
        uint16_t txtColor = sel ? TFT_WHITE : (d.isAir ? TFT_GREEN : TFT_LIGHTGREY);
        gfx->setTextColor(txtColor, rowFill);

        String shown = (d.name.length() > 0) ? d.name : d.mac;
        int maxChars = port ? 13 : 24;
        String label = shown.substring(0, maxChars);
        if (sel) {
          gfx->printf(">%-*s %3ddBm", maxChars, label.c_str(), (int)d.rssi);
        } else {
          gfx->printf(" %-*s %3ddBm", maxChars, label.c_str(), (int)d.rssi);
        }
      } else if (idx == (int)devs.size()) {
        gfx->setTextColor(sel ? TFT_WHITE : TFT_CYAN, rowFill);
        gfx->print(sel ? "> [RESCAN BLE]" : "  [RESCAN BLE]");
      } else if (hasPairedBt && idx == (int)devs.size() + 1) {
        gfx->setTextColor(sel ? TFT_WHITE : TFT_RED, rowFill);
        gfx->print(sel ? "> [FORGET PAIRED BT]" : "  [FORGET PAIRED BT]");
      } else {
        gfx->setTextColor(sel ? TFT_WHITE : TFT_YELLOW, rowFill);
        gfx->print(sel ? "> [< BACK]" : "  [< BACK]");
      }
    }
  }

  int16_t footY = h - 18;
  gfx->fillRect(0, footY, w, 18, footBg);
  gfx->drawFastHLine(0, footY, w, M5.Display.color565(51, 65, 85));
  gfx->setTextColor(TFT_ORANGE, footBg);
  gfx->setCursor(4, footY + 5);
  gfx->print(port ? "[B]Nxt [A]OK" : "[B]Next BT [A]Pair");
  drawClockBadgeOnGfx(gfx, w - 3, footY + 5, footBg, port);

  if (useSprite) {
    uiCanvas.pushSprite(0, 0);
  } else {
    gfx->endWrite();
  }
}

void drawBtPasskeyScreen(const String& devName, const uint8_t digits[6], int cursorPos) {
  int16_t w    = M5.Display.width();
  int16_t h    = M5.Display.height();
  bool    port = isPortraitOrientation();

  float    vbat = getM5BatteryVolts();
  int      bpct = getM5BatteryPercent(vbat);
  uint16_t bCol = (bpct <= 20) ? TFT_RED : (bpct <= 45 ? TFT_YELLOW : TFT_GREEN);

  uint16_t bg     = TFT_BLACK;
  uint16_t hdrBg  = M5.Display.color565(15, 23, 42);
  uint16_t footBg = M5.Display.color565(17, 24, 39);
  uint16_t actBg  = M5.Display.color565(234, 88, 12);
  uint16_t doneBg = M5.Display.color565(22, 163, 74);

  bool useSprite = ensureUiCanvas();
  LovyanGFX* gfx = useSprite ? static_cast<LovyanGFX*>(&uiCanvas) : static_cast<LovyanGFX*>(&M5.Display);

  if (!useSprite) gfx->startWrite();
  gfx->fillScreen(bg);
  gfx->fillRect(0, 0, w, 18, hdrBg);
  gfx->drawFastHLine(0, 18, w, M5.Display.color565(51, 65, 85));
  gfx->setTextSize(1);
  gfx->setTextColor(TFT_CYAN, hdrBg);
  gfx->setCursor(4, 5);
  gfx->printf("BT:%s", devName.substring(0, port ? 9 : 21).c_str());

  char batStr[16];
  snprintf(batStr, sizeof(batStr), "%d%% %.1fV", bpct, vbat);
  gfx->setTextColor(bCol, hdrBg);
  gfx->setCursor(w - (int16_t)(strlen(batStr) * 6) - 4, 5);
  gfx->print(batStr);

  gfx->setTextColor(TFT_LIGHTGREY, bg);
  gfx->setCursor(6, port ? 26 : 24);
  gfx->print(cursorPos < 6 ? "6-Digit BT Passkey:" : "Confirm 6-Digit BT Key?");

  if (port) {
    int boxW = 34, boxH = 30, gap = 6;
    int startX = (w - (3 * boxW + 2 * gap)) / 2;
    for (int i = 0; i < 6; i++) {
      int row = i / 3;
      int col = i % 3;
      int bx  = startX + col * (boxW + gap);
      int by  = 46 + row * (boxH + 8);
      bool active    = (i == cursorPos);
      bool confirmed = (i < cursorPos);
      uint16_t fill   = active ? actBg : M5.Display.color565(15, 23, 42);
      uint16_t border = active ? TFT_YELLOW : (confirmed ? TFT_GREEN : M5.Display.color565(71, 85, 105));
      gfx->fillRoundRect(bx, by, boxW, boxH, 3, fill);
      gfx->drawRoundRect(bx, by, boxW, boxH, 3, border);
      gfx->setTextSize(2);
      gfx->setTextColor(active ? TFT_WHITE : (confirmed ? TFT_GREEN : TFT_WHITE), fill);
      gfx->setCursor(bx + 11, by + 7);
      gfx->printf("%u", (unsigned)digits[i]);
    }
    gfx->setTextSize(1);
  } else {
    int boxW = 30, boxH = 34, gap = 6;
    int startX = (w - (6 * boxW + 5 * gap)) / 2;
    int by = 40;
    for (int i = 0; i < 6; i++) {
      int bx = startX + i * (boxW + gap);
      bool active    = (i == cursorPos);
      bool confirmed = (i < cursorPos);
      uint16_t fill   = active ? actBg : M5.Display.color565(15, 23, 42);
      uint16_t border = active ? TFT_YELLOW : (confirmed ? TFT_GREEN : M5.Display.color565(71, 85, 105));
      gfx->fillRoundRect(bx, by, boxW, boxH, 3, fill);
      gfx->drawRoundRect(bx, by, boxW, boxH, 3, border);
      gfx->setTextSize(2);
      gfx->setTextColor(active ? TFT_WHITE : (confirmed ? TFT_GREEN : TFT_WHITE), fill);
      gfx->setCursor(bx + 9, by + 9);
      gfx->printf("%u", (unsigned)digits[i]);
    }
    gfx->setTextSize(1);
  }

  int16_t actY = port ? 132 : 84;
  if (port) {
    uint16_t cFill = (cursorPos == 6) ? doneBg : M5.Display.color565(15, 23, 42);
    gfx->fillRoundRect(8, actY, w - 16, 22, 4, cFill);
    gfx->drawRoundRect(8, actY, w - 16, 22, 4, (cursorPos == 6) ? TFT_WHITE : TFT_GREEN);
    gfx->setTextColor(TFT_WHITE, cFill);
    gfx->setCursor(16, actY + 7);
    gfx->print("CONFIRM BT KEY");

    uint16_t eFill = (cursorPos == 7) ? actBg : M5.Display.color565(15, 23, 42);
    gfx->fillRoundRect(8, actY + 26, w - 16, 20, 4, eFill);
    gfx->setTextColor(TFT_WHITE, eFill);
    gfx->setCursor(22, actY + 32);
    gfx->print("EDIT DIGITS");

    uint16_t bFill = (cursorPos == 8) ? TFT_RED : M5.Display.color565(15, 23, 42);
    gfx->fillRoundRect(8, actY + 50, w - 16, 20, 4, bFill);
    gfx->setTextColor(TFT_WHITE, bFill);
    gfx->setCursor(22, actY + 56);
    gfx->print("BACK TO BT LIST");
  } else {
    uint16_t cFill = (cursorPos == 6) ? doneBg : M5.Display.color565(15, 23, 42);
    gfx->fillRoundRect(8, actY, 108, 22, 4, cFill);
    gfx->drawRoundRect(8, actY, 108, 22, 4, (cursorPos == 6) ? TFT_WHITE : TFT_GREEN);
    gfx->setTextColor(TFT_WHITE, cFill);
    gfx->setCursor(16, actY + 7);
    gfx->print("CONFIRM CODE");

    uint16_t eFill = (cursorPos == 7) ? actBg : M5.Display.color565(15, 23, 42);
    gfx->fillRoundRect(122, actY, 54, 22, 4, eFill);
    gfx->setTextColor(TFT_WHITE, eFill);
    gfx->setCursor(134, actY + 7);
    gfx->print("EDIT");

    uint16_t bFill = (cursorPos == 8) ? TFT_RED : M5.Display.color565(15, 23, 42);
    gfx->fillRoundRect(182, actY, 50, 22, 4, bFill);
    gfx->setTextColor(TFT_WHITE, bFill);
    gfx->setCursor(194, actY + 7);
    gfx->print("BACK");
  }

  int16_t footY = h - 18;
  gfx->fillRect(0, footY, w, 18, footBg);
  gfx->drawFastHLine(0, footY, w, M5.Display.color565(51, 65, 85));
  gfx->setTextColor(TFT_ORANGE, footBg);
  gfx->setCursor(4, footY + 5);
  if (cursorPos < 6) {
    gfx->print(port ? "[B]+1 [A]Next" : "[B]:+1 Digit [A]Next");
  } else {
    gfx->print(port ? "[B]Mv [A]OK" : "[B]:Move [A]Confirm");
  }
  drawClockBadgeOnGfx(gfx, w - 3, footY + 5, footBg, port);

  if (useSprite) {
    uiCanvas.pushSprite(0, 0);
  } else {
    gfx->endWrite();
  }
}

bool runBtPasskeyPicker(const ScannedBtEntry& dev, uint32_t& outPin6) {
  uint8_t digits[6] = { 0, 0, 0, 0, 0, 0 };
  if (hasPairedBt && dev.mac == savedBtMac) {
    uint32_t p = savedBtPin;
    for (int i = 5; i >= 0; i--) {
      digits[i] = (uint8_t)(p % 10UL);
      p /= 10UL;
    }
  }

  int cursorPos = 0; // 0..5 = digits, 6 = CONFIRM, 7 = EDIT, 8 = BACK
  unsigned long bHoldStartMs    = 0;
  unsigned long bLastRepeatMs   = 0;
  unsigned long lastClockTickMs = millis();
  bool          bMenuTriggered  = false;
  resetGlobalBtnB5xCounter();
  String titleName = (dev.name.length() > 0) ? dev.name : dev.mac;
  drawBtPasskeyScreen(titleName, digits, cursorPos);

  while (true) {
    pollAllButtons();
    if (checkComboShutdownTriggered()) {
      resetGlobalBtnB5xCounter();
      inBtSetupScreen = false;
      shutdownCameraAndM5();
    }
    bool redraw = pollImuAutoRotateIfEnabled();
    if (millis() - lastClockTickMs >= 1000) {
      lastClockTickMs = millis();
      redraw = true;
    }

    bool stepB = false;
    if (M5.BtnB.isPressed() && !M5.BtnA.isPressed()) {
      unsigned long nowMs = millis();
      if (bHoldStartMs == 0) {
        bHoldStartMs   = nowMs;
        bLastRepeatMs  = nowMs;
        bMenuTriggered = false;
        if (cursorPos < 6) stepB = true;
      } else if (cursorPos < 6) {
        if ((nowMs - bHoldStartMs >= 420) && (nowMs - bLastRepeatMs >= 140)) {
          stepB = true;
          bLastRepeatMs = nowMs;
        }
      } else if (!bMenuTriggered && (nowMs - bHoldStartMs >= 600)) {
        bMenuTriggered = true;
        resetGlobalBtnB5xCounter();
        runQuickMenu();
        bHoldStartMs = 0;
        redraw = true;
      }
    } else if (!M5.BtnB.isPressed() && bHoldStartMs != 0) {
      unsigned long durB = millis() - bHoldStartMs;
      bHoldStartMs = 0;
      if (!bMenuTriggered && durB >= 20 && durB < 500) {
        if (recordGlobalBtnBClickAndCheck5x()) {
          inBtSetupScreen = false;
          BLEDevice::deinit(true);
          shutdownCameraAndM5();
        }
        if (cursorPos >= 6) {
          stepB = true;
        }
      }
    } else if (!M5.BtnB.isPressed()) {
      bHoldStartMs = 0;
    }

    if (stepB) {
      playTone(2500, 18);
      if (cursorPos < 6) {
        digits[cursorPos] = (digits[cursorPos] + 1) % 10;
      } else {
        cursorPos++;
        if (cursorPos > 8) cursorPos = 6;
      }
      redraw = true;
    }

    if (M5.BtnA.wasPressed() && !M5.BtnB.isPressed()) {
      resetGlobalBtnB5xCounter();
      if (cursorPos < 6) {
        playTone(2700, 25);
        cursorPos++;
        redraw = true;
      } else if (cursorPos == 6) {
        uint32_t pinVal = 0;
        for (int i = 0; i < 6; i++) pinVal = (pinVal * 10UL) + digits[i];
        outPin6 = pinVal;
        playTone(3200, 60);
        return true;
      } else if (cursorPos == 7) {
        playTone(2300, 25);
        cursorPos = 0;
        redraw = true;
      } else {
        playTone(1700, 30);
        return false;
      }
    }

    if (redraw) {
      drawBtPasskeyScreen(titleName, digits, cursorPos);
    }
    delay(15);
  }
}

void performBleScanCollect(std::vector<ScannedBtEntry>& outDevs) {
  outDevs.clear();
  BLEDevice::init("M5StickS3");
  BLEScan* pScan = BLEDevice::getScan();
  pScan->setActiveScan(true);
  pScan->setInterval(100);
  pScan->setWindow(99);

#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  BLEScanResults* resPtr = pScan->start(3, false);
#else
  BLEScanResults resObj = pScan->start(3, false);
  BLEScanResults* resPtr = &resObj;
#endif

  int count = resPtr ? resPtr->getCount() : 0;
  for (int i = 0; i < count; i++) {
    BLEAdvertisedDevice dev = resPtr->getDevice(i);
    String name = String(dev.getName().c_str());
    String mac  = String(dev.getAddress().toString().c_str());
    int32_t rssi = (int32_t)dev.getRSSI();
    uint8_t aType = (uint8_t)dev.getAddressType();
    bool hasOlyMfg = false;
    if (dev.haveManufacturerData()) {
      auto mData = dev.getManufacturerData();
      // Olympus Imaging Corp SIG Company ID = 0x04D1 (little-endian D1 04)
      if (mData.length() >= 2 && (uint8_t)mData[0] == 0xD1 && (uint8_t)mData[1] == 0x04) {
        hasOlyMfg = true;
      }
    }
    String upper = name;
    upper.toUpperCase();
    bool isAir = (hasOlyMfg || upper.startsWith("AIR") || upper.indexOf("OLYMPUS") != -1);
    if (name.length() == 0 && isAir) {
      name = "OLY-AIR";
    }

    if (name.length() == 0 && !isAir) {
      // Skip unnamed background BLE beacons unless we have very few named entries
      if (outDevs.size() >= 6) continue;
    }

    bool dup = false;
    for (size_t j = 0; j < outDevs.size(); j++) {
      if (outDevs[j].mac == mac) { dup = true; break; }
    }
    if (!dup) {
      ScannedBtEntry e = { name, mac, rssi, aType, isAir };
      outDevs.push_back(e);
    }
  }
  pScan->clearResults();

  for (size_t i = 0; i < outDevs.size(); i++) {
    for (size_t j = i + 1; j < outDevs.size(); j++) {
      bool swapNeeded = false;
      if (!outDevs[i].isAir && outDevs[j].isAir) swapNeeded = true;
      else if (outDevs[i].isAir == outDevs[j].isAir && outDevs[j].rssi > outDevs[i].rssi) swapNeeded = true;
      if (swapNeeded) {
        ScannedBtEntry tmp = outDevs[i];
        outDevs[i] = outDevs[j];
        outDevs[j] = tmp;
      }
    }
  }
}

bool executeBleConnectAndWake(const String& name, const String& mac, uint8_t addrType, uint32_t pin6) {
  if (mac.length() == 0) return false;
  showConnectingSplash("BLE Wake Air A01", (name.length() > 0) ? name : mac);

  traceAppend("=== BLE TRACE (" + name + " " + mac + ") ===", false);
  gBleAuthEventSeen  = false;
  gBleAuthSuccess    = false;
  gBleAuthFailReason = 0;

  BLEDevice::init("M5StickS3");
  gBleActivePasskey = pin6 % 1000000UL;
#if defined(CONFIG_BLUEDROID_ENABLED)
  BLEDevice::setEncryptionLevel(ESP_BLE_SEC_ENCRYPT);
#endif
  static AirBleSecurityCallbacks secCb;
  BLEDevice::setSecurityCallbacks(&secCb);
  BLESecurity bleSec;
  // Air A01 is Bluetooth 4.0 LE (pre-4.2 Secure Connections), so prefer Legacy MITM + Bond
#if defined(CONFIG_BLUEDROID_ENABLED) && defined(ESP_LE_AUTH_BOND) && defined(ESP_LE_AUTH_REQ_MITM)
  bleSec.setAuthenticationMode((esp_ble_auth_req_t)(ESP_LE_AUTH_BOND | ESP_LE_AUTH_REQ_MITM));
#elif defined(ESP_LE_AUTH_BOND) && defined(ESP_LE_AUTH_REQ_MITM)
  bleSec.setAuthenticationMode((uint8_t)(ESP_LE_AUTH_BOND | ESP_LE_AUTH_REQ_MITM));
#else
  bleSec.setAuthenticationMode(ESP_LE_AUTH_REQ_SC_MITM_BOND);
#endif
  bleSec.setCapability(ESP_IO_CAP_IN);
  bleSec.setInitEncryptionKey(ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);

  String  connectMac  = mac;
  uint8_t connectType = addrType;
  BLEClient* pClient  = BLEDevice::createClient();
  BLEAddress targetAddr(connectMac.c_str());

#if defined(CONFIG_BLUEDROID_ENABLED)
  bool connected = pClient->connect(targetAddr, (esp_ble_addr_type_t)connectType);
#else
  bool connected = pClient->connect(targetAddr, connectType, 4500);
#endif

  // Fallback scan by saved name / Olympus Mfg ID 0x04D1 if direct MAC timed out (e.g. rotated RPA address)
  if (!connected) {
    traceAppend("[BLE] Direct connect miss -> scanning 3s for Air A01 (0x04D1)...", false);
    BLEScan* pScan = BLEDevice::getScan();
    pScan->setActiveScan(true);
    pScan->setInterval(100);
    pScan->setWindow(99);
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
    BLEScanResults* resPtr = pScan->start(3, false);
#else
    BLEScanResults resObj = pScan->start(3, false);
    BLEScanResults* resPtr = &resObj;
#endif
    int count = resPtr ? resPtr->getCount() : 0;
    for (int i = 0; i < count; i++) {
      BLEAdvertisedDevice d = resPtr->getDevice(i);
      String dName = String(d.getName().c_str());
      String dUp = dName;
      dUp.toUpperCase();
      bool olyMfg = false;
      String mfgHex = "";
      if (d.haveManufacturerData()) {
        auto mData = d.getManufacturerData();
        mfgHex = formatBytesHexAscii((const uint8_t*)mData.c_str(), mData.length(), 16);
        if (mData.length() >= 2 && (uint8_t)mData[0] == 0xD1 && (uint8_t)mData[1] == 0x04) olyMfg = true;
      }
      if ((name.length() > 0 && dName == name) || olyMfg || dUp.startsWith("AIR")) {
        connectMac  = String(d.getAddress().toString().c_str());
        connectType = (uint8_t)d.getAddressType();
        String svcAdv = d.haveServiceUUID() ? String(d.getServiceUUID().toString().c_str()) : String("none");
        traceAppend("[BLE-ADV] name=" + dName + " mac=" + connectMac + " type=" + String((unsigned)connectType) +
                    " rssi=" + String((int)d.getRSSI()) + " svc=" + svcAdv + " mfg=" + mfgHex, false);
        BLEAddress foundAddr(connectMac.c_str());
#if defined(CONFIG_BLUEDROID_ENABLED)
        connected = pClient->connect(foundAddr, (esp_ble_addr_type_t)connectType);
#else
        connected = pClient->connect(foundAddr, connectType, 4500);
#endif
        if (connected) break;
      }
    }
    pScan->clearResults();
  }

  traceAppend("[BLE] Connect " + name + " (" + connectMac + " type=" + String((unsigned)connectType) +
              ") -> " + String(connected ? "OK" : "FAIL"), false);

  bool wokeAny = false;
  if (connected) {
    bool secOk = pClient->secureConnection();
    delay(200);
    flushBleAsyncTrace(false);

    String authBadge = "SEC WARN";
    if (gBleAuthEventSeen) {
      if (gBleAuthSuccess) {
        authBadge = "BOND OK";
      } else {
        char fBuf[24];
        snprintf(fBuf, sizeof(fBuf), "AUTH FAIL 0x%02X", (unsigned)gBleAuthFailReason);
        authBadge = String(fBuf);
      }
    } else if (secOk) {
      authBadge = "BOND OK (ENC)";
    }
    traceAppend("[BLE] secureConnection=" + String(secOk ? "1" : "0") + " status=" + authBadge, false);
    showConnectingSplash(authBadge, connectMac);

    std::map<std::string, BLERemoteService*>* svcs = pClient->getServices();
    if (svcs) {
      traceAppend("[BLE-GATT] Services=" + String((unsigned)svcs->size()), false);
      for (auto it = svcs->begin(); it != svcs->end(); ++it) {
        String sUuid = String(it->first.c_str());
        std::map<std::string, BLERemoteCharacteristic*>* chrs = it->second->getCharacteristics();
        if (!chrs) continue;
        for (auto cit = chrs->begin(); cit != chrs->end(); ++cit) {
          BLERemoteCharacteristic* c = cit->second;
          if (!c) continue;
          String props = String(c->canRead() ? "R" : "") +
                         String(c->canWrite() ? "W" : "") +
                         String(c->canWriteNoResponse() ? "w" : "") +
                         String(c->canNotify() ? "N" : "") +
                         String(c->canIndicate() ? "I" : "");
          String readInfo = "";
          if (c->canRead()) {
            auto rVal = c->readValue();
            readInfo = " val=" + formatBytesHexAscii((const uint8_t*)rVal.c_str(), rVal.length(), 20);
          }
          BLERemoteDescriptor* pCccd = c->getDescriptor(BLEUUID((uint16_t)0x2902));
          String cccdInfo = pCccd ? " [2902]" : "";
          traceAppend("[BLE-GATT] svc=" + sUuid + " chr=" + String(cit->first.c_str()) +
                      " [" + props + "]" + cccdInfo + readInfo, false);

          if (c->canNotify() || c->canIndicate()) {
            c->registerForNotify(onBleGattNotify);
            traceAppend("[BLE-GATT] Subscribed notify on " + String(cit->first.c_str()), false);
          }
        }
      }
    }

    // Pause briefly to capture any immediate notifications post-CCCD subscribe
    delay(250);
    flushBleAsyncTrace(false);

    if (strlen(AIR_BLE_WAKE_SERVICE_UUID) > 0 && strlen(AIR_BLE_WAKE_CHAR_UUID) > 0) {
      BLERemoteService* pSvc = pClient->getService(BLEUUID(AIR_BLE_WAKE_SERVICE_UUID));
      if (pSvc) {
        BLERemoteCharacteristic* pChr = pSvc->getCharacteristic(BLEUUID(AIR_BLE_WAKE_CHAR_UUID));
        if (pChr && (pChr->canWrite() || pChr->canWriteNoResponse())) {
          uint8_t wakeByte = 0x01;
          pChr->writeValue(&wakeByte, 1, pChr->canWrite());
          wokeAny = true;
          traceAppend("[BLE] Wrote custom AIR_BLE_WAKE_CHAR_UUID", false);
        }
      }
    } else if (svcs) {
      // Best-effort probe on non-SIG 128-bit writable characteristics (OLYCameraKit wakeup UUID/payload is proprietary)
      char pinAscii[8];
      snprintf(pinAscii, sizeof(pinAscii), "%06lu", (unsigned long)gBleActivePasskey);
      for (auto it = svcs->begin(); it != svcs->end(); ++it) {
        String sUuid = String(it->first.c_str());
        if (sUuid.startsWith("00001800") || sUuid.startsWith("00001801") || sUuid.startsWith("0000180a")) continue;
        std::map<std::string, BLERemoteCharacteristic*>* chrs = it->second->getCharacteristics();
        if (!chrs) continue;
        for (auto cit = chrs->begin(); cit != chrs->end(); ++cit) {
          BLERemoteCharacteristic* c = cit->second;
          if (c && (c->canWrite() || c->canWriteNoResponse())) {
            uint8_t cmd1[1] = { 0x01 };
            c->writeValue(cmd1, 1, c->canWrite());
            delay(60);
            c->writeValue((uint8_t*)pinAscii, 6, c->canWrite());
            wokeAny = true;
            traceAppend("[BLE] Probed vendor svc=" + sUuid + " chr=" + String(cit->first.c_str()) + " (0x01+PIN)", false);
            delay(120);
          }
        }
      }
    }

    // Listen ~500ms after writes for any Air A01 notify responses
    for (int w = 0; w < 10; w++) {
      delay(50);
      flushBleAsyncTrace(false);
    }
    showConnectingSplash(authBadge, wokeAny ? "GATT Trace Saved" : connectMac);
    delay(450);
    pClient->disconnect();
  } else {
    showConnectingSplash("BLE Not Found", "Unplug USB + Blink Grn");
    delay(550);
  }
  flushBleAsyncTrace(true);
  BLEDevice::deinit(true);
  delay(80);
  return connected || wokeAny;
}

bool wakeAirViaBluetoothOnBoot() {
  if (!btWakeOnBoot || !hasPairedBt) return false;
  Serial.printf("[BLE] Auto-Wake enabled -> waking '%s' (%s)...\\n", savedBtName.c_str(), savedBtMac.c_str());
  bool ok = executeBleConnectAndWake(savedBtName, savedBtMac, savedBtAddrType, savedBtPin);
  Serial.printf("[BLE] Wake handshake result=%d (handing off RF to Fast Wi-Fi)\\n", ok ? 1 : 0);
  return ok;
}

bool runBtSetupWizard() {
  inBtSetupScreen = true;
  std::vector<ScannedBtEntry> devs;
  int selectedIdx = 0;

  drawBtListScreen(devs, selectedIdx, true);
  performBleScanCollect(devs);
  drawBtListScreen(devs, selectedIdx, false);

  unsigned long bDownMs         = 0;
  unsigned long lastClockTickMs = millis();
  bool          bLongTrig       = false;
  bool          comboCancel     = false;
  resetGlobalBtnB5xCounter();

  while (true) {
    pollAllButtons();
    serviceSerialTraceConsole();
    if (checkComboShutdownTriggered()) {
      resetGlobalBtnB5xCounter();
      inBtSetupScreen = false;
      shutdownCameraAndM5();
    }

    if (M5.BtnA.isPressed() && M5.BtnB.isPressed()) {
      comboCancel = true;
      bDownMs = 0;
      resetGlobalBtnB5xCounter();
    }

    bool redraw = pollImuAutoRotateIfEnabled();
    if (millis() - lastClockTickMs >= 1000) {
      lastClockTickMs = millis();
      redraw = true;
    }

    if (M5.BtnB.isPressed() && !M5.BtnA.isPressed()) {
      if (!comboCancel) {
        if (bDownMs == 0) {
          bDownMs = millis();
          bLongTrig = false;
        } else if (!bLongTrig && (millis() - bDownMs >= 600)) {
          bLongTrig = true;
          resetGlobalBtnB5xCounter();
          runQuickMenu();
          bDownMs = 0;
          comboCancel = M5.BtnB.isPressed();
          redraw = true;
        }
      }
    } else if (!M5.BtnB.isPressed()) {
      if (comboCancel && !M5.BtnA.isPressed()) {
        comboCancel = false;
        bDownMs = 0;
      } else if (bDownMs != 0) {
        unsigned long durB = millis() - bDownMs;
        bDownMs = 0;
        if (!bLongTrig && !comboCancel && durB >= 20 && durB < 600) {
          if (recordGlobalBtnBClickAndCheck5x()) {
            inBtSetupScreen = false;
            BLEDevice::deinit(true);
            shutdownCameraAndM5();
          }
          int extraItems = hasPairedBt ? 3 : 2;
          int totalItems = (int)devs.size() + extraItems;
          if (totalItems > 0) {
            playTone(2300, 18);
            selectedIdx = (selectedIdx + 1) % totalItems;
            redraw = true;
          }
        }
      }
    }

    if (M5.BtnA.wasPressed() && !M5.BtnB.isPressed() && !comboCancel) {
      resetGlobalBtnB5xCounter();
      int extraIdxRescan = (int)devs.size();
      int extraIdxForget = hasPairedBt ? (int)devs.size() + 1 : -1;
      int extraIdxBack   = hasPairedBt ? (int)devs.size() + 2 : (int)devs.size() + 1;

      if (selectedIdx == extraIdxRescan) {
        playTone(2600, 30);
        selectedIdx = 0;
        drawBtListScreen(devs, selectedIdx, true);
        performBleScanCollect(devs);
        redraw = true;
      } else if (hasPairedBt && selectedIdx == extraIdxForget) {
        playTone(1700, 40);
        clearBtCredsInNvs();
        selectedIdx = 0;
        redraw = true;
      } else if (selectedIdx == extraIdxBack) {
        playTone(2000, 30);
        BLEDevice::deinit(true);
        inBtSetupScreen = false;
        return false;
      } else if (selectedIdx >= 0 && selectedIdx < (int)devs.size()) {
        ScannedBtEntry chosen = devs[selectedIdx];
        playTone(3000, 40);
        uint32_t pin6 = 0;
        if (runBtPasskeyPicker(chosen, pin6)) {
          btWakeOnBoot = true;
          String dispName = (chosen.name.length() > 0) ? chosen.name : chosen.mac;
          saveBtCredsToNvs(dispName, chosen.mac, chosen.addrType, pin6);
          executeBleConnectAndWake(dispName, chosen.mac, chosen.addrType, pin6);
          inBtSetupScreen = false;
          return true;
        }
        redraw = true;
      }
    }

    if (redraw) {
      drawBtListScreen(devs, selectedIdx, false);
    }
    delay(15);
  }
}

bool runWifiSetupWizard(bool canReturnToSearch) {
  inWifiSetupScreen = true;
  initWifiFastDriver();
  WiFi.disconnect(false, false);

  std::vector<ScannedApEntry> aps;
  int selectedIdx = 0;
  bool scanInFlight = true;
  unsigned long wizBDownMs      = 0;
  unsigned long lastClockTickMs = millis();
  bool wizBLongTriggered        = false;
  bool wizComboCancel           = false;
  resetGlobalBtnB5xCounter();

  WiFi.scanDelete();
  WiFi.scanNetworks(true, false, false, 180);
  drawApListScreen(aps, selectedIdx, true, canReturnToSearch);

  while (true) {
    pollAllButtons();
    serviceSerialTraceConsole();
    if (checkComboShutdownTriggered()) {
      resetGlobalBtnB5xCounter();
      inWifiSetupScreen = false;
      WiFi.scanDelete();
      shutdownCameraAndM5();
    }

    if (M5.BtnA.isPressed() && M5.BtnB.isPressed()) {
      wizComboCancel = true;
      wizBDownMs = 0;
      resetGlobalBtnB5xCounter();
    }

    bool redraw = pollImuAutoRotateIfEnabled();
    if (millis() - lastClockTickMs >= 1000) {
      lastClockTickMs = millis();
      redraw = true;
    }

    if (scanInFlight) {
      int n = WiFi.scanComplete();
      if (n >= 0) {
        scanInFlight = false;
        collectSortedScanResults(aps, n);
        WiFi.scanDelete();
        int extraItems = canReturnToSearch ? 2 : 1;
        int totalItems = (int)aps.size() + extraItems;
        if (selectedIdx >= totalItems) selectedIdx = 0;
        redraw = true;
      } else if (n == WIFI_SCAN_FAILED) {
        scanInFlight = false;
        redraw = true;
      }
    }

    // Button B: Short release steps AP list (5x[B] enters Deep Sleep); Hold >=600ms opens Quick Menu
    if (M5.BtnB.isPressed() && !M5.BtnA.isPressed()) {
      if (!wizComboCancel) {
        if (wizBDownMs == 0) {
          wizBDownMs = millis();
          wizBLongTriggered = false;
        } else if (!wizBLongTriggered && (millis() - wizBDownMs >= 600)) {
          wizBLongTriggered = true;
          resetGlobalBtnB5xCounter();
          runQuickMenu();
          wizBDownMs = 0;
          wizComboCancel = M5.BtnB.isPressed();
          redraw = true;
        }
      }
    } else if (!M5.BtnB.isPressed()) {
      if (wizComboCancel && !M5.BtnA.isPressed()) {
        wizComboCancel = false;
        wizBDownMs = 0;
      } else if (wizBDownMs != 0) {
        unsigned long durB = millis() - wizBDownMs;
        wizBDownMs = 0;
        if (!wizBLongTriggered && !wizComboCancel && durB >= 20 && durB < 600) {
          if (recordGlobalBtnBClickAndCheck5x()) {
            inWifiSetupScreen = false;
            WiFi.scanDelete();
            shutdownCameraAndM5();
          }
          int extraItems = canReturnToSearch ? 2 : 1;
          int totalItems = (int)aps.size() + extraItems;
          if (totalItems > 0) {
            playTone(2300, 18);
            selectedIdx = (selectedIdx + 1) % totalItems;
            redraw = true;
          }
        }
      }
    }

    if (M5.BtnA.wasPressed() && !M5.BtnB.isPressed() && !wizComboCancel) {
      resetGlobalBtnB5xCounter();
      if (selectedIdx == (int)aps.size()) {
        playTone(2600, 30);
        aps.clear();
        selectedIdx = 0;
        scanInFlight = true;
        WiFi.scanDelete();
        WiFi.scanNetworks(true, false, false, 180);
        redraw = true;
      } else if (canReturnToSearch && selectedIdx == (int)aps.size() + 1) {
        playTone(2200, 30);
        WiFi.scanDelete();
        inWifiSetupScreen = false;
        return false;
      } else if (selectedIdx >= 0 && selectedIdx < (int)aps.size()) {
        ScannedApEntry chosen = aps[selectedIdx];
        playTone(3000, 40);
        WiFi.scanDelete();

        String enteredPass = "";
        if (chosen.isOpen) {
          saveWifiCredsToNvs(chosen.ssid, "", (uint8_t)chosen.channel);
          inWifiSetupScreen = false;
          return true;
        } else if (runPasskeyPickerForAp(chosen, enteredPass)) {
          saveWifiCredsToNvs(chosen.ssid, enteredPass, (uint8_t)chosen.channel);
          inWifiSetupScreen = false;
          return true;
        } else {
          scanInFlight = true;
          WiFi.scanNetworks(true, false, false, 180);
          redraw = true;
        }
      }
    }

    if (redraw) {
      drawApListScreen(aps, selectedIdx, scanInFlight, canReturnToSearch);
    }
    delay(15);
  }
}

// ----------------------------------------------------------------------------
// Fast Static-IP + Channel-Cached Connect & Persistent Saved-Air Search Loop
// ----------------------------------------------------------------------------
bool tryFastConnectSavedCredentials(uint32_t timeoutMs) {
  if (!hasSavedWifiCreds) return false;

  initWifiFastDriver();
  WiFi.disconnect(false, false);
  applyAirStaticIp(); // Must be called BEFORE WiFi.begin() to skip ~1s DHCP exchange

  uint8_t ch = sessionChannelHint;
  Serial.printf("[WIFI] Fast connect '%s' (ch=%u, static .100)...\\n",
                savedWifiSsid.c_str(), (unsigned)ch);

  if (ch > 0) {
    WiFi.begin(savedWifiSsid.c_str(), savedWifiPass.c_str(), (int32_t)ch);
  } else {
    WiFi.begin(savedWifiSsid.c_str(), savedWifiPass.c_str());
  }

  unsigned long startMs = millis();
  unsigned long bHoldMs = 0;
  unsigned long lastSplashTickMs = startMs;
  bool bMenuDone = false;
  while (millis() - startMs < timeoutMs) {
    pollAllButtons();
    serviceSerialTraceConsole();
    if (checkComboShutdownTriggered()) {
      resetGlobalBtnB5xCounter();
      shutdownCameraAndM5();
    }
    if (millis() - lastSplashTickMs >= 1000) {
      lastSplashTickMs = millis();
      showConnectingSplash("Boot Wi-Fi Connect", savedWifiSsid);
    }
    if (M5.BtnB.isPressed() && !M5.BtnA.isPressed()) {
      if (bHoldMs == 0) {
        bHoldMs = millis();
        bMenuDone = false;
      } else if (!bMenuDone && (millis() - bHoldMs >= 600)) {
        bMenuDone = true;
        resetGlobalBtnB5xCounter();
        bool openWiz = false;
        runQuickMenu(&openWiz);
        bHoldMs = 0;
        if (openWiz) {
          WiFi.disconnect(false, false);
          return false;
        }
        showConnectingSplash("Boot Wi-Fi Connect", savedWifiSsid);
      }
    } else {
      if (!M5.BtnB.isPressed() && bHoldMs != 0 && !bMenuDone) {
        unsigned long durB = millis() - bHoldMs;
        if (durB >= 20 && durB < 600 && recordGlobalBtnBClickAndCheck5x()) {
          WiFi.disconnect(false, false);
          shutdownCameraAndM5();
        }
      }
      bHoldMs = 0;
      bMenuDone = false;
    }

    if (M5.BtnA.wasPressed() && !M5.BtnB.isPressed()) {
      resetGlobalBtnB5xCounter();
      // User pressed Button A to jump into Wi-Fi Setup immediately
      WiFi.disconnect(false, false);
      return false;
    }
    processPendingChannelNvsUpdates();
    if (WiFi.status() == WL_CONNECTED) {
      WiFi.setSleep(false);
      diag.wifiStatus = "Online";
      diag.localIp    = WiFi.localIP().toString();
      diag.wifiRssi   = WiFi.RSSI();
      return true;
    }
    delay(20);
  }
  return (WiFi.status() == WL_CONNECTED);
}

bool ensureAirConnectedForSession(bool allowSetupOnMiss) {
  initWifiFastDriver();

  // First boot with no saved NVS credentials:
  // If user customized DEFAULT_TARGET_SSID away from placeholder, try it once briefly;
  // otherwise go straight to the All-AP Wi-Fi Setup Wizard.
  if (!hasSavedWifiCreds) {
    String defSsid = String(DEFAULT_TARGET_SSID);
    String defPass = String(DEFAULT_TARGET_PASSWORD);
    bool isDefaultPlaceholder = (defSsid == "AIR-A01-12345678" || defSsid.length() == 0);

    if (!isDefaultPlaceholder) {
      savedWifiSsid     = defSsid;
      savedWifiPass     = defPass;
      hasSavedWifiCreds = true;
      showConnectingSplash("Boot Wi-Fi Connect", defSsid);
      if (tryFastConnectSavedCredentials(3000)) {
        saveWifiCredsToNvs(savedWifiSsid, savedWifiPass, (uint8_t)WiFi.channel());
        return true;
      }
      if (AUTO_SCAN_SSID) {
        hasSavedWifiCreds = false;
        savedWifiSsid     = "";
        savedWifiPass     = "";
      }
    }

    if (!hasSavedWifiCreds && allowSetupOnMiss) {
      while (true) {
        if (runWifiSetupWizard(false)) {
          showConnectingSplash("Connecting...", savedWifiSsid);
          if (tryFastConnectSavedCredentials(7000)) {
            return true;
          }
          // Chosen AP didn't connect yet -> allow persistent search OR [A] Wi-Fi setup
          break;
        }
      }
    }
  }

  // Keep searching for previously saved Air unit while letting user press Button A
  // for Wi-Fi Setup OR hold Button B (>=600ms) for Quick Menu (Bright, Gyro, pre-mute Air Sound)!
  uint16_t attempt = 0;
  unsigned long searchStartMs = millis();

  while (true) {
    attempt++;
    processPendingChannelNvsUpdates();

    WiFi.disconnect(false, false);
    applyAirStaticIp();
    uint8_t useCh = (attempt % 2 == 1) ? sessionChannelHint : 0; // alternate fast-ch and full scan
    if (useCh > 0) {
      WiFi.begin(savedWifiSsid.c_str(), savedWifiPass.c_str(), (int32_t)useCh);
    } else {
      WiFi.begin(savedWifiSsid.c_str(), savedWifiPass.c_str());
    }

    drawSearchingSavedScreen(savedWifiSsid, useCh, attempt, (millis() - searchStartMs) / 1000);

    unsigned long attemptStart     = millis();
    unsigned long lastSearchDrawMs = attemptStart;
    unsigned long searchBDownMs    = 0;
    bool searchBLongTriggered      = false;
    bool openWizNow                = false;

    while (millis() - attemptStart < 4500) {
      pollAllButtons();
      serviceSerialTraceConsole();
      if (checkComboShutdownTriggered()) {
        resetGlobalBtnB5xCounter();
        shutdownCameraAndM5();
      }

      if (M5.BtnB.isPressed() && !M5.BtnA.isPressed()) {
        if (searchBDownMs == 0) {
          searchBDownMs = millis();
          searchBLongTriggered = false;
        } else if (!searchBLongTriggered && (millis() - searchBDownMs >= 600)) {
          searchBLongTriggered = true;
          resetGlobalBtnB5xCounter();
          bool reqWiz = false;
          runQuickMenu(&reqWiz);
          searchBDownMs = 0;
          if (reqWiz) {
            openWizNow = true;
            break;
          }
          lastSearchDrawMs = millis();
          drawSearchingSavedScreen(savedWifiSsid, useCh, attempt, (millis() - searchStartMs) / 1000);
        }
      } else {
        if (!M5.BtnB.isPressed() && searchBDownMs != 0 && !searchBLongTriggered) {
          unsigned long durB = millis() - searchBDownMs;
          if (durB >= 20 && durB < 600 && recordGlobalBtnBClickAndCheck5x()) {
            WiFi.disconnect(false, false);
            shutdownCameraAndM5();
          }
        }
        searchBDownMs = 0;
        searchBLongTriggered = false;
      }

      if (pollImuAutoRotateIfEnabled() || (millis() - lastSearchDrawMs >= 1000)) {
        lastSearchDrawMs = millis();
        drawSearchingSavedScreen(savedWifiSsid, useCh, attempt, (millis() - searchStartMs) / 1000);
      }

      // User pressed Button A -> launch Wi-Fi Setup Wizard
      if (M5.BtnA.wasPressed() && !M5.BtnB.isPressed()) {
        resetGlobalBtnB5xCounter();
        playTone(2800, 35);
        openWizNow = true;
        break;
      }

      processPendingChannelNvsUpdates();
      if (WiFi.status() == WL_CONNECTED) {
        WiFi.setSleep(false);
        diag.wifiStatus = "Online";
        diag.localIp    = WiFi.localIP().toString();
        diag.wifiRssi   = WiFi.RSSI();
        Serial.printf("[WIFI] Connected to '%s' on ch=%d | Static IP: %s\\n",
                      savedWifiSsid.c_str(), WiFi.channel(), diag.localIp.c_str());
        return true;
      }
      delay(20);
    }

    if (openWizNow) {
      WiFi.disconnect(false, false);
      runWifiSetupWizard(true);
      attempt = 0;
      searchStartMs = millis();
    }
  }
}

// ----------------------------------------------------------------------------
// AsyncUDP Background Packet Handler (Triple-Buffered RFC 3550 RTP)
// ----------------------------------------------------------------------------
inline uint8_t pickFreeWriteSlot(uint8_t currentW) {
  for (uint8_t i = 0; i < activeFrameSlots; i++) {
    uint8_t cand = (uint8_t)((currentW + 1 + i) % activeFrameSlots);
    if ((int8_t)cand != drawSlot && (int8_t)cand != readySlot) {
      return cand;
    }
  }
  for (uint8_t i = 0; i < activeFrameSlots; i++) {
    uint8_t cand = (uint8_t)((currentW + 1 + i) % activeFrameSlots);
    if ((int8_t)cand != drawSlot) {
      return cand;
    }
  }
  return currentW;
}

void onRtpPacket(AsyncUDPPacket& packet) {
  if (pauseUdpAssembly || !frameBuf[0] || !frameBuf[1]) return;

  const uint8_t* data = packet.data();
  size_t len = packet.length();

  diag.rxPackets++;
  diag.rxBytes += len;
  lastRxPacketMs = millis();

  if (len < 12 || (data[0] >> 6) != 2) return;

  bool     hasPadding   = (data[0] & 0x20) != 0;
  bool     hasExtension = (data[0] & 0x10) != 0;
  uint8_t  csrcCount    = (data[0] & 0x0F);
  bool     isEndOfFrame = (data[1] & 0x80) != 0;
  uint16_t seqNumber    = ((uint16_t)data[2] << 8) | data[3];

  size_t packetEnd = len;
  if (hasPadding) {
    uint8_t padLen = data[len - 1];
    if (padLen > 0 && padLen <= (len - 12)) {
      packetEnd = len - padLen;
    } else {
      currentFrameValid = false;
      return;
    }
  }

  size_t payloadOffset = 12 + ((size_t)csrcCount * 4);
  const uint8_t* extBodyPtr = nullptr;
  size_t extBodyBytes = 0;
  if (hasExtension) {
    if (payloadOffset + 4 > packetEnd) return;
    uint16_t extLengthWords = ((uint16_t)data[payloadOffset + 2] << 8) | data[payloadOffset + 3];
    size_t extBodyStart = payloadOffset + 4;
    size_t extWordsBytes = (size_t)extLengthWords * 4;
    payloadOffset = extBodyStart + extWordsBytes;
    if (payloadOffset <= packetEnd && extWordsBytes > 0) {
      extBodyPtr   = data + extBodyStart;
      extBodyBytes = extWordsBytes;
    }
  }

  if (payloadOffset >= packetEnd) return;

  const uint8_t* payloadData = data + payloadOffset;
  size_t         payloadLen  = packetEnd - payloadOffset;

  if (diag.lastHdr0 == 0 || !frameInProgress) {
    diag.lastHdr0       = data[0];
    diag.lastHdr1       = data[1];
    diag.lastPayloadOff = (uint8_t)(payloadOffset & 0xFF);
  }

  bool seqGap = false;
  if (lastRtpSequence != -1) {
    uint16_t expectedSeq = (uint16_t)(lastRtpSequence + 1);
    uint16_t diff = (uint16_t)(seqNumber - expectedSeq);
    if (diff != 0) {
      seqGap = true;
      diag.droppedPackets += (diff < 1000) ? diff : 1;
      currentFrameValid = false;
    }
  }
  lastRtpSequence = seqNumber;

  bool foundSoi = (payloadLen >= 2 && payloadData[0] == 0xFF && payloadData[1] == 0xD8);
  if (!foundSoi && !frameInProgress && payloadLen >= 4) {
    size_t scanLimit = (payloadLen < 18) ? (payloadLen - 1) : 16;
    for (size_t i = 1; i < scanLimit; i++) {
      if (payloadData[i] == 0xFF && payloadData[i + 1] == 0xD8) {
        payloadData += i;
        payloadLen  -= i;
        foundSoi = true;
        break;
      }
    }
  }

  if (foundSoi) {
    portENTER_CRITICAL(&frameMux);
    if ((int8_t)writeSlot == drawSlot || (int8_t)writeSlot == readySlot) {
      writeSlot = pickFreeWriteSlot(writeSlot);
    }
    portEXIT_CRITICAL(&frameMux);

    writeLen          = 0;
    writeExtLen       = 0;
    currentFrameValid = true;
    frameInProgress   = true;

    if (extBodyPtr && extBodyBytes > 0) {
      size_t copyLen = (extBodyBytes <= sizeof(rtpExtBuf[0])) ? extBodyBytes : sizeof(rtpExtBuf[0]);
      memcpy(rtpExtBuf[writeSlot], extBodyPtr, copyLen);
      writeExtLen = copyLen;
    }
  } else if (seqGap) {
    frameInProgress = false;
  }

  if (frameInProgress && currentFrameValid) {
    if (frameBuf[writeSlot] && (writeLen + payloadLen <= FRAME_SLOT_SIZE)) {
      memcpy(&frameBuf[writeSlot][writeLen], payloadData, payloadLen);
      writeLen += payloadLen;
    } else {
      writeLen          = 0;
      currentFrameValid = false;
      frameInProgress   = false;
      diag.corruptFrames++;
    }
  }

  if (isEndOfFrame) {
    if (frameInProgress && currentFrameValid && writeLen > 200 && frameBuf[writeSlot]) {
      uint8_t* slotPtr = frameBuf[writeSlot];
      size_t trimmedLen = writeLen;
      if (!(slotPtr[trimmedLen - 2] == 0xFF && slotPtr[trimmedLen - 1] == 0xD9)) {
        size_t minSearch = (trimmedLen > 10) ? (trimmedLen - 10) : 2;
        for (size_t k = trimmedLen - 1; k > minSearch; k--) {
          if (slotPtr[k - 1] == 0xFF && slotPtr[k] == 0xD9) {
            trimmedLen = k + 1;
            break;
          }
        }
      }

      bool validJpgFraming = (slotPtr[0] == 0xFF && slotPtr[1] == 0xD8 &&
                              slotPtr[trimmedLen - 2] == 0xFF && slotPtr[trimmedLen - 1] == 0xD9);

      if (validJpgFraming) {
        portENTER_CRITICAL(&frameMux);
        readySlot   = (int8_t)writeSlot;
        readyLen    = trimmedLen;
        readyExtLen = writeExtLen;
        writeSlot   = pickFreeWriteSlot(writeSlot);
        portEXIT_CRITICAL(&frameMux);
      } else {
        diag.corruptFrames++;
      }
    } else if (!currentFrameValid) {
      diag.corruptFrames++;
    }

    writeLen          = 0;
    writeExtLen       = 0;
    frameInProgress   = false;
    currentFrameValid = true;
  }
}

// ----------------------------------------------------------------------------
// Decode Real-Time Telemetry from Olympus OPC RTP Extension Header
// ----------------------------------------------------------------------------
inline uint16_t u16be(const uint8_t* p) {
  return ((uint16_t)p[0] << 8) | p[1];
}

inline uint32_t u32be(const uint8_t* p) {
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}

void parseRtpExtensionExposure(const uint8_t* ext, size_t extLen) {
  if (!ext || extLen < 8) return;

  String   newShutter     = diag.expShutterStr;
  String   newAperture    = diag.expApertureStr;
  String   newIso         = diag.expIsoStr;
  int32_t  newRemain      = diag.remainShots;
  String   newRemainStr   = diag.remainShotsStr;
  bool     newExpWarning  = diag.expWarning;
  bool     sawExpWarnId   = false;
  bool     parsedAny      = false;

  size_t cursor = 0;
  while (cursor + 4 <= extLen) {
    uint16_t funcId  = u16be(ext + cursor);
    uint16_t wordLen = u16be(ext + cursor + 2);
    size_t   payloadBytes = (size_t)wordLen * 4;
    if (wordLen == 0 || cursor + 4 + payloadBytes > extLen) break;

    const uint8_t* p = ext + cursor + 4;

    // Trace first occurrence + payload changes for orientation/level/unknown funcIds into persistent trace
    if (funcId < 32 && rtpExtTraceCount < 14 && funcId != 5 && funcId != 8 && funcId != 9 && funcId != 12 && funcId != 16) {
      uint32_t w0 = (payloadBytes >= 4) ? u32be(p) : (uint32_t)p[0];
      uint32_t bit = (1UL << funcId);
      if ((rtpExtLoggedMask & bit) == 0 || (funcId != 1 && rtpExtLastWord0[funcId] != w0) || (funcId == 1 && rtpExtLastWord0[1] != w0)) {
        rtpExtLoggedMask |= bit;
        rtpExtLastWord0[funcId] = w0;
        rtpExtTraceCount++;
        traceAppend("[RTP-EXT] id=" + String((unsigned)funcId) + " len=" + String((unsigned)payloadBytes) +
                    " " + formatBytesHexAscii(p, payloadBytes, 16), true);
      }
    }

    if (funcId == 1 && payloadBytes >= 4) {
      uint32_t rawOri = u32be(p);
      if (rawOri != 1 && rawOri != 3 && rawOri != 6 && rawOri != 8) {
        if (p[0] == 1 || p[0] == 3 || p[0] == 6 || p[0] == 8) rawOri = p[0];
        else if (p[3] == 1 || p[3] == 3 || p[3] == 6 || p[3] == 8) rawOri = p[3];
      }
      if (rawOri == 1 || rawOri == 3 || rawOri == 6 || rawOri == 8) {
        // Clamp live-view auto-flip strictly to 180-degree inversion (1=upright <-> 3=180 deg)
        uint8_t clampedOri = (rawOri == 3) ? 3 : 1;
        if (diag.camExifOrient != clampedOri) {
          diag.camExifOrient = clampedOri;
          Serial.printf("[CAM-GYRO] Air A01 raw EXIF=%u -> clamped 180-only orient=%u\\n",
                        (unsigned)rawOri, (unsigned)clampedOri);
        }
        if (camGyroMode == CAM_GYRO_AUTO) {
          camActiveOrient = clampedOri;
        }
        parsedAny = true;
      }
    } else if (funcId == 5 && payloadBytes >= 4) {
      uint32_t rem = u32be(p);
      if (rem != 0xFFFFFFFFUL && rem != 0xFFFEUL) {
        newRemain = (int32_t)rem;
        newRemainStr = (rem > 99999UL) ? "99999+" : String(rem);
        parsedAny = true;
      }
    } else if (funcId == 8 && payloadBytes >= 12) {
      uint16_t curNum = u16be(p + 8);
      uint16_t curDen = u16be(p + 10);
      if (curNum == 0xFFFF) {
        newShutter = "BULB";
        parsedAny = true;
      } else if (curNum > 0 && curDen > 0) {
        if (curNum >= curDen) {
          if ((curNum % curDen) == 0) newShutter = String(curNum / curDen) + "\\"";
          else newShutter = String((float)curNum / (float)curDen, 1) + "\\"";
        } else if (curNum == 1) {
          newShutter = "1/" + String(curDen);
        } else {
          float sec = (float)curNum / (float)curDen;
          if (sec >= 0.35f) newShutter = String(sec, 1) + "\\"";
          else newShutter = "1/" + String((uint32_t)((curDen + curNum / 2) / curNum));
        }
        parsedAny = true;
      }
    } else if (funcId == 9 && payloadBytes >= 12) {
      uint32_t w0 = u32be(p + 0);
      uint32_t w1 = u32be(p + 4);
      if (w0 > 0 && w0 <= 999 && w1 > 0 && w1 <= 999) {
        uint32_t loF = (w0 < w1) ? w0 : w1;
        if (loF >= 7 && loF <= 120) diag.minLensF10 = loF;
      }
      uint32_t f10 = u32be(p + 8);
      if (f10 > 999) {
        uint16_t hi = u16be(p + 8);
        uint16_t lo = u16be(p + 10);
        f10 = (hi > 0 && hi <= 999) ? hi : lo;
      }
      if (f10 > 0 && f10 <= 999) {
        if (f10 >= 100 && (f10 % 10) == 0) newAperture = "F" + String(f10 / 10);
        else newAperture = "F" + String(f10 / 10) + "." + String(f10 % 10);
        parsedAny = true;
      } else if (w0 == 0 && w1 == 0 && f10 == 0) {
        newAperture = "F--";
        parsedAny = true;
      }
    } else if (funcId == 12 && payloadBytes >= 12) {
      uint32_t vals[9] = {
        u32be(p + 0), u32be(p + 8), u32be(p + 4),
        u16be(p + 0), u16be(p + 2), u16be(p + 8), u16be(p + 10), u16be(p + 4), u16be(p + 6)
      };
      bool gotIso = false;
      for (uint8_t k = 0; k < 9; k++) {
        if (vals[k] == 0xFFFE) {
          newIso = "I:LOW";
          gotIso = true;
          break;
        }
        if (vals[k] >= 50 && vals[k] <= 51200) {
          newIso = "I:" + String(vals[k]);
          gotIso = true;
          break;
        }
      }
      if (gotIso) parsedAny = true;
    } else if (funcId == 16 && payloadBytes >= 4) {
      uint32_t warnWord = u32be(p);
      sawExpWarnId = true;
      newExpWarning = (warnWord != 0);
      diag.expWarningRaw = warnWord;
      parsedAny = true;
    }

    cursor += 4 + payloadBytes;
  }

  if (parsedAny && !sawExpWarnId && diag.expWarning) {
    newExpWarning = false;
  }

  if (parsedAny) {
    loggedExtOnce  = true;
    diag.hasRtpExt = true;
    bool changed = (newShutter != diag.expShutterStr ||
                    newAperture != diag.expApertureStr ||
                    newIso != diag.expIsoStr ||
                    newRemainStr != diag.remainShotsStr ||
                    newExpWarning != diag.expWarning);
    if (changed) {
      diag.expShutterStr  = newShutter.substring(0, 6);
      diag.expApertureStr = newAperture.substring(0, 6);
      diag.expIsoStr      = newIso.substring(0, 6);
      diag.remainShots    = newRemain;
      diag.remainShotsStr = newRemainStr;
      diag.expWarning     = newExpWarning;
      if (diag.displayMode == 0) {
        updateExposureRail();
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Real-Time Focus Peaking Overlay (320x240 Luma or 160x120 Fast, Every Frame)
// Runs strictly inside active crop before grid/reticle overlays
// ----------------------------------------------------------------------------
inline void stampPeakPixel(int16_t px, int16_t py, int16_t minX, int16_t minY, int16_t maxX, int16_t maxY, uint16_t peakCol) {
  if (peakThickness == PEAK_THICK_1PX) {
    if (px >= minX && px < maxX && py >= minY && py < maxY) {
      vpCanvas.writePixel(px, py, peakCol);
    }
  } else if (peakThickness == PEAK_THICK_2PX) {
    for (int16_t dy = 0; dy <= 1; dy++) {
      int16_t yy = py + dy;
      if (yy < minY || yy >= maxY) continue;
      for (int16_t dx = 0; dx <= 1; dx++) {
        int16_t xx = px + dx;
        if (xx >= minX && xx < maxX) {
          vpCanvas.writePixel(xx, yy, peakCol);
        }
      }
    }
  } else {
    for (int16_t dy = -1; dy <= 1; dy++) {
      int16_t yy = py + dy;
      if (yy < minY || yy >= maxY) continue;
      for (int16_t dx = -1; dx <= 1; dx++) {
        int16_t xx = px + dx;
        if (xx >= minX && xx < maxX) {
          vpCanvas.writePixel(xx, yy, peakCol);
        }
      }
    }
  }
}

void applyFocusPeakingToVpCanvas(int16_t relX, int16_t relY, int16_t ovW, int16_t ovH, uint16_t vw, uint16_t vh, uint16_t srcW, uint16_t srcH) {
  if (!vpCanvasActive || !peakEnabled || ovW < 8 || ovH < 8) return;

  int16_t minX = (relX > 0) ? relX : 0;
  int16_t minY = (relY > 0) ? relY : 0;
  int16_t maxX = (relX + ovW <= (int16_t)vw) ? (relX + ovW) : (int16_t)vw;
  int16_t maxY = (relY + ovH <= (int16_t)vh) ? (relY + ovH) : (int16_t)vh;
  if (minX >= maxX || minY >= maxY) return;

  uint16_t peakCol = PEAK_COLOR_RGB565[(peakColorIdx < PEAK_COL_COUNT) ? peakColorIdx : 0];
  bool flip180 = (camActiveOrient == 3);

  vpCanvas.startWrite();
  if (peak320ActiveForFrame && peakLuma320 != nullptr && srcW >= 8 && srcH >= 8 && srcW <= 320 && srcH <= 240) {
    int32_t thresh = PEAK_SENS_THRESH_320[(peakSensitivity < PEAK_SENS_COUNT) ? peakSensitivity : PEAK_SENS_MID];
    int32_t wSrc = (int32_t)srcW;
    int32_t hSrc = (int32_t)srcH;
    for (int32_t sy = 1; sy < hSrc - 1; sy++) {
      const uint8_t* rUp  = &peakLuma320[(sy - 1) * wSrc];
      const uint8_t* rMid = &peakLuma320[sy * wSrc];
      const uint8_t* rDn  = &peakLuma320[(sy + 1) * wSrc];
      int16_t dyBase = (int16_t)((sy * (int32_t)ovH) / hSrc);
      int16_t py = relY + (flip180 ? (ovH - 1 - dyBase) : dyBase);
      for (int32_t sx = 1; sx < wSrc - 1; sx++) {
        int32_t gx = (int32_t)rMid[sx + 1] - (int32_t)rMid[sx - 1];
        int32_t gy = (int32_t)rDn[sx]      - (int32_t)rUp[sx];
        int32_t mag = (gx < 0 ? -gx : gx) + (gy < 0 ? -gy : gy);
        if (mag >= thresh) {
          int16_t dxBase = (int16_t)((sx * (int32_t)ovW) / wSrc);
          int16_t px = relX + (flip180 ? (ovW - 1 - dxBase) : dxBase);
          stampPeakPixel(px, py, minX, minY, maxX, maxY, peakCol);
        }
      }
    }
  } else if (peakLuma160 != nullptr && ovW <= 160 && ovH <= 120) {
    int32_t thresh = PEAK_SENS_THRESH_160[(peakSensitivity < PEAK_SENS_COUNT) ? peakSensitivity : PEAK_SENS_MID];
    for (int16_t vy = 1; vy < ovH - 1; vy++) {
      const uint8_t* rUp  = &peakLuma160[(vy - 1) * ovW];
      const uint8_t* rMid = &peakLuma160[vy * ovW];
      const uint8_t* rDn  = &peakLuma160[(vy + 1) * ovW];
      int16_t py = relY + (flip180 ? (ovH - 1 - vy) : vy);
      for (int16_t vx = 1; vx < ovW - 1; vx++) {
        int32_t gx = (int32_t)rMid[vx + 1] - (int32_t)rMid[vx - 1];
        int32_t gy = (int32_t)rDn[vx]      - (int32_t)rUp[vx];
        int32_t mag = (gx < 0 ? -gx : gx) + (gy < 0 ? -gy : gy);
        if (mag >= thresh) {
          int16_t px = relX + (flip180 ? (ovW - 1 - vx) : vx);
          stampPeakPixel(px, py, minX, minY, maxX, maxY, peakCol);
        }
      }
    }
  }
  vpCanvas.endWrite();
}

// ----------------------------------------------------------------------------
// Decode Latest Completed Frame from Ping-Pong Buffer on Core 1
// ----------------------------------------------------------------------------
void processReadyFrame() {
  if (!frameBuf[0] || !frameBuf[1]) return;
  int8_t slot   = -1;
  size_t len    = 0;
  size_t extLen = 0;

  portENTER_CRITICAL(&frameMux);
  if (readySlot >= 0 && readyLen > 0) {
    slot      = readySlot;
    len       = readyLen;
    extLen    = readyExtLen;
    readySlot = -1;
    drawSlot  = slot;
  }
  portEXIT_CRITICAL(&frameMux);

  if (slot < 0) return;

  diag.lastFrameBytes = len;
  if (extLen > 0) {
    parseRtpExtensionExposure(rtpExtBuf[slot], extLen);
  }

  if (diag.displayMode == 0) {
    uint16_t jpgW = 0, jpgH = 0;
    if (TJpgDec.getJpgSize(&jpgW, &jpgH, frameBuf[slot], len) != JDR_OK || jpgW == 0 || jpgH == 0) {
      jpgW = 320;
      jpgH = 240;
    }
    activeSrcJpgW = jpgW;
    activeSrcJpgH = jpgH;

    int16_t  vx = vpX();
    int16_t  vy = vpY();
    uint16_t vw = vpW();
    uint16_t vh = vpH();
    uint16_t targetW = vw;
    uint16_t targetH = vh;
    if ((uint32_t)jpgW * vh >= (uint32_t)vw * jpgH) {
      targetW = vw;
      targetH = (uint16_t)(((uint32_t)jpgH * vw + (jpgW / 2)) / jpgW);
      if (targetH > vh) targetH = vh;
      if (targetH == 0) targetH = 1;
    } else {
      targetH = vh;
      targetW = (uint16_t)(((uint32_t)jpgW * vh + (jpgH / 2)) / jpgH);
      if (targetW > vw) targetW = vw;
      if (targetW == 0) targetW = 1;
    }

    // When Focus Peaking = ON and Source = 320x240, decode existing 0320x0240 stream at scale=1
    // to preserve upper 4x4 DCT micro-contrast edges without adding Wi-Fi UDP traffic
    bool wantPeak320 = (peakEnabled && peakSource == PEAK_SRC_320 && peakLuma320 != nullptr && jpgW <= 320 && jpgH <= 240);
    uint8_t targetScale = 1;
    if (!wantPeak320) {
      if (((jpgW + 3) / 4) >= targetW && ((jpgH + 3) / 4) >= targetH) {
        targetScale = 4;
      } else if (((jpgW + 1) / 2) >= targetW && ((jpgH + 1) / 2) >= targetH) {
        targetScale = 2;
      } else {
        targetScale = 1;
      }
    }
    peak320ActiveForFrame = wantPeak320;
    if (targetScale != lastJpgScale) {
      TJpgDec.setJpgScale(targetScale);
      lastJpgScale = targetScale;
    }

    dynamicDecW  = (jpgW + targetScale - 1) / targetScale;
    dynamicDecH  = (jpgH + targetScale - 1) / targetScale;
    dynamicMaxW  = targetW;
    dynamicMaxH  = targetH;
    dynamicDrawX = vx + (int16_t)((vw - targetW) / 2);
    dynamicDrawY = vy + (int16_t)((vh - targetH) / 2);
    scaleStepX   = ((uint32_t)dynamicDecW << 16) / dynamicMaxW;
    scaleStepY   = ((uint32_t)dynamicDecH << 16) / dynamicMaxH;

    vpCanvasActive = ensureVpCanvas(vw, vh);

    // Always wipe offscreen vpCanvas every frame so letterbox/pillarbox/rotation transitions leave zero stale artifacts in black bars
    if (vpCanvasActive) {
      vpCanvas.fillSprite(TFT_BLACK);
    }

    bool orientChanged = (lastCamActiveOrient != camActiveOrient);
    bool dimChanged    = (jpgW != lastJpgW || jpgH != lastJpgH);
    if (dimChanged || orientChanged) {
      lastJpgW            = jpgW;
      lastJpgH            = jpgH;
      lastCamActiveOrient = camActiveOrient;
      M5.Display.startWrite();
      if (!vpCanvasActive) {
        M5.Display.fillRect(vx, vy, vw, vh, TFT_BLACK);
      }
      if (hudEnabled(HUD_RES)) {
        uint16_t railBg = M5.Display.color565(10, 15, 28);
        M5.Display.setTextSize(1);
        M5.Display.setTextColor(M5.Display.color565(148, 163, 184), railBg);
        M5.Display.setCursor(isPortraitOrientation() ? 38 : 3, isPortraitOrientation() ? 163 : 88);
        M5.Display.printf("%-7s", (String(dynamicMaxW) + "x" + String(dynamicMaxH)).c_str());
      }
      drawOuterViewportFrame(diag.expWarning);
      M5.Display.endWrite();
    }

    if (!vpCanvasActive) {
      M5.Display.startWrite();
    }
    int jdr = TJpgDec.drawJpg(0, 0, frameBuf[slot], len);
    diag.lastDecodeCode = jdr;

    if (jdr == 0) {
      diag.validFrames++;
      frameCount++;
      if (!sawFirstVideoFrame) {
        sawFirstVideoFrame = true;
        firstVideoFrameMs  = millis();
      }
    } else {
      diag.corruptFrames++;
    }

    int16_t relX = vpCanvasActive ? (dynamicDrawX - vx) : dynamicDrawX;
    int16_t relY = vpCanvasActive ? (dynamicDrawY - vy) : dynamicDrawY;
    int16_t ovW  = (int16_t)dynamicMaxW;
    int16_t ovH  = (int16_t)dynamicMaxH;

    // Camera Gyro 180-Degree Orientation Compensation (in-place pixel swap inside clean vpCanvas, <0.2ms, zero bar artifacts)
    if (vpCanvasActive && camActiveOrient == 3 && jdr == 0) {
      uint16_t* pxBuf = (uint16_t*)vpCanvas.getBuffer();
      if (pxBuf) {
        int16_t x0 = relX, y0 = relY, rw = ovW, rh = ovH;
        if (x0 >= 0 && y0 >= 0 && (x0 + rw) <= (int16_t)vw && (y0 + rh) <= (int16_t)vh) {
          for (int16_t ry = 0; ry < rh / 2; ry++) {
            uint16_t* rowTop = pxBuf + (y0 + ry) * vw + x0;
            uint16_t* rowBot = pxBuf + (y0 + rh - 1 - ry) * vw + x0;
            for (int16_t rx = 0; rx < rw; rx++) {
              uint16_t tmp = rowTop[rx];
              rowTop[rx] = rowBot[rw - 1 - rx];
              rowBot[rw - 1 - rx] = tmp;
            }
          }
          if (rh & 1) {
            uint16_t* midRow = pxBuf + (y0 + rh / 2) * vw + x0;
            for (int16_t rx = 0; rx < rw / 2; rx++) {
              uint16_t tmp = midRow[rx];
              midRow[rx] = midRow[rw - 1 - rx];
              midRow[rw - 1 - rx] = tmp;
            }
          }
        }
      }
    }

    // Real-time Focus Peaking pass (every frame, strictly inside active crop, before grid & AF reticle)
    if (vpCanvasActive && peakEnabled && jdr == 0) {
      applyFocusPeakingToVpCanvas(relX, relY, ovW, ovH, vw, vh, jpgW, jpgH);
    }

    LovyanGFX* ovGfx = vpCanvasActive ? static_cast<LovyanGFX*>(&vpCanvas) : static_cast<LovyanGFX*>(&M5.Display);

    drawGridOverlayOnGfx(ovGfx, relX, relY, ovW, ovH);
    drawAfReticleOnGfx(ovGfx, relX + (int16_t)(ovW / 2), relY + (int16_t)(ovH / 2), contBurstActive);
    if (selfTimerActive) {
      unsigned long nowT = millis();
      uint16_t remS = (selfTimerEndMs > nowT) ? (uint16_t)((selfTimerEndMs - nowT + 999UL) / 1000UL) : 0;
      if (remS > 0) {
        drawSelfTimerOnGfx(ovGfx, relX + (int16_t)(ovW / 2), relY + (int16_t)(ovH / 2), remS);
      }
    }
    if (vpCanvasActive) {
      drawActiveImageFrameOnGfx(&vpCanvas, relX, relY, ovW, ovH, diag.expWarning);
      M5.Display.startWrite();
      vpCanvas.pushSprite(vx, vy);
    }

    static bool prevDrawnExpWarning = false;
    if (diag.expWarning) {
      drawExposureWarningBox(true);
      prevDrawnExpWarning = true;
    } else if (prevDrawnExpWarning || dimChanged || orientChanged) {
      if (!vpCanvasActive) M5.Display.drawRect(vx, vy, vw, vh, TFT_BLACK);
      drawExposureWarningBox(false);
      prevDrawnExpWarning = false;
    }
    M5.Display.endWrite();
  } else {
    diag.validFrames++;
    frameCount++;
    if (!sawFirstVideoFrame) {
      sawFirstVideoFrame = true;
      firstVideoFrameMs  = millis();
    }
  }

  portENTER_CRITICAL(&frameMux);
  drawSlot = -1;
  portEXIT_CRITICAL(&frameMux);

  unsigned long now = millis();
  unsigned long delta = now - lastFrameTimer;
  if (delta >= 1000) {
    diag.currentFps = (frameCount * 1000.0f) / delta;
    frameCount = 0;
    lastFrameTimer = now;
    if (diag.displayMode == 0) {
      updateTopBanner();
    }
  }
}

// ----------------------------------------------------------------------------
// Battery & Exposure Property Query / Set (with TAKEMODE Confirmation Polling)
// ----------------------------------------------------------------------------
void discoverBatteryPropEnum() {
  if (WiFi.status() != WL_CONNECTED) return;
  String resp;
  int code = opcHttpGetWith520Retry(URL_BAT_DESC, resp, 2000);
  Serial.printf("[BATTERY] desc -> HTTP %d\\n", code);
}

String formatAirBatteryToken(const String& rawIn) {
  String u = rawIn;
  u.trim();
  u.toUpperCase();
  if (u.length() == 0) return "--";
  if (u == "CHARGE" || u == "CHARGING") return "CHG";
  if (u == "FULL" || u == "HIGH") return "FULL";
  if (u == "HALF" || u == "MEDIUM" || u == "MID") return "HALF";
  if (u == "NEAR_EMPTY") return "LOW!";
  if (u == "LOW" || u == "LOW_WARNING" || u == "BATTERY_LOW") return "LOW";
  if (u == "EMPTY") return "EMPT";
  if (isDigit(u[0]) && u.indexOf('%') == -1 && u.indexOf('V') == -1) {
    return u + "%";
  }
  return u.substring(0, 4);
}

void updateCameraBatteryStatus(bool backgroundPoll) {
  if (WiFi.status() != WL_CONNECTED) return;

  String payload;
  uint32_t readTo = backgroundPoll ? 700 : 1500;
  uint32_t connTo = backgroundPoll ? 650 : 2500;
  int code = opcHttpGetWith520Retry(URL_BAT_LEVEL, payload, readTo, connTo);

  if (code == 200) {
    int valStart = payload.indexOf("<value>");
    if (valStart != -1) {
      int valEnd = payload.indexOf("</value>", valStart);
      if (valEnd != -1) {
        String raw = payload.substring(valStart + 7, valEnd);
        raw.trim();
        String prevBat = diag.airBatteryStr;
        diag.airBatteryRaw = raw;
        diag.airBatteryStr = formatAirBatteryToken(raw);
        if (diag.airBatteryStr != prevBat && diag.displayMode == 0) {
          updateTopBanner();
        }
        return;
      }
    }
    if (diag.airBatteryStr == "--") diag.airBatteryStr = "?";
  }
}

String extractXmlValue(const String& payload) {
  int valStart = payload.indexOf("<value>");
  if (valStart == -1) return "";
  int valEnd = payload.indexOf("</value>", valStart);
  if (valEnd == -1) return "";
  String val = payload.substring(valStart + 7, valEnd);
  val.trim();
  return val;
}

int queryCameraProp(const char* propName, String& outVal, uint32_t timeoutMs = 800, uint32_t connectTimeoutMs = 2500) {
  String url = String("http://") + CAMERA_IP + "/get_camprop.cgi?com=get&propname=" + propName;
  String resp;
  int code = opcHttpGetWith520Retry(url.c_str(), resp, timeoutMs, connectTimeoutMs);
  if (code == 200) {
    outVal = extractXmlValue(resp);
  }
  return code;
}

String extractXmlEnum(const String& payload) {
  int start = payload.indexOf("<enum>");
  if (start == -1) return "";
  int end = payload.indexOf("</enum>", start);
  if (end == -1) return "";
  String val = payload.substring(start + 6, end);
  val.trim();
  return val;
}

int setCameraPropXml(const char* propName, const String& value, uint32_t timeoutMs = 2500) {
  String url = String("http://") + CAMERA_IP + "/set_camprop.cgi?com=set&propname=" + propName;
  String xml = String("<?xml version=\\"1.0\\"?><set><value>") + value + "</value></set>";
  String resp;
  int code = opcHttpPostXml(url.c_str(), xml, resp, timeoutMs);
  Serial.printf("[PROP] set %s=%s -> HTTP %d: %s\\n", propName, value.c_str(), code, resp.substring(0, 80).c_str());
  return code;
}

String findWidestApertureToken(const String& enumStr) {
  String bestTok = "";
  float bestVal = 999.0f;
  int len = enumStr.length();
  int i = 0;
  while (i < len) {
    while (i < len && isspace((unsigned char)enumStr[i])) i++;
    if (i >= len) break;
    int start = i;
    while (i < len && !isspace((unsigned char)enumStr[i])) i++;
    String tok = enumStr.substring(start, i);
    String numPart = tok;
    if (numPart.length() > 1 && (numPart[0] == 'F' || numPart[0] == 'f')) {
      numPart = numPart.substring(1);
    }
    if (numPart.length() > 0 && isDigit(numPart[0])) {
      float f = numPart.toFloat();
      if (f >= 0.7f && f <= 32.0f && f < bestVal) {
        bestVal = f;
        bestTok = tok;
      }
    }
  }
  if (bestTok.length() == 0 && diag.minLensF10 > 0) {
    bestTok = String(diag.minLensF10 / 10) + "." + String(diag.minLensF10 % 10);
  }
  return bestTok;
}

String findShutter60Token(const String& enumStr) {
  int len = enumStr.length();
  int i = 0;
  String found60 = "";
  while (i < len) {
    while (i < len && isspace((unsigned char)enumStr[i])) i++;
    if (i >= len) break;
    int start = i;
    while (i < len && !isspace((unsigned char)enumStr[i])) i++;
    String tok = enumStr.substring(start, i);
    if (tok == "1/60") return tok;
    if (tok == "60") found60 = tok;
  }
  return found60;
}

String findEnumTokenIgnoreCase(const String& enumStr, const char* target) {
  int len = enumStr.length();
  int i = 0;
  while (i < len) {
    while (i < len && isspace((unsigned char)enumStr[i])) i++;
    if (i >= len) break;
    int start = i;
    while (i < len && !isspace((unsigned char)enumStr[i])) i++;
    String tok = enumStr.substring(start, i);
    if (tok.equalsIgnoreCase(target)) return tok;
  }
  return "";
}

String formatBareAperture(const String& tok) {
  if (tok.length() > 1 && (tok[0] == 'F' || tok[0] == 'f')) {
    return tok.substring(1);
  }
  return tok;
}

void formatAndStoreExposure(uint8_t step, const String& raw) {
  if (raw.length() == 0) return;

  if (step == 0) {
    String s = raw;
    if (s == "AUTO") s = "S:AUTO";
    diag.expShutterStr = s.substring(0, 6);
  } else if (step == 1) {
    String a = raw;
    if (a != "--" && a != "AUTO" && a[0] != 'F' && a[0] != 'f') {
      a = "F" + a;
    }
    diag.expApertureStr = a.substring(0, 6);
  } else if (step == 2) {
    String iso = raw;
    if (iso == "AUTO" || iso == "Auto") iso = "I:AUTO";
    else if (!iso.startsWith("ISO") && !iso.startsWith("I:")) iso = "I:" + iso;
    diag.expIsoStr = iso.substring(0, 6);
  } else if (step == 3) {
    String m = raw;
    if (m.equalsIgnoreCase("iAUTO") || m.equalsIgnoreCase("iAuto")) m = "iAUTO";
    else if (m == "A" && currentShootMode == SHOOT_A_WIDE && diag.targetWideFStr.length() > 0) {
      m = "A:" + formatBareAperture(diag.targetWideFStr);
    } else if (m == "S" && currentShootMode == SHOOT_S_60) {
      m = "S:1/60";
    }
    if (m.length() > 6) m = m.substring(0, 6);
    diag.expModeStr = m;
  }
}

// Per CAMERA_NOTES.md: Poll TAKEMODE every 100ms (takes ~350-550ms) and stop immediately when confirmed
bool confirmTakeModeChange(const String& expectedTok, String& outActual) {
  unsigned long t0 = millis();
  while (millis() - t0 < 1200) {
    delay(100);
    String cur;
    if (queryCameraProp(propModeName.c_str(), cur, 700) == 200 && cur.length() > 0) {
      outActual = cur;
      if (cur.equalsIgnoreCase(expectedTok)) {
        Serial.printf("[MODE] Confirmed TAKEMODE='%s' in %lu ms\\n", cur.c_str(), millis() - t0);
        return true;
      }
    }
  }
  return false;
}

bool waitAndGetWritablePropEnum(const char* propName, String& outEnum, int maxAttempts = 5) {
  String descUrl = String("http://") + CAMERA_IP + "/get_camprop.cgi?com=desc&propname=" + propName;
  for (int attempt = 0; attempt < maxAttempts; attempt++) {
    String resp;
    int code = opcHttpGetWith520Retry(descUrl.c_str(), resp, 2000);
    if (code == 200) {
      outEnum = extractXmlEnum(resp);
      bool isWritable = (resp.indexOf("<attribute>getset</attribute>") != -1 ||
                         resp.indexOf("<attribute>set</attribute>") != -1);
      if (isWritable && outEnum.length() > 0) return true;
      if (attempt == maxAttempts - 1 && outEnum.length() > 0) return true;
    }
    delay(100);
  }
  return false;
}

void ensureAutoIsoForPriorityMode() {
  String isoDescResp;
  String isoDescUrl = String("http://") + CAMERA_IP + "/get_camprop.cgi?com=desc&propname=" + propIsoName;
  if (opcHttpGetWith520Retry(isoDescUrl.c_str(), isoDescResp, 1500) == 200) {
    if (isoDescResp.indexOf("<attribute>getset</attribute>") != -1) {
      String curIso = extractXmlValue(isoDescResp);
      String isoEnum = extractXmlEnum(isoDescResp);
      String autoIsoTok = findEnumTokenIgnoreCase(isoEnum, "Auto");
      if (autoIsoTok.length() > 0 && !curIso.equalsIgnoreCase("Auto")) {
        setCameraPropXml(propIsoName.c_str(), autoIsoTok);
      }
    }
  }
}

bool applyShootingMode(uint8_t modeIdx) {
  if (modeIdx >= SHOOT_COUNT || WiFi.status() != WL_CONNECTED) return false;

  String modeDescResp;
  String modeDescUrl = String("http://") + CAMERA_IP + "/get_camprop.cgi?com=desc&propname=" + propModeName;
  opcHttpGetWith520Retry(modeDescUrl.c_str(), modeDescResp, 2000);
  String modeEnum = extractXmlEnum(modeDescResp);

  int code = 0;
  String actualMode = "";

  if (modeIdx == SHOOT_AUTO) {
    String autoTok = findEnumTokenIgnoreCase(modeEnum, "iAuto");
    if (autoTok.length() == 0) autoTok = findEnumTokenIgnoreCase(modeEnum, "iAUTO");
    if (autoTok.length() == 0) autoTok = findEnumTokenIgnoreCase(modeEnum, "P");
    if (autoTok.length() == 0) autoTok = "iAuto";

    code = setCameraPropXml(propModeName.c_str(), autoTok);
    if (code != 200 && autoTok != "P") {
      autoTok = "P";
      code = setCameraPropXml(propModeName.c_str(), autoTok);
    }
    if (code == 200) {
      confirmTakeModeChange(autoTok, actualMode);
      diag.expModeStr = (actualMode.equalsIgnoreCase("P")) ? "P" : "iAUTO";
    }
  } else if (modeIdx == SHOOT_A_WIDE) {
    String aTok = findEnumTokenIgnoreCase(modeEnum, "A");
    if (aTok.length() == 0) aTok = "A";
    code = setCameraPropXml(propModeName.c_str(), aTok);
    if (code == 503 || code == 409) {
      delay(200);
      code = setCameraPropXml(propModeName.c_str(), aTok);
    }

    if (code == 200 && confirmTakeModeChange(aTok, actualMode)) {
      ensureAutoIsoForPriorityMode();
      String apEnum;
      if (waitAndGetWritablePropEnum(propApertureName.c_str(), apEnum, 5)) {
        String widestTok = findWidestApertureToken(apEnum);
        if (widestTok.length() > 0) {
          diag.targetWideFStr = widestTok;
          int apCode = setCameraPropXml(propApertureName.c_str(), widestTok);
          if (apCode != 200) {
            delay(160);
            apCode = setCameraPropXml(propApertureName.c_str(), widestTok);
          }
          if (apCode == 200) {
            String bareF = formatBareAperture(widestTok);
            diag.expApertureStr = ("F" + bareF).substring(0, 6);
            diag.expModeStr = ("A:" + bareF).substring(0, 6);
          } else {
            diag.expModeStr = "A:ERR";
          }
        }
      } else {
        diag.expModeStr = (diag.targetWideFStr.length() > 0)
                            ? ("A:" + formatBareAperture(diag.targetWideFStr)).substring(0, 6)
                            : "A:MAX";
      }
    }
  } else if (modeIdx == SHOOT_S_60) {
    String sTok = findEnumTokenIgnoreCase(modeEnum, "S");
    if (sTok.length() == 0) sTok = "S";
    code = setCameraPropXml(propModeName.c_str(), sTok);
    if (code == 503 || code == 409) {
      delay(200);
      code = setCameraPropXml(propModeName.c_str(), sTok);
    }

    if (code == 200 && confirmTakeModeChange(sTok, actualMode)) {
      ensureAutoIsoForPriorityMode();
      String shEnum;
      String shTok = "";
      if (waitAndGetWritablePropEnum(propShutterName.c_str(), shEnum, 5)) {
        shTok = findShutter60Token(shEnum);
      }
      int shCode = 0;
      if (shTok.length() > 0) {
        shCode = setCameraPropXml(propShutterName.c_str(), shTok);
        if (shCode != 200) {
          delay(160);
          shCode = setCameraPropXml(propShutterName.c_str(), shTok);
        }
      } else {
        shCode = setCameraPropXml(propShutterName.c_str(), "60");
        if (shCode != 200) shCode = setCameraPropXml(propShutterName.c_str(), "1/60");
      }
      if (shCode == 200) {
        diag.expModeStr = "S:1/60";
        diag.expShutterStr = "1/60";
      } else {
        diag.expModeStr = "S:ERR";
      }
    }
  }

  if (actualMode.length() == 0) {
    queryCameraProp(propModeName.c_str(), actualMode, 700);
  }
  if (actualMode.length() > 0) {
    formatAndStoreExposure(3, actualMode);
  }

  diag.modeCode = code;
  return (code == 200);
}

void discoverExposurePropNames() {
  if (WiFi.status() != WL_CONNECTED) return;

  String val;
  const char* shutterCandidates[]  = { "SHUTTER", "shutspeedvalue" };
  const char* apertureCandidates[] = { "APERTURE", "focalvalue" };
  const char* isoCandidates[]      = { "ISO", "isospeedvalue" };
  const char* modeCandidates[]     = { "TAKEMODE", "TAKE_MODE", "takemode" };

  for (uint8_t i = 0; i < 2; i++) {
    if (queryCameraProp(shutterCandidates[i], val, 700) == 200 && val.length() > 0) {
      propShutterName = shutterCandidates[i];
      break;
    }
  }
  for (uint8_t i = 0; i < 2; i++) {
    if (queryCameraProp(apertureCandidates[i], val, 700) == 200 && val.length() > 0) {
      propApertureName = apertureCandidates[i];
      break;
    }
  }
  for (uint8_t i = 0; i < 2; i++) {
    if (queryCameraProp(isoCandidates[i], val, 700) == 200 && val.length() > 0) {
      propIsoName = isoCandidates[i];
      break;
    }
  }
  for (uint8_t i = 0; i < 3; i++) {
    if (queryCameraProp(modeCandidates[i], val, 700) == 200 && val.length() > 0) {
      propModeName = modeCandidates[i];
      formatAndStoreExposure(3, val);
      break;
    }
  }
}

void pollNextExposureProp(bool pollAll = false) {
  if (WiFi.status() != WL_CONNECTED) return;

  uint8_t count = pollAll ? 4 : 1;
  bool changed = false;

  for (uint8_t c = 0; c < count; c++) {
    uint8_t step = pollAll ? c : exposurePollStep;
    const char* prop = propShutterName.c_str();
    if (step == 1) prop = propApertureName.c_str();
    else if (step == 2) prop = propIsoName.c_str();
    else if (step == 3) prop = propModeName.c_str();

    String val;
    int code = queryCameraProp(prop, val, 600);
    if (code == 200 && val.length() > 0) {
      String prev = (step == 0) ? diag.expShutterStr :
                    (step == 1) ? diag.expApertureStr :
                    (step == 2) ? diag.expIsoStr : diag.expModeStr;
      formatAndStoreExposure(step, val);
      String next = (step == 0) ? diag.expShutterStr :
                    (step == 1) ? diag.expApertureStr :
                    (step == 2) ? diag.expIsoStr : diag.expModeStr;
      if (prev != next) changed = true;
    }

    if (!pollAll) {
      exposurePollStep = (exposurePollStep + 1) % 4;
    }
  }

  if (changed && diag.displayMode == 0) {
    updateExposureRail();
  }
}

// ----------------------------------------------------------------------------
// Desclist Property Auto-Discovery + Continuous Drive & Air Sound Sync
// ----------------------------------------------------------------------------
String findEnumTokenContains(const String& enumStr, const char* mustContainA, const char* mustContainB = nullptr) {
  int len = enumStr.length();
  int i = 0;
  String keyA = mustContainA ? String(mustContainA) : "";
  String keyB = mustContainB ? String(mustContainB) : "";
  keyA.toUpperCase();
  keyB.toUpperCase();

  while (i < len) {
    while (i < len && isspace((unsigned char)enumStr[i])) i++;
    if (i >= len) break;
    int start = i;
    while (i < len && !isspace((unsigned char)enumStr[i])) i++;
    String tok = enumStr.substring(start, i);
    String up = tok;
    up.toUpperCase();
    if (keyA.length() == 0 || up.indexOf(keyA) != -1) {
      if (keyB.length() == 0 || up.indexOf(keyB) != -1) {
        return tok;
      }
    }
  }
  return "";
}

int setCameraPropWithLiveviewRetry(const char* propName, const String& value, bool* stoppedStreamOut = nullptr) {
  int code = setCameraPropXml(propName, value, 2000);
  if (code == 409 || code == 503 || code == 520) {
    String dummy;
    opcHttpGet(URL_STOP_STREAM, dummy, 700, true, 700);
    if (stoppedStreamOut) *stoppedStreamOut = true;
    delay(140);
    code = setCameraPropXml(propName, value, 2000);
    delay(80);
  }
  return code;
}

void parseSoundTokensFromEnum(const String& enumStr) {
  if (enumStr.length() == 0) return;
  uint8_t count = 0;
  int len = enumStr.length();
  int i = 0;
  while (i < len && count < MAX_AIR_SOUND_OPTS) {
    while (i < len && isspace((unsigned char)enumStr[i])) i++;
    if (i >= len) break;
    int start = i;
    while (i < len && !isspace((unsigned char)enumStr[i])) i++;
    String tok = enumStr.substring(start, i);
    if (tok.length() > 0) {
      airSoundTokens[count++] = tok;
    }
  }
  if (count > 0) {
    airSoundCount = count;
    airSoundDiscovered = true;
  }
}

void discoverCameraPropertiesFromDesclist() {
  if (WiFi.status() != WL_CONNECTED) return;

  String desclist;
  String url = String("http://") + CAMERA_IP + "/get_camprop.cgi?com=desc&propname=desclist";
  int code = opcHttpGetWith520Retry(url.c_str(), desclist, 3000, 1500);
  Serial.printf("[OPC] desclist -> HTTP %d (%u bytes)\\n", code, (unsigned)desclist.length());
  if (code != 200 || desclist.length() < 20) return;

  int pos = 0;
  while (true) {
    int descStart = desclist.indexOf("<desc", pos);
    if (descStart == -1) break;
    int descEnd = desclist.indexOf("</desc>", descStart);
    if (descEnd == -1) break;
    String block = desclist.substring(descStart, descEnd + 7);
    pos = descEnd + 7;

    String pName = "";
    int pS = block.indexOf("<propname>");
    if (pS != -1) {
      int pE = block.indexOf("</propname>", pS);
      if (pE != -1) pName = block.substring(pS + 10, pE);
    } else {
      int aS = block.indexOf("propname=\\"");
      if (aS != -1) {
        int aE = block.indexOf("\\"", aS + 10);
        if (aE != -1) pName = block.substring(aS + 10, aE);
      }
    }
    pName.trim();
    if (pName.length() == 0) continue;

    String upName = pName;
    upName.toUpperCase();
    String en = extractXmlEnum(block);
    String cur = extractXmlValue(block);

    if (upName.indexOf("DRIVE") != -1 && (en.length() > 0 || cur.length() > 0)) {
      if (!driveDiscovered || upName == "TAKE_DRIVE" || upName == "DRIVE_MODE" || upName == "DRIVEMODE") {
        propDriveName  = pName;
        driveEnumCache = en;
        driveDiscovered = true;
      }
      Serial.printf("[OPC] Found Drive prop=%s val=%s enum=[%s]\\n", pName.c_str(), cur.c_str(), en.c_str());
    } else if ((upName.indexOf("VELOCITY") != -1 || upName.indexOf("CONTINUOUS") != -1) && en.length() > 0) {
      propSeqVelName  = pName;
      seqVelEnumCache = en;
      seqVelAvailable = true;
      Serial.printf("[OPC] Found SeqVel prop=%s val=%s enum=[%s]\\n", pName.c_str(), cur.c_str(), en.c_str());
    } else if ((upName.indexOf("SOUND") != -1 || upName.indexOf("BEEP") != -1) && en.length() > 0) {
      if (!airSoundDiscovered || upName.indexOf("VOLUME") != -1) {
        propAirSoundName = pName;
        parseSoundTokensFromEnum(en);
        Serial.printf("[OPC] Found Sound prop=%s val=%s enum=[%s]\\n", pName.c_str(), cur.c_str(), en.c_str());
      }
    }
  }
}

void discoverDrivePropOptions() {
  if (WiFi.status() != WL_CONNECTED) return;

  if (!driveDiscovered) {
    discoverCameraPropertiesFromDesclist();
  }

  const char* candidates[] = { propDriveName.c_str(), "TAKE_DRIVE", "DRIVE_MODE", "drivemode", "TAKEDRIVE" };
  for (uint8_t c = 0; c < 5; c++) {
    if (!candidates[c] || candidates[c][0] == '\\0') continue;
    String resp;
    String url = String("http://") + CAMERA_IP + "/get_camprop.cgi?com=desc&propname=" + candidates[c];
    int code = opcHttpGetWith520Retry(url.c_str(), resp, 1500, 1200);
    if (code == 200) {
      String en = extractXmlEnum(resp);
      if (en.length() > 0 || resp.indexOf("<value>") != -1) {
        propDriveName   = candidates[c];
        driveEnumCache  = en;
        driveDiscovered = true;
        Serial.printf("[DRIVE] Active prop=%s enum=[%s]\\n", propDriveName.c_str(), driveEnumCache.c_str());
        break;
      }
    }
  }

  if (!seqVelAvailable) {
    const char* velCands[] = { "CONTINUOUS_SHOOTING_VELOCITY", "CONTINUOUS_SHOOTING_SPEED", "CONT_VELOCITY" };
    for (uint8_t v = 0; v < 3; v++) {
      String vResp;
      String vUrl = String("http://") + CAMERA_IP + "/get_camprop.cgi?com=desc&propname=" + velCands[v];
      if (opcHttpGet(vUrl.c_str(), vResp, 1000, false, 900) == 200) {
        String vEn = extractXmlEnum(vResp);
        if (vEn.length() > 0 && vResp.indexOf("getset") != -1) {
          propSeqVelName  = velCands[v];
          seqVelEnumCache = vEn;
          seqVelAvailable = true;
          break;
        }
      }
    }
  }

  bool hasSplitDriveSpeed =
    (findEnumTokenContains(driveEnumCache, "CONT", "_L").length() > 0 ||
     findEnumTokenContains(driveEnumCache, "CONT", "LOW").length() > 0 ||
     findEnumTokenContains(driveEnumCache, "SEQ", "L").length() > 0);
  seqLowHwSupported = (hasSplitDriveSpeed || seqVelAvailable);
  Serial.printf("[DRIVE] HW Low/High velocity selectable: %s\\n", seqLowHwSupported ? "YES" : "NO (Air A01 fixed ~10fps)");
}

String pickDriveTokenFromEnum(const String& drvEnum, uint8_t driveIdx, uint8_t seqIdx) {
  if (driveIdx == DRIVE_CONT) {
    const char* highCands[] = {
      "CONT_H", "CONTINUOUS_H", "CONTINUOUS_HIGH", "SEQUENTIAL_H", "SEQUENTIAL_HIGH",
      "DRIVE_HIGH", "DRIVE_CONTINUE_H", "HIGH_SPEED", "continuous-H", "HIGH", "CONT_HI"
    };
    const char* lowCands[] = {
      "CONT_L", "CONTINUOUS_L", "CONTINUOUS_LOW", "SEQUENTIAL_L", "SEQUENTIAL_LOW",
      "DRIVE_LOW", "DRIVE_CONTINUE_L", "LOW_SPEED", "continuous-L", "LOW", "CONT_LO"
    };
    const char* genCands[] = {
      "DRIVE_CONTINUE", "DRIVE_CONTINUOUS", "CONTINUOUS", "CONTINUE", "SEQUENTIAL", "CONT", "continuous"
    };

    const char** list = (seqIdx == SEQ_HIGH) ? highCands : lowCands;
    for (uint8_t i = 0; i < 11; i++) {
      String m = findEnumTokenIgnoreCase(drvEnum, list[i]);
      if (m.length() > 0) return m;
    }
    if (seqIdx == SEQ_HIGH) {
      String s = findEnumTokenContains(drvEnum, "CONT", "_H");
      if (s.length() == 0) s = findEnumTokenContains(drvEnum, "CONT", "HIGH");
      if (s.length() == 0) s = findEnumTokenContains(drvEnum, "SEQ", "H");
      if (s.length() > 0) return s;
    } else {
      String s = findEnumTokenContains(drvEnum, "CONT", "_L");
      if (s.length() == 0) s = findEnumTokenContains(drvEnum, "CONT", "LOW");
      if (s.length() == 0) s = findEnumTokenContains(drvEnum, "SEQ", "L");
      if (s.length() > 0) return s;
    }
    for (uint8_t i = 0; i < 7; i++) {
      String m = findEnumTokenIgnoreCase(drvEnum, genCands[i]);
      if (m.length() > 0) return m;
    }
    String anyCont = findEnumTokenContains(drvEnum, "CONT");
    if (anyCont.length() > 0) return anyCont;
    anyCont = findEnumTokenContains(drvEnum, "SEQ");
    if (anyCont.length() > 0) return anyCont;
    return "CONTINUOUS";
  }

  const char* singleCands[] = { "DRIVE_NORMAL", "NORMAL", "SINGLE", "normal", "1SHOT", "ONE_SHOT" };
  for (uint8_t i = 0; i < 6; i++) {
    String m = findEnumTokenIgnoreCase(drvEnum, singleCands[i]);
    if (m.length() > 0) return m;
  }
  return "NORMAL";
}

bool applyDriveModeToCamera(uint8_t driveIdx, uint8_t seqIdx, String* statusOut, bool isSeqSpeedChange) {
  if (WiFi.status() != WL_CONNECTED) {
    if (statusOut) *statusOut = "QUEUED";
    return false;
  }

  if (!driveDiscovered) {
    discoverDrivePropOptions();
  }

  String drvDesc;
  String drvUrl = String("http://") + CAMERA_IP + "/get_camprop.cgi?com=desc&propname=" + propDriveName;
  int code = opcHttpGetWith520Retry(drvUrl.c_str(), drvDesc, 1800, 1200);
  if (code != 200) {
    discoverDrivePropOptions();
    drvUrl = String("http://") + CAMERA_IP + "/get_camprop.cgi?com=desc&propname=" + propDriveName;
    code = opcHttpGetWith520Retry(drvUrl.c_str(), drvDesc, 1800, 1200);
  }

  bool stoppedStream = false;
  bool writable = (drvDesc.indexOf("<attribute>getset</attribute>") != -1 ||
                   drvDesc.indexOf("<attribute>set</attribute>") != -1);

  // Some Olympus Air firmware locks continuous drive while in iAUTO; switch TAKEMODE->P cleanly if read-only
  if (code == 200 && !writable && driveIdx == DRIVE_CONT && currentShootMode == SHOOT_AUTO) {
    Serial.println("[DRIVE] Read-only in iAUTO -> switching TAKEMODE=P for Continuous Drive");
    if (setCameraPropWithLiveviewRetry(propModeName.c_str(), "P", &stoppedStream) == 200) {
      String actualM;
      confirmTakeModeChange("P", actualM);
      diag.expModeStr = "P";
      opcHttpGetWith520Retry(drvUrl.c_str(), drvDesc, 1500, 1000);
      writable = (drvDesc.indexOf("<attribute>getset</attribute>") != -1 ||
                  drvDesc.indexOf("<attribute>set</attribute>") != -1);
    }
  }

  String drvEnum = (code == 200) ? extractXmlEnum(drvDesc) : driveEnumCache;
  if (drvEnum.length() > 0) driveEnumCache = drvEnum;

  String targetTok = pickDriveTokenFromEnum(drvEnum, driveIdx, seqIdx);
  int setCode = setCameraPropWithLiveviewRetry(propDriveName.c_str(), targetTok, &stoppedStream);

  if (setCode != 200 && driveIdx == DRIVE_CONT) {
    const char* fallbacks[] = { "DRIVE_CONTINUE", "CONTINUOUS", "CONT_H", "CONT_L", "continuous-H" };
    for (uint8_t f = 0; f < 5; f++) {
      if (targetTok.equalsIgnoreCase(fallbacks[f])) continue;
      int tryCode = setCameraPropWithLiveviewRetry(propDriveName.c_str(), fallbacks[f], &stoppedStream);
      if (tryCode == 200) {
        targetTok = fallbacks[f];
        setCode = 200;
        break;
      }
    }
  }

  String verifiedVal = "";
  queryCameraProp(propDriveName.c_str(), verifiedVal, 800, 800);
  Serial.printf("[DRIVE] Set %s=%s -> HTTP %d (readback='%s')\\n",
                propDriveName.c_str(), targetTok.c_str(), setCode, verifiedVal.c_str());

  if (driveIdx == DRIVE_CONT) {
    driveContConfirmed = (setCode == 200);
  } else {
    driveContConfirmed = false;
  }

  // Also set dedicated sequential velocity property if exposed by firmware
  bool velAppliedOnHw = seqLowHwSupported;
  if (seqVelAvailable && propSeqVelName.length() > 0) {
    String velDesc;
    String velUrl = String("http://") + CAMERA_IP + "/get_camprop.cgi?com=desc&propname=" + propSeqVelName;
    if (opcHttpGet(velUrl.c_str(), velDesc, 1000, false, 800) == 200 && velDesc.indexOf("getset") != -1) {
      String velEnum = extractXmlEnum(velDesc);
      String velTok = findEnumTokenIgnoreCase(velEnum, (seqIdx == SEQ_HIGH) ? "HIGH" : "LOW");
      if (velTok.length() == 0) {
        velTok = findEnumTokenContains(velEnum, (seqIdx == SEQ_HIGH) ? "HI" : "LO");
      }
      if (velTok.length() > 0 && setCameraPropWithLiveviewRetry(propSeqVelName.c_str(), velTok, &stoppedStream) == 200) {
        velAppliedOnHw = true;
      }
    }
  }

  if (stoppedStream) {
    String resumeResp;
    opcHttpGetWith520Retry(URL_START_STREAM, resumeResp, 2000, 1200);
  }

  if (statusOut) {
    if (isSeqSpeedChange && !velAppliedOnHw) {
      *statusOut = (seqIdx == SEQ_LOW) ? "A-PACED" : "HW FIXED";
    } else if (setCode == 200) {
      *statusOut = String("OK:") + (verifiedVal.length() > 0 ? verifiedVal.substring(0, 5) : targetTok.substring(0, 5));
    } else if (!writable && code == 200) {
      *statusOut = "MODE LOCK";
    } else {
      *statusOut = "ERR:" + String(setCode);
    }
  }
  return (setCode == 200);
}

// ----------------------------------------------------------------------------
// Olympus Air Sound Volume Discovery & Set (SOUND_VOLUME_LEVEL)
// ----------------------------------------------------------------------------
void discoverAirSoundOptions() {
  if (WiFi.status() != WL_CONNECTED) return;

  if (!airSoundDiscovered) {
    discoverCameraPropertiesFromDesclist();
  }

  const char* candidates[] = { propAirSoundName.c_str(), "SOUND_VOLUME_LEVEL", "SOUND_VOLUME", "BEEP_VOLUME" };
  String resp;
  String enumStr;

  for (uint8_t c = 0; c < 4; c++) {
    if (!candidates[c] || candidates[c][0] == '\\0') continue;
    String url = String("http://") + CAMERA_IP + "/get_camprop.cgi?com=desc&propname=" + candidates[c];
    int code = opcHttpGetWith520Retry(url.c_str(), resp, 1500, 1000);
    if (code == 200) {
      enumStr = extractXmlEnum(resp);
      if (enumStr.length() > 0 || resp.indexOf("<value>") != -1) {
        propAirSoundName = candidates[c];
        parseSoundTokensFromEnum(enumStr);
        Serial.printf("[SOUND] Discovered %s (%u levels): %s\\n",
                      propAirSoundName.c_str(), (unsigned)airSoundCount, enumStr.c_str());
        break;
      }
    }
  }

  if (airSoundUserSet && savedAirSoundToken.length() > 0) {
    for (uint8_t k = 0; k < airSoundCount; k++) {
      if (airSoundTokens[k].equalsIgnoreCase(savedAirSoundToken)) {
        currentAirSoundIdx = k;
        return;
      }
    }
  }

  String curVal = extractXmlValue(resp);
  if (curVal.length() == 0) {
    queryCameraProp(propAirSoundName.c_str(), curVal, 800, 800);
  }
  if (!airSoundUserSet && curVal.length() > 0) {
    for (uint8_t k = 0; k < airSoundCount; k++) {
      if (airSoundTokens[k].equalsIgnoreCase(curVal)) {
        currentAirSoundIdx = k;
        break;
      }
    }
  } else if (currentAirSoundIdx >= airSoundCount) {
    currentAirSoundIdx = 0;
  }
}

bool applyAirSoundToCamera(uint8_t idx, String* statusOut) {
  if (idx >= airSoundCount) {
    if (statusOut) *statusOut = "NO ENUM";
    return false;
  }
  if (WiFi.status() != WL_CONNECTED) {
    if (statusOut) *statusOut = "QUEUED";
    return false;
  }

  if (!airSoundDiscovered) {
    discoverAirSoundOptions();
  }

  String tok = airSoundTokens[idx];
  bool stoppedStream = false;
  int code = setCameraPropWithLiveviewRetry(propAirSoundName.c_str(), tok, &stoppedStream);
  if (code != 200 && tok.equalsIgnoreCase("MIDDLE")) {
    code = setCameraPropWithLiveviewRetry(propAirSoundName.c_str(), "MID", &stoppedStream);
  }

  String verifiedVal = "";
  queryCameraProp(propAirSoundName.c_str(), verifiedVal, 700, 700);
  Serial.printf("[SOUND] Set %s=%s -> HTTP %d (readback='%s')\\n",
                propAirSoundName.c_str(), tok.c_str(), code, verifiedVal.c_str());

  if (stoppedStream) {
    String resumeResp;
    opcHttpGetWith520Retry(URL_START_STREAM, resumeResp, 2000, 1200);
  }

  if (statusOut) {
    if (code == 200) {
      *statusOut = "OK:" + formatAirSoundShort(verifiedVal.length() > 0 ? verifiedVal : tok);
    } else {
      *statusOut = "ERR:" + String(code);
    }
  }
  return (code == 200);
}

// Shutdown/Disconnect Flush (ONLY used on Power-Off — NOT when returning to Live View!)
// Applies session props while still in rec mode (where set_camprop is valid), then exits cleanly to standalone
void flushSettingsToStandaloneMode(bool resumeRecAfter) {
  if (WiFi.status() != WL_CONNECTED) return;
  String resp;
  opcHttpGet(URL_STOP_STREAM, resp, 700, true, 700);
  delay(60);

  if (airSoundUserSet && currentAirSoundIdx < airSoundCount) {
    setCameraPropXml(propAirSoundName.c_str(), airSoundTokens[currentAirSoundIdx], 1200);
  }
  if (driveDiscovered && propDriveName.length() > 0) {
    String dTok = pickDriveTokenFromEnum(driveEnumCache, currentDriveMode, currentSeqSpeed);
    setCameraPropXml(propDriveName.c_str(), dTok, 1200);
  }

  int stCode = opcHttpGetWith520Retry(URL_SWITCH_STDBY, resp, 1800, 1200);
  Serial.printf("[STANDALONE] switch_cameramode=standalone -> HTTP %d\\n", stCode);

  if (resumeRecAfter) {
    opcHttpGetWith520Retry(URL_SWITCH_REC, resp, 3000, 1500);
    opcHttpGetWith520Retry(URL_CHANGE_LVQTY, resp, 2000, 1200);
    resetRtpAssembler();
    opcHttpGetWith520Retry(URL_START_STREAM, resp, 2500, 1500);
    lastRxPacketMs = millis();
  }
}

// Deferred post-stream property sync (runs ONLY AFTER first valid video frame arrives)
void syncSavedCameraPropertiesAfterStream() {
  Serial.println("[GATE] First video frame received -> discovering desclist & syncing settings");
  discoverCameraPropertiesFromDesclist();
  discoverCameraAspectTokens();
  setCameraAspectRatio(currentAspectIdx);
  discoverExposurePropNames();
  applyShootingMode(currentShootMode);
  discoverDrivePropOptions();
  applyDriveModeToCamera(currentDriveMode, currentSeqSpeed);
  discoverAirSoundOptions();
  if (airSoundUserSet) {
    applyAirSoundToCamera(currentAirSoundIdx);
  }
  discoverBatteryPropEnum();
  updateCameraBatteryStatus(false);
  lastBatteryCheck = millis();

  if (diag.displayMode == 0) {
    updateExposureRail();
    updateTopBanner();
  } else {
    updateDiagnosticsScreenData();
  }
}

// ----------------------------------------------------------------------------
// Query /get_commandlist.cgi once per session for exec_pwoff & startliveview flags
// ----------------------------------------------------------------------------
void inspectOpcCommandList() {
  if (opcCommandListChecked || WiFi.status() != WL_CONNECTED) return;
  opcCommandListChecked = true;
  String cmdXml;
  String url = String("http://") + CAMERA_IP + "/get_commandlist.cgi";
  int code = opcHttpGetWith520Retry(url.c_str(), cmdXml, 1800, 1200);
  if (code == 200 && cmdXml.length() > 0) {
    int pwIdx = cmdXml.indexOf("exec_pwoff");
    String pwFrag = "none";
    if (pwIdx != -1) {
      int pwEnd = cmdXml.indexOf("</cgi>", pwIdx);
      if (pwEnd == -1) pwEnd = pwIdx + 180;
      pwFrag = cmdXml.substring(pwIdx, (pwEnd + 6 <= (int)cmdXml.length()) ? (pwEnd + 6) : cmdXml.length());
      pwFrag.replace("\\r", "");
      pwFrag.replace("\\n", " ");
      opcSupportsWithBlePwoff = (pwFrag.indexOf("withble") != -1);
    }
    int slvIdx = cmdXml.indexOf("startliveview");
    String slvFrag = "none";
    if (slvIdx != -1) {
      int slvEnd = cmdXml.indexOf("</cgi>", slvIdx);
      if (slvEnd == -1) slvEnd = slvIdx + 200;
      slvFrag = cmdXml.substring(slvIdx, (slvEnd + 6 <= (int)cmdXml.length()) ? (slvEnd + 6) : cmdXml.length());
      slvFrag.replace("\\r", "");
      slvFrag.replace("\\n", " ");
      opcSupportsLvInfo = (slvFrag.indexOf("lvinfo") != -1);
    }
    traceAppend("[OPC] cmdlist HTTP=200 pwoff=" + pwFrag.substring(0, 180), false);
    traceAppend("[OPC] startlv=" + slvFrag.substring(0, 180), true);
  } else {
    traceAppend("[OPC] get_commandlist.cgi -> HTTP " + String(code), true);
  }
}

// ----------------------------------------------------------------------------
// Fast Olympus Air A01 HTTP CGI Handshake Sequence
// Follows stanelie/airview order: mode=rec -> changelvqty (520 retry) -> startliveview
// Applies pre-queued Air Sound (e.g., muted on boot screen) immediately after mode=rec
// ----------------------------------------------------------------------------
bool performOlympusHandshake() {
  String resp;

  showConnectingSplash("Step 1/3: Mode Check", "GET /get_connectmode.cgi");
  diag.cgi1Code = opcHttpGetWith520Retry(URL_CONNECT_MODE, resp, 3000);
  Serial.printf("[CGI] get_connectmode -> HTTP %d\\n", diag.cgi1Code);

  showConnectingSplash("Step 2/3: Arm & LvQty", "switch_cameramode=rec");
  diag.cgi2Code = opcHttpGetWith520Retry(URL_SWITCH_REC, resp, 4000);
  Serial.printf("[CGI] switch_cameramode -> HTTP %d\\n", diag.cgi2Code);

  if (diag.cgi2Code != 200) {
    Serial.println("[CGI] Resetting stale Air A01 session (stopliveview -> standalone -> rec)...");
    opcHttpGet(URL_STOP_STREAM, resp, 1200);
    opcHttpGet(URL_SWITCH_STDBY, resp, 1200);
    delay(250);
    diag.cgi2Code = opcHttpGetWith520Retry(URL_SWITCH_REC, resp, 4000);
  }

  inspectOpcCommandList();

  // If user pre-muted / set Air Sound in Quick Menu before connecting, apply it right away in rec mode!
  if (airSoundUserSet && currentAirSoundIdx < airSoundCount) {
    String sndTok = (savedAirSoundToken.length() > 0) ? savedAirSoundToken : airSoundTokens[currentAirSoundIdx];
    setCameraPropXml(propAirSoundName.c_str(), sndTok, 1200);
  }

  int lvqCode = opcHttpGetWith520Retry(URL_CHANGE_LVQTY, resp, 2500);
  Serial.printf("[CGI] changelvqty -> HTTP %d\\n", lvqCode);

  if (!diag.udpListening) {
    if (udp.listen(STREAM_PORT)) {
      udp.onPacket(onRtpPacket);
      diag.udpListening = true;
      Serial.printf("[UDP] AsyncUDP listening on port %d\\n", STREAM_PORT);
    } else {
      diag.lastError = "UDPerr";
      return false;
    }
  }

  showConnectingSplash("Step 3/3: Start Stream", "startliveview:" + String(STREAM_PORT));
  resetRtpAssembler();
  sawFirstVideoFrame    = false;
  pendingPostStreamSync = true;
  lastRxPacketMs = millis();

  diag.cgi3Code = opcHttpGetWith520Retry(URL_START_STREAM, resp, 3500);
  Serial.printf("[CGI] startliveview -> HTTP %d\\n", diag.cgi3Code);

  if (diag.cgi3Code == 200 || diag.cgi3Code == 204) {
    diag.lastError = "LIVE";
    sessionReady = true;
    return true;
  } else {
    diag.lastError = "CGI" + String(diag.cgi3Code);
    sessionReady = false;
    return false;
  }
}

// ----------------------------------------------------------------------------
// M5StickS3 Persistent Clock / RTC (Preserved via Deep Sleep) + Air Sync
// ----------------------------------------------------------------------------
void initStickClockOnBoot() {
  setenv("TZ", "UTC0", 1);
  tzset();

  if (rtcSyncMagic == RTC_SYNC_MAGIC && rtcClockSynced) {
    time_t nowSec = time(nullptr);
    struct tm tmNow;
    if (nowSec > 0 && localtime_r(&nowSec, &tmNow) != nullptr) {
      uint16_t yr = (uint16_t)(tmNow.tm_year + 1900);
      if (yr >= 2015 && yr <= 2099) {
        clockSynced          = true;
        clockLastSyncYear    = yr;
        clockInvalid2015     = rtcClockInvalid2015 || (yr <= 2015);
        clockLastStopwatchMs = rtcLastStopwatchMs;
        clockLastSyncFile    = String(rtcLastSyncFile);
        clockSyncPendingOnShutter = clockInvalid2015;
        Serial.printf("[CLOCK] Restored ESP32-S3 RTC across Deep Sleep: %04d-%02d-%02d %02d:%02d:%02d (inv2015=%d)\\n",
                      (int)yr, tmNow.tm_mon + 1, tmNow.tm_mday,
                      tmNow.tm_hour, tmNow.tm_min, tmNow.tm_sec,
                      clockInvalid2015 ? 1 : 0);
        return;
      }
    }
  }

  if (M5.Rtc.isEnabled()) {
    auto dt = M5.Rtc.getDateTime();
    if (dt.date.year >= 2015 && dt.date.year <= 2099) {
      struct tm tmBoot = {};
      tmBoot.tm_year = dt.date.year - 1900;
      tmBoot.tm_mon  = (dt.date.month >= 1 && dt.date.month <= 12) ? (dt.date.month - 1) : 0;
      tmBoot.tm_mday = (dt.date.date >= 1 && dt.date.date <= 31) ? dt.date.date : 1;
      tmBoot.tm_hour = dt.time.hours % 24;
      tmBoot.tm_min  = dt.time.minutes % 60;
      tmBoot.tm_sec  = dt.time.seconds % 60;
      time_t ep = mktime(&tmBoot);
      if (ep > 0) {
        struct timeval tv = { .tv_sec = ep, .tv_usec = 0 };
        settimeofday(&tv, nullptr);
        clockSynced       = true;
        clockLastSyncYear = dt.date.year;
        rtcSyncMagic      = RTC_SYNC_MAGIC;
        rtcClockSynced    = true;
        rtcLastSyncYear   = dt.date.year;
        if (dt.date.year <= 2015) {
          clockInvalid2015          = true;
          rtcClockInvalid2015       = true;
          clockSyncPendingOnShutter = true;
        } else {
          clockSyncPendingOnShutter = clockInvalid2015;
        }
        Serial.printf("[CLOCK] Restored HW RTC: %04d-%02d-%02d %02d:%02d:%02d (inv2015=%d)\\n",
                      (int)dt.date.year, (int)dt.date.month, (int)dt.date.date,
                      (int)dt.time.hours, (int)dt.time.minutes, (int)dt.time.seconds,
                      clockInvalid2015 ? 1 : 0);
      }
    }
  }
}

bool getStickLocalTime(struct tm* outTm) {
  if (!outTm || !clockSynced) return false;
  time_t nowSec = time(nullptr);
  if (nowSec <= 0) return false;
  localtime_r(&nowSec, outTm);
  return true;
}

String getClockTimeStr(bool includeSeconds) {
  struct tm tmNow;
  if (!getStickLocalTime(&tmNow)) {
    return includeSeconds ? String("--:--:--") : String("--:--");
  }
  char buf[12];
  if (includeSeconds) {
    snprintf(buf, sizeof(buf), "%02d:%02d:%02d", tmNow.tm_hour, tmNow.tm_min, tmNow.tm_sec);
  } else {
    snprintf(buf, sizeof(buf), "%02d:%02d", tmNow.tm_hour, tmNow.tm_min);
  }
  return String(buf);
}

String getClockDateStr() {
  struct tm tmNow;
  if (!getStickLocalTime(&tmNow)) {
    return String("----/--/--");
  }
  char buf[16];
  snprintf(buf, sizeof(buf), "%04d-%02d-%02d", tmNow.tm_year + 1900, tmNow.tm_mon + 1, tmNow.tm_mday);
  return String(buf);
}

void drawClockBadgeOnGfx(LovyanGFX* gfx, int16_t rightX, int16_t y, uint16_t normBg, bool compact) {
  if (!gfx) return;
  gfx->setTextSize(1);
  if (clockInvalid2015) {
    String txt = compact ? "2015!" : "2015!INV";
    int16_t tw = (int16_t)(txt.length() * 6);
    int16_t bx = rightX - tw - 4;
    if (bx < 0) bx = 0;
    gfx->fillRoundRect(bx, y - 2, tw + 4, 11, 2, TFT_RED);
    gfx->setTextColor(TFT_WHITE, TFT_RED);
    gfx->setCursor(bx + 2, y);
    gfx->print(txt);
  } else if (clockSynced) {
    String txt = getClockTimeStr(!compact);
    int16_t tw = (int16_t)(txt.length() * 6);
    int16_t bx = rightX - tw;
    if (bx < 0) bx = 0;
    gfx->setTextColor(TFT_CYAN, normBg);
    gfx->setCursor(bx, y);
    gfx->print(txt);
  } else {
    String txt = compact ? "--:--" : "CLK:--:--";
    int16_t tw = (int16_t)(txt.length() * 6);
    int16_t bx = rightX - tw;
    if (bx < 0) bx = 0;
    gfx->setTextColor(M5.Display.color565(148, 163, 184), normBg);
    gfx->setCursor(bx, y);
    gfx->print(txt);
  }
}

void showInvalidClock2015Alert(const String& fileLabel, uint16_t yr, const String& timeStr) {
  int16_t w = M5.Display.width();
  int16_t h = M5.Display.height();
  bool port = isPortraitOrientation();
  uint16_t bg  = M5.Display.color565(90, 10, 14);
  uint16_t hdr = TFT_RED;

  bool useSprite = ensureUiCanvas();
  LovyanGFX* gfx = useSprite ? static_cast<LovyanGFX*>(&uiCanvas) : static_cast<LovyanGFX*>(&M5.Display);
  if (!useSprite) gfx->startWrite();
  gfx->fillScreen(bg);
  gfx->fillRect(0, 0, w, 20, hdr);
  gfx->setTextSize(1);
  gfx->setTextColor(TFT_WHITE, hdr);
  gfx->setCursor(6, 6);
  gfx->print(port ? "! AIR CLOCK 2015 !" : "! OLYMPUS AIR CLOCK INVALID !");

  gfx->drawRect(2, 22, w - 4, h - 24, TFT_RED);
  int16_t y = port ? 34 : 28;
  gfx->setTextColor(TFT_YELLOW, bg);
  gfx->setCursor(8, y);
  gfx->printf("Photo year read: %04u", (unsigned)yr);

  gfx->setTextColor(TFT_WHITE, bg);
  gfx->setCursor(8, y + 14);
  gfx->print(fileLabel.substring(0, port ? 19 : 34));
  gfx->setCursor(8, y + 26);
  gfx->print(timeStr.substring(0, port ? 19 : 34));

  gfx->setTextColor(TFT_CYAN, bg);
  gfx->setCursor(8, y + 44);
  gfx->print(port ? "Air lost date/time!" : "Air A01 lost its date/time!");
  gfx->setCursor(8, y + 58);
  gfx->print(port ? "Set via phone app," : "Re-sync Air time with phone app,");
  gfx->setCursor(8, y + 72);
  gfx->print(port ? "then shoot to sync." : "then take a photo to re-sync RTC.");

  gfx->fillRect(0, h - 18, w, 18, hdr);
  gfx->setTextColor(TFT_WHITE, hdr);
  gfx->setCursor(8, h - 13);
  gfx->print("[A]/[B] Dismiss");

  if (useSprite) {
    uiCanvas.pushSprite(0, 0);
  } else {
    gfx->endWrite();
  }

  playTone(880, 130);
  delay(60);
  playTone(660, 190);
  delay(60);
  playTone(880, 140);

  unsigned long alertStart = millis();
  while (millis() - alertStart < 2800UL) {
    pollAllButtons();
    if (checkComboShutdownTriggered()) shutdownCameraAndM5();
    if (M5.BtnA.wasPressed() || M5.BtnB.wasPressed()) break;
    delay(20);
  }
}

static bool parseImgListLine(const String& line, ImgListItem& out) {
  out.valid = false;
  if (line.length() < 5 || line.startsWith("VER_")) return false;
  int c1 = line.indexOf(',');
  int c2 = (c1 >= 0) ? line.indexOf(',', c1 + 1) : -1;
  int c3 = (c2 >= 0) ? line.indexOf(',', c2 + 1) : -1;
  int c4 = (c3 >= 0) ? line.indexOf(',', c3 + 1) : -1;
  int c5 = (c4 >= 0) ? line.indexOf(',', c4 + 1) : -1;
  if (c1 < 0 || c2 < 0 || c3 < 0 || c4 < 0 || c5 < 0) return false;

  String dir  = line.substring(0, c1); dir.trim();
  String name = line.substring(c1 + 1, c2); name.trim();
  if (name.length() == 0) return false;

  uint32_t sz   = (uint32_t)strtoul(line.substring(c2 + 1, c3).c_str(), nullptr, 10);
  uint16_t attr = (uint16_t)strtoul(line.substring(c3 + 1, c4).c_str(), nullptr, 10);
  uint16_t fDt  = (uint16_t)strtoul(line.substring(c4 + 1, c5).c_str(), nullptr, 10);
  uint16_t fTm  = (uint16_t)strtoul(line.substring(c5 + 1).c_str(), nullptr, 10);

  out.isDir = ((attr & 0x10) != 0);
  if (dir.endsWith("/")) out.fullPath = dir + name;
  else if (dir.length() > 0) out.fullPath = dir + "/" + name;
  else out.fullPath = "/" + name;
  out.name      = name;
  out.sizeBytes = sz;
  out.attr      = attr;
  out.fatDate   = fDt;
  out.fatTime   = fTm;
  out.sortKey   = ((uint32_t)fDt << 16) | (uint32_t)fTm;
  out.valid     = true;
  return true;
}

static bool queryImgListDir(const String& dirPath, ImgListItem& bestDir, ImgListItem& bestFile) {
  bestDir.valid  = false;
  bestDir.sortKey = 0;
  bestFile.valid = false;
  bestFile.sortKey = 0;

  String url = String(URL_IMGLIST_BASE) + dirPath;
  String resp;
  int code = opcHttpGetWith520Retry(url.c_str(), resp, 2500, 1200);
  Serial.printf("[IMGLIST] GET %s -> HTTP %d (%u bytes)\\n", url.c_str(), code, (unsigned)resp.length());
  if (code != 200 || resp.length() < 4 || resp.indexOf("<errcode>") != -1) {
    return false;
  }

  int pos = 0;
  while (pos < (int)resp.length()) {
    int nl = resp.indexOf('\\n', pos);
    String ln = (nl == -1) ? resp.substring(pos) : resp.substring(pos, nl);
    ln.trim();
    pos = (nl == -1) ? resp.length() : (nl + 1);
    ImgListItem item;
    if (!parseImgListLine(ln, item)) continue;
    if (item.isDir) {
      if (!bestDir.valid || item.sortKey > bestDir.sortKey ||
          (item.sortKey == bestDir.sortKey && item.name > bestDir.name)) {
        bestDir = item;
      }
    } else if (item.fatDate > 0) {
      if (!bestFile.valid || item.sortKey > bestFile.sortKey ||
          (item.sortKey == bestFile.sortKey && item.name > bestFile.name)) {
        bestFile = item;
      }
    }
  }
  return true;
}

bool syncClockFromAirImageList(unsigned long stopwatchStartMs) {
  if (WiFi.status() != WL_CONNECTED) return false;
  diag.lastError = "SYNC..";
  updateTopBanner();

  ImgListItem bestDir, bestFile;
  bool switchedToPlay = false;

  bool dcimOk = queryImgListDir("/DCIM", bestDir, bestFile);
  if (!dcimOk) {
    String modeResp;
    opcHttpGet(URL_STOP_STREAM, modeResp, 700, true, 700);
    delay(60);
    int pCode = opcHttpGetWith520Retry(URL_SWITCH_PLAY, modeResp, 2200, 1200);
    Serial.printf("[IMGLIST] switch_cameramode=play -> HTTP %d\\n", pCode);
    if (pCode == 200) {
      switchedToPlay = true;
      delay(80);
      dcimOk = queryImgListDir("/DCIM", bestDir, bestFile);
    }
  }

  if (dcimOk && bestDir.valid) {
    ImgListItem subDirDummy, subBestFile;
    if (queryImgListDir(bestDir.fullPath, subDirDummy, subBestFile) && subBestFile.valid) {
      bestFile = subBestFile;
    } else if (!bestFile.valid) {
      delay(180);
      if (queryImgListDir(bestDir.fullPath, subDirDummy, subBestFile) && subBestFile.valid) {
        bestFile = subBestFile;
      }
    }
  } else if (dcimOk && !bestFile.valid) {
    ImgListItem subDirDummy, subBestFile;
    if (queryImgListDir("/DCIM/100OLYMP", subDirDummy, subBestFile) && subBestFile.valid) {
      bestFile = subBestFile;
    } else {
      delay(180);
      if (queryImgListDir("/DCIM/100OLYMP", subDirDummy, subBestFile) && subBestFile.valid) {
        bestFile = subBestFile;
      }
    }
  }

  if (switchedToPlay) {
    String recResp;
    opcHttpGetWith520Retry(URL_SWITCH_REC, recResp, 3000, 1500);
    opcHttpGetWith520Retry(URL_CHANGE_LVQTY, recResp, 2000, 1200);
  }

  if (!bestFile.valid) {
    Serial.println("[CLOCK] No timestamped images returned by /get_imglist.cgi");
    diag.lastError = "NOIMG!";
    return false;
  }

  unsigned long elapsedMs = millis() - stopwatchStartMs;
  uint16_t yr = ((bestFile.fatDate >> 9) & 0x7F) + 1980;
  uint8_t  mo = (bestFile.fatDate >> 5) & 0x0F; if (mo < 1 || mo > 12) mo = 1;
  uint8_t  dy = bestFile.fatDate & 0x1F;        if (dy < 1 || dy > 31) dy = 1;
  uint8_t  hr = (bestFile.fatTime >> 11) & 0x1F; if (hr > 23) hr = 0;
  uint8_t  mn = (bestFile.fatTime >> 5) & 0x3F;  if (mn > 59) mn = 0;
  uint8_t  sc = (bestFile.fatTime & 0x1F) * 2;   if (sc > 59) sc = 58;

  struct tm photoTm = {};
  photoTm.tm_year = (int)yr - 1900;
  photoTm.tm_mon  = (int)mo - 1;
  photoTm.tm_mday = (int)dy;
  photoTm.tm_hour = (int)hr;
  photoTm.tm_min  = (int)mn;
  photoTm.tm_sec  = (int)sc;
  time_t photoEpoch  = mktime(&photoTm);
  time_t targetEpoch = photoEpoch + (time_t)((elapsedMs + 500UL) / 1000UL);

  struct timeval tv = { .tv_sec = targetEpoch, .tv_usec = 0 };
  settimeofday(&tv, nullptr);

  struct tm setTm;
  localtime_r(&targetEpoch, &setTm);
  if (M5.Rtc.isEnabled()) {
    m5::rtc_datetime_t rtcDt;
    rtcDt.date.year    = (int16_t)(setTm.tm_year + 1900);
    rtcDt.date.month   = (int8_t)(setTm.tm_mon + 1);
    rtcDt.date.date    = (int8_t)setTm.tm_mday;
    rtcDt.date.weekDay = (int8_t)setTm.tm_wday;
    rtcDt.time.hours   = (int8_t)setTm.tm_hour;
    rtcDt.time.minutes = (int8_t)setTm.tm_min;
    rtcDt.time.seconds = (int8_t)setTm.tm_sec;
    M5.Rtc.setDateTime(rtcDt);
  }

  clockSynced          = true;
  clockLastSyncYear    = (uint16_t)(setTm.tm_year + 1900);
  clockLastSyncFile    = bestFile.name;
  clockLastStopwatchMs = (uint32_t)elapsedMs;

  rtcSyncMagic       = RTC_SYNC_MAGIC;
  rtcClockSynced     = true;
  rtcLastSyncYear    = clockLastSyncYear;
  rtcLastStopwatchMs = clockLastStopwatchMs;
  strncpy(rtcLastSyncFile, bestFile.name.c_str(), sizeof(rtcLastSyncFile) - 1);
  rtcLastSyncFile[sizeof(rtcLastSyncFile) - 1] = '\\0';

  char syncBuf[28];
  snprintf(syncBuf, sizeof(syncBuf), "%04d-%02d-%02d %02d:%02d:%02d",
           setTm.tm_year + 1900, setTm.tm_mon + 1, setTm.tm_mday,
           setTm.tm_hour, setTm.tm_min, setTm.tm_sec);
  Serial.printf("[CLOCK] Latest=%s (%04u-%02u-%02u %02u:%02u:%02u) + %lums -> Stick RTC=%s\\n",
                bestFile.fullPath.c_str(), (unsigned)yr, (unsigned)mo, (unsigned)dy,
                (unsigned)hr, (unsigned)mn, (unsigned)sc, elapsedMs, syncBuf);
  traceAppend("[CLOCK] Sync " + bestFile.name + " +" + String(elapsedMs) + "ms -> " + String(syncBuf), true);

  if (clockLastSyncYear <= 2015 || yr == 2015) {
    clockInvalid2015          = true;
    rtcClockInvalid2015       = true;
    clockSyncPendingOnShutter = true;
    saveSettingsToNvs();
    diag.lastError = "2015!";
    showInvalidClock2015Alert(bestFile.name, clockLastSyncYear, String(syncBuf));
  } else {
    clockInvalid2015          = false;
    rtcClockInvalid2015       = false;
    clockSyncPendingOnShutter = false;
    saveSettingsToNvs();
    diag.lastError = "CLKOK!";
    playTone(3000, 35);
    delay(30);
    playTone(3600, 45);
  }
  return true;
}

// ----------------------------------------------------------------------------
// Real OPC Autofocus & Shutter Release (Button A - GPIO 11)
// ----------------------------------------------------------------------------
void triggerSnapshot() {
  Serial.println("[SHUTTER] Button A pressed -> OPC Capture Sequence");
  pauseUdpAssembly = true;
  diag.lastError = "AF...";
  updateTopBanner();

  M5.Display.startWrite();
  drawAfReticle(true);
  M5.Display.endWrite();
  playTone(2800, 30);

  String resp;
  diag.readyCode = opcHttpGetWith520Retry(URL_TAKE_READY, resp, 4000);

  M5.Display.startWrite();
  M5.Display.drawRect(vpX() - 1, vpY() - 1, vpW() + 2, vpH() + 2, TFT_WHITE);
  M5.Display.endWrite();
  playTone(3500, 50);

  diag.lastError = "SNAP..";
  updateTopBanner();

  unsigned long clockStopwatchStartMs = millis();
  bool usedLegacyTake = false;
  diag.lastShutterCode = opcHttpGet(URL_NEW_START, resp, 7000);
  if (diag.lastShutterCode != 200 && diag.lastShutterCode != 204) {
    usedLegacyTake = true;
    diag.lastShutterCode = opcHttpGet(URL_OLD_START, resp, 7000);
  }

  // Time-critical shutter stop bypasses 50ms inter-call throttle (urgent = true)
  if (usedLegacyTake) {
    diag.stopCode = opcHttpGet(URL_OLD_STOP, resp, 4000, true);
  } else {
    diag.stopCode = opcHttpGet(URL_NEW_STOP, resp, 4000, true);
  }

  if (diag.lastShutterCode == 200 || diag.lastShutterCode == 204) {
    diag.lastError = "SAVED!";
    playTone(1800, 40);
    if (clockSyncPendingOnShutter || clockInvalid2015 || !clockSynced) {
      syncClockFromAirImageList(clockStopwatchStartMs);
    }
  } else {
    diag.lastError = "ERR" + String(diag.lastShutterCode);
  }

  resetRtpAssembler();
  int resumeCode = opcHttpGetWith520Retry(URL_START_STREAM, resp, 3000);
  Serial.printf("[SHUTTER] resume startliveview -> HTTP %d\\n", resumeCode);
  lastRxPacketMs = millis();
  pauseUdpAssembly = false;

  if (!diag.hasRtpExt) {
    pollNextExposureProp(true);
  }

  if (diag.displayMode == 1) {
    updateDiagnosticsScreenData();
  } else {
    drawChromeUI();
    updateTopBanner();
  }
}

// ----------------------------------------------------------------------------
// Continuous Burst Start / Stop (Drive Mode: CONT — Hardware + Sequential Fallback)
// ----------------------------------------------------------------------------
void startContinuousBurst() {
  Serial.println("[BURST] Starting Continuous Shooting");
  pauseUdpAssembly = true;
  diag.lastError = "AF...";
  updateTopBanner();

  if (!driveContConfirmed) {
    applyDriveModeToCamera(DRIVE_CONT, currentSeqSpeed);
  }

  M5.Display.startWrite();
  drawAfReticle(true);
  M5.Display.endWrite();
  playTone(2800, 30);

  String resp;
  diag.readyCode = opcHttpGetWith520Retry(URL_TAKE_READY, resp, 3500);
  playTone(3500, 50);

  unsigned long tStart = millis();
  diag.lastShutterCode = opcHttpGet(URL_NEW_START, resp, 5000);
  if (diag.lastShutterCode == 520 || diag.lastShutterCode == 409 || diag.lastShutterCode == 503) {
    delay(120);
    diag.lastShutterCode = opcHttpGet(URL_NEW_START, resp, 5000);
  }
  if (diag.lastShutterCode != 200 && diag.lastShutterCode != 204) {
    diag.lastShutterCode = opcHttpGet(URL_OLD_START, resp, 5000);
  }
  unsigned long takeDurationMs = millis() - tStart;

  if (diag.lastShutterCode == 200 || diag.lastShutterCode == 204) {
    contBurstActive      = true;
    contBurstStartMs     = millis();
    contBurstLastShotMs  = contBurstStartMs;
    // Use Wi-Fi paced loop if drive isn't writable, camera blocked for single frame, or LOW speed requested without HW L support
    contBurstManualLoop  = (!driveContConfirmed ||
                            (currentSeqSpeed == SEQ_LOW && !seqLowHwSupported) ||
                            resp.indexOf("<file>") != -1 ||
                            takeDurationMs >= 320);
    diag.lastError       = "BURST!";
    Serial.printf("[BURST] Started OK (%lu ms, mode=%s): %s\\n",
                  takeDurationMs,
                  contBurstManualLoop ? "WIFI-PACED" : "HW-CONT",
                  resp.substring(0, 80).c_str());
  } else {
    contBurstActive     = false;
    contBurstManualLoop = false;
    diag.lastError      = "ERR" + String(diag.lastShutterCode);
    pauseUdpAssembly    = false;
  }
  lastRxPacketMs = millis();
  updateTopBanner();
}

void stopContinuousBurst() {
  Serial.println("[BURST] Stopping Continuous Shooting");
  pauseUdpAssembly = true;
  unsigned long clockStopwatchStartMs = millis();
  String resp;
  diag.stopCode = opcHttpGet(URL_NEW_STOP, resp, 4000, true);
  if (diag.stopCode != 200 && diag.stopCode != 204) {
    diag.stopCode = opcHttpGet(URL_OLD_STOP, resp, 4000, true);
  }
  contBurstActive     = false;
  contBurstManualLoop = false;
  diag.lastError      = "SAVED!";
  playTone(1800, 45);

  if (clockSyncPendingOnShutter || clockInvalid2015 || !clockSynced) {
    syncClockFromAirImageList(clockStopwatchStartMs);
  }

  delay(80);
  resetRtpAssembler();
  opcHttpGetWith520Retry(URL_START_STREAM, resp, 3000);
  lastRxPacketMs = millis();
  pauseUdpAssembly = false;

  if (diag.displayMode == 1) {
    updateDiagnosticsScreenData();
  } else {
    drawChromeUI();
    updateTopBanner();
  }
}

// ----------------------------------------------------------------------------
// ESP32-S3 Deep Sleep (Keeps Internal RTC Alive + Configurable Wake Keys)
//   - Wake keys: BTN B (GPIO 12, default), BTN A (GPIO 11), A+B
// ----------------------------------------------------------------------------
void enterDeepSleepInternal(bool powerOffAir) {
  if (wakeKeyMode >= WAKE_COUNT) wakeKeyMode = WAKE_BTN_B;
  Serial.printf("[SLEEP] Entering Deep Sleep (%s, Wake=%s, RTC=%s)\\n",
                powerOffAir ? "AIR+STICK" : "STICK-ONLY",
                WAKE_KEY_NAMES[wakeKeyMode],
                clockSynced ? getClockTimeStr(true).c_str() : "PENDING");
  saveSettingsToNvs();

  M5.Display.fillScreen(TFT_BLACK);
  M5.Display.setTextSize(1);
  M5.Display.setTextColor(powerOffAir ? TFT_RED : TFT_CYAN, TFT_BLACK);
  M5.Display.setCursor(isPortraitOrientation() ? 8 : 34, (M5.Display.height() / 2) - 10);
  M5.Display.print(powerOffAir ? "DEEP SLEEP AIR+S3" : "SLEEP S3 (AIR ON)");
  M5.Display.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
  M5.Display.setCursor(isPortraitOrientation() ? 8 : 34, (M5.Display.height() / 2) + 4);
  M5.Display.printf("Wake:%s RTC:ALIVE", WAKE_KEY_NAMES[wakeKeyMode]);

  if (WiFi.status() == WL_CONNECTED) {
    flushSettingsToStandaloneMode(false);
    if (powerOffAir) {
      String bye;
      String pwoffUrl = opcSupportsWithBlePwoff ? (String(URL_POWER_OFF) + "?mode=withble") : String(URL_POWER_OFF);
      int pwCode = opcHttpGetWith520Retry(pwoffUrl.c_str(), bye, 2000);
      traceAppend("[SLEEP] " + pwoffUrl + " -> HTTP " + String(pwCode), true);
      // Per PlayOPC DeveloperNote: send NO further CGI commands after power-off
      delay(150);
    }
  }
  WiFi.disconnect(true, powerOffAir);
  WiFi.mode(WIFI_OFF);

  playTone(powerOffAir ? 1200 : 1500, 100);
  delay(180);
  M5.Speaker.end();

  bool useBtnBWake = (wakeKeyMode == WAKE_BTN_B || wakeKeyMode == WAKE_A_AND_B);
  bool useBtnAWake = (wakeKeyMode == WAKE_BTN_A || wakeKeyMode == WAKE_A_AND_B);

  // Wait until physical buttons release so EXT1 ANY_LOW doesn't trigger immediately on release edge
  unsigned long waitRelStart = millis();
  while (millis() - waitRelStart < 2000UL) {
    M5.update();
    if (!M5.BtnA.isPressed() && !M5.BtnB.isPressed()) break;
    delay(15);
  }
  delay(40);

  M5.Display.setBrightness(0);
  M5.Display.sleep();
  M5.Display.waitDisplay();
  M5.Power.setExtOutput(false);

  uint64_t ext1Mask = 0;
  if (useBtnBWake) {
    rtc_gpio_init(PIN_BTN_B_GPIO);
    rtc_gpio_set_direction(PIN_BTN_B_GPIO, RTC_GPIO_MODE_INPUT_ONLY);
    rtc_gpio_pullup_en(PIN_BTN_B_GPIO);
    rtc_gpio_pulldown_dis(PIN_BTN_B_GPIO);
    ext1Mask |= (1ULL << PIN_BTN_B_GPIO);
  }
  if (useBtnAWake) {
    rtc_gpio_init(PIN_BTN_A_GPIO);
    rtc_gpio_set_direction(PIN_BTN_A_GPIO, RTC_GPIO_MODE_INPUT_ONLY);
    rtc_gpio_pullup_en(PIN_BTN_A_GPIO);
    rtc_gpio_pulldown_dis(PIN_BTN_A_GPIO);
    ext1Mask |= (1ULL << PIN_BTN_A_GPIO);
  }
  if (ext1Mask == 0) {
    rtc_gpio_init(PIN_BTN_B_GPIO);
    rtc_gpio_set_direction(PIN_BTN_B_GPIO, RTC_GPIO_MODE_INPUT_ONLY);
    rtc_gpio_pullup_en(PIN_BTN_B_GPIO);
    rtc_gpio_pulldown_dis(PIN_BTN_B_GPIO);
    ext1Mask = (1ULL << PIN_BTN_B_GPIO);
  }

  esp_sleep_pd_config(ESP_PD_DOMAIN_RTC_PERIPH, ESP_PD_OPTION_ON);
#if defined(ESP_IDF_VERSION) && ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
  esp_sleep_enable_ext1_wakeup_io(ext1Mask, ESP_EXT1_WAKEUP_ANY_LOW);
#else
  esp_sleep_enable_ext1_wakeup(ext1Mask, ESP_EXT1_WAKEUP_ANY_LOW);
#endif
  Serial.printf("[SLEEP] esp_deep_sleep_start() EXT1=0x%llX\\n", (unsigned long long)ext1Mask);
  Serial.flush();
  esp_deep_sleep_start();
}

void shutdownCameraAndM5() {
  enterDeepSleepInternal(true);
}

void shutdownM5OnlyKeepAir() {
  enterDeepSleepInternal(false);
}

// ----------------------------------------------------------------------------
// Focus Peaking Submenu (Flicker-Free M5Canvas, 2-Button)
// ----------------------------------------------------------------------------
static const int PEAK_SUBMENU_COUNT = 6;

void drawFocusPeakSubmenuScreen(int selectedIdx, const String& statusBadge) {
  int16_t w    = M5.Display.width();
  int16_t h    = M5.Display.height();
  bool    port = isPortraitOrientation();

  uint16_t bg     = TFT_BLACK;
  uint16_t hdrBg  = M5.Display.color565(15, 23, 42);
  uint16_t selBg  = M5.Display.color565(234, 88, 12);
  uint16_t footBg = M5.Display.color565(17, 24, 39);

  int maxVisible = port ? 10 : 5;
  int rowH       = 18;
  int listTop    = 21;
  int scrollStart = 0;
  if (PEAK_SUBMENU_COUNT > maxVisible && selectedIdx >= maxVisible - 1) {
    scrollStart = selectedIdx - maxVisible + 2;
    int maxStart = PEAK_SUBMENU_COUNT - maxVisible;
    if (scrollStart > maxStart) scrollStart = maxStart;
  }

  bool useSprite = ensureUiCanvas();
  LovyanGFX* gfx = useSprite ? static_cast<LovyanGFX*>(&uiCanvas) : static_cast<LovyanGFX*>(&M5.Display);

  if (!useSprite) gfx->startWrite();
  gfx->fillScreen(bg);
  gfx->fillRect(0, 0, w, 19, hdrBg);
  gfx->drawFastHLine(0, 19, w, M5.Display.color565(51, 65, 85));
  gfx->setTextSize(1);
  gfx->setTextColor(TFT_CYAN, hdrBg);
  gfx->setCursor(4, 6);
  gfx->print(port ? "PEAK SETUP" : "FOCUS PEAKING SETUP");

  if (statusBadge.length() > 0) {
    String bShort = statusBadge.substring(0, port ? 10 : 14);
    gfx->setTextColor(TFT_GREEN, hdrBg);
    gfx->setCursor(w - (int16_t)(bShort.length() * 6) - 4, 6);
    gfx->print(bShort);
  }

  for (int row = 0; row < maxVisible; row++) {
    int idx = scrollStart + row;
    if (idx >= PEAK_SUBMENU_COUNT) break;

    int16_t ry  = listTop + row * rowH;
    bool    sel = (idx == selectedIdx);
    uint16_t rowFill = sel ? selBg : bg;
    gfx->fillRect(2, ry, w - 4, rowH - 1, rowFill);

    String label = "";
    String val   = "";
    uint16_t txtCol = sel ? TFT_WHITE : TFT_LIGHTGREY;

    switch (idx) {
      case 0:
        label = "< Back";
        txtCol = sel ? TFT_WHITE : TFT_CYAN;
        break;
      case 1:
        label = "Peaking";
        val   = peakEnabled ? "ON" : "OFF";
        txtCol = sel ? TFT_WHITE : (peakEnabled ? TFT_GREEN : TFT_LIGHTGREY);
        break;
      case 2:
        label = "Color";
        val   = PEAK_COLOR_NAMES[peakColorIdx];
        txtCol = sel ? TFT_WHITE : PEAK_COLOR_RGB565[peakColorIdx];
        break;
      case 3:
        label = "Thick";
        val   = PEAK_THICK_NAMES[peakThickness];
        break;
      case 4:
        label = "Sens";
        val   = PEAK_SENS_NAMES[peakSensitivity];
        break;
      case 5:
        label = "Source";
        val   = PEAK_SOURCE_NAMES[peakSource];
        txtCol = sel ? TFT_WHITE : TFT_CYAN;
        break;
    }

    gfx->setTextColor(txtCol, rowFill);
    gfx->setCursor(6, ry + 5);
    if (val.length() > 0) {
      int totalChars = port ? 19 : 36;
      int pad = totalChars - (int)label.length() - (int)val.length() - 1;
      if (pad < 1) pad = 1;
      String line = String(sel ? ">" : " ") + label;
      for (int p = 0; p < pad; p++) line += ' ';
      line += val;
      gfx->print(line.substring(0, totalChars + 1));
    } else {
      gfx->print((sel ? "> " : "  ") + label);
    }
  }

  int16_t footY = h - 18;
  gfx->fillRect(0, footY, w, 18, footBg);
  gfx->drawFastHLine(0, footY, w, M5.Display.color565(51, 65, 85));
  gfx->setTextColor(TFT_ORANGE, footBg);
  gfx->setCursor(4, footY + 5);
  gfx->print(port ? "[B]N [A]S HB:Bk" : "[B]Next [A]Set HB:Back");
  drawClockBadgeOnGfx(gfx, w - 3, footY + 5, footBg, port);

  if (useSprite) {
    uiCanvas.pushSprite(0, 0);
  } else {
    gfx->endWrite();
  }
}

void runFocusPeakSubmenu() {
  int subIdx = 1;
  String subBadge = "";
  playTone(2800, 30);
  drawFocusPeakSubmenuScreen(subIdx, subBadge);

  unsigned long subBDownMs     = 0;
  unsigned long lastClockTickMs = millis();
  bool subBLongHandled = false;
  bool subComboCancel  = false;

  while (true) {
    pollAllButtons();
    if (checkComboShutdownTriggered()) {
      shutdownCameraAndM5();
    }

    if (M5.BtnA.isPressed() && M5.BtnB.isPressed()) {
      subComboCancel = true;
      subBDownMs = 0;
    }

    bool redraw = pollImuAutoRotateIfEnabled();
    if (millis() - lastClockTickMs >= 1000) {
      lastClockTickMs = millis();
      redraw = true;
    }

    if (M5.BtnB.isPressed() && !M5.BtnA.isPressed()) {
      if (!subComboCancel) {
        if (subBDownMs == 0) {
          subBDownMs = millis();
          subBLongHandled = false;
        } else if (!subBLongHandled && (millis() - subBDownMs >= 600)) {
          subBLongHandled = true;
          playTone(2000, 35);
          break;
        }
      }
    } else if (!M5.BtnB.isPressed()) {
      if (subComboCancel && !M5.BtnA.isPressed()) {
        subComboCancel = false;
        subBDownMs = 0;
      } else if (subBDownMs != 0) {
        unsigned long durB = millis() - subBDownMs;
        subBDownMs = 0;
        if (!subBLongHandled && !subComboCancel && durB >= 25 && durB < 600) {
          playTone(2300, 18);
          subIdx = (subIdx + 1) % PEAK_SUBMENU_COUNT;
          subBadge = "";
          redraw = true;
        }
      }
    }

    if (M5.BtnA.wasPressed() && !M5.BtnB.isPressed() && !subComboCancel) {
      if (subIdx == 0) {
        playTone(2200, 30);
        break;
      } else if (subIdx == 1) {
        peakEnabled = !peakEnabled;
        saveSettingsToNvs();
        playTone(peakEnabled ? 3000 : 1800, 30);
        subBadge = peakEnabled ? "OK:ON" : "OK:OFF";
        redraw = true;
      } else if (subIdx == 2) {
        peakColorIdx = (peakColorIdx + 1) % PEAK_COL_COUNT;
        saveSettingsToNvs();
        playTone(2600, 25);
        subBadge = String("OK:") + PEAK_COLOR_SHORT[peakColorIdx];
        redraw = true;
      } else if (subIdx == 3) {
        peakThickness = (peakThickness + 1) % PEAK_THICK_COUNT;
        saveSettingsToNvs();
        playTone(2600, 25);
        subBadge = String("OK:") + PEAK_THICK_NAMES[peakThickness];
        redraw = true;
      } else if (subIdx == 4) {
        peakSensitivity = (peakSensitivity + 1) % PEAK_SENS_COUNT;
        saveSettingsToNvs();
        playTone(2600, 25);
        subBadge = String("OK:") + PEAK_SENS_NAMES[peakSensitivity];
        redraw = true;
      } else if (subIdx == 5) {
        peakSource = (peakSource + 1) % PEAK_SRC_COUNT;
        saveSettingsToNvs();
        playTone(2600, 25);
        subBadge = String("OK:") + ((peakSource == PEAK_SRC_320) ? "320" : "160");
        redraw = true;
      }
    }

    serviceSerialTraceConsole();
    if (redraw) {
      drawFocusPeakSubmenuScreen(subIdx, subBadge);
    }
    delay(15);
  }
}

// ----------------------------------------------------------------------------
// On-Screen HUD Text Elements Submenu (Flicker-Free M5Canvas, 2-Button)
// ----------------------------------------------------------------------------
static const int HUD_SUBMENU_COUNT = 16;
static const char* HUD_ITEM_LABELS[14] = {
  "FPS",
  "Status",
  "Aspect",
  "Res",
  "Battery",
  "Mode",
  "Shutter",
  "Aperture",
  "ISO",
  "Drive/Tag",
  "Remain",
  "AF/Exp W",
  "Clock",
  "Btn Hints"
};

void drawHudSubmenuScreen(int selectedIdx, const String& statusBadge) {
  int16_t w    = M5.Display.width();
  int16_t h    = M5.Display.height();
  bool    port = isPortraitOrientation();

  uint16_t bg     = TFT_BLACK;
  uint16_t hdrBg  = M5.Display.color565(15, 23, 42);
  uint16_t selBg  = M5.Display.color565(234, 88, 12);
  uint16_t footBg = M5.Display.color565(17, 24, 39);

  int maxVisible = port ? 10 : 5;
  int rowH       = 18;
  int listTop    = 21;
  int scrollStart = 0;
  if (HUD_SUBMENU_COUNT > maxVisible && selectedIdx >= maxVisible - 1) {
    scrollStart = selectedIdx - maxVisible + 2;
    int maxStart = HUD_SUBMENU_COUNT - maxVisible;
    if (scrollStart > maxStart) scrollStart = maxStart;
  }

  bool useSprite = ensureUiCanvas();
  LovyanGFX* gfx = useSprite ? static_cast<LovyanGFX*>(&uiCanvas) : static_cast<LovyanGFX*>(&M5.Display);

  if (!useSprite) gfx->startWrite();
  gfx->fillScreen(bg);
  gfx->fillRect(0, 0, w, 19, hdrBg);
  gfx->drawFastHLine(0, 19, w, M5.Display.color565(51, 65, 85));
  gfx->setTextSize(1);
  gfx->setTextColor(TFT_CYAN, hdrBg);
  gfx->setCursor(4, 6);
  gfx->print(port ? "HUD SETUP" : "ON-SCREEN HUD TEXT");

  if (statusBadge.length() > 0) {
    String bShort = statusBadge.substring(0, port ? 10 : 14);
    gfx->setTextColor(TFT_GREEN, hdrBg);
    gfx->setCursor(w - (int16_t)(bShort.length() * 6) - 4, 6);
    gfx->print(bShort);
  }

  uint8_t onCnt = hudEnabledCount();

  for (int row = 0; row < maxVisible; row++) {
    int idx = scrollStart + row;
    if (idx >= HUD_SUBMENU_COUNT) break;

    int16_t ry  = listTop + row * rowH;
    bool    sel = (idx == selectedIdx);
    uint16_t rowFill = sel ? selBg : bg;
    gfx->fillRect(2, ry, w - 4, rowH - 1, rowFill);

    String label = "";
    String val   = "";
    uint16_t txtCol = sel ? TFT_WHITE : TFT_LIGHTGREY;

    if (idx == 0) {
      label  = "< Back";
      txtCol = sel ? TFT_WHITE : TFT_CYAN;
    } else if (idx == 1) {
      label = "All HUD";
      if (hudMask == HUD_ALL_MASK) {
        val    = "ALL ON";
        txtCol = sel ? TFT_WHITE : TFT_GREEN;
      } else if (hudMask == 0) {
        val    = "ALL OFF";
        txtCol = sel ? TFT_WHITE : TFT_ORANGE;
      } else {
        val    = String(onCnt) + "/14";
        txtCol = sel ? TFT_WHITE : TFT_YELLOW;
      }
    } else {
      uint8_t bit = (uint8_t)(idx - 2);
      bool en = hudEnabled(bit);
      label  = HUD_ITEM_LABELS[bit];
      val    = en ? "ON" : "OFF";
      txtCol = sel ? TFT_WHITE : (en ? TFT_GREEN : TFT_DARKGREY);
    }

    gfx->setTextColor(txtCol, rowFill);
    gfx->setCursor(6, ry + 5);
    if (val.length() > 0) {
      int totalChars = port ? 19 : 36;
      int pad = totalChars - (int)label.length() - (int)val.length() - 1;
      if (pad < 1) pad = 1;
      String line = String(sel ? ">" : " ") + label;
      for (int p = 0; p < pad; p++) line += ' ';
      line += val;
      gfx->print(line.substring(0, totalChars + 1));
    } else {
      gfx->print((sel ? "> " : "  ") + label);
    }
  }

  int16_t footY = h - 18;
  gfx->fillRect(0, footY, w, 18, footBg);
  gfx->drawFastHLine(0, footY, w, M5.Display.color565(51, 65, 85));
  gfx->setTextColor(TFT_ORANGE, footBg);
  gfx->setCursor(4, footY + 5);
  gfx->print(port ? "[B]N [A]S HB:Bk" : "[B]Next [A]Set HB:Back");
  drawClockBadgeOnGfx(gfx, w - 3, footY + 5, footBg, port);

  if (useSprite) {
    uiCanvas.pushSprite(0, 0);
  } else {
    gfx->endWrite();
  }
}

void runHudSubmenu() {
  int subIdx = 1;
  String subBadge = "";
  playTone(2800, 30);
  drawHudSubmenuScreen(subIdx, subBadge);

  while (M5.BtnA.isPressed()) {
    pollAllButtons();
    delay(15);
  }

  unsigned long subBDownMs      = 0;
  unsigned long lastClockTickMs = millis();
  bool subBLongHandled = false;
  bool subComboCancel  = false;

  while (true) {
    pollAllButtons();
    if (checkComboShutdownTriggered()) {
      shutdownCameraAndM5();
    }

    if (M5.BtnA.isPressed() && M5.BtnB.isPressed()) {
      subComboCancel = true;
      subBDownMs = 0;
    }

    bool redraw = pollImuAutoRotateIfEnabled();
    if (millis() - lastClockTickMs >= 1000) {
      lastClockTickMs = millis();
      redraw = true;
    }

    if (M5.BtnB.isPressed() && !M5.BtnA.isPressed()) {
      if (!subComboCancel) {
        if (subBDownMs == 0) {
          subBDownMs = millis();
          subBLongHandled = false;
        } else if (!subBLongHandled && (millis() - subBDownMs >= 600)) {
          subBLongHandled = true;
          playTone(2000, 35);
          break;
        }
      }
    } else if (!M5.BtnB.isPressed()) {
      if (subComboCancel && !M5.BtnA.isPressed()) {
        subComboCancel = false;
        subBDownMs = 0;
      } else if (subBDownMs != 0) {
        unsigned long durB = millis() - subBDownMs;
        subBDownMs = 0;
        if (!subBLongHandled && !subComboCancel && durB >= 25 && durB < 600) {
          playTone(2300, 18);
          subIdx = (subIdx + 1) % HUD_SUBMENU_COUNT;
          subBadge = "";
          redraw = true;
        }
      }
    }

    if (M5.BtnA.wasPressed() && !M5.BtnB.isPressed() && !subComboCancel) {
      if (subIdx == 0) {
        playTone(2200, 30);
        break;
      } else if (subIdx == 1) {
        hudMask = (hudMask == HUD_ALL_MASK) ? 0 : HUD_ALL_MASK;
        saveSettingsToNvs();
        playTone((hudMask == HUD_ALL_MASK) ? 3000 : 1800, 30);
        subBadge = (hudMask == HUD_ALL_MASK) ? "ALL ON" : "ALL OFF";
        redraw = true;
      } else {
        uint8_t bit = (uint8_t)(subIdx - 2);
        hudMask ^= (uint16_t)(1U << bit);
        saveSettingsToNvs();
        bool nowOn = hudEnabled(bit);
        playTone(nowOn ? 2900 : 1800, 25);
        subBadge = nowOn ? "OK:ON" : "OK:OFF";
        redraw = true;
      }
    }

    serviceSerialTraceConsole();
    if (redraw) {
      drawHudSubmenuScreen(subIdx, subBadge);
    }
    delay(15);
  }
}

// ----------------------------------------------------------------------------
// Paginated Help & Button Reference Screen ([A] Page Up, [B] Page Down, HB: Back)
// ----------------------------------------------------------------------------
static void appendWrappedHelpLines(std::vector<HelpLine>& out, const String& src, int maxChars, uint16_t col) {
  int start = 0;
  int len   = src.length();
  bool first = true;
  while (start < len) {
    String prefix = first ? "" : "  ";
    int avail = maxChars - prefix.length();
    if (avail < 6) avail = 6;
    if (len - start <= avail) {
      out.push_back({ prefix + src.substring(start), col });
      break;
    }
    int cut = start + avail;
    int sp  = -1;
    for (int i = cut; i > start; i--) {
      if (src[i] == ' ') { sp = i; break; }
    }
    if (sp > start) {
      out.push_back({ prefix + src.substring(start, sp), col });
      start = sp + 1;
      while (start < len && src[start] == ' ') start++;
    } else {
      out.push_back({ prefix + src.substring(start, cut), col });
      start = cut;
    }
    first = false;
  }
}

static void buildHelpPages(bool port, std::vector<HelpPage>& pages) {
  pages.clear();
  int maxChars = port ? 21 : 38;
  int maxLines = port ? 14 : 8;

  static const HelpSectionDef SECTIONS[] = {
    {
      "[BUTTONS: LIVE VIEW]",
      TFT_CYAN,
      {
        "[A] Tap: Shutter (or Focus Peak if BtnA Mode = PEAK)",
        "[A] Hold: Cont burst (CONT Drive) / cancel timer",
        "1x[B]: Aspect 16:9 / 4:3 / 3:2 / 1:1",
        "2x[B]: Mode iAUTO / A:MAX / S:1/60",
        "3x[B]: Toggle Diagnostics HUD",
        "4x[B]: Lock/Unlock Stick+Cam Gyro",
        "5x[B]: Deep Sleep Air+Stick (Live, Boot, Wi-Fi, BT)",
        "Hold[B]: Open Quick Menu (>=600ms)",
        "Hold A+B: Deep Sleep Air+Stick",
        "Pwr Btn: HW Reset (not sleep wake)"
      },
      10
    },
    {
      "[CUSTOMIZABLE KEYS]",
      TFT_YELLOW,
      {
        "BtnA Mode: SHUTTER or PEAK toggle (use Air shutter when PEAK)",
        "Wake Key: BTN B (default, pocket-safe), BTN A, or A+B",
        "Stick Rot: AUTO / 90D / 270D / LOCK",
        "Cam Gyro: AUTO 180 / 180D / LOCK",
        "Peak Setup>: ON, 5 Colors, 1-3px, L/M/H Sens, 320/160",
        "HUD Setup>: Toggle 14 HUD texts + All"
      },
      6
    },
    {
      "[MENUS & SETUP UI]",
      TFT_ORANGE,
      {
        "Quick Menu: [B] Next, [A] Set/Open",
        "Hold[B]: Exits menu/submenu before release",
        "Wi-Fi/BT Scan: [B] Step, [A] Pick, 5x[B] Sleep",
        "Passkey: [B] +1 (Hold fast), [A] Next"
      },
      4
    },
    {
      "[NOTABLE FEATURES]",
      TFT_GREEN,
      {
        "Deep Sleep RTC: Keeps Stick clock ticking across sleep",
        "Clock Sync: Shutter stopwatch + /get_imglist.cgi (2015! alert)",
        "BLE Wake: 6-digit BT PIN wakes Air on boot (unplugged)",
        "Fast Wi-Fi: Static .100 + NVS channel + 520 retry",
        "Zero-Flicker: Triple UDP + vpCanvas + 320x240 Peaking"
      },
      5
    }
  };

  HelpPage cur;
  for (int s = 0; s < 4; s++) {
    const HelpSectionDef& sec = SECTIONS[s];
    if ((int)cur.lines.size() > 0 && (int)cur.lines.size() + 2 > maxLines) {
      pages.push_back(cur);
      cur.lines.clear();
    }
    if ((int)cur.lines.size() > 0 && (int)cur.lines.size() < maxLines) {
      cur.lines.push_back({ "", TFT_BLACK });
      if ((int)cur.lines.size() + 2 > maxLines) {
        pages.push_back(cur);
        cur.lines.clear();
      }
    }
    cur.lines.push_back({ String(sec.title).substring(0, maxChars), sec.titleColor });

    for (int b = 0; b < sec.bulletCount; b++) {
      std::vector<HelpLine> wrapped;
      appendWrappedHelpLines(wrapped, String("* ") + sec.bullets[b], maxChars, TFT_LIGHTGREY);
      for (size_t k = 0; k < wrapped.size(); k++) {
        if ((int)cur.lines.size() >= maxLines) {
          pages.push_back(cur);
          cur.lines.clear();
        }
        cur.lines.push_back(wrapped[k]);
      }
    }
  }
  if (!cur.lines.empty()) {
    pages.push_back(cur);
  }
}

void drawHelpScreen(int pageIdx, const std::vector<HelpPage>& pages) {
  int16_t w    = M5.Display.width();
  int16_t h    = M5.Display.height();
  bool    port = isPortraitOrientation();

  uint16_t bg     = TFT_BLACK;
  uint16_t hdrBg  = M5.Display.color565(15, 23, 42);
  uint16_t footBg = M5.Display.color565(17, 24, 39);

  int totalPages = (int)pages.size();
  if (totalPages < 1) totalPages = 1;
  int safePage = pageIdx;
  if (safePage < 0) safePage = 0;
  if (safePage >= totalPages) safePage = totalPages - 1;

  bool useSprite = ensureUiCanvas();
  LovyanGFX* gfx = useSprite ? static_cast<LovyanGFX*>(&uiCanvas) : static_cast<LovyanGFX*>(&M5.Display);

  if (!useSprite) gfx->startWrite();
  gfx->fillScreen(bg);
  gfx->fillRect(0, 0, w, 19, hdrBg);
  gfx->drawFastHLine(0, 19, w, M5.Display.color565(51, 65, 85));
  gfx->setTextSize(1);
  gfx->setTextColor(TFT_CYAN, hdrBg);
  gfx->setCursor(4, 6);
  gfx->print(port ? "HELP & KEYS" : "HELP: BUTTONS & FEATURES");

  String pgBadge = "Pg " + String(safePage + 1) + "/" + String(totalPages);
  gfx->setTextColor(TFT_YELLOW, hdrBg);
  gfx->setCursor(w - (int16_t)(pgBadge.length() * 6) - 4, 6);
  gfx->print(pgBadge);

  if (!pages.empty()) {
    const HelpPage& pg = pages[safePage];
    int16_t lineH = port ? 13 : 12;
    int16_t y0    = 23;
    for (size_t i = 0; i < pg.lines.size(); i++) {
      if (pg.lines[i].text.length() == 0) continue;
      gfx->setTextColor(pg.lines[i].color, bg);
      gfx->setCursor(4, y0 + (int16_t)i * lineH);
      gfx->print(pg.lines[i].text);
    }
  }

  int16_t footY = h - 18;
  gfx->fillRect(0, footY, w, 18, footBg);
  gfx->drawFastHLine(0, footY, w, M5.Display.color565(51, 65, 85));
  gfx->setTextColor(TFT_ORANGE, footBg);
  gfx->setCursor(4, footY + 5);
  gfx->print(port ? "[A]Up [B]Dn HB:Bk" : "[A]PgUp [B]PgDn HB:Back");
  drawClockBadgeOnGfx(gfx, w - 3, footY + 5, footBg, port);

  if (useSprite) {
    uiCanvas.pushSprite(0, 0);
  } else {
    gfx->endWrite();
  }
}

void runHelpScreen() {
  int helpPage = 0;
  bool lastPort = isPortraitOrientation();
  std::vector<HelpPage> pages;
  buildHelpPages(lastPort, pages);

  playTone(2800, 30);
  drawHelpScreen(helpPage, pages);

  while (M5.BtnA.isPressed()) {
    pollAllButtons();
    delay(15);
  }

  unsigned long subBDownMs      = 0;
  unsigned long lastClockTickMs = millis();
  bool subBLongHandled = false;
  bool subComboCancel  = false;

  while (true) {
    pollAllButtons();
    if (checkComboShutdownTriggered()) {
      shutdownCameraAndM5();
    }

    if (M5.BtnA.isPressed() && M5.BtnB.isPressed()) {
      subComboCancel = true;
      subBDownMs = 0;
    }

    bool redraw = pollImuAutoRotateIfEnabled();
    bool curPort = isPortraitOrientation();
    if (curPort != lastPort) {
      lastPort = curPort;
      buildHelpPages(curPort, pages);
      if (helpPage >= (int)pages.size()) {
        helpPage = (int)pages.size() - 1;
      }
      if (helpPage < 0) helpPage = 0;
      redraw = true;
    }

    if (millis() - lastClockTickMs >= 1000) {
      lastClockTickMs = millis();
      redraw = true;
    }

    // Short [B]: Next Page (Down); Hold [B] >=600ms: Back to Quick Menu immediately
    if (M5.BtnB.isPressed() && !M5.BtnA.isPressed()) {
      if (!subComboCancel) {
        if (subBDownMs == 0) {
          subBDownMs = millis();
          subBLongHandled = false;
        } else if (!subBLongHandled && (millis() - subBDownMs >= 600)) {
          subBLongHandled = true;
          playTone(2000, 35);
          break;
        }
      }
    } else if (!M5.BtnB.isPressed()) {
      if (subComboCancel && !M5.BtnA.isPressed()) {
        subComboCancel = false;
        subBDownMs = 0;
      } else if (subBDownMs != 0) {
        unsigned long durB = millis() - subBDownMs;
        subBDownMs = 0;
        if (!subBLongHandled && !subComboCancel && durB >= 25 && durB < 600) {
          if (helpPage + 1 < (int)pages.size()) {
            helpPage++;
            playTone(2300, 20);
            redraw = true;
          } else {
            playTone(1400, 25);
          }
        }
      }
    }

    // [A] Tap: Previous Page (Up)
    if (M5.BtnA.wasPressed() && !M5.BtnB.isPressed() && !subComboCancel) {
      if (helpPage > 0) {
        helpPage--;
        playTone(2600, 20);
        redraw = true;
      } else {
        playTone(1400, 25);
      }
    }

    serviceSerialTraceConsole();
    if (redraw) {
      drawHelpScreen(helpPage, pages);
    }
    delay(15);
  }
}

// ----------------------------------------------------------------------------
// Hold-B Quick Settings & Camera Menu (Flicker-Free M5Canvas, 2-Button)
// ----------------------------------------------------------------------------
static const int QUICK_MENU_COUNT = 22;

void drawQuickMenuScreen(int selectedIdx, const String& statusBadge) {
  int16_t w    = M5.Display.width();
  int16_t h    = M5.Display.height();
  bool    port = isPortraitOrientation();

  uint16_t bg     = TFT_BLACK;
  uint16_t hdrBg  = M5.Display.color565(15, 23, 42);
  uint16_t selBg  = M5.Display.color565(234, 88, 12);
  uint16_t footBg = M5.Display.color565(17, 24, 39);

  int maxVisible = port ? 10 : 5;
  int rowH       = 18;
  int listTop    = 21;

  int scrollStart = 0;
  if (QUICK_MENU_COUNT > maxVisible && selectedIdx >= maxVisible - 1) {
    scrollStart = selectedIdx - maxVisible + 2;
    int maxStart = QUICK_MENU_COUNT - maxVisible;
    if (scrollStart > maxStart) scrollStart = maxStart;
  }

  uint8_t briPct = (currentBrightnessLevel == 0) ? 100 : (currentBrightnessLevel == 1 ? 60 : 30);
  String airSndShort = (currentAirSoundIdx < airSoundCount)
                         ? formatAirSoundShort(airSoundTokens[currentAirSoundIdx])
                         : "--";

  bool useSprite = ensureUiCanvas();
  LovyanGFX* gfx = useSprite ? static_cast<LovyanGFX*>(&uiCanvas) : static_cast<LovyanGFX*>(&M5.Display);

  if (!useSprite) gfx->startWrite();
  gfx->fillScreen(bg);
  gfx->fillRect(0, 0, w, 19, hdrBg);
  gfx->drawFastHLine(0, 19, w, M5.Display.color565(51, 65, 85));
  gfx->setTextSize(1);
  gfx->setTextColor(TFT_CYAN, hdrBg);
  gfx->setCursor(4, 6);
  gfx->print(port ? "MENU" : "OLYMPUS AIR MENU");

  if (statusBadge.length() > 0) {
    uint16_t stCol = (statusBadge.startsWith("OK") || statusBadge == "QUEUED" || statusBadge == "ALL ON") ? TFT_GREEN :
                     ((statusBadge == "SYNC..." || statusBadge == "NEXT SHT" || statusBadge == "HW FIXED" || statusBadge == "A-PACED" || statusBadge == "ALL OFF") ? TFT_YELLOW : TFT_RED);
    String bShort = statusBadge.substring(0, port ? 12 : 16);
    gfx->setTextColor(stCol, hdrBg);
    gfx->setCursor(w - (int16_t)(bShort.length() * 6) - 4, 6);
    gfx->print(bShort);
  }

  uint8_t hudOn = hudEnabledCount();

  for (int row = 0; row < maxVisible; row++) {
    int idx = scrollStart + row;
    if (idx >= QUICK_MENU_COUNT) break;

    int16_t ry  = listTop + row * rowH;
    bool    sel = (idx == selectedIdx);
    uint16_t rowFill = sel ? selBg : bg;
    gfx->fillRect(2, ry, w - 4, rowH - 1, rowFill);

    String label = "";
    String val   = "";
    uint16_t txtCol = sel ? TFT_WHITE : TFT_LIGHTGREY;

    switch (idx) {
      case 0:
        label = (WiFi.status() == WL_CONNECTED) ? "< Back to Live" : "< Back";
        txtCol = sel ? TFT_WHITE : TFT_CYAN;
        break;
      case 1:
        label = "Focus Peak";
        val   = peakEnabled ? "ON" : "OFF";
        txtCol = sel ? TFT_WHITE : (peakEnabled ? PEAK_COLOR_RGB565[peakColorIdx] : TFT_LIGHTGREY);
        break;
      case 2:
        label = "Peak Setup >";
        val   = String(PEAK_COLOR_SHORT[peakColorIdx]) + " " + String(PEAK_THICK_NAMES[peakThickness]);
        txtCol = sel ? TFT_WHITE : TFT_CYAN;
        break;
      case 3:
        label = "BtnA Mode";
        val   = BTNA_MODE_NAMES[btnAMode];
        txtCol = sel ? TFT_WHITE : (btnAMode == BTNA_PEAK ? TFT_YELLOW : TFT_LIGHTGREY);
        break;
      case 4:
        label = "Grid";
        val   = GRID_MODE_NAMES[currentGridMode];
        break;
      case 5:
        label = "Drive";
        val   = DRIVE_MODE_NAMES[currentDriveMode];
        break;
      case 6:
        label = "Seq Spd";
        val   = SEQ_SPEED_NAMES[currentSeqSpeed];
        break;
      case 7:
        label = "Stick Snd";
        val   = stickSoundEnabled ? "ON" : "OFF";
        break;
      case 8:
        label = "Air Sound";
        val   = airSndShort;
        break;
      case 9:
        label = "Bright";
        val   = String(briPct) + "%";
        break;
      case 10:
        label = "Stick Rot";
        val   = STICK_ROT_NAMES[stickRotMode];
        break;
      case 11:
        label = "Cam Gyro";
        val   = CAM_GYRO_NAMES[camGyroMode];
        break;
      case 12:
        label = "HUD Setup >";
        val   = (hudMask == HUD_ALL_MASK) ? "ALL" : (hudMask == 0 ? "OFF" : (String(hudOn) + "/14"));
        txtCol = sel ? TFT_WHITE : TFT_CYAN;
        break;
      case 13:
        label = "BT Wake";
        val   = btWakeOnBoot ? (hasPairedBt ? "ON" : "PAIR!") : "OFF";
        txtCol = sel ? TFT_WHITE : (btWakeOnBoot ? TFT_GREEN : TFT_LIGHTGREY);
        break;
      case 14:
        label = "BT Setup";
        val   = inBtSetupScreen ? "BACK" : (hasPairedBt ? "SAVED" : "PAIR");
        txtCol = sel ? TFT_WHITE : TFT_CYAN;
        break;
      case 15:
        label = "Wi-Fi Setup";
        val   = inWifiSetupScreen ? "BACK" : "SCAN";
        txtCol = sel ? TFT_WHITE : TFT_YELLOW;
        break;
      case 16:
        label = "Sync Clock";
        if (clockInvalid2015) {
          val = "2015!INV";
          txtCol = sel ? TFT_WHITE : TFT_RED;
        } else if (clockSyncPendingOnShutter) {
          val = "NEXT SHT";
          txtCol = sel ? TFT_WHITE : TFT_YELLOW;
        } else {
          val = getClockTimeStr(false);
          txtCol = sel ? TFT_WHITE : TFT_CYAN;
        }
        break;
      case 17:
        label = "Wake Key";
        val   = WAKE_KEY_NAMES[wakeKeyMode];
        txtCol = sel ? TFT_WHITE : TFT_GREEN;
        break;
      case 18:
        label = "Help >";
        val   = "GUIDE";
        txtCol = sel ? TFT_WHITE : TFT_CYAN;
        break;
      case 19:
        label = "Dump Trace";
        val   = (gTraceRamBuf.length() > 0) ? "USB" : "EMPTY";
        txtCol = sel ? TFT_WHITE : TFT_GREEN;
        break;
      case 20:
        label = "Sleep: Stick Only";
        val   = (WiFi.status() == WL_CONNECTED) ? "AIR ON" : "SLEEP";
        txtCol = sel ? TFT_WHITE : TFT_ORANGE;
        break;
      case 21:
        label = "Sleep: Air + Stick";
        val   = "ALL";
        txtCol = sel ? TFT_WHITE : TFT_RED;
        break;
    }

    gfx->setTextColor(txtCol, rowFill);
    gfx->setCursor(6, ry + 5);
    if (val.length() > 0) {
      int totalChars = port ? 19 : 36;
      int pad = totalChars - (int)label.length() - (int)val.length() - 1;
      if (pad < 1) pad = 1;
      String line = String(sel ? ">" : " ") + label;
      for (int p = 0; p < pad; p++) line += ' ';
      line += val;
      gfx->print(line.substring(0, totalChars + 1));
    } else {
      gfx->print((sel ? "> " : "  ") + label);
    }
  }

  int16_t footY = h - 18;
  gfx->fillRect(0, footY, w, 18, footBg);
  gfx->drawFastHLine(0, footY, w, M5.Display.color565(51, 65, 85));
  gfx->setTextColor(TFT_ORANGE, footBg);
  gfx->setCursor(4, footY + 5);
  gfx->print(port ? "[B]N [A]S HB:X" : "[B]Next [A]Set HB:Exit");
  drawClockBadgeOnGfx(gfx, w - 3, footY + 5, footBg, port);

  if (useSprite) {
    uiCanvas.pushSprite(0, 0);
  } else {
    gfx->endWrite();
  }
}

// Returns true if liveview session remains active, false if Wi-Fi was reconfigured
// Works both during Live View AND during Boot / Wi-Fi Search / AP & BT Setup!
bool runQuickMenu(bool* wifiSetupRequestedOut, bool* btSetupRequestedOut) {
  if (wifiSetupRequestedOut) *wifiSetupRequestedOut = false;
  if (btSetupRequestedOut)   *btSetupRequestedOut   = false;
  bool wasConnected = (WiFi.status() == WL_CONNECTED && sessionReady);
  pauseUdpAssembly = true;
  int selectedIdx = 0;
  String menuStatusBadge = "";
  playTone(2900, 40);
  drawQuickMenuScreen(selectedIdx, menuStatusBadge);

  // Wait for user to release Hold-B (or Hold-A) before listening for menu clicks
  while (M5.BtnB.isPressed() || M5.BtnA.isPressed()) {
    pollAllButtons();
    if (checkComboShutdownTriggered()) {
      shutdownCameraAndM5();
    }
    delay(15);
  }

  unsigned long menuBDownMs     = 0;
  unsigned long lastClockTickMs = millis();
  bool menuBLongHandled = false;
  bool menuComboCancel  = false;

  while (true) {
    pollAllButtons();
    if (checkComboShutdownTriggered()) {
      shutdownCameraAndM5();
    }

    if (M5.BtnA.isPressed() && M5.BtnB.isPressed()) {
      menuComboCancel = true;
      menuBDownMs = 0;
    }

    bool redraw = pollImuAutoRotateIfEnabled();
    if (millis() - lastClockTickMs >= 1000) {
      lastClockTickMs = millis();
      redraw = true;
    }

    // Button B short release steps down; Hold B (>=600ms) closes menu immediately
    if (M5.BtnB.isPressed() && !M5.BtnA.isPressed()) {
      if (!menuComboCancel) {
        if (menuBDownMs == 0) {
          menuBDownMs = millis();
          menuBLongHandled = false;
        } else if (!menuBLongHandled && (millis() - menuBDownMs >= 600)) {
          menuBLongHandled = true;
          playTone(2000, 35);
          break;
        }
      }
    } else if (!M5.BtnB.isPressed()) {
      if (menuComboCancel && !M5.BtnA.isPressed()) {
        menuComboCancel = false;
        menuBDownMs = 0;
      } else if (menuBDownMs != 0) {
        unsigned long durB = millis() - menuBDownMs;
        menuBDownMs = 0;
        if (!menuBLongHandled && !menuComboCancel && durB >= 25 && durB < 600) {
          playTone(2300, 18);
          selectedIdx = (selectedIdx + 1) % QUICK_MENU_COUNT;
          menuStatusBadge = "";
          redraw = true;
        }
      }
    }

    // Button A activates/cycles selected menu item (applies immediately when online, or queues in NVS when offline)
    if (M5.BtnA.wasPressed() && !M5.BtnB.isPressed() && !menuComboCancel) {
      if (selectedIdx == 0) {
        playTone(2200, 30);
        break;
      } else if (selectedIdx == 1) {
        peakEnabled = !peakEnabled;
        saveSettingsToNvs();
        playTone(peakEnabled ? 3000 : 1800, 30);
        menuStatusBadge = peakEnabled ? "OK:ON" : "OK:OFF";
        redraw = true;
      } else if (selectedIdx == 2) {
        runFocusPeakSubmenu();
        menuStatusBadge = peakEnabled ? "OK:PK" : "";
        drawQuickMenuScreen(selectedIdx, menuStatusBadge);
        while (M5.BtnB.isPressed() || M5.BtnA.isPressed()) {
          pollAllButtons();
          if (checkComboShutdownTriggered()) {
            shutdownCameraAndM5();
          }
          if (pollImuAutoRotateIfEnabled()) {
            drawQuickMenuScreen(selectedIdx, menuStatusBadge);
          }
          delay(15);
        }
        redraw = false;
      } else if (selectedIdx == 3) {
        btnAMode = (btnAMode + 1) % BTNA_COUNT;
        saveSettingsToNvs();
        playTone(2600, 25);
        menuStatusBadge = String("OK:") + BTNA_MODE_NAMES[btnAMode];
        redraw = true;
      } else if (selectedIdx == 4) {
        currentGridMode = (currentGridMode + 1) % GRID_COUNT;
        saveSettingsToNvs();
        playTone(2600, 25);
        menuStatusBadge = String("OK:") + GRID_MODE_NAMES[currentGridMode];
        redraw = true;
      } else if (selectedIdx == 5) {
        currentDriveMode = (currentDriveMode + 1) % DRIVE_COUNT;
        saveSettingsToNvs();
        playTone(2600, 25);
        if (WiFi.status() == WL_CONNECTED) {
          drawQuickMenuScreen(selectedIdx, "SYNC...");
          applyDriveModeToCamera(currentDriveMode, currentSeqSpeed, &menuStatusBadge, false);
        } else {
          menuStatusBadge = "QUEUED";
        }
        redraw = true;
      } else if (selectedIdx == 6) {
        currentSeqSpeed = (currentSeqSpeed + 1) % SEQ_COUNT;
        saveSettingsToNvs();
        playTone(2600, 25);
        if (WiFi.status() == WL_CONNECTED) {
          drawQuickMenuScreen(selectedIdx, "SYNC...");
          applyDriveModeToCamera(currentDriveMode, currentSeqSpeed, &menuStatusBadge, true);
        } else {
          menuStatusBadge = "QUEUED";
        }
        redraw = true;
      } else if (selectedIdx == 7) {
        stickSoundEnabled = !stickSoundEnabled;
        saveSettingsToNvs();
        if (stickSoundEnabled) {
          playTone(2600, 25);
        } else if (M5.Speaker.isEnabled()) {
          M5.Speaker.stop();
        }
        menuStatusBadge = stickSoundEnabled ? "OK:ON" : "OK:OFF";
        redraw = true;
      } else if (selectedIdx == 8) {
        if (!airSoundDiscovered && WiFi.status() == WL_CONNECTED) {
          drawQuickMenuScreen(selectedIdx, "SYNC...");
          discoverAirSoundOptions();
        }
        if (airSoundCount > 0) {
          currentAirSoundIdx = (currentAirSoundIdx + 1) % airSoundCount;
          airSoundUserSet = true;
          saveSettingsToNvs();
          playTone(2600, 25);
          if (WiFi.status() == WL_CONNECTED) {
            drawQuickMenuScreen(selectedIdx, "SYNC...");
            applyAirSoundToCamera(currentAirSoundIdx, &menuStatusBadge);
          } else {
            menuStatusBadge = "QUEUED";
          }
        } else {
          playTone(1000, 80);
          menuStatusBadge = "NO ENUM";
        }
        redraw = true;
      } else if (selectedIdx == 9) {
        currentBrightnessLevel = (currentBrightnessLevel + 1) % 3;
        applyScreenBrightness(currentBrightnessLevel);
        saveSettingsToNvs();
        playTone(2600, 25);
        uint8_t b = (currentBrightnessLevel == 0) ? 100 : (currentBrightnessLevel == 1 ? 60 : 30);
        menuStatusBadge = "OK:" + String(b) + "%";
        redraw = true;
      } else if (selectedIdx == 10) {
        if (!imuReady) imuReady = M5.Imu.begin();
        if (imuReady) {
          stickRotMode    = (stickRotMode + 1) % STICK_ROT_COUNT;
          dualGyroLocked  = false;
          lastImuCheckMs  = 0;
          imuPendingRot   = 255;
          imuPendingCount = 0;
          saveSettingsToNvs();
          playTone((stickRotMode == STICK_ROT_LOCK) ? 1800 : 3100, 40);
          menuStatusBadge = String("OK:") + STICK_ROT_NAMES[stickRotMode];
        } else {
          playTone(1000, 80);
          menuStatusBadge = "NO IMU";
        }
        redraw = true;
      } else if (selectedIdx == 11) {
        camGyroMode    = (camGyroMode + 1) % CAM_GYRO_COUNT;
        dualGyroLocked = false;
        if (camGyroMode == CAM_GYRO_FLIP180) {
          camActiveOrient = 3;
        } else if (camGyroMode == CAM_GYRO_AUTO) {
          camActiveOrient = (diag.camExifOrient == 3) ? 3 : 1;
        } else {
          camActiveOrient = 1;
        }
        saveSettingsToNvs();
        playTone((camGyroMode == CAM_GYRO_LOCK) ? 1800 : 3100, 40);
        menuStatusBadge = String("OK:") + CAM_GYRO_NAMES[camGyroMode];
        redraw = true;
      } else if (selectedIdx == 12) {
        runHudSubmenu();
        uint8_t hc = hudEnabledCount();
        menuStatusBadge = (hudMask == HUD_ALL_MASK) ? "ALL ON" : (hudMask == 0 ? "ALL OFF" : ("OK:" + String(hc) + "/14"));
        drawQuickMenuScreen(selectedIdx, menuStatusBadge);
        while (M5.BtnB.isPressed() || M5.BtnA.isPressed()) {
          pollAllButtons();
          if (checkComboShutdownTriggered()) {
            shutdownCameraAndM5();
          }
          if (pollImuAutoRotateIfEnabled()) {
            drawQuickMenuScreen(selectedIdx, menuStatusBadge);
          }
          delay(15);
        }
        redraw = false;
      } else if (selectedIdx == 13) {
        btWakeOnBoot = !btWakeOnBoot;
        saveBtCredsToNvs(savedBtName, savedBtMac, savedBtAddrType, savedBtPin);
        playTone(btWakeOnBoot ? 2900 : 1700, 35);
        if (btWakeOnBoot && !hasPairedBt) {
          menuStatusBadge = "PAIR BT!";
        } else {
          menuStatusBadge = btWakeOnBoot ? "OK:ON" : "OK:OFF";
        }
        redraw = true;
      } else if (selectedIdx == 14) {
        playTone(2800, 35);
        if (inBtSetupScreen) {
          break;
        }
        if (btSetupRequestedOut) {
          *btSetupRequestedOut = true;
          break;
        }
        bool hadConn = (WiFi.status() == WL_CONNECTED);
        if (hadConn) {
          String bye;
          opcHttpGet(URL_STOP_STREAM, bye, 700, true);
        }
        runBtSetupWizard();
        if (hadConn && WiFi.status() == WL_CONNECTED) {
          String res;
          opcHttpGetWith520Retry(URL_START_STREAM, res, 1500);
          resetRtpAssembler();
          lastRxPacketMs = millis();
        }
        drawQuickMenuScreen(selectedIdx, hasPairedBt ? "OK:PAIRED" : "");
        redraw = false;
      } else if (selectedIdx == 15) {
        playTone(2800, 35);
        if (inWifiSetupScreen) {
          break;
        }
        if (wifiSetupRequestedOut) {
          *wifiSetupRequestedOut = true;
          break;
        }
        if (WiFi.status() == WL_CONNECTED) {
          String bye;
          opcHttpGet(URL_STOP_STREAM, bye, 700, true);
        }
        sessionReady = false;
        WiFi.disconnect(false, false);
        runWifiSetupWizard(true);
        return false;
      } else if (selectedIdx == 16) {
        clockSyncPendingOnShutter = true;
        playTone(2800, 35);
        menuStatusBadge = "NEXT SHT";
        Serial.println("[CLOCK] Armed RTC sync for next shutter press + stopwatch");
        redraw = true;
      } else if (selectedIdx == 17) {
        wakeKeyMode = (wakeKeyMode + 1) % WAKE_COUNT;
        saveSettingsToNvs();
        playTone(2600, 25);
        menuStatusBadge = String("OK:") + WAKE_KEY_NAMES[wakeKeyMode];
        redraw = true;
      } else if (selectedIdx == 18) {
        runHelpScreen();
        menuStatusBadge = "";
        drawQuickMenuScreen(selectedIdx, menuStatusBadge);
        while (M5.BtnB.isPressed() || M5.BtnA.isPressed()) {
          pollAllButtons();
          if (checkComboShutdownTriggered()) {
            shutdownCameraAndM5();
          }
          if (pollImuAutoRotateIfEnabled()) {
            drawQuickMenuScreen(selectedIdx, menuStatusBadge);
          }
          delay(15);
        }
        redraw = false;
      } else if (selectedIdx == 19) {
        dumpTraceToSerial();
        playTone(2900, 35);
        menuStatusBadge = "SENT";
        redraw = true;
      } else if (selectedIdx == 20) {
        shutdownM5OnlyKeepAir();
      } else if (selectedIdx == 21) {
        shutdownCameraAndM5();
      }
    }

    serviceSerialTraceConsole();
    if (redraw) {
      drawQuickMenuScreen(selectedIdx, menuStatusBadge);
    }
    delay(15);
  }

  // Resume liveview immediately (~0ms overhead; no slow mode=standalone -> mode=rec reset!)
  if (wasConnected) {
    resetRtpAssembler();
    lastRxPacketMs = millis();
  }
  pauseUdpAssembly = false;
  return true;
}

// ----------------------------------------------------------------------------
// Setup Entry Point
// ----------------------------------------------------------------------------
void setup() {
  esp_sleep_wakeup_cause_t wakeCause = esp_sleep_get_wakeup_cause();
  if (wakeCause == ESP_SLEEP_WAKEUP_EXT1) {
    rtc_gpio_deinit(PIN_BTN_A_GPIO);
    rtc_gpio_deinit(PIN_BTN_B_GPIO);
  }

  auto cfg = M5.config();
  cfg.internal_imu = true;
  cfg.internal_spk = true;
  cfg.internal_mic = false; // Disable MEMS mic to reduce I2S/power overhead
  M5.begin(cfg);
  M5.Power.setExtOutput(true);

  if (${cfg.debugSerial ? "true" : "false"}) {
    Serial.begin(115200);
    delay(120);
    Serial.println("\\n====================================================");
    Serial.println("  Olympus Air A01 Live Viewfinder (M5StickS3)       ");
    Serial.println("  Deep Sleep RTC + 320x240 Peaking + Wake Key Config ");
    Serial.printf("  WakeCause=%d\\n", (int)wakeCause);
    Serial.println("====================================================");
  }

  M5.Speaker.begin();
  M5.Speaker.setVolume(SPEAKER_SAFE_VOL);

  currentRotation = LCD_ROTATION;
  loadSettingsFromNvs();
  initStickClockOnBoot();
  loadWifiCredsFromNvs();
  loadBtCredsFromNvs();
  loadTraceFromNvs();
  applyScreenBrightness(currentBrightnessLevel);
  M5.Display.setRotation(currentRotation);
  M5.Display.setTextWrap(false);
  // Swap RGB565 bytes in M5GFX because TJpg_Decoder outputs CPU-endian uint16_t pixels
  M5.Display.setSwapBytes(true);

  imuReady = M5.Imu.isEnabled();
  if (!imuReady) imuReady = M5.Imu.begin();

  // Allocate reusable 8-bit luma buffers for Focus Peaking (320x240 = 75KB, 160x120 = 18.75KB)
  peakLuma320 = psramFound() ? (uint8_t*)ps_malloc(320 * 240) : (uint8_t*)malloc(320 * 240);
  if (!peakLuma320) peakLuma320 = (uint8_t*)malloc(320 * 240);
  peakLuma160 = (uint8_t*)malloc(160 * 120);
  if (!peakLuma160 && psramFound()) peakLuma160 = (uint8_t*)ps_malloc(160 * 120);

  // Allocate 3 triple-buffered JPEG frame slots (internal SRAM first, OPI PSRAM for overflow/slot 3)
  frameBuf[0] = (uint8_t*)malloc(FRAME_SLOT_SIZE);
  frameBuf[1] = (uint8_t*)malloc(FRAME_SLOT_SIZE);
  frameBuf[2] = psramFound() ? (uint8_t*)ps_malloc(FRAME_SLOT_SIZE) : (uint8_t*)malloc(FRAME_SLOT_SIZE);
  if ((!frameBuf[0] || !frameBuf[1]) && psramFound()) {
    if (!frameBuf[0]) frameBuf[0] = (uint8_t*)ps_malloc(FRAME_SLOT_SIZE);
    if (!frameBuf[1]) frameBuf[1] = (uint8_t*)ps_malloc(FRAME_SLOT_SIZE);
  }
  if (!frameBuf[0] || !frameBuf[1]) {
    Serial.println("[MEM] Failed to allocate JPEG frame buffers!");
    diag.lastError = "NoRAM";
    showConnectingSplash("Memory Error", "Heap alloc failed");
    return;
  }
  activeFrameSlots = frameBuf[2] ? 3 : 2;
  Serial.printf("[MEM] Active RTP frame slots: %u (slot=%u B) | PeakBuf320=%d 160=%d\\n",
                activeFrameSlots, (unsigned)FRAME_SLOT_SIZE,
                peakLuma320 ? 1 : 0, peakLuma160 ? 1 : 0);

  TJpgDec.setJpgScale(JPG_SCALE);
  TJpgDec.setSwapBytes(false);
  TJpgDec.setCallback(tft_output);

  // Optional Bluetooth Auto-Wake on StickS3 wake/boot (wakes Air A01 over BLE before Wi-Fi connect)
  wakeAirViaBluetoothOnBoot();

  // Fast connect to saved Air OR first-run AP Scanner + 8-digit passkey onboarding
  if (ensureAirConnectedForSession(true)) {
    if (!performOlympusHandshake()) {
      showConnectingSplash("Handshake Warning", diag.lastError);
      delay(600);
    }
  }

  lastFrameTimer = millis();
  if (sessionReady) {
    drawChromeUI();
    updateTopBanner();
  }
}

void toggleDualGyroLock() {
  if (!dualGyroLocked) {
    priorStickRotMode = stickRotMode;
    priorCamGyroMode  = camGyroMode;
    dualGyroLocked    = true;
    stickRotMode      = STICK_ROT_LOCK;
    camGyroMode       = CAM_GYRO_LOCK;
    camActiveOrient   = 1;
    imuPendingRot     = 255;
    imuPendingCount   = 0;
    saveSettingsToNvs();
    playTone(1800, 65);
    diag.lastError = "GYRO:LCK";
    Serial.printf("[GYRO-4B] Locked BOTH gyros (saved prior Stick=%s Cam=%s)\\n",
                  STICK_ROT_NAMES[priorStickRotMode], CAM_GYRO_NAMES[priorCamGyroMode]);
  } else {
    if (!imuReady) imuReady = M5.Imu.begin();
    uint8_t nextStick = (priorStickRotMode < STICK_ROT_COUNT) ? priorStickRotMode : STICK_ROT_GYRO;
    uint8_t nextCam   = (priorCamGyroMode < CAM_GYRO_COUNT) ? priorCamGyroMode : CAM_GYRO_AUTO;
    if (nextStick == STICK_ROT_LOCK && nextCam == CAM_GYRO_LOCK) {
      nextStick = STICK_ROT_GYRO;
      nextCam   = CAM_GYRO_AUTO;
    }
    stickRotMode    = nextStick;
    camGyroMode     = nextCam;
    dualGyroLocked  = false;
    imuPendingRot   = 255;
    imuPendingCount = 0;
    if (camGyroMode == CAM_GYRO_FLIP180) {
      camActiveOrient = 3;
    } else if (camGyroMode == CAM_GYRO_AUTO) {
      camActiveOrient = (diag.camExifOrient == 3) ? 3 : 1;
    } else {
      camActiveOrient = 1;
    }
    saveSettingsToNvs();
    playTone(3100, 65);
    diag.lastError = "GYRO:ON";
    Serial.printf("[GYRO-4B] Unlocked & restored Stick=%s Cam=%s\\n",
                  STICK_ROT_NAMES[stickRotMode], CAM_GYRO_NAMES[camGyroMode]);
  }
}

// ----------------------------------------------------------------------------
// Main Loop
// ----------------------------------------------------------------------------
void loop() {
  pollAllButtons();
  processPendingChannelNvsUpdates();
  serviceSerialTraceConsole();

  // Dual shutdown anytime: Hold BtnA + BtnB together (>=650ms)
  if (checkComboShutdownTriggered()) {
    if (contBurstActive) {
      stopContinuousBurst();
    }
    btnAComboCancelled = true;
    btnBComboCancelled = true;
    btnADownTime       = 0;
    btnAShotHandled    = false;
    btnBDownTime       = 0;
    btnBClickCount     = 0;
    btnBLongTriggered  = false;
    shutdownCameraAndM5();
  }

  // Re-connect / re-search cleanly if Wi-Fi drops or session stalls offline
  if (WiFi.status() != WL_CONNECTED || !sessionReady) {
    sessionReady = false;
    if (ensureAirConnectedForSession(true)) {
      if (performOlympusHandshake()) {
        if (diag.displayMode == 1) {
          initDiagnosticsScreenLayout();
          updateDiagnosticsScreenData();
        } else {
          drawChromeUI();
          updateTopBanner();
        }
      }
    }
    return;
  }

  // Self-Timer Countdown Tick (non-blocking so liveview keeps updating)
  if (selfTimerActive) {
    unsigned long nowT = millis();
    if (nowT >= selfTimerEndMs) {
      selfTimerActive = false;
      selfTimerLastSec = -1;
      triggerSnapshot();
      return;
    } else {
      int16_t remS = (int16_t)((selfTimerEndMs - nowT + 999UL) / 1000UL);
      if (remS != selfTimerLastSec) {
        selfTimerLastSec = remS;
        playTone(remS <= 2 ? 3200 : 2300, remS <= 2 ? 55 : 30);
        diag.lastError = "T-" + String(remS) + "s";
        updateTopBanner();
      }
    }
  }

  // Continuous burst handling while [A] remains held (30s safety cap)
  if (contBurstActive) {
    unsigned long nowB = millis();
    if (nowB - contBurstStartMs > 30000UL) {
      stopContinuousBurst();
    } else if (contBurstManualLoop) {
      unsigned long stepMs = (currentSeqSpeed == SEQ_HIGH) ? 180UL : 380UL;
      if (nowB - contBurstLastShotMs >= stepMs) {
        contBurstLastShotMs = nowB;
        String bResp;
        opcHttpGet(URL_NEW_STOP, bResp, 1500, true, 800);
        playTone(3500, 25);
        diag.lastShutterCode = opcHttpGet(URL_NEW_START, bResp, 4000, false, 1200);
      }
    }
  }

  // Button A (GPIO 11): SHUTTER mode -> Shot/Burst/Timer; PEAK mode -> Tap toggles Focus Peaking ONLY
  if (M5.BtnA.isPressed()) {
    if (M5.BtnB.isPressed()) {
      btnAComboCancelled = true;
      btnADownTime = 0;
      btnAShotHandled = false;
      if (contBurstActive) {
        stopContinuousBurst();
      }
    } else if (!btnAComboCancelled) {
      if (btnADownTime == 0) {
        btnADownTime = millis();
        btnAShotHandled = false;
      } else if (!btnAShotHandled && (millis() - btnADownTime >= BTNA_COMBO_GUARD_MS)) {
        btnAShotHandled = true;
        if (btnAMode == BTNA_PEAK) {
          peakEnabled = !peakEnabled;
          saveSettingsToNvs();
          playTone(peakEnabled ? 3100 : 1700, 35);
          diag.lastError = peakEnabled ? "PK:ON" : "PK:OFF";
          if (diag.displayMode == 0) {
            drawChromeUI();
            updateTopBanner();
          } else {
            updateDiagnosticsScreenData();
          }
        } else if (selfTimerActive) {
          selfTimerActive = false;
          selfTimerLastSec = -1;
          diag.lastError = "CANCL";
          playTone(1400, 60);
          drawChromeUI();
          updateTopBanner();
        } else if (currentDriveMode == DRIVE_CONT) {
          if (!contBurstActive) {
            startContinuousBurst();
          }
        } else if (currentDriveMode == DRIVE_TIMER_2S || currentDriveMode == DRIVE_TIMER_10S) {
          uint32_t delayMs = (currentDriveMode == DRIVE_TIMER_2S) ? 2000UL : 10000UL;
          selfTimerActive  = true;
          selfTimerEndMs   = millis() + delayMs;
          selfTimerLastSec = -1;
        } else {
          // DRIVE_SINGLE: takes exactly 1 shot per press, even if Button A remains held down
          triggerSnapshot();
        }
      }
    }
  } else {
    if (contBurstActive) {
      stopContinuousBurst();
    }
    if (btnAComboCancelled) {
      btnAComboCancelled = false;
      btnADownTime = 0;
      btnAShotHandled = false;
    } else if (btnADownTime != 0) {
      unsigned long durA = millis() - btnADownTime;
      btnADownTime = 0;
      bool alreadyHandled = btnAShotHandled;
      btnAShotHandled = false;
      // Handle ultra-fast taps released before the 45ms combo guard window
      if (!alreadyHandled && durA >= 20) {
        if (btnAMode == BTNA_PEAK) {
          peakEnabled = !peakEnabled;
          saveSettingsToNvs();
          playTone(peakEnabled ? 3100 : 1700, 35);
          diag.lastError = peakEnabled ? "PK:ON" : "PK:OFF";
          if (diag.displayMode == 0) {
            drawChromeUI();
            updateTopBanner();
          } else {
            updateDiagnosticsScreenData();
          }
        } else if (selfTimerActive) {
          selfTimerActive = false;
          selfTimerLastSec = -1;
          diag.lastError = "CANCL";
          playTone(1400, 60);
          drawChromeUI();
          updateTopBanner();
        } else if (currentDriveMode == DRIVE_TIMER_2S || currentDriveMode == DRIVE_TIMER_10S) {
          uint32_t delayMs = (currentDriveMode == DRIVE_TIMER_2S) ? 2000UL : 10000UL;
          selfTimerActive  = true;
          selfTimerEndMs   = millis() + delayMs;
          selfTimerLastSec = -1;
        } else {
          triggerSnapshot();
        }
      }
    }
  }

  // Button B (GPIO 12): 1x=Aspect, 2x=Mode, 3x=Diag, 4x=Dual-Gyro Lock/Restore, 5x=Off Air+Stick, Hold=Menu
  if (M5.BtnB.isPressed()) {
    if (M5.BtnA.isPressed()) {
      btnBComboCancelled = true;
      btnBDownTime = 0;
      btnBClickCount = 0;
    } else if (!btnBComboCancelled) {
      if (btnBDownTime == 0) {
        btnBDownTime = millis();
        btnBLongTriggered = false;
      } else if (!btnBLongTriggered && (millis() - btnBDownTime >= 600)) {
        btnBLongTriggered = true;
        btnBClickCount = 0;
        if (selfTimerActive) {
          selfTimerActive = false;
          selfTimerLastSec = -1;
        }
        if (contBurstActive) {
          stopContinuousBurst();
        }
        bool stillOnline = runQuickMenu();
        btnBDownTime = 0;
        btnBComboCancelled = M5.BtnB.isPressed();
        if (!stillOnline) return;
        if (diag.displayMode == 1) {
          initDiagnosticsScreenLayout();
          updateDiagnosticsScreenData();
        } else {
          drawChromeUI();
          updateTopBanner();
        }
      }
    }
  } else {
    if (btnBComboCancelled) {
      btnBComboCancelled = false;
      btnBDownTime = 0;
    } else if (btnBDownTime != 0) {
      unsigned long duration = millis() - btnBDownTime;
      btnBDownTime = 0;
      if (!btnBLongTriggered && duration >= 25 && duration < 600) {
        if (selfTimerActive) {
          selfTimerActive = false;
          selfTimerLastSec = -1;
          btnBClickCount = 0;
          diag.lastError = "CANCL";
          playTone(1400, 60);
          drawChromeUI();
          updateTopBanner();
        } else {
          btnBClickCount++;
          btnBLastReleaseMs = millis();
          if (btnBClickCount >= 5) {
            btnBClickCount = 0;
            shutdownCameraAndM5();
          }
        }
      }
    }
  }

  if (btnBClickCount > 0 && !M5.BtnB.isPressed() && (millis() - btnBLastReleaseMs > BTNB_MULTI_CLICK_MS)) {
    uint8_t clicks = btnBClickCount;
    btnBClickCount = 0;
    if (clicks == 1) {
      currentAspectIdx = (currentAspectIdx + 1) % ASPECT_COUNT;
      saveSettingsToNvs();
      playTone(2400, 35);
      bool ok = setCameraAspectRatio(currentAspectIdx);
      diag.lastError = ok ? String(ASPECT_NAMES[currentAspectIdx]) : ("A:" + String(diag.aspectCode));
      if (diag.displayMode == 0) {
        drawChromeUI();
        updateTopBanner();
      } else {
        updateDiagnosticsScreenData();
      }
    } else if (clicks == 2) {
      currentShootMode = (currentShootMode + 1) % SHOOT_COUNT;
      saveSettingsToNvs();
      playTone(2900, 60);
      bool ok = applyShootingMode(currentShootMode);
      diag.lastError = ok ? String(SHOOT_MODE_LABELS[currentShootMode]) : ("M:" + String(diag.modeCode));
      if (diag.displayMode == 0) {
        updateExposureRail();
        updateTopBanner();
      } else {
        updateDiagnosticsScreenData();
      }
    } else if (clicks == 3) {
      diag.displayMode = (diag.displayMode == 0) ? 1 : 0;
      playTone(3000, 65);
      if (diag.displayMode == 1) {
        initDiagnosticsScreenLayout();
        updateDiagnosticsScreenData();
      } else {
        drawChromeUI();
        updateTopBanner();
      }
    } else if (clicks == 4) {
      toggleDualGyroLock();
      if (diag.displayMode == 1) {
        updateDiagnosticsScreenData();
      } else {
        updateTopBanner();
      }
    }
  }

  // BMI270 IMU Gyro Auto-Rotate (LOCK / GYRO / L-FLIP toggled in Hold-B Menu; skip NVS write in loop for zero frame stalls)
  if (pollImuAutoRotateIfEnabled()) {
    if (diag.displayMode == 1) {
      initDiagnosticsScreenLayout();
      updateDiagnosticsScreenData();
    } else {
      drawChromeUI();
      updateTopBanner();
    }
  }

  // Render latest completed frame from AsyncUDP ping-pong buffer
  processReadyFrame();

  // First-Frame Stream Gate: push saved aspect/mode/drive/battery only after frame 1 settles (+150ms)
  if (pendingPostStreamSync && sawFirstVideoFrame && (millis() - firstVideoFrameMs >= 150)) {
    pendingPostStreamSync = false;
    syncSavedCameraPropertiesAfterStream();
  }

  unsigned long now = millis();

  // Stream Watchdog: If UDP goes silent >4s, recover via standalone -> rec -> startliveview
  if (diag.udpListening && WiFi.status() == WL_CONNECTED &&
      (now - lastRxPacketMs > 4000) && (now - lastStreamResumeMs > 5000)) {
    lastStreamResumeMs = now;
    String resp;
    Serial.println("[WATCHDOG] LiveView quiet >4s, re-issuing startliveview...");
    diag.cgi3Code = opcHttpGetWith520Retry(URL_START_STREAM, resp, 2500);
    if (diag.cgi3Code != 200) {
      opcHttpGet(URL_SWITCH_STDBY, resp, 1200);
      delay(200);
      opcHttpGetWith520Retry(URL_SWITCH_REC, resp, 3000);
      opcHttpGetWith520Retry(URL_CHANGE_LVQTY, resp, 2000);
      diag.cgi3Code = opcHttpGetWith520Retry(URL_START_STREAM, resp, 3000);
    }
    lastRxPacketMs = millis();
  }

  // Fallback HTTP exposure polling ONLY if stream lacks RTP Extension Header
  if (!diag.hasRtpExt && sawFirstVideoFrame && !pendingPostStreamSync && (now - lastExposurePollMs >= 1500)) {
    lastExposurePollMs = now;
    pollNextExposureProp(false);
  }

  if (now - lastHudUpdate > 500) {
    lastHudUpdate = now;
    if (diag.displayMode == 1) updateDiagnosticsScreenData();
    else updateTopBanner();
  }

  // Background battery & mode poll every 15s (short connect timeout prevents liveview stalls)
  if (now - lastBatteryCheck > 15000 && !contBurstActive) {
    lastBatteryCheck = now;
    updateCameraBatteryStatus(true);
    String modeVal;
    if (queryCameraProp(propModeName.c_str(), modeVal, 600, 650) == 200 && modeVal.length() > 0) {
      String prevMode = diag.expModeStr;
      formatAndStoreExposure(3, modeVal);
      if (prevMode != diag.expModeStr) updateExposureRail();
    }
  }

  delay(1);
}
`;
}

export function generateConfigHeader(cfg: GeneratorConfig): string {
  const effectiveScale = cfg.liveViewQuality === "0640x0480" && cfg.jpegScale < 4 ? 4 : cfg.jpegScale;
  const slotSize = cfg.liveViewQuality === "0640x0480" ? 49152 : 36864;
  return `/**
 * config.h - Olympus Air A01 Configuration for M5StickS3 (ESP32-S3)
 */
#ifndef CONFIG_H
#define CONFIG_H

#define OLYMPUS_WIFI_SSID     "${cfg.wifiSsid}"
#define OLYMPUS_WIFI_PASS     "${cfg.wifiPass}"
#define OLYMPUS_AUTO_SCAN     ${cfg.autoScanAir ? "1" : "0"}

#define OLYMPUS_CAMERA_IP     "${cfg.cameraIp}"
#define OLYMPUS_STREAM_PORT   ${cfg.streamPort}
#define OLYMPUS_USER_AGENT    "OlympusCameraKit"
#define OLYMPUS_HTTP_MIN_GAP  50

#define OLYMPUS_LV_QUALITY    "${cfg.liveViewQuality}"
#define OLYMPUS_ASPECT_RATIO  "${cfg.defaultAspectRatio}"
#define OLYMPUS_SHOOT_MODE    "${cfg.defaultShootingMode}"
#define TFT_DISPLAY_ROTATION  ${cfg.rotation}
#define JPEG_SCALE_FACTOR     ${effectiveScale}
#define FRAME_SLOT_BUFFER     ${slotSize}

#endif // CONFIG_H
`;
}

export function generatePlatformIoIni(): string {
  return `[env:m5stack-sticks3]
platform = espressif32@6.12.0
board = esp32-s3-devkitc-1
framework = arduino

monitor_speed = 115200
upload_speed = 921600

board_build.partitions = default_8MB.csv
board_build.arduino.memory_type = qio_opi
board_build.f_cpu = 240000000L

lib_deps =
    m5stack/M5Unified @ ^0.2.12
    bodmer/TJpg_Decoder @ ^1.1.0

build_flags =
    -DESP32S3
    -DBOARD_HAS_PSRAM
    -mfix-esp32-psram-cache-issue
    -DARDUINO_USB_CDC_ON_BOOT=1
    -DARDUINO_USB_MODE=1
    -DCORE_DEBUG_LEVEL=0
    -O3
`;
}

export interface OlympusApiEndpoint {
  method: string;
  endpoint: string;
  purpose: string;
  response: string;
}

export const OLYMPUS_API_DOCS: OlympusApiEndpoint[] = [
  {
    method: "GET",
    endpoint: "/get_connectmode.cgi",
    purpose: "Validates Wi-Fi connection mode (sends User-Agent & X-Protocol: OlympusCameraKit)",
    response: "XML containing <connectmode>standalone</connectmode>",
  },
  {
    method: "GET",
    endpoint: "/switch_cameramode.cgi?mode=rec",
    purpose: "Switches Air A01 to shooting (REC) mode cleanly (falls back via standalone if stale)",
    response: "XML containing <result>ok</result>",
  },
  {
    method: "GET",
    endpoint: "/exec_takemisc.cgi?com=changelvqty&lvqty=0320x0240",
    purpose: "Sets liveview stream resolution (auto-retries after 200ms if HTTP 520 mid-transition)",
    response: "XML containing <result>ok</result>",
  },
  {
    method: "GET",
    endpoint: "/exec_takemisc.cgi?com=startliveview&port=5555",
    purpose: "Starts RTP/UDP liveview immediately (post-stream camprop writes wait for frame 1)",
    response: "XML containing <result>ok</result>",
  },
  {
    method: "GET",
    endpoint: "/exec_takemotion.cgi?com=takeready&point=0160x0120",
    purpose: "Locks autofocus/exposure before firing shutter (50ms inter-call HTTP gap)",
    response: "XML containing <result>ok</result>",
  },
  {
    method: "GET",
    endpoint: "/exec_takemotion.cgi?com=newstarttake -> newstoptake",
    purpose: "Fires OPC shutter exposure (newstoptake bypasses 50ms throttle for immediate stop)",
    response: "XML containing <result>ok</result>",
  },
  {
    method: "GET",
    endpoint: "/get_camprop.cgi?com=get&propname=BATTERY_LEVEL",
    purpose: "Reads Olympus Air A01 battery status level",
    response: "XML containing <value>FULL</value> (or percentage)",
  },
  {
    method: "POST",
    endpoint: "/set_camprop.cgi?com=set&propname=ASPECT_RATIO",
    purpose: "Sets camera still/framing aspect ratio (16:9, 4:3, 3:2, and 1:1 via OPC 6:6)",
    response: "XML containing <result>ok</result>",
  },
  {
    method: "POST",
    endpoint: "/set_camprop.cgi?com=set&propname=TAKEMODE",
    purpose: "Sets shooting mode (treats 200 <notset/> as trigger & polls com=get every 100ms)",
    response: "XML <result>ok</result> or <notset/> confirmed via com=get",
  },
  {
    method: "POST",
    endpoint: "/set_camprop.cgi?com=set&propname=TAKE_DRIVE / DRIVE_MODE",
    purpose: "Auto-discovered via desclist for HW Continuous & Hold [A] burst (Air A01 OPC burst runs at fixed ~10fps without numeric FPS)",
    response: "XML containing <result>ok</result>",
  },
  {
    method: "POST",
    endpoint: "/set_camprop.cgi?com=set&propname=SOUND_VOLUME_LEVEL",
    purpose: "Updates & verifies Air A01 beep volume immediately in REC mode (also applied right on connect if pre-set offline before Wi-Fi)",
    response: "XML containing <result>ok</result>",
  },
  {
    method: "GET",
    endpoint: "/switch_cameramode.cgi?mode=standalone",
    purpose: "Transitions cleanly to standalone before power-off (menu exit resumes Live View in ~0ms without round-trip)",
    response: "XML containing <result>ok</result>",
  },
  {
    method: "GET",
    endpoint: "/exec_takemisc.cgi?com=stopliveview",
    purpose: "Stops live video streaming and terminates RTP broadcast",
    response: "XML containing <result>ok</result>",
  },
  {
    method: "GET",
    endpoint: "/exec_pwoff.cgi (or ?mode=withble via /get_commandlist.cgi)",
    purpose: "Powers off Olympus Air A01 cleanly on 5x[B], Hold A+B, or Quick Menu 'Sleep: Air + Stick', then enters ESP32-S3 Deep Sleep (keeps RTC alive)",
    response: "XML containing <result>ok</result>",
  },
  {
    method: "RTP Ext",
    endpoint: "RTP Extension funcId=1 (EXIF 1 <-> 3, 180-deg Only)",
    purpose: "Reads physical Air A01 upside-down orientation (EXIF 3=180 deg) to auto-flip Live View cleanly in vpCanvas (ignores 90/270 deg)",
    response: "4-byte BE EXIF code: 1=0°, 3=180° (manual 180D / LOCK also in menu)",
  },
  {
    method: "BLE",
    endpoint: "ESP32-S3 BLE Scanner + 6-Digit Bonding + NVS GATT Trace",
    purpose: "Pairs & wakes Air A01 on boot when BT Wake = ON; logs SMP BOND OK/AUTH FAIL, GATT UUIDs/values, and notifications to NVS for 115200 USB replay",
    response: "BLE connect + 6-digit PIN + GATT/NVS trace -> deinit before Static IP Wi-Fi",
  },
  {
    method: "GET",
    endpoint: "/get_imglist.cgi?DIR=/DCIM",
    purpose: "Queried immediately after shutter stopwatch on next shot; adds elapsed stopwatch ms to latest FAT photo timestamp to sync StickS3 RTC (alerts on year 2015)",
    response: "VER_100 CSV: <dir>,<name>,<size>,<attr>,<fatDate>,<fatTime>",
  },
];
