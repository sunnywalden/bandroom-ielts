"""Speaking scorecard (bandroom-speaking-scorecard-v1).

ELSA-style score-first feedback adapted to the zero-cost honesty contract
(docs/speaking-redesign-2026-11-19.md). ELSA's own assessment dimensions are
Overall / Pronunciation / Intonation / Fluency / Grammar / Vocabulary; we map
them to the four IELTS criteria with a mandatory evidence status per card:

- ``calibrated``  : pause/timing metrics from the human-annotation-calibrated
                    waveform detector (the only numbers presented as measured).
- ``reference``   : disclosed heuristic band estimates over real evidence
                    (calibrated prosody, ASR transcript, quoted LLM analysis).
                    Never an official IELTS score; UI must say 参考估计.
- ``suggestive``  : pronunciation layer — detector T3 candidates and self-listen
                    progress. NO band: phoneme assertion gates (Wilson 95% LB
                    >= 0.70) are unmet, so any pronunciation score would be fake.
- ``asr``         : the Whisper transcript itself, with word probabilities.

Band heuristics are deterministic and auditable (constants below). LLM issues
must quote the transcript verbatim (normalized substring) or they are dropped:
a correction that cannot be traced to what the learner actually said is not
shown. The prose coach prompt still forbids scores; scores live ONLY here.
"""
from __future__ import annotations

import json
import re
from typing import Any, Mapping, Sequence

SCHEMA = "bandroom-speaking-scorecard-v1"

MAX_TRANSCRIPT_WORDS = 2000
MAX_ISSUES = 8
MAX_DRILLS = 3
MAX_QUOTE_CHARS = 300

# Disclosed FC heuristic: speech-ratio base band (IELTS FC descriptors:
# sustained speech with occasional hesitation ~6; frequent long pauses ~5).
_FC_RATIO_BANDS = ((0.70, 7.0), (0.55, 6.5), (0.40, 6.0), (0.25, 5.0))
_FC_BASE_FLOOR = 4.0
_LONG_PAUSE_SECONDS = 1.0
_LONG_PAUSE_RATIO_PENALTY = 0.15  # >15% of recording in >=1s pauses -> -0.5
_BAND_MIN, _BAND_MAX = 3.5, 8.0

STATUS_CALIBRATED = "calibrated"
STATUS_REFERENCE = "reference"
STATUS_SUGGESTIVE = "suggestive"
STATUS_ASR = "asr"

_REFERENCE_DISCLOSURE_ZH = (
    "参考估计：由已校准韵律证据与转写分析按披露的启发式映射得出，非官方雅思评分。"
    "转写来自 ASR，识别误差可能影响语法/词汇判断。"
)
_PRONUNCIATION_DISCLOSURE_ZH = (
    "发音层为建议性反馈：音素断言精度门禁未通过，不给发音分数；"
    "琥珀色词为检测器建议回听（非错误断言），红色仅来自你的自听确认。"
)


def _round_half(value: float) -> float:
    return round(value * 2) / 2


def _clamp_band(value: float) -> float:
    return _round_half(max(_BAND_MIN, min(_BAND_MAX, value)))


def normalize_transcript(words: Sequence[Any]) -> list[dict[str, Any]]:
    """Bound and validate detector/Whisper word timings; drop malformed rows."""
    out: list[dict[str, Any]] = []
    for raw in words or ():
        if not isinstance(raw, Mapping):
            continue
        word = str(raw.get("word") or "").strip()
        if not word or len(word) > 80:
            continue
        try:
            start = float(raw.get("start"))
            end = float(raw.get("end"))
        except (TypeError, ValueError):
            continue
        if not (0 <= start <= end <= 10800):
            continue
        try:
            probability = float(raw.get("probability"))
        except (TypeError, ValueError):
            probability = 0.0
        if not 0 <= probability <= 1:
            probability = 0.0
        out.append({
            "word": word,
            "start": round(start, 3),
            "end": round(end, 3),
            "probability": round(probability, 4),
        })
        if len(out) >= MAX_TRANSCRIPT_WORDS:
            break
    return out


def transcript_text(words: Sequence[Mapping[str, Any]]) -> str:
    return " ".join(str(w.get("word") or "") for w in words).strip()


def _clean_text(value: str, limit: int = MAX_QUOTE_CHARS) -> str:
    """Strip control characters and collapse whitespace in LLM free text.

    Defense-in-depth for the learner-draft prompt-injection surface: whatever
    the model returns for fix/improved/reason is stored and (for improved)
    synthesized by TTS. Length is bounded and control bytes are removed; the
    text stays plain prose the learner reads about their own answer.
    """
    text = re.sub(r"[\x00-\x1f\x7f]", " ", str(value))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def _norm_quote(text: str) -> str:
    """Lowercase, drop punctuation (keep apostrophes), collapse whitespace.

    Punctuation-insensitive so a quote spanning a sentence boundary still
    traces to the transcript; word boundaries are enforced at match time so a
    mid-word fragment ("choo" inside "school") can never pass as verbatim.
    """
    cleaned = re.sub(r"[^a-z0-9'\s]", " ", str(text).lower())
    return re.sub(r"\s+", " ", cleaned).strip()


def _quote_in_transcript(quote: str, text: str) -> bool:
    target = _norm_quote(quote)
    haystack = _norm_quote(text)
    if not target:
        return False
    pattern = r"(?<![a-z0-9'])" + re.escape(target) + r"(?![a-z0-9'])"
    return re.search(pattern, haystack) is not None


def fluency_card(
    calibrated: Mapping[str, Any], word_count: int
) -> dict[str, Any]:
    """FC card: calibrated pause/timing evidence + disclosed reference band."""
    total = float(calibrated.get("total_duration_seconds") or 0.0)
    speech = float(calibrated.get("speech_duration_seconds") or 0.0)
    ratio = float(calibrated.get("speech_ratio") or 0.0)
    if total <= 0 or speech <= 0:
        # No usable measurement (e.g. a broken instrument or a silent upload):
        # NEVER translate that into a low band. Refuse to score the criterion.
        return {
            "key": "fluency_coherence",
            "label_zh": "流利度与连贯性",
            "band": None,
            "status": STATUS_REFERENCE,
            "evidence": {
                "speech_ratio": round(ratio, 4),
                "speech_duration_seconds": round(speech, 3),
                "total_duration_seconds": round(total, 3),
                "pause_count": int(calibrated.get("pause_count") or 0),
                "pause_seconds": round(float(calibrated.get("pause_seconds") or 0.0), 3),
                "metrics_status": STATUS_CALIBRATED,
                "pace_wpm": None,
                "pace_status": "uncalibrated",
            },
            "disclosure_zh": "本次未测得可用语音（语音时长或总时长为 0），流利度不评分；请确认录音设备后重录。",
        }
    pause_count = int(calibrated.get("pause_count") or 0)
    pause_seconds = float(calibrated.get("pause_seconds") or 0.0)
    pauses = calibrated.get("pauses") or []
    long_pause_seconds = sum(
        float(p.get("seconds") or 0.0)
        for p in pauses
        if isinstance(p, Mapping) and float(p.get("seconds") or 0.0) >= _LONG_PAUSE_SECONDS
    )
    base = _FC_BASE_FLOOR
    for threshold, band in _FC_RATIO_BANDS:
        if ratio >= threshold:
            base = band
            break
    if total > 0 and long_pause_seconds / total > _LONG_PAUSE_RATIO_PENALTY:
        base -= 0.5
    pace_wpm = round(word_count / speech * 60, 1) if speech > 0 and word_count else None
    return {
        "key": "fluency_coherence",
        "label_zh": "流利度与连贯性",
        "band": _clamp_band(base),
        "status": STATUS_REFERENCE,
        "evidence": {
            "speech_ratio": round(ratio, 4),
            "speech_duration_seconds": round(speech, 3),
            "total_duration_seconds": round(total, 3),
            "pause_count": pause_count,
            "pause_seconds": round(pause_seconds, 3),
            "long_pause_seconds": round(long_pause_seconds, 3),
            "metrics_status": STATUS_CALIBRATED,
            "pace_wpm": pace_wpm,
            "pace_status": "uncalibrated",
        },
        "disclosure_zh": _REFERENCE_DISCLOSURE_ZH,
    }


def lexical_card(
    words: Sequence[Mapping[str, Any]], issues: Sequence[Mapping[str, Any]]
) -> dict[str, Any]:
    tokens = [
        re.sub(r"[^a-z']", "", str(w.get("word") or "").lower())
        for w in words
    ]
    tokens = [t for t in tokens if t]
    word_count = len(tokens)
    ttr = round(len(set(tokens)) / word_count, 4) if word_count else 0.0
    band = 6.0
    if word_count >= 60 and ttr >= 0.60:
        band += 1.0
    elif word_count >= 30 and ttr >= 0.55:
        band += 0.5
    band -= min(1.5, 0.5 * len(issues))
    return {
        "key": "lexical_resource",
        "label_zh": "词汇",
        "band": _clamp_band(band),
        "status": STATUS_REFERENCE,
        "evidence": {
            "word_count": word_count,
            "type_token_ratio": ttr,
            "issues": list(issues),
        },
        "disclosure_zh": _REFERENCE_DISCLOSURE_ZH,
    }


def grammar_card(issues: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    penalty = sum(
        1.0 if str(i.get("severity") or "minor") == "major" else 0.5
        for i in issues
    )
    return {
        "key": "grammar",
        "label_zh": "语法",
        "band": _clamp_band(7.0 - penalty),
        "status": STATUS_REFERENCE,
        "evidence": {"error_count": len(issues), "issues": list(issues)},
        "disclosure_zh": _REFERENCE_DISCLOSURE_ZH,
    }


def pronunciation_card(candidate_count: int) -> dict[str, Any]:
    """P card: NEVER a band while assertion gates are unmet."""
    return {
        "key": "pronunciation",
        "label_zh": "发音",
        "band": None,
        "status": STATUS_SUGGESTIVE,
        "evidence": {"self_listen_candidates": candidate_count},
        "disclosure_zh": _PRONUNCIATION_DISCLOSURE_ZH,
    }


def validate_issues(
    raw: Any, text: str, *, kind: str
) -> list[dict[str, Any]]:
    """Keep only issues whose quote is a verbatim transcript substring.

    Fail-closed: an untraceable "correction" is dropped, never shown.
    """
    if not isinstance(raw, (list, tuple)):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, Mapping):
            continue
        quote = _clean_text(item.get("quote") or "")
        if not quote:
            continue
        if not _quote_in_transcript(quote, text):
            continue
        if kind == "grammar":
            fix = _clean_text(item.get("fix") or "")
            reason = _clean_text(item.get("reason_zh") or "")
            if not fix:
                continue
            severity = str(item.get("severity") or "minor")
            if severity not in {"major", "minor"}:
                severity = "minor"
            out.append({
                "quote": quote, "fix": fix,
                "reason_zh": reason, "severity": severity,
            })
        else:
            suggestion = _clean_text(item.get("suggestion") or "")
            reason = _clean_text(item.get("reason_zh") or "")
            if not suggestion:
                continue
            out.append({
                "quote": quote, "suggestion": suggestion,
                "reason_zh": reason,
            })
        if len(out) >= MAX_ISSUES:
            break
    return out


def validate_drills(raw: Any, text: str) -> list[dict[str, Any]]:
    if not isinstance(raw, (list, tuple)):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, Mapping):
            continue
        quote = _clean_text(item.get("quote") or "")
        improved = _clean_text(item.get("improved") or "")
        focus = _clean_text(item.get("focus_zh") or "")
        if not quote or not improved:
            continue
        if not _quote_in_transcript(quote, text):
            continue
        out.append({"quote": quote, "improved": improved, "focus_zh": focus[:MAX_QUOTE_CHARS]})
        if len(out) >= MAX_DRILLS:
            break
    return out


def parse_scorecard_llm(raw: str) -> dict[str, Any]:
    """Parse the structured analysis call; raise ValueError on bad shape."""
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`").removeprefix("json").strip()
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("scorecard LLM output is not an object")
    return value


def build_scorecard(
    *,
    calibrated: Mapping[str, Any],
    words: Sequence[Mapping[str, Any]],
    llm: Mapping[str, Any] | None,
    candidate_count: int,
) -> dict[str, Any]:
    """Assemble the scorecard. Degrades honestly when transcript/LLM absent."""
    text = transcript_text(words)
    grammar_issues = validate_issues((llm or {}).get("grammar_issues"), text, kind="grammar")
    lexical_issues = validate_issues((llm or {}).get("lexical_issues"), text, kind="lexical")
    drills = validate_drills((llm or {}).get("drills"), text)

    cards = [fluency_card(calibrated, len(words))]
    if words:
        cards.append(lexical_card(words, lexical_issues))
        cards.append(grammar_card(grammar_issues))
    cards.append(pronunciation_card(candidate_count))

    band_cards = [c for c in cards if c.get("band") is not None]
    overall = (
        _clamp_band(sum(c["band"] for c in band_cards) / len(band_cards))
        if band_cards else None
    )
    # Derive the label from what was actually averaged: pronunciation is never
    # scored, and FC refuses to score without measurable speech, so a fixed
    # "四科" label would misdescribe the evidence.
    scored_labels = [str(c.get("label_zh") or c.get("key")) for c in band_cards]
    if scored_labels:
        basis = "、".join(scored_labels) + "参考估计均值"
        if not any(c.get("key") == "fluency_coherence" and c.get("band") is not None for c in cards):
            basis += "（本次未测得可用语音，流利度不参与）"
    else:
        basis = "无可估科目"
    return {
        "schema": SCHEMA,
        "overall": {
            "band": overall,
            "status": STATUS_REFERENCE,
            "disclosure_zh": _REFERENCE_DISCLOSURE_ZH,
            "basis_zh": basis,
        },
        "criteria": cards,
        # The full word list travels once in groundedAnalysis.transcript; the
        # card only marks provenance. Embedding a 2000-word copy here pushed the
        # card past the transport's 64 KiB cap for long recordings.
        "transcript": {
            "source": "whisper-large-v3-turbo",
            "status": STATUS_ASR,
        } if words else None,
        "drills": drills,
        "llm_status": "ok" if llm is not None else "unavailable",
    }


SCORECARD_SYSTEM_PROMPT = """你是一名严谨的英语口语教练，正在分析学习者的口语转写。只输出一个严格 JSON 对象，不要 Markdown、不要解释。

JSON 结构：
{"grammar_issues":[{"quote":"逐字引自转写的英文片段","fix":"更正确的英文写法","reason_zh":"中文原因，一句","severity":"major|minor"}],"lexical_issues":[{"quote":"逐字引自转写的英文片段","suggestion":"更自然的用词/表达","reason_zh":"中文原因，一句"}],"drills":[{"quote":"逐字引自转写的一个完整句子或从句","improved":"更自然的完整英文句子","focus_zh":"这句练什么，中文一句"}]}

硬性规则：
1. quote 必须是转写中逐字出现的片段（大小写/空白可忽略），不得改写、不得编造转写里没有的词。
2. 只评语法与词汇，不评发音：不得提及任何音素、读音错误、口音；发音由系统另行处理。
3. grammar_issues 最多 8 条，只报真实错误（时态、主谓一致、冠词、介词、词序等）；severity=major 仅用于影响理解的错误。
4. lexical_issues 最多 8 条，只报真实可改进的用词（重复、搭配不当、语域不符）。
5. drills 最多 3 条，选学习者最值得练的句子；improved 保留原意。
6. 没有问题的类别给空数组。reason_zh/focus_zh 用中文。"""


def build_scorecard_prompt(
    words: Sequence[Mapping[str, Any]],
    calibrated: Mapping[str, Any],
    *,
    learner_draft: str = "",
) -> tuple[str, str]:
    text = transcript_text(words)
    ratio = calibrated.get("speech_ratio")
    pauses = calibrated.get("pause_count")
    user = (
        f"【口语转写（Whisper，可能含识别误差）】\n{text}\n\n"
        f"【已校准韵律证据】语音占比 {ratio}，停顿 {pauses} 个。\n"
    )
    if learner_draft.strip():
        user += f"\n【学习者提交的文字草稿（仅供对照，引文必须来自转写）】\n{learner_draft.strip()[:2000]}\n"
    return SCORECARD_SYSTEM_PROMPT, user
