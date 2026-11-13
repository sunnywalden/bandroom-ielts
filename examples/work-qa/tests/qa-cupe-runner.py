"""Offline CPU diagnostic runner. No network, labels, or learner data.

The first eight model windows are a real acoustic checkpoint. Resume requires
the same decoded PCM and runtime, and compares every output byte against a
cold run. This establishes transport/recovery, not pronunciation accuracy.
"""
import argparse
import hashlib
import json
import math
import platform
from pathlib import Path
import subprocess
import time


def sha(data):
    return hashlib.sha256(data).hexdigest()


def put_json(path, value):
    data = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    path.write_bytes(data)
    return sha(data)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("stage", choices=("prefix", "resume"))
    p.add_argument("--audio", required=True, type=Path)
    p.add_argument("--input-sha256", required=True)
    p.add_argument("--recipe-sha256", required=True)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--metadata", type=Path)
    p.add_argument("--prefix", type=Path)
    p.add_argument("--run-id")
    p.add_argument("--fence", type=int)
    args = p.parse_args()
    if args.input_sha256 != "55ecb210cf3490448df0372344d2618086709bf2c6112e6f6354e18ac6b232d1":
        raise ValueError("This diagnostic recipe is scoped to the public HJK fixture only")
    import numpy as np
    import torch
    from model2i import CUPEEmbeddingsExtractor
    from windowing import slice_windows
    started = time.monotonic()
    args.out.mkdir(parents=True, exist_ok=True)
    root = Path(__file__).resolve().parent
    provenance = json.loads((root / "provenance.json").read_text())
    for file in provenance["files"]:
        if sha((root / file["name"]).read_bytes()) != file["sha256"]:
            raise ValueError("runtime_file_integrity: " + file["name"])
    original = args.audio.read_bytes()
    if sha(original) != args.input_sha256:
        raise ValueError("original_recording_integrity")
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(args.audio),
        "-f", "f32le", "-ac", "1", "-ar", "16000", "-"], check=True, capture_output=True).stdout
    samples = np.frombuffer(raw, dtype="<f4").copy()
    if not 0 < len(samples) <= 181 * 16000 or not np.isfinite(samples).all():
        raise ValueError("invalid_pcm")
    torch.set_num_threads(2)
    torch.manual_seed(0)
    torch.use_deterministic_algorithms(True)
    runtime = {"python": platform.python_version(), "machine": platform.machine(),
        "torch": str(torch.__version__), "numpy": np.__version__, "threads": 2,
        "ffmpeg": subprocess.run(["ffmpeg", "-version"], check=True, capture_output=True,
        text=True).stdout.splitlines()[0]}
    n = max(1, math.ceil(max(0, len(samples) - 1920) / 1280) + 1)
    padded = (n - 1) * 1280 + 1920
    wave = torch.from_numpy(np.pad(samples, (0, padded-len(samples))))[None, None]
    windows = slice_windows(wave, 16000, 120, 80).squeeze(0)
    model = CUPEEmbeddingsExtractor(str(root / "en_libri1000_ua01c.ckpt"), device="cpu").eval()
    def infer(start, end):
        chunks = []
        with torch.inference_mode():
            for i in range(start, end, 8):
                logits, _ = model.predict(windows[i:min(i + 8, end)])
                chunks.append(logits.cpu().numpy().astype("<f4", copy=False).tobytes())
        return b"".join(chunks)
    prefix_windows = min(8, n)
    current = {"schema": "bandroom.qa.cupe-prefix.v1", "recordingSha256": args.input_sha256,
        "recipeSha256": args.recipe_sha256, "pcmSha256": sha(raw), "samples": len(samples),
        "duration": len(samples)/16000, "windows": n, "prefixWindows": prefix_windows,
        "runtime": runtime, "modelSha256": provenance["modelSha256"],
        "runnerSha256": sha(Path(__file__).read_bytes())}
    if args.stage == "prefix":
        prefix = infer(0, prefix_windows)
        current.update(prefixSha256=sha(prefix), prefixBytes=len(prefix))
        meta_sha = put_json(args.out / "checkpoint-0.json", current)
        (args.out / "checkpoint-1.bin").write_bytes(prefix)
        report = {"stage": "prefix", "metadataSha256": meta_sha, **current,
            "elapsedSeconds": time.monotonic()-started}
    else:
        if not args.metadata or not args.prefix or not args.run_id or not args.fence:
            raise ValueError("resume requires metadata, prefix, run-id and fence")
        prior = json.loads(args.metadata.read_text())
        if any(prior.get(k) != v for k, v in current.items()):
            raise ValueError("runtime_or_pcm_changed; preserve checkpoint and report differences")
        prefix = args.prefix.read_bytes()
        if len(prefix) != prior["prefixBytes"] or sha(prefix) != prior["prefixSha256"]:
            raise ValueError("prefix_integrity")
        resumed = prefix + infer(prefix_windows, n)
        cold = infer(0, n)
        if resumed != cold:
            raise ValueError("cold_resumed_output_mismatch")
        (args.out / "cold-logits.f32le").write_bytes(cold)
        (args.out / "resumed-logits.f32le").write_bytes(resumed)
        # These three anchors originate from the separate public human truth
        # fixture. They are deliberately not CUPE predictions or accuracy claims.
        truth_sha = "394fcb74a4221278aa7df02ead49a3743da6293c527617c7f973b1a52c062e28"
        markers = [{"source": "human_annotation", "truthSha256": truth_sha,
            "word": word, "start": start, "end": end} for word, start, end in
            [("business", 3.36, 3.66), ("and", 11.44, 11.74), ("suitcase", 55.209724, 55.509724)]]
        feedback = "声学链路验收（不代表纠音盲测达标）。已校验原录音与固定模型，完成跨运行检查点恢复；冷启动与续跑声学输出逐字节一致。下方三处为公开人工标注的回听点，不是模型识别结论。"
        output = {"schema": "bandroom.qa.acoustic-output.v1", "mode": "diagnostic",
            "recordingSha256": args.input_sha256, "recipeSha256": args.recipe_sha256,
            "runId": args.run_id, "fence": args.fence, "coldOutputSha256": sha(cold),
            "resumedOutputSha256": sha(resumed), "windows": n, "duration": len(samples)/16000,
            "feedback": feedback, "markers": markers, "pcmSha256": sha(raw),
            "modelSha256": provenance["modelSha256"], "runtime": runtime,
            "rawOutputBytes": len(cold), "prefixSha256": sha(prefix)}
        output_sha = put_json(args.out / "checkpoint-2.json", output)
        report = {"stage": "resume", "outputSha256": output_sha, "coldResumedEqual": True,
            "coldOutputSha256": sha(cold), "rawOutputBytes": len(cold),
            "prefixSha256": sha(prefix), "elapsedSeconds": time.monotonic()-started,
            "windows": n, "duration": len(samples)/16000, "runtime": runtime}
    put_json(args.out / "report.json", report)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
