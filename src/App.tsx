import React, { useState } from "react";
import { 
  Download, 
  ExternalLink, 
  Layers, 
  Terminal, 
  Code2, 
  Sparkles, 
  Cpu, 
  Camera, 
  Wifi, 
  Check 
} from "lucide-react";
import { M5StickEmulator } from "./components/M5StickEmulator";
import { CodeWorkbench } from "./components/CodeWorkbench";
import { UploadGuide } from "./components/UploadGuide";
import { 
  DEFAULT_CONFIG, 
  GeneratorConfig, 
  generateArduinoSketch 
} from "./data/arduinoCode";

export default function App() {
  const [config, setConfig] = useState<GeneratorConfig>(DEFAULT_CONFIG);
  const [activeView, setActiveView] = useState<"emulator" | "code" | "guide">("emulator");
  const [copiedQuick, setCopiedQuick] = useState(false);

  const handleDownloadIno = () => {
    const code = generateArduinoSketch(config);
    const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "OlympusAir_M5StickS3.ino";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleCopyIno = () => {
    const code = generateArduinoSketch(config);
    navigator.clipboard.writeText(code);
    setCopiedQuick(true);
    setTimeout(() => setCopiedQuick(false), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* 1. TOP BAR (Strict 3-Zone Contract) */}
      <header className="flex items-center justify-between gap-8 px-6 py-4 border-b border-slate-800 bg-slate-950/90 backdrop-blur sticky top-0 z-50">
        {/* Zone 1: Single Brand Wordmark */}
        <a 
          href="#home" 
          onClick={(e) => { e.preventDefault(); setActiveView("emulator"); }}
          className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0 flex items-center gap-2"
        >
          <Camera className="w-5 h-5 text-orange-500" />
          <span>Olympus Air Viewfinder</span>
        </a>

        {/* Zone 2: 4-5 Clean Single-Line Nav Links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
          <button
            onClick={() => setActiveView("emulator")}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              activeView === "emulator" ? "text-orange-400 font-semibold" : ""
            }`}
          >
            Live Hardware Emulator
          </button>
          <button
            onClick={() => setActiveView("code")}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              activeView === "code" ? "text-orange-400 font-semibold" : ""
            }`}
          >
            Arduino C++ Code
          </button>
          <button
            onClick={() => setActiveView("guide")}
            className={`hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              activeView === "guide" ? "text-orange-400 font-semibold" : ""
            }`}
          >
            Flashing Guide & Pinout
          </button>
          <a
            href="https://github.com/m5stack/M5Unified"
            target="_blank"
            rel="noreferrer noopener"
            className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1"
          >
            M5Unified Library <ExternalLink className="w-3 h-3 text-slate-500" />
          </a>
        </nav>

        {/* Zone 3: 1 Primary Action */}
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            onClick={handleCopyIno}
            className="hidden sm:flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            {copiedQuick ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Code2 className="w-3.5 h-3.5" />}
            {copiedQuick ? "Copied" : "Copy .ino"}
          </button>
          <button
            onClick={handleDownloadIno}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-500 rounded-lg transition-colors whitespace-nowrap shrink-0 shadow-sm"
          >
            <Download className="w-3.5 h-3.5" />
            Download .ino Sketch
          </button>
        </div>
      </header>

      {/* Hero Header & Metadata Strip */}
      <div className="border-b border-slate-800/80 bg-slate-900/40 px-6 py-6">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs text-slate-400 mb-1.5 font-mono flex-wrap">
              <span>ESP32-S3-PICO-1-N8R8</span>
              <span aria-hidden="true">·</span>
              <span>8MB OPI PSRAM</span>
              <span aria-hidden="true">·</span>
              <span>ST7789P3 TFT 135x240</span>
              <span aria-hidden="true">·</span>
              <span>M5Unified + TJpgDec</span>
            </div>
            <h1 className="text-xl md:text-2xl font-bold tracking-tight text-white">
              Olympus Air A01 Live Viewfinder for M5StickS3
            </h1>
            <p className="text-xs md:text-sm text-slate-400 mt-1 max-w-3xl">
              Production-ready Arduino C++ firmware connecting M5StickS3 (ESP32-S3) to the Olympus Air A01 camera over Wi-Fi, executing HTTP CGI initialization, and rendering tear-free RTP/MJPEG video via AsyncUDP and M5Unified.
            </p>
          </div>

          {/* View Mode Switcher */}
          <div className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg shrink-0">
            <button
              onClick={() => setActiveView("emulator")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                activeView === "emulator" ? "bg-slate-800 text-orange-400 shadow-sm" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Hardware Emulator
            </button>
            <button
              onClick={() => setActiveView("code")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                activeView === "code" ? "bg-slate-800 text-orange-400 shadow-sm" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              C++ Source Code
            </button>
            <button
              onClick={() => setActiveView("guide")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                activeView === "guide" ? "bg-slate-800 text-orange-400 shadow-sm" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Setup & Flashing
            </button>
          </div>
        </div>
      </div>

      {/* Main Workbench Body */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6">
        {activeView === "emulator" && (
          <div className="space-y-6">
            <M5StickEmulator config={config} />
          </div>
        )}

        {activeView === "code" && (
          <div className="space-y-6">
            <CodeWorkbench config={config} onChangeConfig={setConfig} />
          </div>
        )}

        {activeView === "guide" && (
          <div className="space-y-8">
            {/* Interactive Step-by-Step Upload Guide */}
            <UploadGuide />

            {/* Architecture & Parsing Deep Dive */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
              <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                <Terminal className="w-4 h-4 text-orange-400" />
                How the AsyncUDP RTP/MJPEG Stream Extraction Works
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                When <span className="font-mono text-orange-300">GET /exec_takemisc.cgi?com=startliveview&port=5555</span> is invoked, the Olympus Air A01 broadcasts RTP-framed MJPEG packets to UDP port 5555. The M5StickS3 parses RFC 3550 headers and decodes frames into the ST7789P3 display using M5GFX.
              </p>
              
              <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 font-mono text-xs text-slate-300 space-y-2">
                <div className="text-slate-500">// AsyncUDP + RFC 3550 Ping-Pong State Machine:</div>
                <div>1. <span className="text-cyan-400">onRtpPacket()</span> strips RTP padding (P bit), CSRC list, and parses Extension Headers (ID 5/8/9/12/16)</div>
                <div>2. Start-Of-Image (<span className="text-emerald-400">0xFF 0xD8</span>) begins assembling into ping-pong slot (<span className="text-cyan-400">frameBuf[2]</span>)</div>
                <div>3. RTP Marker bit (<span className="text-emerald-400">M == 1</span>) &amp; End-Of-Image (<span className="text-emerald-400">0xFF 0xD9</span>) commit the completed JPEG frame</div>
                <div>4. <span className="text-orange-400">TJpgDec.drawJpg(0, 0, frameBuf[slot], len)</span> decodes native RGB565 scanlines</div>
                <div>5. <span className="text-cyan-400">M5.Display.pushImage()</span> blits 16-bit pixels into the ST7789P3 controller via ESP32-S3 SPI DMA</div>
              </div>
            </div>

            {/* Code embed in guide */}
            <CodeWorkbench config={config} onChangeConfig={setConfig} />
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800 py-6 px-6 text-center text-xs text-slate-500 font-mono">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>Olympus Air A01 (OPC SDK) · M5StickS3 (ESP32-S3-PICO-1-N8R8)</span>
          <span>MIT License · Production Firmware & Emulator</span>
        </div>
      </footer>
    </div>
  );
}
