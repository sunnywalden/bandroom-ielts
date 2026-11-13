#!/usr/bin/env node
// Contract checker for Bandroom G3 v26 output manifests.
//
// The server-side gate is completeAcousticFeedback() in
//   <qa-checkout>/dist/server/acoustic-completion.js (lines 27-87, 114-115).
// This file reproduces those predicates exactly, plus a stricter local policy
// for the frozen v26 HJK run. It never talks to the QA server and never writes
// evidence; it only accepts or rejects manifest bytes.
//
// Usage:
//   node validate-acoustic-manifest.mjs --file checkpoint-7.json [--fence N]
//   node validate-acoustic-manifest.mjs --selftest
//
// Exit 0 = accepted, 1 = rejected, 2 = usage/IO error.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const DIGEST = /^[a-f0-9]{64}$/;
const RUN_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const PLACEHOLDER = /<[A-Z0-9_]+>|MEASURED_|C_RUN_ID_LOWERCASE_HEX_UUID/;

// Frozen v26 constants (FIXED_CONTRACT.json).
const RECORDING = "55ecb210cf3490448df0372344d2618086709bf2c6112e6f6354e18ac6b232d1";
const RECIPE = "9022a23414fc0201753c3a06e81209d058c9ae0fbe5c6dff5893042e909e95c2";
const MODEL = "913f30b95735bbf2e7d80dc93066e2730dc02bd0d19fb4a6b7cfefab657ed07c";
const TRUTH = "394fcb74a4221278aa7df02ead49a3743da6293c527617c7f973b1a52c062e28";
const PREFIX_BYTES = 125976;
const PREFIX_PARTS = 6;
const MAX_PART = 24576;
const WINDOWS = 859;
const BYTES_PER_FRAME = 400; // frame[49] + ctc[50] + boundary[1], float32
const FRAMES_PER_WINDOW = 5;
const OUTPUT_INDEX = 7;
const FEEDBACK_PREFIX = "声学链路验收（不代表纠音盲测达标）。";
const QUOTE = "[原声录音]";
const BANNED_SYNTHETIC = ["487a9db6", "4779241b"];
const ANCHORS = [
  { word: "business", start: 3.36, end: 3.66, kind: "substitution" },
  { word: "and", start: 11.44, end: 11.74, kind: "deletion" },
  { word: "suitcase", start: 55.209724, end: 55.509724, kind: "insertion" },
];

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
const fail = (code, message) => ({ code, message });
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// Exact reproduction of completeAcousticFeedback()'s manifest gate.
export function serverChecks(output, { fence = null, runId = null } = {}) {
  const errors = [];
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return [fail("server.object", "output must be a JSON object")];
  }
  if (output.schema !== "bandroom.qa.acoustic-output.v1") {
    errors.push(fail("server.schema", "schema must be bandroom.qa.acoustic-output.v1"));
  }
  if (output.recordingSha256 !== RECORDING) {
    errors.push(fail("server.recording", "recordingSha256 must equal the lease recording"));
  }
  if (output.recipeSha256 !== RECIPE) {
    errors.push(fail("server.recipe", "recipeSha256 must equal the write argument"));
  }
  if (!RUN_ID.test(output.runId ?? "")) {
    errors.push(fail("server.runId", "runId must be a lowercase hex UUID"));
  }
  if (runId !== null && output.runId !== runId) {
    errors.push(fail("server.runIdBinding", "manifest runId differs from the write argument"));
  }
  if (!Number.isSafeInteger(output.fence) || output.fence < 1) {
    errors.push(fail("server.fence", "fence must be a positive safe integer"));
  }
  if (fence !== null && output.fence !== fence) {
    errors.push(fail("server.fenceBinding", "manifest fence differs from the write argument"));
  }
  if (!DIGEST.test(output.coldOutputSha256 ?? "")) {
    errors.push(fail("server.coldDigest", "coldOutputSha256 must be 64 lowercase hex"));
  }
  if (output.coldOutputSha256 !== output.resumedOutputSha256) {
    errors.push(fail("server.coldEqualsResumed", "coldOutputSha256 must equal resumedOutputSha256"));
  }
  if (!Number.isSafeInteger(output.windows) || output.windows < 1) {
    errors.push(fail("server.windows", "windows must be a safe integer >= 1"));
  }
  if (!isFiniteNumber(output.duration) || output.duration <= 0 || output.duration > 181) {
    errors.push(fail("server.duration", "duration must be finite in (0, 181]"));
  }
  if (!Number.isSafeInteger(output.rawOutputBytes) || output.rawOutputBytes < 1) {
    errors.push(fail("server.rawOutputBytes", "rawOutputBytes must be a positive safe integer"));
  }
  if (!DIGEST.test(output.pcmSha256 ?? "")) {
    errors.push(fail("server.pcm", "pcmSha256 must be 64 lowercase hex"));
  }
  if (!DIGEST.test(output.modelSha256 ?? "")) {
    errors.push(fail("server.model", "modelSha256 must be 64 lowercase hex"));
  }
  if (!output.runtime || typeof output.runtime !== "object" || Array.isArray(output.runtime)) {
    errors.push(fail("server.runtime", "runtime must be a non-null, non-array object"));
  }
  if (!DIGEST.test(output.prefixSha256 ?? output.prefixSha ?? "")) {
    errors.push(fail("server.prefix", "prefixSha256 (or the prefixSha alias) must be 64 lowercase hex"));
  }
  if (output.mode === "diagnostic") {
    if (typeof output.feedback !== "string" ||
        output.feedback.length < 10 || output.feedback.length > 800 ||
        !output.feedback.startsWith(FEEDBACK_PREFIX)) {
      errors.push(fail("server.feedback",
        "diagnostic feedback must be 10-800 UTF-16 units and start with the frozen disclaimer"));
    }
  } else if (output.mode !== "measured_feedback") {
    errors.push(fail("server.mode", "mode must be diagnostic (measured_feedback needs measured evidence)"));
  } else {
    errors.push(fail("server.mode", "mode measured_feedback is not permitted for this transport run"));
  }
  const markers = output.markers ?? [];
  if (!Array.isArray(markers) || markers.length > 6) {
    errors.push(fail("server.markers", "markers must be an array with at most 6 entries"));
  } else {
    markers.forEach((m, i) => {
      if (m === null || typeof m !== "object") {
        errors.push(fail("server.marker", `marker ${i} is not an object`));
        return;
      }
      if (m.source !== "human_annotation") {
        errors.push(fail("server.markerSource", `marker ${i} source must be human_annotation`));
      }
      if (!DIGEST.test(m.truthSha256 ?? "")) {
        errors.push(fail("server.markerTruth", `marker ${i} truthSha256 must be 64 lowercase hex`));
      }
      if (!isFiniteNumber(m.start) || !isFiniteNumber(m.end) ||
          m.start < 0 || m.end <= m.start ||
          (isFiniteNumber(output.duration) && m.end > output.duration)) {
        errors.push(fail("server.markerSpan", `marker ${i} must satisfy 0 <= start < end <= duration`));
      }
      if (typeof m.word !== "string" || !m.word.trim() || m.word.length > 80) {
        errors.push(fail("server.markerWord", `marker ${i} word must be non-empty and <= 80 chars`));
      }
    });
  }
  return errors;
}

// Local v26 policy: fixed bindings, no placeholders, HJK anchor set, index math.
export function localChecks(output, { fence = null, runId = null } = {}) {
  const errors = [];
  const warnings = [];
  const raw = JSON.stringify(output);
  if (PLACEHOLDER.test(raw)) {
    errors.push(fail("local.placeholder", "manifest still contains template placeholders; it is not measured evidence"));
  }
  if (output.recipeSha256 !== RECIPE) {
    errors.push(fail("local.recipe", "recipeSha256 must equal the frozen v26 recipe"));
  }
  if (output.modelSha256 !== MODEL) {
    errors.push(fail("local.model", "modelSha256 must equal the frozen encoder-int8 graph digest"));
  }
  if (output.windows !== WINDOWS) {
    errors.push(fail("local.windows", `windows must be ${WINDOWS} for the HJK original`));
  }
  if (output.prefixBytes !== PREFIX_BYTES) {
    errors.push(fail("local.prefixBytes", `prefixBytes must be ${PREFIX_BYTES}`));
  }
  if (!DIGEST.test(output.prefixSha256 ?? "")) {
    errors.push(fail("local.prefixSha", "prefixSha256 must be 64 lowercase hex"));
  }
  if (has(output, "prefixSha") && output.prefixSha !== output.prefixSha256) {
    errors.push(fail("local.prefixAlias", "optional prefixSha alias must equal prefixSha256"));
  }
  if (PREFIX_BYTES % PREFIX_PARTS !== 0 || PREFIX_BYTES / PREFIX_PARTS > MAX_PART) {
    errors.push(fail("local.prefixParts", "frozen prefix cannot be split into 6 parts <= 24576 B"));
  }
  const expectedRaw = WINDOWS * FRAMES_PER_WINDOW * BYTES_PER_FRAME;
  if (output.rawOutputBytes !== expectedRaw) {
    errors.push(fail("local.rawOutputBytes",
      `rawOutputBytes must be ${expectedRaw} for ${WINDOWS} windows`));
  }
  if (!DIGEST.test(output.pcmSha256 ?? "")) {
    errors.push(fail("local.pcm", "pcmSha256 must be 64 lowercase hex (measured cloud decode)"));
  }
  if (output.runtime === null || typeof output.runtime !== "object" ||
      output.runtime.onnxruntime !== "1.24.4" ||
      output.runtime.provider !== "CPUExecutionProvider") {
    errors.push(fail("local.runtime", "runtime must record onnxruntime 1.24.4 and CPUExecutionProvider"));
  }
  if (typeof output.runId !== "string" || !RUN_ID.test(output.runId)) {
    errors.push(fail("local.runId", "runId must be a measured lowercase hex UUID"));
  }
  if (fence !== null && output.fence !== fence) {
    errors.push(fail("local.fence", "manifest fence differs from the C run fence"));
  }
  if (isFiniteNumber(output.duration) && Math.abs(output.duration - 68.699728) > 0.05) {
    warnings.push(`duration ${output.duration} differs from the decoded-media reference 68.699728 by > 50 ms`);
  }
  for (const marker of BANNED_SYNTHETIC) {
    if (raw.includes(marker)) {
      errors.push(fail("local.syntheticSha", `synthetic/v24 reference ${marker} must not appear in HJK evidence`));
    }
  }
  // Exactly the three frozen human anchors, in order; extras are allowed by the
  // server but not by this run's truth set.
  const markers = Array.isArray(output.markers) ? output.markers : [];
  if (markers.length !== ANCHORS.length) {
    errors.push(fail("local.anchorCount", "HJK manifest must carry exactly the three frozen anchors"));
  }
  ANCHORS.forEach((anchor, i) => {
    const m = markers[i] ?? {};
    if (m.word !== anchor.word || m.start !== anchor.start || m.end !== anchor.end) {
      errors.push(fail("local.anchor", `anchor ${i} must be ${anchor.word} ${anchor.start}-${anchor.end}`));
    }
    if (m.truthSha256 !== TRUTH) {
      errors.push(fail("local.anchorTruth", `anchor ${i} truthSha256 must be the frozen truth digest`));
    }
  });
  return { errors, warnings };
}

export function validateManifest(output, options = {}) {
  const server = serverChecks(output, options);
  const local = localChecks(output, options);
  return { errors: [...server, ...local.errors], warnings: local.warnings };
}

function checkQuote(quote) {
  return quote === QUOTE ? [] : [fail("local.quote", "quote must be exactly [原声录音]")];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readManifest(path) {
  const bytes = readFileSync(path);
  return { bytes, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
}

function report(result, bytes, options) {
  if (result.warnings.length) {
    for (const warning of result.warnings) console.error(`WARN  ${warning}`);
  }
  if (result.errors.length) {
    for (const error of result.errors) console.error(`FAIL  ${error.code}: ${error.message}`);
    console.error(`\n${result.errors.length} contract violation(s); manifest rejected.`);
    return 1;
  }
  const digest = sha256(bytes);
  const args = {
    jobId: "qa_hosted_ad79ac58-4d0a-4a29-af0f-c4f37cbc5710",
    quote: QUOTE,
    feedback: JSON.parse(new TextDecoder().decode(bytes)).feedback,
    recipeSha256: RECIPE,
    runId: JSON.parse(new TextDecoder().decode(bytes)).runId,
    fence: JSON.parse(new TextDecoder().decode(bytes)).fence,
    outputSha256: digest,
    outputIndex: OUTPUT_INDEX,
  };
  console.log("PASS  manifest satisfies completeAcousticFeedback and the frozen v26 policy");
  console.log(`outputSha256=${digest}`);
  console.log(`checkpoint bytes=${bytes.length}`);
  console.log("write_qa_text_feedback args:");
  console.log(JSON.stringify(args, null, 2));
  if (options.quote !== undefined && checkQuote(options.quote).length) {
    console.error("FAIL  local.quote: quote must be exactly [原声录音]");
    return 1;
  }
  return 0;
}

function selftest() {
  const base = {
    schema: "bandroom.qa.acoustic-output.v1",
    mode: "diagnostic",
    recordingSha256: RECORDING,
    recipeSha256: RECIPE,
    runId: "0f0e0d0c-0b0a-4908-8706-050403020100",
    fence: 3,
    coldOutputSha256: "a".repeat(64),
    resumedOutputSha256: "a".repeat(64),
    windows: WINDOWS,
    duration: 68.699728,
    rawOutputBytes: WINDOWS * 5 * 400,
    pcmSha256: "b".repeat(64),
    modelSha256: MODEL,
    runtime: { ort: "1.24.4", onnxruntime: "1.24.4", numpy: "2.4.4", python: "3.12.11", provider: "CPUExecutionProvider",
      intraOpThreads: 2, interOpThreads: 1, machine: "x86_64", system: "Linux" },
    prefixSha256: "c".repeat(64),
    prefixBytes: PREFIX_BYTES,
    feedback: "声学链路验收（不代表纠音盲测达标）。v26 诊断链路：859 窗，前缀 8 窗，cold==resumed 逐字节一致；business/and/suitcase 三个标记来自人工锚点，不代表纠音盲测结论。",
    markers: ANCHORS.map(({ word, start, end }) => ({
      word, start, end, source: "human_annotation", truthSha256: TRUTH,
    })),
  };
  const clone = () => JSON.parse(JSON.stringify(base));
  const cases = [];
  const add = (name, mutate, expected) => {
    const value = clone();
    mutate(value);
    cases.push({ name, value, expected });
  };
  add("positive", () => {}, null);
  add("missing schema", (v) => { v.schema = "x"; }, "server.schema");
  add("wrong recording", (v) => { v.recordingSha256 = "d".repeat(64); }, "server.recording");
  add("cold != resumed", (v) => { v.resumedOutputSha256 = "e".repeat(64); }, "server.coldEqualsResumed");
  add("cold 63 hex", (v) => { v.coldOutputSha256 = "a".repeat(63); }, "server.coldDigest");
  add("windows 0", (v) => { v.windows = 0; }, "server.windows");
  add("duration 0", (v) => { v.duration = 0; }, "server.duration");
  add("duration > 181", (v) => { v.duration = 181.5; }, "server.duration");
  add("rawOutputBytes 0", (v) => { v.rawOutputBytes = 0; }, "server.rawOutputBytes");
  add("pcm not hex", (v) => { v.pcmSha256 = "nothex"; }, "server.pcm");
  add("model not hex", (v) => { v.modelSha256 = "nothex"; }, "server.model");
  add("runtime array", (v) => { v.runtime = []; }, "server.runtime");
  add("prefix alias missing", (v) => { delete v.prefixSha256; }, "server.prefix");
  add("measured mode", (v) => { v.mode = "measured_feedback"; }, "server.mode");
  add("short feedback", (v) => { v.feedback = "太短"; }, "server.feedback");
  add("wrong feedback prefix", (v) => { v.feedback = "声学结果。" + "x".repeat(20); }, "server.feedback");
  add("marker source", (v) => { v.markers[0].source = "model"; }, "server.markerSource");
  add("marker truth", (v) => { v.markers[0].truthSha256 = "z".repeat(64); }, "server.markerTruth");
  add("marker end > duration", (v) => { v.markers[2].end = 200; }, "server.markerSpan");
  add("marker word 81", (v) => { v.markers[0].word = "w".repeat(81); }, "server.markerWord");
  add("seven markers", (v) => { while (v.markers.length <= 6) v.markers.push({ ...v.markers[0] }); }, "server.markers");
  add("placeholder runId", (v) => { v.runId = "<C_RUN_ID_LOWERCASE_HEX_UUID>"; }, "local.placeholder");
  add("windows 858", (v) => { v.windows = 858; }, "local.windows");
  add("raw bytes mismatch", (v) => { v.rawOutputBytes = 1000; }, "local.rawOutputBytes");
  add("wrong anchor", (v) => { v.markers[0].start = 3.3; }, "local.anchor");
  add("prefix bytes wrong", (v) => { v.prefixBytes = 24576; }, "local.prefixBytes");
  add("synthetic sha", (v) => { v.prefixSha256 = "487a9db6" + "0".repeat(56); }, "local.syntheticSha");

  let failures = 0;
  for (const { name, value, expected } of cases) {
    const { errors } = validateManifest(value, { fence: value.fence, runId: value.runId });
    if (expected === null) {
      if (errors.length) {
        failures += 1;
        console.error(`FAIL  selftest ${name}: expected accept, got ${errors.map((e) => e.code).join(",")}`);
      } else {
        console.log(`PASS  selftest ${name}`);
      }
    } else if (!errors.some((e) => e.code === expected)) {
      failures += 1;
      console.error(`FAIL  selftest ${name}: expected ${expected}, got ${errors.map((e) => e.code).join(",") || "accept"}`);
    } else {
      console.log(`PASS  selftest ${name} -> ${expected}`);
    }
  }
  // Argument-side checks that the manifest cannot express.
  if (checkQuote("[原声录音]").length || !checkQuote("原声").length) {
    failures += 1;
    console.error("FAIL  selftest quote constant");
  } else {
    console.log("PASS  selftest quote constant");
  }
  console.log(`\n${cases.length + 1 - failures}/${cases.length + 1} selftest cases passed`);
  return failures ? 1 : 0;
}

function main(argv) {
  if (argv.includes("--selftest")) return selftest();
  const fileIndex = argv.indexOf("--file");
  if (fileIndex === -1) {
    console.error("usage: node validate-acoustic-manifest.mjs --file <checkpoint-7.json> [--fence N] [--run-id UUID] [--quote TEXT]");
    console.error("       node validate-acoustic-manifest.mjs --selftest");
    return 2;
  }
  const path = argv[fileIndex + 1];
  if (!path) {
    console.error("--file requires a path");
    return 2;
  }
  const fenceIndex = argv.indexOf("--fence");
  const fence = fenceIndex === -1 ? null : Number(argv[fenceIndex + 1]);
  const runIndex = argv.indexOf("--run-id");
  const runId = runIndex === -1 ? null : argv[runIndex + 1];
  const quoteIndex = argv.indexOf("--quote");
  const quote = quoteIndex === -1 ? undefined : argv[quoteIndex + 1];
  const options = { fence, runId, quote };
  const { bytes, value } = readManifest(path);
  const quoteErrors = quote === undefined ? [] : checkQuote(quote);
  const result = validateManifest(value, options);
  result.errors.unshift(...quoteErrors);
  return report(result, bytes, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}

export { RECORDING, RECIPE, MODEL, TRUTH, PREFIX_BYTES, OUTPUT_INDEX, QUOTE, FEEDBACK_PREFIX };