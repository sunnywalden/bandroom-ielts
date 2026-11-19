#!/usr/bin/env python3
"""Bounded zero-production probe: can DashScope `qwen-audio-3.0-realtime-plus`
perceive phoneme-level mispronunciations well enough to ASSERT them?

This probe is read-only with respect to the Bandroom product repository.  It
writes only under ~/.bandroom-acoustic/realtime_probe/.  It never prints the
API key.

PRE-REGISTRATION (fixed before the first scored call)
-----------------------------------------------------
Model:      qwen-audio-3.0-realtime-plus (WebSocket realtime API only; the
            compatible-mode and native multimodal HTTP endpoints both return
            "current user api does not support http call").
Protocol:   wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=...
            input_audio_format = pcm16, 16 kHz, mono, manual turn detection.
Audio path validation: one ASR calibration call on the first 6.0 s of HJK
            ("Okay, um, Tom had a business trip to New York this Sunday.").
Items:      HJK annotated errors (12 word occurrences, forced anchors
            business@3.36 s, deletion and@11.44 s, suitcase addition@55.21 s)
            + 4 held-out-speaker substitutions from TextGrid labels
            (njs/tlv/tni/txhc) = 16 error items.
            12 HJK control words + 4 held-out-speaker control words = 16
            controls.  Controls have no annotated phone error overlapping
            their word span and are >=300 ms long.
Selection:  seed 20261119, deterministic; word occurrences deduplicated.
Clip:       word span + 0.45 s before + 0.45 s after (~1.0-1.6 s), 16 kHz mono
            PCM16.
Prompt:     identical focused-clip wording to the project's earlier E1 probe:
            canonical pronunciation is supplied, the model is told many clips
            are correct, and it must reply strict JSON
            {matches_canonical, deviation, affected_sound, heard_as,
             confidence, audible_evidence}.
Repeats:    2 independent WebSocket sessions per item.
Scoring:
  strict  = model asserts a deviation AND identifies the annotated
            target->actual phone change (deletion: target omitted; addition:
            inserted phone named).
  loose   = model asserts any deviation (matches_canonical=false or a
            non-null deviation/affected_sound).
  V1-comparable strict precision = strict hits / all asserted deviations
            (strict hits + type-wrong error flags + control flags).  This is
            the project's precision semantics (same word + expected phone +
            observed phone).
  loose precision = error-word flags / all asserted deviations (word-level
            "is this word wrong" precision).
  recall is reported against the 16 annotated error items.
No pass is manufactured: if the model asserts nothing, precision is reported
as undefined and the assertion hypothesis fails.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import math
import os
import pathlib
import random
import re
import subprocess
import sys
import time
from collections import defaultdict

BASE = pathlib.Path(os.environ.get("BANDROOM_ACOUSTIC_DIR", str(pathlib.Path.home() / ".bandroom-acoustic")))
OUTDIR = BASE / "realtime_probe"
CLIPS = OUTDIR / "clips"
REPO = pathlib.Path(os.environ.get(
    "BANDROOM_ACCEPTANCE_DIR",
    str(pathlib.Path(__file__).resolve().parents[3] / "acceptance-2026-11-10")))
HJK_WAV = REPO / "fixtures" / "hjk.wav"
TRUTH = REPO / "iteration-20" / "qa-work-fixture" / "truth.json"
CORPUS = BASE / "corpus" / "suitcase_corpus"
HELD_OUT = ["njs", "tlv", "tni", "txhc"]

MODEL = "qwen-audio-3.0-realtime-plus"
URL = f"wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model={MODEL}"
SEED = 20261119
REPEATS = 2
N_HJK_ERR = 12
N_HJK_CTL = 12
N_HELD_ERR = 4
N_HELD_CTL = 4
CAL_SECONDS = 6.0
CAL_EXPECTED = "Okay, um, Tom had a business trip to New York this Sunday."

TARGET_SR = 16000
PAD = 0.45

ZOOM_PROMPT = (
    "You are listening to a short excerpt of an English learner's speech. "
    "The word in focus is \"{word}\". Its canonical General American pronunciation "
    "is /{ipa}/ (ARPABET: {phones}).\n\n"
    "Listen carefully to how this speaker ACTUALLY produces the word. Many excerpts "
    "are perfectly correct - do not assume an error exists.\n\n"
    "Report ONLY what you can hear. Reply with strict JSON:\n"
    "{{\"matches_canonical\": true|false, \"deviation\": \"<plain articulatory description: "
    "voicing/place/manner/vowel quality/length, or null>\", "
    "\"affected_sound\": \"<ARPABET phone or null>\", \"heard_as\": \"<ARPABET phone or null>\", "
    "\"confidence\": 0.0-1.0, \"audible_evidence\": \"<what in the signal supports this>\"}}"
)

A2I = {
    "AA": "ɑ", "AE": "æ", "AH": "ʌ", "AO": "ɔ", "AW": "aʊ", "AY": "aɪ",
    "B": "b", "CH": "tʃ", "D": "d", "DH": "ð", "EH": "ɛ", "ER": "ɝ",
    "EY": "eɪ", "F": "f", "G": "ɡ", "HH": "h", "IH": "ɪ", "IY": "i",
    "JH": "dʒ", "K": "k", "L": "l", "M": "m", "N": "n", "NG": "ŋ",
    "OW": "oʊ", "OY": "ɔɪ", "P": "p", "R": "r", "S": "s", "SH": "ʃ",
    "T": "t", "TH": "θ", "UH": "ʊ", "UW": "u", "V": "v", "W": "w",
    "Y": "j", "Z": "z", "ZH": "ʒ",
}
I2A = {v: k for k, v in A2I.items()}
ALIASES = {"AX": "AH", "IX": "IH", "AXR": "ER", "EL": "L", "EN": "N",
           "EM": "M", "DX": "T", "T*": "T", "D*": "D", "S*": "S", "Z*": "Z",
           "AA*": "AA", "IY*": "IY"}

TG_INTERVAL = re.compile(
    r'intervals \[\d+\]:\s*xmin = ([0-9.]+)\s*xmax = ([0-9.]+)\s*text = "([^"]*)"')


# --------------------------------------------------------------------------- #
# Credentials / audio
# --------------------------------------------------------------------------- #
def load_key() -> str:
    env = pathlib.Path.home() / ".config" / "bandroom" / "credentials.env"
    for line in env.read_text().splitlines():
        line = line.strip().removeprefix("export ")
        if line.startswith("DASHSCOPE_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("DASHSCOPE_API_KEY not found")


def cut_pcm(name: str, wav: pathlib.Path, start_s: float, dur_s: float) -> pathlib.Path:
    CLIPS.mkdir(parents=True, exist_ok=True)
    p = CLIPS / f"{name}.pcm"
    if not p.exists():
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-ss", f"{start_s:.3f}", "-i", str(wav),
             "-t", f"{dur_s:.3f}", "-ar", str(TARGET_SR), "-ac", "1",
             "-f", "s16le", str(p)], check=True)
    return p


# --------------------------------------------------------------------------- #
# TextGrid / truth helpers
# --------------------------------------------------------------------------- #
def phone_norm(text: str) -> str:
    value = re.sub(r"[012]$", "", text.strip().upper()).replace("*", "")
    return ALIASES.get(value, value)


def tg_intervals(text: str):
    return [(float(a), float(b), c.strip())
            for a, b, c in TG_INTERVAL.findall(text)]


def load_textgrid(speaker: str):
    raw = (CORPUS / "annotation" / f"{speaker}.TextGrid").read_text()
    words = [(a, b, c.strip()) for a, b, c in
             tg_intervals(raw.split('name = "words"')[1].split('name = "phones"')[0])
             if c.strip()]
    phones = []
    for a, b, c in tg_intervals(raw.split('name = "phones"')[1]):
        parts = [x.strip() for x in c.split(",")]
        if len(parts) != 3:
            continue
        phones.append(dict(start=a, end=b, expected=phone_norm(parts[0]),
                           actual=phone_norm(parts[1]), kind=parts[2]))
    return words, phones


def phones_in_span(phones, start_s: float, end_s: float):
    return sorted(
        [p for p in phones
         if p["start"] < end_s and p["end"] > start_s
         and re.fullmatch("[A-Z]+", p["expected"]) is not None],
        key=lambda p: p["start"])


_CMU = None


def cmu_phones(word: str):
    """First cmudict General-American pronunciation, ARPABET without stress."""
    global _CMU
    if _CMU is None:
        try:
            import cmudict
        except ModuleNotFoundError:
            # cmudict lives in the project's local venv; the realtime client
            # runs on the system interpreter which has websockets.
            sys.path.insert(0, str(BASE / "env" / "lib" / "python3.13" / "site-packages"))
            import cmudict
        _CMU = cmudict.dict()
    key = re.sub(r"[^a-z']", "", word.lower())
    entries = _CMU.get(key) or []
    if not entries and key.endswith("'s"):
        entries = _CMU.get(key[:-2], [])
    if not entries:
        return []
    return [re.sub(r"[012]$", "", p).upper() for p in entries[0]]


def arpabet_to_ipa(phones) -> str:
    return "".join(A2I.get(re.sub(r"[0-9*]", "", p.upper()), p.lower())
                   for p in phones)


def word_bounds(truth, w):
    return w["startMs"] / 1000.0, w["endMs"] / 1000.0


# --------------------------------------------------------------------------- #
# Pre-registered item construction
# --------------------------------------------------------------------------- #
def build_items():
    truth = json.loads(TRUTH.read_text())
    words = truth["words"]
    events = [e for e in truth["events"] if e.get("valid")]
    rng = random.Random(SEED)

    # Forced anchors: business@3.36, and-deletion@11.44, suitcase-addition@55.21
    anchors = []
    for e in events:
        if (e["word"] == "business" and abs(e["atMs"] - 3360) < 1) \
           or (e["word"] == "and" and e["kind"] == "deletion" and abs(e["atMs"] - 11440) < 1) \
           or (e["word"] == "suitcase" and e["kind"] == "addition" and abs(e["atMs"] - 55209.724) < 1):
            anchors.append(e)
    assert len(anchors) == 3, f"anchor match failed: {[e['word'] for e in anchors]}"

    # 9 more: 6 substitutions + 3 deletions, distinct word occurrences, spread.
    used_occ = {e["wordStartMs"] for e in anchors}
    subs = [e for e in events if e["kind"] == "substitution"
            and e["wordStartMs"] not in used_occ]
    dels = [e for e in events if e["kind"] == "deletion"
            and e["wordStartMs"] not in used_occ]
    rng.shuffle(subs)
    rng.shuffle(dels)
    chosen = list(anchors)
    def add_from(pool, n):
        added = 0
        for e in pool:
            if added >= n:
                break
            if e["wordStartMs"] in used_occ:
                continue
            chosen.append(e)
            used_occ.add(e["wordStartMs"])
            added += 1
        return added
    add_from(subs, 6)
    add_from(dels, 3)
    assert len(chosen) == N_HJK_ERR, f"error selection {len(chosen)}"

    hjk_errors = []
    for e in chosen:
        hjk_errors.append(dict(
            id=f"HJK_E_{e['wordIndex']}_{int(e['atMs'])}",
            source="hjk", kind=e["kind"], word=e["word"],
            target=e["target"], actual=e["actual"],
            word_start_ms=e["wordStartMs"], word_end_ms=e["wordEndMs"],
            at_ms=e["atMs"], phones=e["canonicalPhones"],
            wav=str(HJK_WAV)))
    hjk_errors.sort(key=lambda x: x["at_ms"])

    # HJK controls: no error event overlapping the word span, >=300 ms.
    ctl_pool = []
    for wi, w in enumerate(words):
        if not w.get("word") or w.get("startMs") is None:
            continue
        if (w["endMs"] - w["startMs"]) < 300:
            continue
        overlap = any(e["wordStartMs"] < w["endMs"] and e["wordEndMs"] > w["startMs"]
                      for e in events)
        if overlap:
            continue
        if not re.fullmatch(r"[A-Za-z']+", w["word"]):
            continue
        ctl_pool.append((w, wi))
    rng.shuffle(ctl_pool)
    hjk_controls = []
    for w, wi in ctl_pool[:N_HJK_CTL]:
        hjk_controls.append(dict(
            id=f"HJK_C_{wi}_{int(w['startMs'])}",
            source="hjk", kind="control", word=w["word"],
            target=None, actual=None,
            word_start_ms=w["startMs"], word_end_ms=w["endMs"],
            at_ms=(w["startMs"] + w["endMs"]) / 2, phones=w["phones"],
            wav=str(HJK_WAV)))
    hjk_controls.sort(key=lambda x: x["at_ms"])

    # Held-out: one substitution + one control per speaker.
    held_errors, held_controls = [], []
    for speaker in HELD_OUT:
        wav = CORPUS / "wav" / f"{speaker}.wav"
        wts, phs = load_textgrid(speaker)
        # error candidates: comparable substitution phone, word span >=300 ms
        err_cands = []
        for p in phs:
            if p["kind"] != "s":
                continue
            if re.fullmatch("[A-Z]+", p["expected"]) is None:
                continue
            if re.fullmatch("[A-Z]+", p["actual"]) is None:
                continue
            if p["expected"] == p["actual"]:
                continue
            mid = (p["start"] + p["end"]) / 2.0
            owner = next(((a, b, t) for a, b, t in wts if a <= mid <= b), None)
            if not owner:
                continue
            a, b, t = owner
            if b - a < 0.30:
                continue
            err_cands.append((p, a, b, t))
        err_cands.sort(key=lambda x: x[0]["start"])
        if not err_cands:
            continue
        p, a, b, t = err_cands[rng.randrange(len(err_cands))]
        held_errors.append(dict(
            id=f"{speaker}_E_{int(p['start']*1000)}", source="heldout",
            kind="substitution", word=t, target=p["expected"], actual=p["actual"],
            word_start_ms=a * 1000.0, word_end_ms=b * 1000.0,
            at_ms=((p["start"] + p["end"]) / 2.0) * 1000.0,
            phones=cmu_phones(t) or [p["expected"]],
            wav=str(wav)))

        # control: word with no annotated s/a/d phone interval overlapping it.
        # The corpus phone tier contains only annotated deviations, so a clean
        # word has no phone-tier interval at all.
        def word_clean(a0, b0):
            inside = [q for q in phs if q["start"] < b0 and q["end"] > a0]
            return not any(q["kind"] in ("s", "a", "d") for q in inside)
        clean = [(a0, b0, t0) for a0, b0, t0 in wts
                 if b0 - a0 >= 0.30 and word_clean(a0, b0)
                 and re.fullmatch(r"[A-Za-z']+", t0) and cmu_phones(t0)]
        if clean:
            a0, b0, t0 = clean[rng.randrange(len(clean))]
            held_controls.append(dict(
                id=f"{speaker}_C_{int(a0*1000)}", source="heldout", kind="control",
                word=t0, target=None, actual=None,
                word_start_ms=a0 * 1000.0, word_end_ms=b0 * 1000.0,
                at_ms=((a0 + b0) / 2.0) * 1000.0,
                phones=cmu_phones(t0),
                wav=str(wav)))

    items = hjk_errors + held_errors + hjk_controls + held_controls
    # deterministic search-key order for the run log (not shown to the model)
    for it in items:
        s = max(0.0, it["word_start_ms"] / 1000.0 - PAD)
        d = (it["word_end_ms"] - it["word_start_ms"]) / 1000.0 + 2 * PAD
        it["clip_start"] = round(s, 3)
        it["clip_dur"] = round(d, 3)
        it["clip"] = str(cut_pcm(it["id"], pathlib.Path(it["wav"]), s, d))
        it["ipa"] = arpabet_to_ipa(it["phones"])
        it["prompt"] = ZOOM_PROMPT.format(
            word=it["word"], ipa=it["ipa"] or "n/a",
            phones=" ".join(it["phones"]) or "n/a")
    return dict(
        items=items, counts=dict(
            hjk_errors=len(hjk_errors), held_errors=len(held_errors),
            hjk_controls=len(hjk_controls), held_controls=len(held_controls),
            errors=len(hjk_errors) + len(held_errors),
            controls=len(hjk_controls) + len(held_controls)))


# --------------------------------------------------------------------------- #
# Realtime WebSocket client
# --------------------------------------------------------------------------- #
async def _ws_once(key: str, pcm: bytes, prompt: str, timeout_s: float = 75.0) -> dict:
    import websockets
    t0 = time.time()
    out = dict(ok=False, text="", events=0, error=None)
    try:
        async with websockets.connect(
                URL, additional_headers={"Authorization": f"Bearer {key}"},
                open_timeout=15, max_size=32_000_000) as ws:
            # session.created
            while True:
                ev = json.loads(await asyncio.wait_for(ws.recv(), 15))
                out["events"] += 1
                if ev.get("type") == "session.created":
                    out["session_model"] = ev.get("session", {}).get("model")
                    break
            cfg = {"type": "session.update", "session": {
                "modalities": ["text"],
                "instructions": "You are a careful phonetician. Answer only from the audio.",
                "input_audio_format": "pcm16",
                "turn_detection": None,
                "input_audio_transcription": None}}
            await ws.send(json.dumps(cfg))
            while True:
                ev = json.loads(await asyncio.wait_for(ws.recv(), 15))
                out["events"] += 1
                if ev.get("type") in ("session.updated", "error"):
                    if ev.get("type") == "error":
                        out["error"] = json.dumps(ev)[:300]
                    break
            for i in range(0, len(pcm), 3200):
                await ws.send(json.dumps({
                    "type": "input_audio_buffer.append",
                    "audio": base64.b64encode(pcm[i:i + 3200]).decode()}))
            await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
            while True:
                ev = json.loads(await asyncio.wait_for(ws.recv(), 15))
                out["events"] += 1
                if ev.get("type") in ("input_audio_buffer.committed", "error"):
                    break
            await ws.send(json.dumps({"type": "response.create", "response": {
                "modalities": ["text"], "instructions": prompt}}))
            deadline = time.time() + timeout_s
            text = ""
            while time.time() < deadline:
                ev = json.loads(await asyncio.wait_for(ws.recv(), deadline - time.time()))
                out["events"] += 1
                typ = ev.get("type", "")
                if typ == "response.text.delta":
                    text += ev.get("delta", "")
                elif typ == "error":
                    out["error"] = json.dumps(ev)[:300]
                    break
                elif typ == "response.done":
                    r = ev.get("response") or {}
                    for item in r.get("output") or []:
                        for c in item.get("content") or []:
                            if c.get("type") == "text" and c.get("text"):
                                text = c["text"]
                    break
            out.update(ok=bool(text.strip()), text=text.strip())
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}: {e}"[:300]
    out["latency_s"] = round(time.time() - t0, 2)
    return out


async def _calibrate(key: str) -> dict:
    pcm = cut_pcm("cal_first6s", HJK_WAV, 0.0, CAL_SECONDS).read_bytes()
    prompt = "Transcribe exactly what you hear, verbatim. No commentary."
    rec = await _ws_once(key, pcm, prompt, timeout_s=60)
    heard = re.sub(r"[^a-z ]", "", rec.get("text", "").lower())
    expected = re.sub(r"[^a-z ]", "", CAL_EXPECTED.lower())
    rec["expected"] = CAL_EXPECTED
    rec["word_overlap"] = len(set(heard.split()) & set(expected.split())) / max(1, len(set(expected.split())))
    rec["audio_path_ok"] = rec.get("ok") and rec["word_overlap"] >= 0.7
    return rec


def call_item(key: str, item: dict, repeat: int) -> dict:
    pcm = pathlib.Path(item["clip"]).read_bytes()
    last = None
    for attempt in range(1, 4):
        rec = asyncio.run(_ws_once(key, pcm, item["prompt"]))
        last = rec
        if rec.get("ok"):
            break
        time.sleep(1.5 * attempt)
    rec = dict(last or {"ok": False, "error": "no attempt"})
    rec.update(item_id=item["id"], source=item["source"], kind=item["kind"],
               word=item["word"], target=item["target"], actual=item["actual"],
               repeat=repeat)
    rec["parsed"] = parse_json(rec.get("text", ""))
    return rec


# --------------------------------------------------------------------------- #
# Scoring
# --------------------------------------------------------------------------- #
def parse_json(text: str):
    if not text:
        return None
    for candidate in (text, *re.findall(r"\{.*?\}", text, re.S)):
        try:
            v = json.loads(candidate)
            if isinstance(v, dict):
                return v
        except json.JSONDecodeError:
            continue
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            return None
    return None


PHONE_TOKEN = re.compile(r"(?<![A-Za-z])([A-Z]{1,3}\*?)(?![A-Za-z])")


def phone_tokens(text: str):
    toks = set()
    if not text:
        return toks
    for m in PHONE_TOKEN.finditer(text):
        toks.add(phone_norm(m.group(1)))
    # IPA symbols are only trusted inside /.../ or [...] notation.  Scanning
    # raw English text for single-letter IPA (s, t, d, k, ...) would turn
    # ordinary words like "sounding" into a false /s/ token.
    keys = sorted(I2A, key=len, reverse=True)
    for chunk in re.findall(r"[/\[]([^/\]]+)[/\]]", text):
        i = 0
        while i < len(chunk):
            for k in keys:
                if chunk.startswith(k, i):
                    toks.add(I2A[k])
                    i += len(k)
                    break
            else:
                i += 1
    return toks


def norm_phone(value):
    if value is None:
        return None
    s = str(value).strip().strip("/[]{}() ")
    if not s or s.lower() in ("null", "none", "n/a", "na", "∅", "0"):
        return None
    s = s.upper().replace("*", "")
    s = re.sub(r"[0-2]$", "", s)
    s = ALIASES.get(s, s)
    if re.fullmatch("[A-Z]{1,3}", s):
        return s
    toks = phone_tokens(str(value))
    return next(iter(toks)) if len(toks) == 1 else None


def interpret(rec: dict) -> dict:
    parsed = rec.get("parsed")
    text = rec.get("text", "") or ""
    flagged = False
    m = None
    dev = None
    aff = None
    hrd = None
    if isinstance(parsed, dict):
        m = parsed.get("matches_canonical")
        if isinstance(m, str):
            m = m.strip().lower() == "true"
        dev = parsed.get("deviation")
        aff = norm_phone(parsed.get("affected_sound"))
        hrd = norm_phone(parsed.get("heard_as"))
        flagged = (m is False) or (dev not in (None, "", "null", "none", "None")) \
            or aff is not None or hrd is not None
    else:
        low = text.lower()
        if re.search(r"matches_canonical\"?\s*[:=]\s*false", low):
            flagged = True
        if re.search(r"deviation\"?\s*[:=]\s*\"?[^n\" ]", low):
            flagged = True
    return dict(flagged=flagged, matches=m, deviation=dev,
                affected=aff, heard=hrd,
                tokens=phone_tokens(" ".join(str(x) for x in
                                             (text, dev, aff, hrd) if x)))


DEL_RE = re.compile(r"delet|omiss|omit|drop|missing|not pronounced|silent|elid|∅|零|省略|吞", re.I)
ADD_RE = re.compile(r"insert|add|epenthe|extra|intrusive|添加|插入", re.I)
CHANGE_RE = re.compile(r"->|→|to |becom|instead|substitut|realis|realiz|pronounc|devoic|"
                       r"voic|change|replace|heard as|actual", re.I)


def strict_match(item: dict, interp: dict, raw_text: str) -> bool:
    if not interp["flagged"]:
        return False
    kind = item["kind"]
    target = phone_norm(item["target"]) if item.get("target") else None
    actual = phone_norm(item["actual"]) if item.get("actual") else None
    text = raw_text or ""
    toks = interp["tokens"]
    aff, hrd = interp["affected"], interp["heard"]

    if kind == "substitution":
        if aff is not None and hrd is not None:
            # Both endpoints stated explicitly: direction must be correct.
            return aff == target and hrd == actual
        if aff is not None:
            return aff == target and actual in toks and bool(CHANGE_RE.search(text))
        if hrd is not None:
            return hrd == actual and target in toks and bool(CHANGE_RE.search(text))
        if target and actual and target in toks and actual in toks and CHANGE_RE.search(text):
            return True
        return False

    if kind == "deletion":
        if target and DEL_RE.search(text) and (aff == target or target in toks):
            return True
        return False

    if kind == "addition":
        if actual and ADD_RE.search(text) and (hrd == actual or actual in toks):
            return True
        return False
    return False


def wilson(k: int, n: int, z: float = 1.96):
    if n == 0:
        return None
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return [max(0.0, centre - half), min(1.0, centre + half)]


def annotated_errors_in_word(item: dict):
    """All annotated phone errors on the item's word occurrence.

    Used only for a POST-HOC generous bound: the pre-registered unit is the
    single selected event, but a word can carry more than one annotation
    (e.g. HJK 'rushed' has AH->AA and T->deletion).  This lets the report say
    whether a model claim matched *some* real error in the same word.
    """
    if item["source"] == "hjk":
        truth = json.loads(TRUTH.read_text())
        return [
            dict(kind=e["kind"], target=phone_norm(e["target"]),
                 actual=phone_norm(e["actual"]))
            for e in truth["events"]
            if e.get("valid") and e["wordStartMs"] < item["word_end_ms"]
            and e["wordEndMs"] > item["word_start_ms"]]
    speaker = item["id"].split("_")[0]
    _, phs = load_textgrid(speaker)
    kmap = {"s": "substitution", "d": "deletion", "a": "addition"}
    return [
        dict(kind=kmap[p["kind"]], target=p["expected"], actual=p["actual"])
        for p in phs
        if p["kind"] in kmap
        and p["start"] < item["word_end_ms"] / 1000.0
        and p["end"] > item["word_start_ms"] / 1000.0]


def score(records, items_by_id):
    rows = []
    for rec in records:
        it = items_by_id[rec["item_id"]]
        interp = interpret(rec)
        strict = strict_match(it, interp, rec.get("text", ""))
        posthoc = False
        if it["kind"] != "control":
            posthoc = any(strict_match(ev, interp, rec.get("text", ""))
                          for ev in annotated_errors_in_word(it))
        rows.append(dict(
            item_id=rec["item_id"], source=it["source"], kind=it["kind"],
            word=it["word"], repeat=rec["repeat"], ok=rec.get("ok"),
            parse_ok=isinstance(rec.get("parsed"), dict),
            flagged=interp["flagged"], strict=strict, posthoc_strict=posthoc,
            matches=interp["matches"], deviation=interp["deviation"],
            affected=interp["affected"], heard=interp["heard"],
            target=it["target"], actual=it["actual"],
            text=(rec.get("text") or "")[:600], latency_s=rec.get("latency_s")))

    def agg(rs):
        errs = [r for r in rs if r["kind"] != "control"]
        ctls = [r for r in rs if r["kind"] == "control"]
        strict_hits = sum(1 for r in errs if r["strict"])
        posthoc_hits = sum(1 for r in errs if r["posthoc_strict"])
        err_flags = sum(1 for r in errs if r["flagged"])
        ctl_flags = sum(1 for r in ctls if r["flagged"])
        all_flags = err_flags + ctl_flags
        return dict(
            error_items=len(errs), control_items=len(ctls),
            strict_hits=strict_hits, posthoc_same_word_hits=posthoc_hits,
            error_flags=err_flags, control_fps=ctl_flags,
            all_assertions=all_flags,
            strict_recall=strict_hits / len(errs) if errs else None,
            posthoc_same_word_recall=posthoc_hits / len(errs) if errs else None,
            loose_recall=err_flags / len(errs) if errs else None,
            strict_precision=strict_hits / all_flags if all_flags else None,
            posthoc_same_word_precision=posthoc_hits / all_flags if all_flags else None,
            loose_precision=err_flags / all_flags if all_flags else None,
            control_fp_rate=ctl_flags / len(ctls) if ctls else None,
            strict_precision_ci95=wilson(strict_hits, all_flags) if all_flags else None,
            posthoc_same_word_precision_ci95=wilson(posthoc_hits, all_flags) if all_flags else None,
            loose_precision_ci95=wilson(err_flags, all_flags) if all_flags else None,
            parse_ok=sum(1 for r in rs if r["parse_ok"]),
            usable=sum(1 for r in rs if r["ok"]),
        )

    run1 = [r for r in rows if r["repeat"] == 1]
    run2 = [r for r in rows if r["repeat"] == 2]
    pooled = rows
    out = dict(
        run1=agg(run1), run2=agg(run2), pooled=agg(pooled),
        by_source={},
        by_kind={},
        repeatability={},
        rows=rows,
    )
    for src in sorted({r["source"] for r in rows}):
        out["by_source"][src] = {f"run{i}": agg([r for r in rr if r["source"] == src])
                                 for i, rr in [(1, run1), (2, run2)]}
    for kind in sorted({r["kind"] for r in rows if r["kind"] != "control"}):
        out["by_kind"][kind] = {f"run{i}": agg([r for r in rr if r["kind"] == kind])
                                for i, rr in [(1, run1), (2, run2)]}
    # repeat agreement per item
    per_item = defaultdict(list)
    for r in rows:
        per_item[r["item_id"]].append(r)
    agree_flag = agree_strict = n = 0
    for _, rs in per_item.items():
        if len(rs) < 2:
            continue
        n += 1
        if rs[0]["flagged"] == rs[1]["flagged"]:
            agree_flag += 1
        if rs[0]["strict"] == rs[1]["strict"]:
            agree_strict += 1
    out["repeatability"] = dict(
        items=n, flag_agreement=agree_flag / n if n else None,
        strict_agreement=agree_strict / n if n else None)
    return out


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--repeats", type=int, default=REPEATS)
    ap.add_argument("--skip-calibration", action="store_true")
    ap.add_argument("--rescore", action="store_true",
                    help="re-score records.jsonl with the current matcher, no API calls")
    args = ap.parse_args()

    built = build_items()
    items = built["items"]
    if args.limit:
        items = items[:args.limit]
    print(f"items: {len(items)} | counts {built['counts']}")
    for it in items:
        print(f"  {it['id']:26s} {it['source']:8s} {it['kind']:13s} "
              f"{it['word']:12s} {str(it['target']):4s}->{str(it['actual']):4s} "
              f"{it['clip_start']:6.2f}s {it['clip_dur']:.2f}s")
    if args.dry_run:
        return

    if args.rescore:
        records = [json.loads(line) for line in
                   (OUTDIR / "records.jsonl").read_text().splitlines() if line.strip()]
        items_by_id = {it["id"]: it for it in items}
        scored = score(records, items_by_id)
        out_path = OUTDIR / "REALTIME_PROBE_RESULT.json"
        result = json.loads(out_path.read_text())
        result["scoring"] = scored
        result["rescored_at_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        result["rescoring_note"] = ("Final scorer is stricter than the live run's "
                                    "in-memory scorer: direction is required when both "
                                    "affected_sound and heard_as are named.")
        out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2))
        sums = []
        for p in sorted(OUTDIR.rglob("*")):
            if not p.is_file() or p.name == "SHA256SUMS":
                continue
            if "__pycache__" in p.parts:
                continue
            sums.append(f"{sha256(p)}  {p.relative_to(OUTDIR)}")
        (OUTDIR / "SHA256SUMS").write_text("\n".join(sums) + "\n")
        print("=== RESCORE SUMMARY ===")
        for arm, label in [("run1", "run1"), ("run2", "run2"), ("pooled", "pooled")]:
            a = scored[arm]
            print(f"{label:7s} errors={a['error_items']:2d} controls={a['control_items']:2d} "
                  f"strict_hits={a['strict_hits']:2d} posthoc_hits={a['posthoc_same_word_hits']:2d} "
                  f"err_flags={a['error_flags']:2d} ctl_fps={a['control_fps']:2d} "
                  f"strict_recall={a['strict_recall']} loose_recall={a['loose_recall']} "
                  f"strict_prec={a['strict_precision']} posthoc_prec={a['posthoc_same_word_precision']} "
                  f"loose_prec={a['loose_precision']}")
        print(f"repeatability: {scored['repeatability']}")
        print(f"wrote {out_path}")
        return

    key = load_key()
    calibration = None
    if not args.skip_calibration:
        print("calibrating audio path ...")
        calibration = asyncio.run(_calibrate(key))
        print(f"  calibration ok={calibration.get('audio_path_ok')} "
              f"text={calibration.get('text','')[:120]!r}")
        if not calibration.get("audio_path_ok"):
            print("WARNING: audio-path calibration failed; results may be invalid.")

    records = []
    t_start = time.time()
    total = len(items) * args.repeats
    k = 0
    journal = (OUTDIR / "records.jsonl").open("w")
    for rep in range(1, args.repeats + 1):
        for it in items:
            k += 1
            rec = call_item(key, it, rep)
            records.append(rec)
            journal.write(json.dumps(rec, ensure_ascii=False) + "\n")
            journal.flush()
            p = rec.get("parsed") or {}
            tag = f"matches={p.get('matches_canonical')} dev={str(p.get('deviation'))[:45]}"
            print(f"[{k:3d}/{total}] r{rep} {it['id']:26s} "
                  f"{'OK ' if rec.get('ok') else 'ERR'} {rec.get('latency_s',0):5.1f}s {tag}",
                  flush=True)
            time.sleep(0.25)
    journal.close()

    items_by_id = {it["id"]: it for it in items}
    scored = score(records, items_by_id)
    result = dict(
        probe="realtime-plus focused-clip phoneme perception",
        run_at_utc=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        model=MODEL,
        callability=dict(
            compatible_mode_http=False,
            native_multimodal_http=False,
            websocket=True,
            http_error="current user api does not support http call",
            websocket_url=URL,
            session_model_confirmed=records[0].get("session_model") if records else None,
            audio_format="pcm16 16 kHz mono, manual turn detection",
        ),
        preregistration=dict(
            seed=SEED, repeats=args.repeats, clip_pad_seconds=PAD,
            prompt=ZOOM_PROMPT,
            selection="12 HJK annotated error occurrences (anchors business@3.36, "
                      "and-del@11.44, suitcase-add@55.21) + 4 held-out substitutions; "
                      "12 HJK controls + 4 held-out controls; controls have no annotated "
                      "phone error and are >=300 ms.",
            strict_definition="asserts deviation AND identifies annotated target->actual "
                              "phone (deletion: target omitted; addition: inserted phone named)",
            loose_definition="asserts any deviation (matches_canonical false or non-null "
                             "deviation/affected_sound)",
            precision_semantics="V1-comparable strict precision = strict hits / all asserted "
                                "deviations, including control flags and type-wrong error flags",
            no_manufactured_pass=True,
        ),
        audio_path_calibration=calibration,
        counts=built["counts"],
        items=[{k: v for k, v in it.items() if k != "prompt"} for it in items],
        scoring=scored,
        elapsed_s=round(time.time() - t_start, 1),
    )
    out_path = OUTDIR / "REALTIME_PROBE_RESULT.json"
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2))

    # SHA256SUMS over probe artefacts (script, result, clips)
    sums = []
    for p in sorted(OUTDIR.rglob("*")):
        if not p.is_file() or p.name == "SHA256SUMS":
            continue
        if "__pycache__" in p.parts:
            continue
        sums.append(f"{sha256(p)}  {p.relative_to(OUTDIR)}")
    (OUTDIR / "SHA256SUMS").write_text("\n".join(sums) + "\n")

    print("\n=== SUMMARY (pre-registered run 1) ===")
    for arm, label in [("run1", "run1"), ("run2", "run2"), ("pooled", "pooled")]:
        a = scored[arm]
        print(f"{label:7s} errors={a['error_items']:2d} controls={a['control_items']:2d} "
              f"strict_hits={a['strict_hits']:2d} posthoc_hits={a['posthoc_same_word_hits']:2d} "
              f"err_flags={a['error_flags']:2d} ctl_fps={a['control_fps']:2d} "
              f"strict_recall={a['strict_recall']} loose_recall={a['loose_recall']} "
              f"strict_prec={a['strict_precision']} posthoc_prec={a['posthoc_same_word_precision']} "
              f"loose_prec={a['loose_precision']}")
    print(f"repeatability: {scored['repeatability']}")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()