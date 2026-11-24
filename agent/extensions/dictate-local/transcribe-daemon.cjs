#!/usr/bin/env node
/**
 * transcribe-daemon — keeps the local Whisper model warm for dictate-local.
 *
 * Protocol: one JSON object per line on stdin, one JSON object per line on
 * stdout. The model is loaded once at startup, so the first take pays the
 * ~1.2 s load and every later take only pays the decode.
 *
 *   {"wav":"/tmp/take.wav","threads":8} -> {"ok":true,"text":"...","decodeMs":412}
 */

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const modelDir = process.argv[2];
const defaultThreads = Number(process.argv[3] || 0) || undefined;

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
}

function pick(dir, needle, suffix) {
  const files = fs.readdirSync(dir);
  const hit = files.find((f) => f.includes(needle) && f.endsWith(suffix));
  return hit ? path.join(dir, hit) : null;
}

let recognizer = null;
let loadMs = 0;

function load() {
  if (recognizer) return recognizer;
  const started = Date.now();
  let sr;
  try {
    sr = require("sherpa-onnx-node");
  } catch (error) {
    throw new Error(`sherpa-onnx-node not installed in the extension: ${error.message}`);
  }
  const encoder = pick(modelDir, "encoder", ".onnx");
  const decoder = pick(modelDir, "decoder", ".onnx");
  const tokens = pick(modelDir, "tokens", ".txt");
  if (!encoder || !decoder || !tokens) {
    throw new Error(`no Whisper model files in ${modelDir}`);
  }
  recognizer = new sr.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: {
        encoder,
        decoder,
        language: "en",
        task: "transcribe",
        tailPaddings: 1000,
      },
      tokens,
      numThreads: defaultThreads || 4,
      debug: 0,
      provider: "cpu",
    },
  });
  loadMs = Date.now() - started;
  return recognizer;
}

// Load immediately so the model is warm by the time the user stops talking.
try {
  load();
  process.stdout.write(JSON.stringify({ ok: true, ready: true, loadMs }) + "\n");
} catch (error) {
  fail(error.message);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    fail("bad request");
    return;
  }
  try {
    const rec = load();
    const sr = require("sherpa-onnx-node");
    const wav = sr.readWave(request.wav);
    const started = Date.now();
    const stream = rec.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples: wav.samples });
    rec.decode(stream);
    const text = (rec.getResult(stream).text || "").trim();
    process.stdout.write(JSON.stringify({ ok: true, text, decodeMs: Date.now() - started, loadMs }) + "\n");
  } catch (error) {
    fail(error.message);
  }
});

rl.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
