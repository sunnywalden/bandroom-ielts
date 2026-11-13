"""Create a deterministic, immutable private QA bundle; never put weights in Git."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--source", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    a = p.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    files = {name: (a.source/name).read_bytes() for name in
        ["model2i.py", "model_utils.py", "windowing.py", "LICENSE", "README.md", "en_libri1000_ua01c.ckpt"]}
    model_sha = "7ed14d8ffe603bda67e687ec084d2c5eeab3e04bfab2389af69479f31ec764dd"
    if sha(files["en_libri1000_ua01c.ckpt"]) != model_sha:
        raise ValueError("weight mismatch")
    files["qa-cupe-runner.py"] = Path(__file__).with_name("qa-cupe-runner.py").read_bytes()
    provenance = {"schema": "bandroom.qa.cupe-provenance.v1", "scope": "G3 diagnostic only; not a qualified pronunciation analyzer",
        "modelSha256": model_sha, "sourceRevision": "56f6291afb3b3519fcad88c377dee5c86a9cde14",
        "modelRevision": "772503ad6605916b88b81b1855f81533243069be", "license": "GPL-3.0",
        "files": [{"name": name, "sha256": sha(data), "byteLength": len(data)} for name, data in sorted(files.items())]}
    files["provenance.json"] = json.dumps(provenance, sort_keys=True, separators=(",", ":")).encode()
    archive = a.out/"cupe-qa.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as z:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            z.writestr(info, data)
    raw = archive.read_bytes()
    parts = []
    for i in range(0, len(raw), 6*1024*1024):
        part = raw[i:i+6*1024*1024]
        digest = sha(part)
        (a.out/(digest+".part")).write_bytes(part)
        parts.append({"sha256": digest, "byteLength": len(part)})
    manifest = {"schema": "bandroom.qa.analysis-bundle.v1", "bundleSha256": sha(raw),
        "byteLength": len(raw), "parts": parts, "provenance": provenance,
        "format": "zip", "entrypoint": "qa-cupe-runner.py", "requires": ["Python 3", "torch", "numpy", "ffmpeg"]}
    data = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    (a.out/"manifest.json").write_bytes(data)
    recipe = {"schema": "bandroom.qa.hjk-recipe.v24", "manifestSha256": sha(data),
        "bundleSha256": sha(raw), "modelSha256": model_sha,
        "inputSha256": "55ecb210cf3490448df0372344d2618086709bf2c6112e6f6354e18ac6b232d1",
        "algorithm": "120ms windows, 80ms stride, batch 8, CPU 2 threads, first 8 checkpoint, cold/resumed byte equality",
        "scope": "G3 acoustic diagnostic; human anchors explicitly attributed; no G2 quality claim"}
    recipe_data = json.dumps(recipe, sort_keys=True, separators=(",", ":")).encode()
    (a.out/"recipe.json").write_bytes(recipe_data)
    print(json.dumps({"manifestSha256": sha(data), "bundleSha256": sha(raw),
        "recipeSha256": sha(recipe_data), "byteLength": len(raw), "parts": len(parts)}))


if __name__ == "__main__":
    main()
