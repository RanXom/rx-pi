/**
 * dictate-local — local push-to-talk dictation for pi.
 *
 * Backend: ffmpeg/arecord capture -> sherpa-onnx Whisper (small.en, int8),
 * already on disk from opencode-voice. No network, no API keys.
 * Frontend: native pi status row, focus-aware delivery into whatever input
 * has keyboard focus. The delivery technique is adapted from pi-dictate
 * (MIT, Amos Blomqvist); the recognition backend follows opencode-voice
 * (MIT, JuliusKB).
 *
 * Usage: alt+m toggles recording, alt+n cancels. `/dictate` does the same
 * from the command palette, `/dictate-unload` frees the model now.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";

const STATUS_KEY = "dictate";
const EXT_DIR = dirname(new URL(import.meta.url).pathname);
const DAEMON = join(EXT_DIR, "transcribe-daemon.cjs");
const CONFIG = join(homedir(), ".pi", "agent", "dictate.json");

interface Settings {
  modelDir: string;
  recorder: "ffmpeg" | "arecord";
  threads: number;
  idleUnloadMinutes: number;
  maxSeconds: number;
  meter: boolean;
}

const DEFAULTS: Settings = {
  modelDir: "~/.local/share/opencode-voice/models/sherpa-onnx-whisper-small.en",
  recorder: "ffmpeg",
  threads: 8,
  idleUnloadMinutes: 10,
  maxSeconds: 60,
  meter: true,
};

function expand(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function loadSettings(): Settings {
  try {
    if (!existsSync(CONFIG)) {
      mkdirSync(dirname(CONFIG), { recursive: true });
      writeFileSync(CONFIG, JSON.stringify(DEFAULTS, null, 2) + "\n");
      return { ...DEFAULTS };
    }
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

const settings = loadSettings();

// The standalone release runs on Bun and has no node binary to spawn, so the
// model is loaded in-process there. The npm install keeps using the daemon.
const IS_BUN = Boolean((process.versions as any).bun);
const requireFromExtension = createRequire(import.meta.url);

let inlineRecognizer: any = null;
let inlineLoadMs = 0;

function modelFile(files: string[], needle: string, suffix: string): string | undefined {
  const hit = files.find((file) => file.includes(needle) && file.endsWith(suffix));
  return hit ? join(expand(settings.modelDir), hit) : undefined;
}

function loadInlineRecognizer(): any {
  if (inlineRecognizer) return inlineRecognizer;
  const started = Date.now();
  const sr = requireFromExtension("sherpa-onnx-node");
  const dir = expand(settings.modelDir);
  const files = readdirSync(dir);
  const encoder = modelFile(files, "encoder", ".onnx");
  const decoder = modelFile(files, "decoder", ".onnx");
  const tokens = modelFile(files, "tokens", ".txt");
  if (!encoder || !decoder || !tokens) throw new Error(`no Whisper model files in ${dir}`);
  inlineRecognizer = new sr.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: { encoder, decoder, language: "en", task: "transcribe", tailPaddings: 1000 },
      tokens,
      numThreads: settings.threads || 4,
      debug: 0,
      provider: "cpu",
    },
  });
  inlineLoadMs = Date.now() - started;
  return inlineRecognizer;
}

function transcribeInline(wavPath: string): string {
  const recognizer = loadInlineRecognizer();
  const sr = requireFromExtension("sherpa-onnx-node");
  const wav = sr.readWave(wavPath);
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: 16000, samples: wav.samples });
  recognizer.decode(stream);
  return String(recognizer.getResult(stream).text || "").trim();
}

// ── delivery target (adapted from pi-dictate, MIT) ──────────────────────────
interface EditorLike {
  getText(): string;
  setText(text: string): void;
}
type Target =
  | { kind: "editor"; editor: EditorLike }
  | { kind: "typable"; component: { handleInput(data: string): void } };

const asEditorLike = (value: any): EditorLike | null =>
  value && typeof value.getText === "function" && typeof value.setText === "function" ? value : null;

const METER_CELLS = 6;
const PEAK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function rmsOfPcm16(buf: Buffer): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const s = buf.readInt16LE(i) / 32768;
    sum += s * s;
    count++;
  }
  return count ? Math.sqrt(sum / count) : 0;
}

function bars(rms: number): string {
  if (rms <= 0.0015) return "";
  const db = 20 * Math.log10(rms);
  const norm = Math.max(0, Math.min(1, (db + 50) / 40));
  const filled = Math.max(1, Math.round(norm * METER_CELLS));
  return PEAK_BLOCKS[Math.min(PEAK_BLOCKS.length - 1, Math.round(norm * (PEAK_BLOCKS.length - 1)))].repeat(filled);
}

export default function dictateLocal(pi: ExtensionAPI) {
  let state: "idle" | "recording" | "finalizing" = "idle";
  let recorder: ChildProcess | null = null;
  let wavPath = "";
  let meterTimer: NodeJS.Timeout | null = null;
  let capTimer: NodeJS.Timeout | null = null;
  let spinnerTimer: NodeJS.Timeout | null = null;
  let spinnerFrame = 0;
  let startedAt = 0;
  let cancelled = false;
  let activeCtx: ExtensionContext | null = null;
  let tuiHandle: any = null;
  let removeInputListener: (() => void) | null = null;

  // ── transcription daemon ────────────────────────────────────────────────
  let daemon: ChildProcess | null = null;
  let daemonBuffer = "";
  let daemonReady: Promise<void> | null = null;
  let pending: { resolve: (v: { ok: boolean; text?: string; error?: string }) => void } | null = null;
  let idleTimer: NodeJS.Timeout | null = null;

  const setStatus = (text: string | undefined) => {
    try {
      activeCtx?.ui.setStatus(STATUS_KEY, text);
    } catch {
      /* ignore */
    }
  };

  const killDaemon = () => {
    inlineRecognizer = null;
    inlineLoadMs = 0;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    pending = null;
    daemonReady = null;
    daemonBuffer = "";
    if (daemon) {
      try {
        daemon.stdin?.end();
        daemon.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      daemon = null;
    }
  };

  const unloadNow = () => {
    killDaemon();
    // Bun keeps the ONNX buffers until a collection; nudge it after each take.
    try {
      (globalThis as { Bun?: { gc?: (force?: boolean) => void } }).Bun?.gc?.(true);
    } catch {
      /* ignore */
    }
  };

  const touchIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (settings.idleUnloadMinutes <= 0) return;
    idleTimer = setTimeout(killDaemon, settings.idleUnloadMinutes * 60_000);
    idleTimer.unref?.();
  };

  const ensureDaemon = (): Promise<void> => {
    if (daemonReady) return daemonReady;
    if (!existsSync(DAEMON)) return Promise.reject(new Error(`missing ${DAEMON}`));
    daemonReady = new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [DAEMON, expand(settings.modelDir), String(settings.threads)], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      daemon = child;
      const timer = setTimeout(() => reject(new Error("transcriber did not start within 15s")), 15_000);
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        daemonBuffer += chunk;
        let index: number;
        while ((index = daemonBuffer.indexOf("\n")) >= 0) {
          const line = daemonBuffer.slice(0, index).trim();
          daemonBuffer = daemonBuffer.slice(index + 1);
          if (!line) continue;
          let message: any;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.ready) {
            clearTimeout(timer);
            resolve();
            continue;
          }
          const waiter = pending;
          pending = null;
          waiter?.resolve(message);
        }
      });
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", () => {});
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", () => {
        clearTimeout(timer);
        daemon = null;
        daemonReady = null;
        daemonBuffer = "";
      });
    });
    return daemonReady;
  };

  const transcribe = async (wav: string): Promise<string> => {
    if (IS_BUN) return transcribeInline(wav);
    await ensureDaemon();
    if (!daemon) throw new Error("transcriber not running");
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = null;
        reject(new Error("transcription timed out"));
      }, 120_000);
      pending = {
        resolve: (message) => {
          clearTimeout(timer);
          if (!message.ok) reject(new Error(message.error || "transcription failed"));
          else resolve(message.text || "");
        },
      };
      daemon!.stdin!.write(JSON.stringify({ wav }) + "\n");
    });
  };

  // ── delivery ────────────────────────────────────────────────────────────
  const resolveTarget = (): Target | null => {
    const focused = tuiHandle?.focusedComponent;
    if (!focused) return null;
    const editor = asEditorLike(focused) ?? asEditorLike(focused.editor);
    if (editor) return { kind: "editor", editor };
    if (typeof focused.handleInput === "function") return { kind: "typable", component: focused };
    return null;
  };

  const deliver = (text: string) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) {
      activeCtx?.ui.notify("Heard nothing.", "warning");
      return;
    }
    if (tuiHandle) {
      const target = resolveTarget();
      if (target?.kind === "editor") {
        const current = target.editor.getText() ?? "";
        const sep = current && !/\s$/.test(current) ? " " : "";
        target.editor.setText(current + sep + clean);
        tuiHandle.requestRender?.();
        return;
      }
      if (target?.kind === "typable") {
        target.component.handleInput(clean);
        tuiHandle.requestRender?.();
        return;
      }
    }
    if (activeCtx) {
      const current = activeCtx.ui.getEditorText() ?? "";
      const sep = current && !/\s$/.test(current) ? " " : "";
      activeCtx.ui.setEditorText(current + sep + clean);
    } else {
      activeCtx?.ui.notify("Transcript ready but no editor available.", "warning");
    }
  };

  // ── capture ─────────────────────────────────────────────────────────────
  const clearStatusTimers = () => {
    if (meterTimer) clearInterval(meterTimer);
    if (spinnerTimer) clearInterval(spinnerTimer);
    if (capTimer) clearTimeout(capTimer);
    meterTimer = null;
    spinnerTimer = null;
    capTimer = null;
  };

  const startMeter = () => {
    if (!settings.meter) return;
    let ring: string[] = [];
    meterTimer = setInterval(() => {
      if (state !== "recording") return;
      let size = 0;
      try {
        size = statSync(wavPath).size;
      } catch {
        return;
      }
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      let level = "";
      const start = Math.max(44, size - 3200);
      const length = size - start;
      if (length >= 2) {
        try {
          const fd = openSync(wavPath, "r");
          const buf = Buffer.alloc(length - (length % 2));
          readSync(fd, buf, 0, buf.length, start);
          closeSync(fd);
          level = bars(rmsOfPcm16(buf));
        } catch {
          /* ignore */
        }
      }
      ring = [...ring, level].slice(-METER_CELLS);
      const meter = ring.join("").padEnd(METER_CELLS, " ");
      setStatus(`● ${meter} listening… ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);
    }, 120);
  };

  const recorderCommand = () => {
    if (settings.recorder === "arecord") {
      return { bin: "arecord", args: ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", wavPath] };
    }
    return {
      bin: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "pulse",
        "-i",
        "default",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-flush_packets",
        "1",
        "-y",
        wavPath,
      ],
    };
  };

  const startRecording = async (ctx: ExtensionContext) => {
    if (state !== "idle") return;
    activeCtx = ctx;
    cancelled = false;
    state = "recording";
    startedAt = Date.now();
    wavPath = join(tmpdir(), `pi-dictate-${Date.now()}.wav`);

    // Warm the model while the user talks; ignore readiness here.
    if (IS_BUN) {
      try {
        loadInlineRecognizer();
      } catch (error: any) {
        ctx.ui.notify(`Transcriber: ${error.message}`, "warning");
      }
    } else {
      ensureDaemon().catch((error) => ctx.ui.notify(`Transcriber: ${error.message}`, "warning"));
    }

    const { bin, args } = recorderCommand();
    try {
      recorder = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error: any) {
      state = "idle";
      ctx.ui.notify(`Could not start ${bin}: ${error.message}`, "error");
      return;
    }
    let stderr = "";
    recorder.stderr!.setEncoding("utf8");
    recorder.stderr!.on("data", (d: string) => {
      stderr = (stderr + d).slice(-400);
    });
    recorder.on("error", (error) => {
      state = "idle";
      clearStatusTimers();
      setStatus(undefined);
      ctx.ui.notify(`Recorder error: ${error.message}`, "error");
      recorder = null;
    });

    setStatus("● listening…");
    startMeter();

    // Long takes degrade Whisper quality; finish automatically instead.
    capTimer = setTimeout(() => {
      if (state !== "recording") return;
      activeCtx?.ui.notify(`Dictation limit (${settings.maxSeconds}s) reached — finishing.`, "info");
      if (activeCtx) void finalize(activeCtx);
    }, Math.max(5, settings.maxSeconds) * 1000);
    capTimer.unref?.();
  };

  const stopRecorder = (): Promise<void> =>
    new Promise((resolve) => {
      const child = recorder;
      recorder = null;
      if (!child || child.exitCode !== null) return resolve();
      const done = () => resolve();
      child.once("close", done);
      try {
        child.kill("SIGINT");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        done();
      }, 2500).unref?.();
    });

  const finalize = async (ctx: ExtensionContext) => {
    state = "finalizing";
    if (meterTimer) clearInterval(meterTimer);
    meterTimer = null;
    spinnerFrame = 0;
    setStatus(`${SPINNER[0]} finalizing…`);
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
      setStatus(`${SPINNER[spinnerFrame]} finalizing…`);
    }, 90);

    try {
      await stopRecorder();
      // Keep the spinner running while the model decodes; only the meter dies here.
      if (meterTimer) clearInterval(meterTimer);
      meterTimer = null;
      if (cancelled) {
        setStatus(undefined);
        return;
      }
      if (!existsSync(wavPath) || statSync(wavPath).size <= 44) {
        setStatus(undefined);
        ctx.ui.notify("No audio captured. Check the microphone.", "warning");
        return;
      }
      const text = await transcribe(wavPath);
      setStatus(undefined);
      if (cancelled) return;
      deliver(text);
    } catch (error: any) {
      clearStatusTimers();
      setStatus(undefined);
      ctx.ui.notify(`Dictation failed: ${error.message}`, "error");
    } finally {
      state = "idle";
      try {
        if (existsSync(wavPath)) unlinkSync(wavPath);
      } catch {
        /* ignore */
      }
      wavPath = "";
      unloadNow();
    }
  };

  const toggle = (ctx: ExtensionContext) => {
    activeCtx = ctx;
    if (state === "idle") void startRecording(ctx);
    else if (state === "recording") void finalize(ctx);
  };

  const cancel = () => {
    if (state === "idle") return;
    cancelled = true;
    if (state === "recording") {
      void stopRecorder().then(() => {
        clearStatusTimers();
        setStatus(undefined);
        state = "idle";
        if (wavPath && existsSync(wavPath)) {
          try {
            unlinkSync(wavPath);
          } catch {
            /* ignore */
          }
        }
        wavPath = "";
        unloadNow();
        activeCtx?.ui.notify("Dictation cancelled.", "info");
      });
    }
  };

  // ── global key handling (works inside dialogs) ──────────────────────────
  const onGlobalInput = (data: string): { consume: boolean } | undefined => {
    if (isKeyRelease(data) || isKeyRepeat(data)) return undefined;
    if (matchesKey(data, Key.alt("m"))) {
      if (activeCtx) toggle(activeCtx);
      return { consume: true };
    }
    if (matchesKey(data, Key.alt("n"))) {
      cancel();
      return { consume: true };
    }
    return undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    activeCtx = ctx;
    if (ctx.mode !== "tui" || tuiHandle) return;
    ctx.ui.setWidget("dictate-tui-handle", (tui: any) => {
      tuiHandle = tui;
      removeInputListener = tui.addInputListener(onGlobalInput);
      return { render: () => [], invalidate: () => {} };
    });
  });

  pi.registerShortcut(Key.alt("m"), {
    description: "Toggle local voice dictation",
    handler: async (ctx) => toggle(ctx),
  });

  pi.registerShortcut(Key.alt("n"), {
    description: "Cancel voice dictation",
    handler: async () => cancel(),
  });

  pi.registerCommand("dictate", {
    description: "Toggle local voice dictation",
    handler: async (_args, ctx) => toggle(ctx),
  });

  pi.registerCommand("dictate-unload", {
    description: "Unload the local Whisper model and free its memory",
    handler: async (_args, ctx) => {
      killDaemon();
      ctx.ui.notify("Dictation model unloaded.", "info");
    },
  });

  pi.on("session_shutdown", () => {
    if (state !== "idle") {
      try {
        recorder?.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    clearStatusTimers();
    removeInputListener?.();
    removeInputListener = null;
    killDaemon();
  });
}
