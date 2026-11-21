import React, { useState } from "react";
import { 
  Copy, 
  Check, 
  Download, 
  FileCode, 
  Settings2, 
  Terminal, 
  BookOpen, 
  Cpu, 
  ShieldCheck, 
  ExternalLink 
} from "lucide-react";
import { 
  GeneratorConfig, 
  generateArduinoSketch, 
  generateConfigHeader, 
  generatePlatformIoIni,
  OLYMPUS_API_DOCS
} from "../data/arduinoCode";

interface CodeWorkbenchProps {
  config: GeneratorConfig;
  onChangeConfig: (newCfg: GeneratorConfig) => void;
}

export const CodeWorkbench: React.FC<CodeWorkbenchProps> = ({ config, onChangeConfig }) => {
  const [activeTab, setActiveTab] = useState<"ino" | "config" | "platformio" | "docs">("ino");
  const [copied, setCopied] = useState(false);

  const arduinoSketchCode = generateArduinoSketch(config);
  const configHeaderCode = generateConfigHeader(config);
  const platformIoCode = generatePlatformIoIni();

  const getCurrentCode = () => {
    switch (activeTab) {
      case "ino": return arduinoSketchCode;
      case "config": return configHeaderCode;
      case "platformio": return platformIoCode;
      default: return "";
    }
  };

  const getFileName = () => {
    switch (activeTab) {
      case "ino": return "OlympusAir_M5StickS3.ino";
      case "config": return "config.h";
      case "platformio": return "platformio.ini";
      default: return "docs.md";
    }
  };

  const handleCopy = () => {
    const text = getCurrentCode();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const text = getCurrentCode();
    const filename = getFileName();
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Parameter Customizer Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-orange-400" />
            <h3 className="text-sm font-semibold text-slate-200">Hardware & Firmware Configuration</h3>
          </div>
          <span className="text-xs text-slate-400">Live code updates automatically</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
          {/* SSID Input */}
          <div>
            <label className="block text-slate-400 mb-1 font-medium">Camera Wi-Fi SSID</label>
            <input
              type="text"
              value={config.wifiSsid}
              onChange={(e) => onChangeConfig({ ...config, wifiSsid: e.target.value })}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 font-mono focus:outline-none focus:border-orange-500"
              placeholder="AIR-A01-12345678"
            />
          </div>

          {/* Wi-Fi Password */}
          <div>
            <label className="block text-slate-400 mb-1 font-medium">WPA2 Password</label>
            <input
              type="text"
              value={config.wifiPass}
              onChange={(e) => onChangeConfig({ ...config, wifiPass: e.target.value })}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 font-mono focus:outline-none focus:border-orange-500"
              placeholder="Found on camera hatch"
            />
          </div>

          {/* Screen Rotation */}
          <div>
            <label className="block text-slate-400 mb-1 font-medium">Display Rotation</label>
            <select
              value={config.rotation}
              onChange={(e) => onChangeConfig({ ...config, rotation: Number(e.target.value) })}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 font-mono focus:outline-none focus:border-orange-500"
            >
              <option value={1}>Landscape (240x135) Button-Aligned - Recommended</option>
              <option value={3}>Landscape Flipped 180&deg; (240x135)</option>
              <option value={0}>Portrait (135x240)</option>
              <option value={2}>Portrait Flipped 180&deg; (135x240)</option>
            </select>
          </div>

          {/* Live View Quality */}
          <div>
            <label className="block text-slate-400 mb-1 font-medium">Stream Resolution</label>
            <select
              value={config.liveViewQuality}
              onChange={(e) => onChangeConfig({ ...config, liveViewQuality: e.target.value })}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 font-mono focus:outline-none focus:border-orange-500"
            >
              <option value="0320x0240">320x240 (Fast / Low Latency)</option>
              <option value="0640x0480">640x480 (High Detail)</option>
            </select>
          </div>

          {/* JPEG Hardware Scale */}
          <div>
            <label className="block text-slate-400 mb-1 font-medium">JPEG Scale Factor</label>
            <select
              value={config.jpegScale}
              onChange={(e) => onChangeConfig({ ...config, jpegScale: Number(e.target.value) })}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 font-mono focus:outline-none focus:border-orange-500"
            >
              <option value={2}>Scale 2: 1/2 (160x120) - Recommended ★</option>
              <option value={1}>Scale 1: 1:1 (320x240)</option>
              <option value={4}>Scale 4: 1/4 (80x60)</option>
            </select>
          </div>

          {/* Default Aspect Ratio */}
          <div>
            <label className="block text-slate-400 mb-1 font-medium">Default Aspect Ratio</label>
            <select
              value={config.defaultAspectRatio || "16:9"}
              onChange={(e) => onChangeConfig({ ...config, defaultAspectRatio: e.target.value })}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 font-mono focus:outline-none focus:border-orange-500"
            >
              <option value="16:9">16:9 (Widescreen Video) - Default</option>
              <option value="4:3">4:3 (Native Micro 4/3)</option>
              <option value="3:2">3:2 (35mm Photo Format)</option>
              <option value="1:1">1:1 (Square Format / OPC 6:6)</option>
            </select>
          </div>

          {/* Default Shooting Mode */}
          <div>
            <label className="block text-slate-400 mb-1 font-medium">Default Shooting Mode</label>
            <select
              value={config.defaultShootingMode || "AUTO"}
              onChange={(e) =>
                onChangeConfig({
                  ...config,
                  defaultShootingMode: e.target.value as "AUTO" | "A_WIDE" | "S_60",
                })
              }
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 font-mono focus:outline-none focus:border-orange-500"
            >
              <option value="AUTO">Standard Automatic (iAUTO)</option>
              <option value="A_WIDE">Aperture Priority (Widest Lens F-Stop)</option>
              <option value="S_60">Shutter Priority (1/60s Slowest)</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4 pt-3 border-t border-slate-800/60 text-xs">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="autoScan"
              checked={config.autoScanAir}
              onChange={(e) => onChangeConfig({ ...config, autoScanAir: e.target.checked })}
              className="rounded bg-slate-950 border-slate-800 text-orange-500 focus:ring-0"
            />
            <label htmlFor="autoScan" className="text-slate-300 cursor-pointer">
              Launch All-AP Setup Wizard on first boot
            </label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="debugSerial"
              checked={config.debugSerial}
              onChange={(e) => onChangeConfig({ ...config, debugSerial: e.target.checked })}
              className="rounded bg-slate-950 border-slate-800 text-orange-500 focus:ring-0"
            />
            <label htmlFor="debugSerial" className="text-slate-300 cursor-pointer">
              Serial Debugging (115200 baud)
            </label>
          </div>

          <div className="text-slate-400 flex items-center justify-end font-mono">
            Triple Buffer: 3 &times; {config.liveViewQuality === "0640x0480" ? 48 : 36} KB + vpCanvas
          </div>
        </div>
      </div>

      {/* Code Editor & Documentation Tabs */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        {/* Tab Header Bar */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-slate-950 border-b border-slate-800">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setActiveTab("ino")}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                activeTab === "ino" ? "bg-slate-800 text-orange-400 shadow-sm" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <FileCode className="w-3.5 h-3.5" />
              OlympusAir_M5StickS3.ino
            </button>
            <button
              onClick={() => setActiveTab("config")}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                activeTab === "config" ? "bg-slate-800 text-orange-400 shadow-sm" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <FileCode className="w-3.5 h-3.5" />
              config.h
            </button>
            <button
              onClick={() => setActiveTab("platformio")}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                activeTab === "platformio" ? "bg-slate-800 text-orange-400 shadow-sm" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Terminal className="w-3.5 h-3.5" />
              platformio.ini
            </button>
            <button
              onClick={() => setActiveTab("docs")}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                activeTab === "docs" ? "bg-slate-800 text-orange-400 shadow-sm" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" />
              Setup Guide & Pinout
            </button>
          </div>

          {activeTab !== "docs" && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition-colors"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? "Copied!" : "Copy Code"}
              </button>
              <button
                onClick={handleDownload}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-xs font-medium transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Download {getFileName()}
              </button>
            </div>
          )}
        </div>

        {/* Tab Content */}
        {activeTab === "docs" ? (
          <div className="p-6 space-y-6 text-sm text-slate-300">
            {/* 1. Required Libraries */}
            <div className="space-y-3">
              <h4 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-orange-400" />
                Required Arduino Libraries
              </h4>
              <p className="text-slate-400 text-xs leading-relaxed">
                Open Arduino IDE, go to <strong className="text-slate-200">Tools → Manage Libraries...</strong> and install:
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                  <div className="font-semibold text-orange-400 font-mono">1. M5Unified (+ M5GFX)</div>
                  <div className="text-slate-400 mt-1">Author: M5Stack (v0.2.12+)</div>
                  <div className="text-slate-500 mt-0.5">Unified driver for ST7789P3 LCD, BMI270 IMU, ES8311 speaker, and GPIO 11/12 buttons.</div>
                </div>
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                  <div className="font-semibold text-orange-400 font-mono">2. TJpg_Decoder</div>
                  <div className="text-slate-400 mt-1">Author: Bodmer (v1.1.0+)</div>
                  <div className="text-slate-500 mt-0.5">Baseline JPEG decoder for ESP32-S3 feeding native RGB565 scanlines into M5GFX DMA pushImage.</div>
                </div>
              </div>
            </div>

            {/* 2. Board Configuration */}
            <div className="space-y-3">
              <h4 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                <Terminal className="w-4 h-4 text-cyan-400" />
                Arduino IDE Board Settings (M5StickS3)
              </h4>
              <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs space-y-1.5 text-slate-300">
                <div><span className="text-slate-500">Board:</span> &quot;M5StickS3&quot; (M5Stack Board Manager v3.2.5+ or &quot;ESP32S3 Dev Module&quot;)</div>
                <div><span className="text-slate-500">USB CDC On Boot:</span> &quot;Enabled&quot; (required for USB-C Serial Monitor)</div>
                <div><span className="text-slate-500">Flash Size / PSRAM:</span> 8MB (64Mb) / &quot;OPI PSRAM&quot;</div>
                <div><span className="text-slate-500">Upload Speed:</span> 921600 (or 460800)</div>
                <div><span className="text-slate-500">CPU / Flash Frequency:</span> 240MHz (WiFi) / 80MHz</div>
                <div><span className="text-slate-500">Partition Scheme:</span> &quot;8M with spiffs (3MB APP/1.5MB SPIFFS)&quot; or &quot;Huge APP&quot;</div>
              </div>
            </div>

            {/* 3. Olympus Air A01 CGI API Reference */}
            <div className="space-y-3">
              <h4 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                Olympus Air A01 Protocol & CGI Endpoints
              </h4>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border border-slate-800 rounded-lg overflow-hidden">
                  <thead className="bg-slate-950 text-slate-400 font-mono">
                    <tr>
                      <th className="p-2.5">Method</th>
                      <th className="p-2.5">Endpoint</th>
                      <th className="p-2.5">Function</th>
                      <th className="p-2.5">Response</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono text-slate-300">
                    {OLYMPUS_API_DOCS.map((doc, idx) => (
                      <tr key={idx} className="hover:bg-slate-950/40">
                        <td className="p-2.5 text-cyan-400 font-semibold">{doc.method}</td>
                        <td className="p-2.5 text-orange-300">{doc.endpoint}</td>
                        <td className="p-2.5 font-sans text-slate-300">{doc.purpose}</td>
                        <td className="p-2.5 text-slate-400">{doc.response}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 4. Hardware Pinout */}
            <div className="space-y-3">
              <h4 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-purple-400" />
                M5StickS3 (ESP32-S3) Pinout Reference
              </h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs font-mono">
                <div className="p-2.5 rounded bg-slate-950 border border-slate-800">
                  <div className="text-slate-500 text-[10px]">TFT Display (ST7789P3)</div>
                  <div className="text-slate-200 font-semibold">MOSI: G39 / SCLK: G40</div>
                  <div className="text-slate-400">CS:41 / DC:45 / RST:21 / BL:38</div>
                </div>
                <div className="p-2.5 rounded bg-slate-950 border border-slate-800">
                  <div className="text-slate-500 text-[10px]">Button A (M5 Front)</div>
                  <div className="text-slate-200 font-semibold">GPIO 11 (Active LOW)</div>
                  <div className="text-emerald-400 text-[11px] mt-0.5">Shutter/Burst OR Focus Peak Toggle (BtnA Mode)</div>
                </div>
                <div className="p-2.5 rounded bg-slate-950 border border-slate-800">
                  <div className="text-slate-500 text-[10px]">Button B (Side Edge)</div>
                  <div className="text-slate-200 font-semibold">GPIO 12 (Active LOW)</div>
                  <div className="text-orange-400 text-[11px] mt-0.5">1x:Asp | 2x:Mode | 3x:Diag | 5x:Sleep | Hold:Menu</div>
                </div>
                <div className="p-2.5 rounded bg-slate-950 border border-slate-800">
                  <div className="text-slate-500 text-[10px]">Wake Key, Sleep &amp; Sensors</div>
                  <div className="text-slate-200 font-semibold">Wake: BTN B / BTN A / A+B · Hold A+B: Sleep</div>
                  <div className="text-slate-400 text-[11px] mt-0.5">5x[B] Wi-Fi/Live Sleep | BMI270 | ES8311 | RTC Alive</div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="relative">
            <pre className="p-4 text-xs font-mono text-slate-200 overflow-x-auto max-h-[620px] leading-relaxed select-text">
              <code>{getCurrentCode()}</code>
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};
