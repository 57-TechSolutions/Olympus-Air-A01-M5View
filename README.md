# OlympusAir-M5StickS3

[![License: MIT](https://img.shields.io/badge/License-MIT-orange.svg)](LICENSE)
![Hardware](https://img.shields.io/badge/Hardware-M5StickS3%20(ESP32--S3)-blue)
![Camera](https://img.shields.io/badge/Camera-Olympus%20Air%20A01%20(OPC)-cyan)
![Status](https://img.shields.io/badge/Status-Heavy%20Active%20Development-yellow)

A standalone, two-button wireless live viewfinder and pocket controller for the **Olympus Air A01** Open Platform Camera (OPC), built for the **M5StickS3 (ESP32-S3)**.

> [!WARNING]
> **Active Development Notice:** This repository is currently being **heavily developed**, and many features, menu layouts, and defaults are **subject to change**.  
> If you try this out, hit bugs, or want a feature adjusted, please **open an [Issue](../../issues) or [Pull Request](../../pulls)** right away so we can get your feedback in as quickly as possible!

---

## Which File Do I Need? (Arduino IDE Quick Pointer)

If you are brand new and just want to flash your M5StickS3 from GitHub:

1. **You only need one folder:** **`OlympusAir_M5StickS3/OlympusAir_M5StickS3.ino`**
2. That `.ino` file is **100% self-contained** — you do **not** need `config.h`, `src/`, `package.json`, or any knowledge of the rest of the files in this repository (those files only power an optional browser-based emulator and code generator).

Jump straight to [From-Scratch Installation (Arduino IDE)](#from-scratch-installation-arduino-ide) to flash your StickS3 in a few minutes.

---

## Key Features

- **First-Boot 2-Button Wi-Fi Onboarding:** On first boot (or anytime via `Wi-Fi Setup`), the StickS3 scans nearby Wi-Fi networks (`AIR-*` cameras listed first) and lets you enter your camera's 8-digit Wi-Fi password directly from the M5StickS3 buttons — no hardcoded SSID/password edits needed.
- **Real-Time Focus Peaking (`Peak Setup >`):** Edge-detection focus peaking overlay with **ON/OFF** toggle, **5 highlight colors** (`RED`, `YELLOW`, `GREEN`, `CYAN`, `WHITE`), **3 line thicknesses** (`1PX`, `2PX`, `3PX`), **3 calibrated sensitivities** (`LOW`, `MID`, `HIGH`), and `320×240` or `160×120` source selection.
- **Customizable On-Screen HUD (`HUD Setup >`):** Toggle **all 14 individual HUD text elements** (`FPS`, `Status`, `Aspect`, `Res`, `Battery`, `Mode`, `Shutter`, `Aperture`, `ISO`, `Drive/Tag`, `Remain`, `AF/Exp W`, `Clock`, `Btn Hints`) or flip `All HUD` ON/OFF for an unobstructed viewfinder.
- **Accelerometer UI Rotation & Lock (`Stick Rot`):** Uses the built-in BMI270 IMU to rotate the UI automatically (`GYRO` 4-way, `L-FLIP` landscape auto-flip, or `LOCK`), plus instant lock/unlock via `4×[B]`.
- **Turn Off M5StickS3 & Olympus Air A01 Together:** `Hold A+B`, `5×[B]`, or Menu `Sleep: Air + Stick` powers down the Olympus Air A01 and puts the M5StickS3 into Deep Sleep simultaneously (`Sleep: Stick Only` lets you sleep only the StickS3 while leaving the Air powered on).
- **Built-In Help Guide (`Help >`):** Paginated button & feature reference directly inside the Quick Menu (`[A]` Page Up, `[B]` Page Down, `Hold [B]` back).
- **Persistent RTC Clock Sync (`Sync Clock`):** Uses a shutter-stopwatch + `/get_imglist.cgi` photo timestamp sync to set the M5StickS3 clock accurately and preserve it across Deep Sleep cycles (alerts with `2015!` if the Air's internal clock is unset).

---

## Personalized 2-Button Controls & Quirky Presets

This firmware is tailored around quick one-handed shooting on a 2-button device rather than standard PASM menus:

### Live View Button Map

| Input | Action | Notes |
| :--- | :--- | :--- |
| **`[A]` Tap** | **Shutter** *or* **Focus Peak Toggle** | Configured via `BtnA Mode` (`SHUTTER` default, or `PEAK`). In `PEAK` mode, `[A]` only toggles Focus Peaking — use the physical shutter button on the Air A01 to shoot. |
| **`[A]` Hold** | **Continuous Burst** | In `SHUTTER` mode with `Drive = CONT`, holding `[A]` fires continuous frames until released (also cancels an active 2s/10s self-timer). |
| **`1× [B]`** | **Cycle Aspect Ratio** | Directly cycles **`16:9` → `4:3` → `3:2` → `1:1`** (sends `6:6` to OPC) straight from Live View. |
| **`2× [B]`** | **Cycle Shooting Preset** | Cycles 3 personalized modes instead of full PASM:<br>• **`iAUTO`** — Standard point-and-shoot auto<br>• **`A:MAX`** — Aperture Priority locked to your attached lens's **widest/fastest aperture** (e.g., `F1.7`, `F1.8`, `F2.8`)<br>• **`S:1/60`** — Shutter Priority locked to **`1/60s`** |
| **`3× [B]`** | **Diagnostics HUD** | Toggles between Live View and the Diagnostics / connection telemetry view. |
| **`4× [B]`** | **Dual-Gyro Lock** | Locks/restores both Stick IMU rotation and Camera gyro orientation together. |
| **`5× [B]`** | **Sleep Air + Stick** | Powers off the Air A01 + puts StickS3 into Deep Sleep. Works on **Live View, Boot/Searching, Wi-Fi Setup, and BT Setup** screens. |
| **`Hold [B]` (≥600ms)** | **Quick Menu** | Opens the 22-item Quick Menu with look-ahead scrolling (keeps the next item visible before advancing). |
| **`Hold [A+B]` (≥650ms)** | **Sleep Air + Stick** | Instant combined shutdown shortcut from any screen or menu. |

### Inside Menus & Setup Wizards

- **`[B]` Tap:** Move down / cycle digit / next page (`Help >`)
- **`[A]` Tap:** Select / toggle / confirm digit / previous page (`Help >`)
- **`Hold [B]` (≥600ms):** Exits Quick Menu, `Peak Setup >`, `HUD Setup >`, or `Help >` **immediately before you even release the button**
- **Passkey Entry:** `[B]` increments digit `+1` (hold to fast-step), `[A]` advances to the next digit

---

## Known Quirks, Frame Rates & Shutdown Behavior

Because this firmware targets real-world quirks on the Olympus Air A01 + M5StickS3 hardware, keep these behaviors in mind:

- **Frame Rate (~20 FPS in `16:9`, ~10 FPS in other ratios):** Live View runs at around **20 FPS in `16:9`**, whereas `4:3`, `3:2`, and `1:1` run at around **10 FPS**.
- **Initial Connection Lag:** Expect a brief lag right after initially connecting to the Air A01 while the stream and camera properties settle.
- **BLE Wake Does Not Work Yet:** The `BT Wake` / `BT Setup` scanner and 6-digit passkey menus are present in the UI, but automatic Bluetooth wake on boot **does not work yet** and is still being worked on.
- **Camera Gyro Rotation Doesn't Work Quite Right Yet:** `Cam Gyro` (`AUTO` / `180D` / `LOCK`) attempts to flip the Air A01 live view automatically when mounted upside down, but it **doesn't work quite right yet** and may behave inconsistently (`LOCK` or manual `180D` is available as a fallback).
- **Two Ways to Turn Off the M5StickS3:**
  1. **Power Button (2 Clicks) — Hard Power-Off:** Completely shuts off power to the M5StickS3, which **kills the internal clock** (requires re-syncing time on the next shoot). Also note that pushing the Power button while in Deep Sleep hardware-resets the device, so it cannot be used as a soft wake key.
  2. **Deep Sleep (`Hold A+B`, `5×[B]`, or Menu Sleep):** Puts the ESP32-S3 into Deep Sleep so it **preserves your synced RTC clock** and **boots back up a little faster**. Configure which button wakes it via `Wake Key` (`BTN B` default pocket-safe, `BTN A`, or `A+B`).

---

## Complete Quick Menu & Submenus

Hold **`[B]` (≥600ms)** from Live View, Boot, Wi-Fi Setup, or BT Setup to open the **22-item Quick Menu**:

| # | Menu Item | Values / Action | Notes |
| :-: | :--- | :--- | :--- |
| 0 | `< Back to Live` | Return | Resumes Live View (or current setup screen) |
| 1 | `Focus Peak` | `ON` / `OFF` | Quick toggle for Focus Peaking overlay |
| 2 | `Peak Setup >` | Submenu (6 items) | `Peaking`, `Color`, `Thick`, `Sens`, `Source`, `< Back` |
| 3 | `BtnA Mode` | `SHUTTER` / `PEAK` | Tap `[A]` fires shutter vs toggles Focus Peaking |
| 4 | `Grid` | `OFF` / `3RDS` / `4x4` / `DIAG` / `GOLD` | Viewfinder framing guides |
| 5 | `Drive` | `SINGLE` / `CONT` / `TMR 2s` / `TMR 10s` | Single, continuous burst, or self-timer |
| 6 | `Seq Spd` | `HIGH` / `LOW` | Continuous drive speed when supported by lens/OPC |
| 7 | `Stick Snd` | `ON` / `OFF` | M5StickS3 ES8311 speaker feedback tones |
| 8 | `Air Sound` | Camera beep level | Syncs Air A01 `SOUND_VOLUME_LEVEL` |
| 9 | `Bright` | `100%` / `60%` / `30%` | TFT backlight brightness |
| 10 | `Stick Rot` | `LOCK` / `GYRO` / `L-FLIP` | StickS3 BMI270 screen rotation mode |
| 11 | `Cam Gyro` | `AUTO` / `180D` / `LOCK` | Experimental Air A01 180° flip control |
| 12 | `HUD Setup >` | Submenu (16 items) | `All HUD` + 14 individual HUD text toggles |
| 13 | `BT Wake` | `ON` / `OFF` | Experimental BLE wake-on-boot toggle (WIP) |
| 14 | `BT Setup` | BLE Scan + 6-digit PIN | Pair Air A01 BLE address & passkey |
| 15 | `Wi-Fi Setup` | Scan + 8-digit passkey | Pick `AIR-*` AP & save credentials to NVS |
| 16 | `Sync Clock` | `NEXT SHT` / time / `2015!INV` | Arm shutter-stopwatch photo clock sync |
| 17 | `Wake Key` | `BTN B` / `BTN A` / `A+B` | Deep Sleep wake button (`BTN B` pocket-safe default) |
| 18 | `Help >` | Paginated Guide | `[A]` Page Up, `[B]` Page Down, `Hold [B]` back |
| 19 | `Dump Trace` | USB Serial dump | Prints diagnostic & BLE/GATT NVS trace at `115200` |
| 20 | `Sleep: Stick Only` | Deep Sleep (Stick) | Sleeps M5StickS3 only; leaves Air A01 powered on |
| 21 | `Sleep: Air + Stick` | Deep Sleep (Both) | Powers off Air A01 + puts M5StickS3 into Deep Sleep |

### Submenu Details

- **`Peak Setup >`:** `Peaking` (`ON`/`OFF`), `Color` (`RED` / `YELLOW` / `GREEN` / `CYAN` / `WHITE`), `Thick` (`1PX` / `2PX` / `3PX`), `Sens` (`LOW` / `MID` / `HIGH`), `Source` (`320x240` / `160x120`).
- **`HUD Setup >`:** `All HUD` (`ALL ON` / `ALL OFF` / `X/14`) plus individual toggles for: `FPS`, `Status`, `Aspect`, `Res`, `Battery`, `Mode`, `Shutter`, `Aperture`, `ISO`, `Drive/Tag`, `Remain`, `AF/Exp W`, `Clock`, and `Btn Hints`.

---

## From-Scratch Installation (Arduino IDE)

### 1. Hardware Prerequisites

- **M5StickS3** (ESP32-S3-PICO-1-N8R8, 8MB Flash, 8MB OPI PSRAM, 135×240 ST7789P3 TFT)
- **Olympus Air A01** camera module with lens attached & microSD card inserted
- **Data-rated USB-C cable** (charge-only cables will not create a serial port)

> [!TIP]
> **If the M5StickS3 fails to enter flash mode:** Hold/jumper **`G0` → `GND`** on the bottom Hat2-Bus header while plugging in USB-C to force ROM download mode, then remove the jumper and press Reset after uploading.

### 2. Install Arduino IDE & Board Package

1. Install **Arduino IDE 2.x**.
2. Open **File → Preferences**, paste this URL into **Additional Boards Manager URLs**, and click **OK**:
   ```text
   https://static-cdn.m5stack.com/resource/arduino/package_m5stack_index.json
   ```
3. Open **Tools → Board → Boards Manager...**, search for **`M5Stack`**, and install **`M5Stack` (`v3.2.5` or newer)**.

### 3. Install Required Libraries

Open **Tools → Manage Libraries...** and install:

1. **`M5Unified`** by M5Stack (`>= 0.2.12`, automatically installs `M5GFX >= 0.2.18`)
2. **`TJpg_Decoder`** by Bodmer (`>= 1.1.0`)

### 4. Open & Flash the Sketch

1. Clone or download this repository and open **`OlympusAir_M5StickS3/OlympusAir_M5StickS3.ino`** in Arduino IDE. *(Keep it inside its `OlympusAir_M5StickS3/` folder — Arduino IDE requires the folder name to match the `.ino` filename.)*
2. Select your COM / `/dev/tty*` port and configure **Tools** exactly as follows:

| Arduino IDE Tools Setting | Required Value |
| :--- | :--- |
| **Board** | `M5StickS3` *(or `ESP32S3 Dev Module`)* |
| **USB CDC On Boot** | **`Enabled`** *(required for `115200` Serial Monitor)* |
| **Flash Size** | `8MB (64Mb)` |
| **PSRAM** | **`OPI PSRAM`** |
| **CPU Frequency** | `240MHz (WiFi)` |
| **Flash Frequency** | `80MHz` |
| **Partition Scheme** | `8M with spiffs (3MB APP/1.5MB SPIFFS)` or `Huge APP` |
| **Upload Speed** | `921600` *(drop to `460800` if flaky)* |

3. Click **Upload**.

### Alternative: PlatformIO

If you prefer PlatformIO, create a project with `OlympusAir_M5StickS3/OlympusAir_M5StickS3.ino` as `src/main.cpp` and use these `platformio.ini` settings:

```ini
[env:m5stack-sticks3]
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
```

### 5. First-Boot Camera Pairing

1. Power on your **Olympus Air A01** (blue Wi-Fi LED steady/blinking).
2. Boot the **M5StickS3**. On first run, the built-in Wi-Fi scanner opens automatically and sorts `AIR-*` networks to the top.
3. Tap **`[B]`** to highlight your Air A01 SSID, tap **`[A]`** to select it, and enter the **8-digit Wi-Fi password** printed inside the Air A01 rear hatch (`[B]` increments digit, `[A]` advances to the next digit).
4. Credentials and the Air's Wi-Fi channel are cached to NVS so future boots reconnect automatically.

---

## Hardware Pinout & Protocol Notes

### M5StickS3 Pinout Reference

| Subsystem | Pin / Interface | Notes |
| :--- | :--- | :--- |
| **Display (`ST7789P3` 135×240)** | `MOSI: G39`, `SCLK: G40`, `CS: 41`, `DC: 45`, `RST: 21`, `BL: 38` | Managed by `M5Unified` / `M5GFX` |
| **Button A (Front `M5`)** | `GPIO 11` (Active LOW, RTC-capable) | Shutter / Burst or Focus Peak toggle |
| **Button B (Side Edge)** | `GPIO 12` (Active LOW, RTC-capable) | Aspect, Mode presets, Menu, Deep Sleep & default Wake Key |
| **Power Button** | Hardware PMIC (`M5PM1`) | 2 clicks = hard power off (kills RTC); resets board if pressed during sleep |
| **Sensors & Audio** | `BMI270` IMU, `ES8311` + `AW8737` | Auto-rotation & speaker tones |

### Olympus OPC & Firmware Notes

- **Fast Static IP + Channel Cache:** Assigns static IP `.100` (`192.168.0.100`) and caches the AP Wi-Fi channel + BSSID in NVS to skip DHCP and 13-channel scans (auto-clears on `WIFI_REASON_NO_AP_FOUND`).
- **OPC HTTP Resilience:** Sends `User-Agent: OlympusCameraKit` and `X-Protocol: OlympusCameraKit`, enforces a `50ms` inter-request gap (`HTTP_MIN_GAP_MS`) to protect the Air's embedded server, automatically retries `HTTP 520` mid-transition responses, and uses a first-frame gate before writing post-stream properties.
- **RTP Live View Stream:** Listens on UDP port `5555` (`exec_takemisc.cgi?com=startliveview&port=5555`) with a 3-slot AsyncUDP buffer and 4-second stream watchdog recovery.
- **USB Serial Diagnostics:** Connect at **`115200` baud** and type **`TRACE`** (or use `Dump Trace` in the Quick Menu) to inspect startup diagnostics and saved NVS trace logs.

---

## License

Released under the [MIT License](https://opensource.org/licenses/MIT).
