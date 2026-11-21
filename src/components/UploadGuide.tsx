import React, { useEffect, useRef, useState } from "react";
import { 
  Check, 
  Copy, 
  AlertTriangle, 
  Usb, 
  HelpCircle,
  ChevronDown,
  ChevronRight,
  Terminal,
  Trash2,
  Send
} from "lucide-react";

interface WebSerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

interface NavigatorWithSerial {
  serial?: {
    requestPort(): Promise<WebSerialPortLike>;
  };
}

export const UploadGuide: React.FC = () => {
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [activeStep, setActiveStep] = useState<number>(1);

  // Web Serial Trace Capture State (115200 baud)
  const [serialConnected, setSerialConnected] = useState(false);
  const [serialError, setSerialError] = useState<string>("");
  const [serialTraceText, setSerialTraceText] = useState<string>("");
  const [copiedTrace, setCopiedTrace] = useState(false);
  const serialPortRef = useRef<WebSerialPortLike | null>(null);
  const serialReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const serialKeepReadingRef = useRef(false);

  const webSerialAvailable =
    typeof navigator !== "undefined" &&
    Boolean((navigator as unknown as NavigatorWithSerial).serial);

  const m5BoardUrl = "https://static-cdn.m5stack.com/resource/arduino/package_m5stack_index.json";

  const handleCopyBoardUrl = () => {
    navigator.clipboard.writeText(m5BoardUrl);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const disconnectWebSerial = async () => {
    serialKeepReadingRef.current = false;
    try {
      if (serialReaderRef.current) {
        await serialReaderRef.current.cancel();
        serialReaderRef.current.releaseLock();
        serialReaderRef.current = null;
      }
    } catch {
      // Ignore reader cancel errors on abrupt unplug
    }
    try {
      if (serialPortRef.current) {
        await serialPortRef.current.close();
        serialPortRef.current = null;
      }
    } catch {
      // Ignore port close errors
    }
    setSerialConnected(false);
  };

  useEffect(() => {
    return () => {
      void disconnectWebSerial();
    };
  }, []);

  const connectWebSerial = async () => {
    setSerialError("");
    const serialApi = (navigator as unknown as NavigatorWithSerial).serial;
    if (!serialApi) {
      setSerialError(
        "Web Serial is unavailable in this browser or blocked by an embedded iframe. Use Arduino IDE Serial Monitor at 115200 baud instead."
      );
      return;
    }
    try {
      const port = await serialApi.requestPort();
      await port.open({ baudRate: 115200 });
      serialPortRef.current = port;
      serialKeepReadingRef.current = true;
      setSerialConnected(true);

      const decoder = new TextDecoder();
      if (port.readable) {
        const reader = port.readable.getReader();
        serialReaderRef.current = reader;
        void (async () => {
          try {
            while (serialKeepReadingRef.current) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value) {
                const chunk = decoder.decode(value, { stream: true });
                setSerialTraceText((prev) => {
                  const combined = prev + chunk;
                  return combined.length > 24000 ? combined.slice(-24000) : combined;
                });
              }
            }
          } catch (readErr) {
            if (serialKeepReadingRef.current) {
              setSerialError(
                readErr instanceof Error ? readErr.message : "Serial read interrupted."
              );
            }
          } finally {
            setSerialConnected(false);
          }
        })();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("permissions policy") || msg.toLowerCase().includes("access") || msg.toLowerCase().includes("gesture")) {
        setSerialError(
          `Browser/iframe blocked Web Serial (${msg}). Open Tools -> Serial Monitor in Arduino IDE at 115200 baud, then type TRACE or choose Menu -> Dump Trace.`
        );
      } else {
        setSerialError(msg);
      }
      setSerialConnected(false);
    }
  };

  const sendSerialCommand = async (cmd: string) => {
    const port = serialPortRef.current;
    if (!port?.writable) return;
    try {
      const writer = port.writable.getWriter();
      const encoder = new TextEncoder();
      await writer.write(encoder.encode(`${cmd}\n`));
      writer.releaseLock();
    } catch (err) {
      setSerialError(err instanceof Error ? err.message : "Failed to write command.");
    }
  };

  const handleCopyTrace = () => {
    if (!serialTraceText) return;
    navigator.clipboard.writeText(serialTraceText);
    setCopiedTrace(true);
    setTimeout(() => setCopiedTrace(false), 2000);
  };

  const steps = [
    {
      num: 1,
      title: "Connect via USB-C (Native ESP32-S3 USB CDC)",
      shortDesc: "M5StickS3 uses built-in ESP32-S3 USB-JTAG/CDC—no external CH9102/CP2104 driver needed.",
      content: (
        <div className="space-y-3 text-xs text-slate-300">
          <p>
            Unlike older M5StickC models that relied on a CH9102 or CP2104 USB-UART bridge, the <strong>M5StickS3 (ESP32-S3-PICO-1-N8R8)</strong> connects directly over native USB-C on Windows 10/11, macOS, and Linux without third-party serial drivers.
          </p>
          <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 space-y-2">
            <div className="font-semibold text-slate-200">Entering Bootloader Download Mode (If Needed):</div>
            <p className="text-slate-400 leading-relaxed">
              If the COM/ttyACM port does not appear or an upload times out, hold the <strong>G0 (Boot)</strong> pin on the top 16-pin <strong>Hat2-Bus</strong> to <strong>GND</strong> (Pin 5 → Pin 1) while plugging in USB-C, or double-click/hold Reset as prompted by esptool.
            </p>
          </div>
          <div className="p-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-300 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              <strong>Crucial:</strong> Use a certified USB-C <strong>data cable</strong>. Charge-only cables will power the M5PM1 PMIC without enumerating the ESP32-S3 USB CDC interface.
            </span>
          </div>
        </div>
      ),
    },
    {
      num: 2,
      title: "Add M5Stack Board Package in Arduino IDE 2.x",
      shortDesc: "Install M5Stack Board Manager v3.2.5+ (includes official M5StickS3 definition).",
      content: (
        <div className="space-y-3 text-xs text-slate-300">
          <ol className="list-decimal list-inside space-y-2 leading-relaxed">
            <li>
              Open <strong>Arduino IDE 2.x</strong>. Go to <strong>File → Preferences</strong> (or <strong>Arduino IDE → Settings</strong> on macOS).
            </li>
            <li>
              In the <strong>Additional Boards Manager URLs</strong> field, paste M5Stack&apos;s official board index URL:
            </li>
          </ol>
          <div className="flex items-center gap-2 p-2 bg-slate-950 border border-slate-800 rounded-lg font-mono text-[11px] text-cyan-300">
            <span className="truncate flex-1">{m5BoardUrl}</span>
            <button
              onClick={handleCopyBoardUrl}
              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-sans font-medium flex items-center gap-1 shrink-0 transition-colors"
            >
              {copiedUrl ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              {copiedUrl ? "Copied" : "Copy URL"}
            </button>
          </div>
          <ol start={3} className="list-decimal list-inside space-y-2 leading-relaxed">
            <li>Click <strong>OK</strong>.</li>
            <li>
              Go to <strong>Tools → Board → Boards Manager...</strong> and search for <strong>&quot;M5Stack&quot;</strong>.
            </li>
            <li>
              Install <strong>M5Stack</strong> version <strong>3.2.5 or newer</strong> (or Espressif <strong>esp32 v3.x</strong> if using generic <em>ESP32S3 Dev Module</em>).
            </li>
          </ol>
        </div>
      ),
    },
    {
      num: 3,
      title: "Install the Required Libraries (M5Unified & TJpg_Decoder)",
      shortDesc: "Only M5Unified (>=0.2.12) and TJpg_Decoder (>=1.1.0) are required—no extra wake/PMIC library needed.",
      content: (
        <div className="space-y-3 text-xs text-slate-300">
          <p>
            In Arduino IDE, open <strong>Sketch → Include Library → Manage Libraries...</strong> (or press <kbd className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 font-mono">Ctrl+Shift+I</kbd> / <kbd className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 font-mono">Cmd+Shift+I</kbd>):
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg space-y-1.5">
              <div className="font-semibold text-orange-400 font-mono">1. M5Unified (v0.2.12+)</div>
              <div className="text-slate-400 text-[11px]">Author: <strong>M5Stack</strong> (Required)</div>
              <div className="text-slate-400 leading-relaxed text-[11px]">
                Search <strong>&quot;M5Unified&quot;</strong> and click <strong>Install All</strong> so <strong>M5GFX (&ge;0.2.18)</strong> is installed together for ST7789P3, BMI270, ES8311, and GPIO 11/12 button support.
              </div>
            </div>
            <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg space-y-1.5">
              <div className="font-semibold text-cyan-400 font-mono">2. TJpg_Decoder (v1.1.0+)</div>
              <div className="text-slate-400 text-[11px]">Author: <strong>Bodmer</strong> (Required)</div>
              <div className="text-slate-400 leading-relaxed text-[11px]">
                Search <strong>&quot;TJpg_Decoder&quot;</strong> and click <strong>Install</strong>. Outputs native RGB565 scanlines into M5GFX&apos;s DMA <code className="text-cyan-300 font-mono">pushImage()</code> for the 135×240 ST7789P3 display.
              </div>
            </div>
          </div>
        </div>
      ),
    },
    {
      num: 4,
      title: "Configure ESP32-S3 Flash, OPI PSRAM & USB CDC",
      shortDesc: "Enable USB CDC On Boot and OPI PSRAM to unlock 8MB Flash + 8MB PSRAM.",
      content: (
        <div className="space-y-3 text-xs text-slate-300">
          <p>Under the <strong>Tools</strong> menu in Arduino IDE, set the following parameters:</p>
          <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg font-mono text-xs space-y-2 text-slate-200">
            <div className="flex items-center justify-between border-b border-slate-900 pb-1.5">
              <span className="text-slate-400">Board:</span>
              <span className="text-orange-400 font-semibold">&quot;M5StickS3&quot; (or &quot;ESP32S3 Dev Module&quot;)</span>
            </div>
            <div className="flex items-center justify-between border-b border-slate-900 pb-1.5">
              <span className="text-slate-400">USB CDC On Boot:</span>
              <span className="text-emerald-400 font-bold">&quot;Enabled&quot; ★</span>
            </div>
            <div className="flex items-center justify-between border-b border-slate-900 pb-1.5">
              <span className="text-slate-400">Flash Size:</span>
              <span className="text-slate-200">8MB (64Mb)</span>
            </div>
            <div className="flex items-center justify-between border-b border-slate-900 pb-1.5">
              <span className="text-slate-400">PSRAM:</span>
              <span className="text-emerald-400 font-bold">&quot;OPI PSRAM&quot; ★</span>
            </div>
            <div className="flex items-center justify-between border-b border-slate-900 pb-1.5">
              <span className="text-slate-400">Partition Scheme:</span>
              <span className="text-cyan-400">&quot;8M with spiffs (3MB APP/1.5MB SPIFFS)&quot; or &quot;Huge APP&quot;</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Upload Speed / Port:</span>
              <span className="text-cyan-400">921600 · Active USB-C COM / ttyACM</span>
            </div>
          </div>
          <div className="text-[11px] text-amber-400/90 bg-amber-500/10 p-2 rounded border border-amber-500/20">
            ★ <strong>Why USB CDC &amp; OPI PSRAM?</strong> Without <em>USB CDC On Boot: Enabled</em>, <code className="font-mono">Serial</code> prints won&apos;t appear over USB-C. Selecting <em>OPI PSRAM</em> enables the 8MB octal PSRAM inside the ESP32-S3-PICO-1-N8R8.
          </div>
        </div>
      ),
    },
    {
      num: 5,
      title: "Upload & Complete First-Boot On-Device Wi-Fi Setup",
      shortDesc: "Flash OlympusAir_M5StickS3.ino, then pair with any Air A01 right from the StickS3 buttons.",
      content: (
        <div className="space-y-3 text-xs text-slate-300">
          <ol className="list-decimal list-inside space-y-2 leading-relaxed">
            <li>
              In Arduino IDE, open the downloaded <span className="font-mono text-orange-400">OlympusAir_M5StickS3.ino</span> (you can leave the placeholder credentials as-is!).
            </li>
            <li>
              Click <strong>Upload</strong> (<span className="text-cyan-400 font-bold">→</span>) and wait for <span className="font-mono text-emerald-400">&quot;Hard resetting via RTS pin...&quot;</span>.
            </li>
            <li>
              <strong>First-Boot 2-Button Wi-Fi Onboarding (Zero-Flicker):</strong>
              <ul className="list-disc list-inside ml-4 mt-1 space-y-1 text-slate-400">
                <li>If no saved Air credentials exist in NVS, M5StickS3 scans <strong>all nearby 2.4GHz APs</strong> (<code className="text-emerald-300 font-mono">AIR-*</code> listed first).</li>
                <li>Press <code className="text-cyan-300 font-mono">Button B</code> (GPIO 12) to step down through APs, and press <code className="text-emerald-300 font-mono">Button A</code> (GPIO 11) to select your AP.</li>
                <li>Enter the camera&apos;s <strong>8-digit numeric passkey</strong>: press or hold <code className="text-cyan-300 font-mono">Button B</code> to increment digits <code className="font-mono">0→9→0</code> (and cycle <em>CONFIRM / EDIT / BACK</em>), and press <code className="text-emerald-300 font-mono">Button A</code> to advance/confirm.</li>
              </ul>
            </li>
            <li>
              <strong>Persistent Saved-Air Search, Deep Sleep RTC &amp; 22-Item Quick Menu:</strong> On future boots, M5StickS3 can optionally attempt BLE Wake (when <strong>BT Wake: ON</strong> and paired via <strong>BT Setup</strong> + 6-digit PIN), then connects via <strong>Static IP .100</strong> + cached Wi-Fi channel. Hold <strong>[B] (&ge;600ms)</strong> on Boot, Wi-Fi/BT setup, or Live View to open the <strong>22-item Quick Menu</strong> (including <strong>Focus Peak</strong>, <strong>Peak Setup &gt;</strong>, <strong>HUD Setup &gt;</strong> above <strong>BT Wake</strong>, <strong>BtnA Mode</strong>, <strong>Wake Key</strong>, <strong>Help &gt;</strong>, and <strong>Sleep: Stick Only / Air + Stick</strong>). On the next shutter press, M5StickS3 syncs its internal ESP32-S3 RTC via <code className="font-mono">/get_imglist.cgi</code> and keeps it alive across <strong>Deep Sleep</strong> (<code className="font-mono">esp_deep_sleep_start()</code>).
            </li>
          </ol>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-800">
          <div>
            <div className="flex items-center gap-2 text-xs text-orange-400 font-mono mb-1">
              <Usb className="w-3.5 h-3.5" />
              <span>Step-by-Step Hardware Upload Walkthrough</span>
            </div>
            <h2 className="text-lg font-bold text-white">How to Flash M5StickS3 (ESP32-S3)</h2>
            <p className="text-xs text-slate-400 mt-1">
              Follow these 5 steps to configure M5Unified + OPI PSRAM and flash your M5StickS3 as an ultra-fast Olympus Air A01 live viewfinder.
            </p>
          </div>

          {/* Quick Stats */}
          <div className="flex items-center gap-4 text-xs font-mono text-slate-400">
            <div className="p-2 rounded bg-slate-950 border border-slate-800">
              <span className="text-slate-500 block text-[10px]">TIME TO FLASH</span>
              <span className="text-slate-200 font-semibold">~4 Minutes</span>
            </div>
            <div className="p-2 rounded bg-slate-950 border border-slate-800">
              <span className="text-slate-500 block text-[10px]">IDE SUPPORT</span>
              <span className="text-slate-200 font-semibold">Arduino 2.x / PlatformIO</span>
            </div>
          </div>
        </div>

        {/* Stepper Timeline */}
        <div className="mt-6 space-y-4">
          {steps.map((s) => (
            <div
              key={s.num}
              className={`rounded-lg border transition-all ${
                activeStep === s.num
                  ? "bg-slate-950/80 border-orange-500/50 shadow-md"
                  : "bg-slate-950/30 border-slate-800/60 hover:border-slate-700"
              }`}
            >
              <button
                onClick={() => setActiveStep(activeStep === s.num ? 0 : s.num)}
                className="w-full flex items-center justify-between p-4 text-left cursor-pointer"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-7 h-7 rounded-full flex items-center justify-center font-mono font-bold text-xs shrink-0 ${
                      activeStep === s.num
                        ? "bg-orange-500 text-white shadow-sm"
                        : "bg-slate-800 text-slate-400"
                    }`}
                  >
                    {s.num}
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-slate-200">{s.title}</h3>
                    <p className="text-xs text-slate-500">{s.shortDesc}</p>
                  </div>
                </div>
                {activeStep === s.num ? (
                  <ChevronDown className="w-4 h-4 text-orange-400" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-slate-500" />
                )}
              </button>

              {activeStep === s.num && (
                <div className="px-4 pb-4 pt-1 border-t border-slate-900">
                  {s.content}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* USB Serial Trace Capture (115200 baud) */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-slate-800">
          <div>
            <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
              <Terminal className="w-4 h-4 text-emerald-400" />
              USB Serial Trace Capture (115200 Baud)
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Captures persistent <code className="text-emerald-300 font-mono">olympus_trace</code> NVS logs (BLE SMP/GATT UUIDs, <code className="font-mono">/get_commandlist.cgi</code>, and RTP extension telemetry) across unplugged boots.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {!serialConnected ? (
              <button
                onClick={() => void connectWebSerial()}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                <Usb className="w-3.5 h-3.5" />
                Connect USB (115200)
              </button>
            ) : (
              <button
                onClick={() => void disconnectWebSerial()}
                className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold transition-colors cursor-pointer"
              >
                Disconnect USB
              </button>
            )}
            <button
              onClick={() => void sendSerialCommand("TRACE")}
              disabled={!serialConnected}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 transition-colors ${
                serialConnected
                  ? "bg-cyan-600 hover:bg-cyan-500 text-white cursor-pointer"
                  : "bg-slate-800 text-slate-500 cursor-not-allowed"
              }`}
              title="Send TRACE command to dump saved NVS trace immediately"
            >
              <Send className="w-3 h-3" />
              Request Saved Trace
            </button>
            <button
              onClick={handleCopyTrace}
              disabled={!serialTraceText}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 transition-colors ${
                serialTraceText
                  ? "bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer"
                  : "bg-slate-800/60 text-slate-600 cursor-not-allowed"
              }`}
            >
              {copiedTrace ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              {copiedTrace ? "Copied" : "Copy Trace"}
            </button>
            <button
              onClick={() => setSerialTraceText("")}
              disabled={!serialTraceText}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 transition-colors ${
                serialTraceText
                  ? "bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer"
                  : "bg-slate-800/60 text-slate-600 cursor-not-allowed"
              }`}
            >
              <Trash2 className="w-3 h-3" />
              Clear
            </button>
          </div>
        </div>

        {serialError && (
          <div className="p-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-300 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{serialError}</span>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[11px] text-slate-300">
          <div className="p-2.5 bg-slate-950 border border-slate-800 rounded-lg">
            <div className="font-semibold text-cyan-300 mb-1">1. Run BLE / Camera Test Unplugged</div>
            Unplug the Air A01&apos;s USB cable so BLE wake is active, run <strong>BT Setup</strong> or boot M5StickS3, then connect over Wi-Fi if needed. Traces auto-save into NVS Flash.
          </div>
          <div className="p-2.5 bg-slate-950 border border-slate-800 rounded-lg">
            <div className="font-semibold text-emerald-300 mb-1">2. Plug StickS3 into PC via USB-C</div>
            Click <strong>Connect USB (115200)</strong> above (or open <strong>Arduino IDE → Tools → Serial Monitor</strong> at <strong>115200 baud</strong>). NVS trace auto-replays on USB connect.
          </div>
          <div className="p-2.5 bg-slate-950 border border-slate-800 rounded-lg">
            <div className="font-semibold text-amber-300 mb-1">3. Copy `[TRACE-BEGIN] ... [TRACE-END]`</div>
            If auto-replay scrolled past, select <strong>Menu → Dump Trace</strong> on the StickS3 or send <code className="font-mono text-cyan-300">TRACE</code>, then click <strong>Copy Trace</strong>.
          </div>
        </div>

        <pre className="w-full h-40 overflow-y-auto p-3 rounded-lg bg-slate-950 border border-slate-800 font-mono text-[11px] text-emerald-300/90 whitespace-pre-wrap break-all">
          {serialTraceText ||
            (webSerialAvailable
              ? "Waiting for USB connection... Click 'Connect USB (115200)' or open Arduino IDE Serial Monitor at 115200 baud."
              : "Web Serial API unavailable in this embedded browser view — open Arduino IDE Serial Monitor (115200 baud) and type TRACE or select Menu -> Dump Trace.")}
        </pre>
      </div>

      {/* Troubleshooting & FAQ Section */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
        <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
          <HelpCircle className="w-4 h-4 text-amber-400" />
          M5StickS3 Hardware Notes &amp; Air A01 Protocol Optimizations
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          {/* Issue 1 */}
          <div className="p-3.5 bg-slate-950 border border-slate-800 rounded-lg space-y-1.5">
            <div className="font-semibold text-rose-400 font-mono">
              &quot;Device reboots on beep / Speaker brownout on battery&quot;
            </div>
            <div className="text-slate-300 leading-relaxed">
              <strong>Cause:</strong> The AW8737 1W cavity speaker amplifier draws high transient current from the 250mAh battery when volume exceeds 75%.
            </div>
            <div className="text-slate-400 leading-relaxed text-[11px] pt-1 border-t border-slate-900">
              <strong>Fix:</strong> The sketch caps <code className="text-emerald-300 font-mono">M5.Speaker.setVolume(140)</code> (~55%) and disables the MEMS microphone to prevent voltage sag during shutter cues.
            </div>
          </div>

          {/* Issue 2 */}
          <div className="p-3.5 bg-slate-950 border border-slate-800 rounded-lg space-y-1.5">
            <div className="font-semibold text-rose-400 font-mono">
              &quot;Pocket-Safe Deep Sleep Wake &amp; 2-Button Flicker-Free UI&quot;
            </div>
            <div className="text-slate-300 leading-relaxed">
              <strong>Pocket-Safe Wake + Zero Flicker:</strong> The active UI runs on <strong>2 buttons only (BtnA + BtnB)</strong> with flicker-free <code className="text-emerald-300 font-mono">M5Canvas</code> sprites and look-ahead scrolling (keeps highlight at the 2nd-to-last row so the next item stays visible). Entering sleep via <strong>5&times;[B]</strong> (on Live View, Boot/Searching, Wi-Fi, or BT screens), <strong>Hold A+B</strong>, or the menu enters <code className="text-cyan-300 font-mono">esp_deep_sleep_start()</code> so ESP32-S3&apos;s internal RTC keeps ticking.
            </div>
            <div className="text-slate-400 leading-relaxed text-[11px] pt-1 border-t border-slate-900">
              <strong>Configurable Wake Key (Default: BTN B):</strong> Pressing the recessed Power Button during sleep hardware-resets M5StickS3 at the PMIC level, so Wake Key uses only ESP32-S3 RTC GPIOs via <code className="font-mono">esp_sleep_enable_ext0_wakeup()</code> / <code className="font-mono">ext1</code>: <code className="font-mono">BTN B</code> (GPIO 12, default — keeps Button A wake OFF), <code className="font-mono">BTN A</code> (GPIO 11), or <code className="font-mono">A+B</code>.
            </div>
          </div>

          {/* Issue 3 */}
          <div className="p-3.5 bg-slate-950 border border-slate-800 rounded-lg space-y-1.5">
            <div className="font-semibold text-rose-400 font-mono">
              &quot;ESP32-S3 port missing or upload times out&quot;
            </div>
            <div className="text-slate-300 leading-relaxed">
              <strong>Cause:</strong> Charge-only USB-C cable, or ESP32-S3 is stuck in deep sleep / USB peripheral conflict.
            </div>
            <div className="text-slate-400 leading-relaxed text-[11px] pt-1 border-t border-slate-900">
              <strong>Fix:</strong> Use a data-rated USB-C cable, ensure <em>USB CDC On Boot: Enabled</em>, or bridge <strong>G0 → GND</strong> on the top Hat2-Bus while plugging in USB-C to force ROM download mode.
            </div>
          </div>

          {/* Issue 4 */}
          <div className="p-3.5 bg-slate-950 border border-slate-800 rounded-lg space-y-1.5">
            <div className="font-semibold text-rose-400 font-mono">
              &quot;Slow Wi-Fi connect, HTTP 520, or wedged Air A01 HTTP server&quot;
            </div>
            <div className="text-slate-300 leading-relaxed">
              <strong>Cause:</strong> DHCP negotiation (~1s), full 13-channel scans, flash stalls during EAPOL, or back-to-back CGI bursts can stall the Air A01&apos;s embedded HTTP server.
            </div>
            <div className="text-slate-400 leading-relaxed text-[11px] pt-1 border-t border-slate-900">
              <strong>Fix (airview + CAMERA_NOTES):</strong> Uses Static IP (<code className="text-emerald-300 font-mono">.100</code>), NVS channel cache (auto-cleared on <code className="font-mono">NO_AP_FOUND</code>), <code className="text-emerald-300 font-mono">WiFi.persistent(false)</code>, <code className="text-cyan-300 font-mono">X-Protocol: OlympusCameraKit</code>, 50ms inter-call gap, and automatic HTTP 520 retry.
            </div>
          </div>

          {/* Issue 5 - Zero-Flicker Live View, Black Screen After Connect & Byte Order */}
          <div className="p-3.5 bg-slate-950 border border-slate-800 rounded-lg space-y-1.5 md:col-span-2">
            <div className="font-semibold text-rose-400 font-mono flex items-center justify-between">
              <span>&quot;VHS screen flicker / 1-2s freezes, black liveview, or JDR:6&quot;</span>
              <span className="text-[10px] bg-rose-950/80 text-rose-300 border border-rose-800/60 px-1.5 py-0.5 rounded">vpCanvas + Triple Buffer</span>
            </div>
            <div className="text-slate-300 leading-relaxed">
              <strong>Offscreen Compositing Sprite (<code className="text-emerald-300 font-mono">vpCanvas</code>):</strong> Instead of drawing JPEG MCU blocks directly over SPI and painting grids/reticles on top (which causes 25Hz VHS flashing), every frame decodes into an offscreen 16-bit <code className="text-emerald-300 font-mono">M5Canvas</code>, composites grid overlays + AF reticle + countdown in RAM, and pushes atomically via <code className="font-mono">vpCanvas.pushSprite()</code> across <strong>3-slot triple-buffered AsyncUDP buffers</strong>. Background battery/prop polls use tight 650ms connect timeouts so dropped HTTP SYNs cannot stall the UI.
            </div>
            <div className="text-slate-300 leading-relaxed text-[11px] pt-1.5 border-t border-slate-900 grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <strong className="text-cyan-400">First-Frame Gate + True RGB565:</strong> Waits for frame #1 + 150ms before applying saved properties (<code className="font-mono">ASPECT_RATIO</code>, <code className="font-mono">TAKEMODE</code>, <code className="font-mono">SOUND_VOLUME_LEVEL</code>, <code className="font-mono">TAKE_DRIVE</code>), pairing <code className="text-emerald-300 font-mono">M5.Display.setSwapBytes(true)</code> + <code className="text-emerald-300 font-mono">TJpgDec.setSwapBytes(false)</code>.
              </div>
              <div>
                <strong className="text-emerald-400">How to Diagnose:</strong> Triple-click <strong>Button B (GPIO 12)</strong> to open the Diagnostics HUD for live <code className="text-slate-300">RAM / PSRAM</code>, <code className="text-slate-300">Pkts / Drop / Hdr</code>, <code className="text-slate-300">JDR</code> decode status, and HTTP codes.
              </div>
            </div>
          </div>

          {/* Issue 6 - Continuous Shooting, 180-deg Cam Gyro & OPC Hardware Limits */}
          <div className="p-3.5 bg-slate-950 border border-slate-800 rounded-lg space-y-1.5">
            <div className="font-semibold text-emerald-400 font-mono">
              &quot;Continuous Shooting, 180° Cam Auto-Flip &amp; OPC Hardware Limits&quot;
            </div>
            <div className="text-slate-300 leading-relaxed">
              <strong>180°-Only Cam Gyro + Dual Lock:</strong> Reads Olympus RTP Extension <code className="text-emerald-300 font-mono">funcId=1</code> strictly for upright vs upside-down (<code className="font-mono">1 ↔ 3</code>) inside <code className="font-mono">vpCanvas</code> (ignoring 90°/270° portrait codes to eliminate cropped bars). Quick Menu exposes <strong>Cam Gyro: AUTO / 180D / LOCK</strong>, and <strong>4×[B]</strong> locks or restores both Stick + Cam gyros together.
            </div>
            <div className="text-slate-400 leading-relaxed text-[11px] pt-1 border-t border-slate-900">
              <strong>Real OPC Limits:</strong> Over public Wi-Fi OPC, <code className="font-mono">SOUND_VOLUME_LEVEL</code> resets on cold Air reboot into standalone (StickS3 saves it in NVS &amp; re-applies right at connect). Air A01 burst runs at fixed ~10fps without arbitrary FPS numbers, and physical Air shutter half-press events are not broadcast over OPC.
            </div>
          </div>

          {/* Issue 7 - Focus Peaking, Deep Sleep RTC, Aspect Ratio & Button Controls */}
          <div className="p-3.5 bg-slate-950 border border-slate-800 rounded-lg space-y-1.5">
            <div className="font-semibold text-cyan-400 font-mono">
              &quot;Focus Peaking (320×240 / 160×120), BtnA Mode &amp; Deep Sleep RTC&quot;
            </div>
            <div className="text-slate-300 leading-relaxed">
              Every frame runs real-time integer Focus Peaking inside the active aspect crop before grids &amp; reticles—decoding the existing <code className="text-cyan-300 font-mono">0320x0240</code> stream at <code className="font-mono">scale=1</code> (<strong>320×240</strong> high-detail default, or <strong>160×120</strong> fast mode in <strong>Peak Setup &gt;</strong>) with 5 colors (<code className="font-mono">RED/YELLOW/GREEN/CYAN/WHITE</code>), 3 thicknesses, and 3 calibrated sensitivities (<code className="font-mono">LOW 156/138</code>, <code className="font-mono">MID 126/111</code>, <code className="font-mono">HIGH 96/84</code>).
            </div>
            <div className="space-y-1 text-[11px] text-slate-400 pt-1 border-t border-slate-900">
              <div>
                <strong className="text-orange-400">Controls:</strong> <strong>1×[B]</strong> cycles Aspect; <strong>2×[B]</strong> cycles Mode; <strong>3×[B]</strong> toggles Diag; <strong>4×[B]</strong> toggles Dual-Gyro Lock; <strong>5×[B]</strong> sleeps Air + StickS3 (works on Live View, Wi-Fi, Boot &amp; BT screens); <strong>Hold [B] (&ge;600ms)</strong> opens the 22-item <strong>Quick Menu</strong> with look-ahead scrolling (and immediately exits submenus like <strong>Peak Setup &gt;</strong>, <strong>HUD Setup &gt;</strong>, and <strong>Help &gt;</strong> before button release); <strong>BtnA Mode</strong> switches <strong>[A]</strong> between Shutter and Focus Peaking toggle; inside <strong>Help &gt;</strong>, <strong>[A]</strong> pages up and <strong>[B]</strong> pages down.
              </div>
              <div>
                <strong className="text-cyan-400">Deep Sleep RTC &amp; 2015 Alert:</strong> <code className="font-mono">RTC_DATA_ATTR</code> + <code className="font-mono">time(nullptr)</code> preserve the synced clock across <strong>Deep Sleep</strong> (<strong>5×[B]</strong>, <strong>Hold A+B</strong>, and Menu Sleep). If Air returns year <strong>2015</strong>, StickS3 sounds an alert and flashes <code className="text-rose-300 font-mono">2015!</code>.
              </div>
            </div>
          </div>

          {/* Issue 8 - Dual Battery Monitoring & Bluetooth BLE Wake */}
          <div className="p-3.5 bg-slate-950 border border-slate-800 rounded-lg space-y-1.5 md:col-span-2">
            <div className="font-semibold text-purple-400 font-mono flex items-center justify-between flex-wrap gap-2">
              <span>&quot;Bluetooth BLE Auto-Wake (6-Digit Passkey), Single-Bond Limit &amp; NVS Trace&quot;</span>
              <span className="text-[10px] bg-sky-950/80 text-sky-300 border border-sky-800/60 px-1.5 py-0.5 rounded">BT Wake + S3/Air BAT</span>
            </div>
            <div className="text-slate-300 leading-relaxed">
              The <strong>BT Setup</strong> wizard scans nearby BLE devices (<code className="text-emerald-300 font-mono">AIR-*</code> sorted first), accepts the camera&apos;s <strong>6-digit numeric passkey</strong> (<code className="font-mono">[B]</code> increments <code className="font-mono">0→9</code>, <code className="font-mono">[A]</code> confirms), logs SMP status (<code className="font-mono">BOND OK</code> vs <code className="font-mono">AUTH FAIL 0xXX</code>) + GATT characteristics/notifications to persistent NVS flash (<code className="font-mono">olympus_trace</code>), and checks <code className="font-mono">/get_commandlist.cgi</code> so shutdown uses <code className="font-mono">/exec_pwoff.cgi?mode=withble</code> when supported (with zero trailing CGIs).
            </div>
            <div className="text-slate-400 leading-relaxed text-[11px] pt-1 border-t border-slate-900">
              <strong>Important Air A01 BLE Notes:</strong> Air A01 stores only <strong>one active BLE central bond</strong> and does not respond to BLE wake while its USB charging cable is plugged in. Unpair/Forget the Air A01 on your phone &amp; toggle phone Bluetooth OFF before pairing StickS3. If StickS3 shows <code className="text-rose-300 font-mono">AUTH FAIL</code>, power off the Air, remove its microSD card, hold <strong>Lens Release + Shutter + Power (~2s)</strong> until LEDs flash to reset wireless/BT info, re-insert the microSD card, and run <strong>BT Setup</strong> again.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
