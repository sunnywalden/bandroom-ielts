#!/usr/bin/env python3
"""Tests for the V3 gate: fail-closed on inadequate data, runs on adequate data."""
import json, pathlib, random, shutil, subprocess, sys, tempfile

B = pathlib.Path(__file__).resolve().parent
P = B / "v3_gate.py"
# Fixtures go to a temp dir so running the tests never litters the checkout.
T = pathlib.Path(tempfile.mkdtemp(prefix="v3gate-test-"))


def run(mode, data=None):
    cmd = [sys.executable, "-I", str(P), mode] + ([str(data)] if data else [])
    r = subprocess.run(cmd, capture_output=True, text=True)
    # module prints JSON then a trailing "wrote ..." line; take the first JSON object
    out = r.stdout
    try:
        obj, _ = json.JSONDecoder().raw_decode(out.lstrip())
    except Exception:
        obj = None
    return r.returncode, obj, r.stderr


def mk(uid, nsess=3, n=25, rng=None):
    ss = []
    for k in range(nsess):
        cs, vs = [], []
        for j in range(n):
            cid = f"{uid}_s{k}_c{j}"
            truth = rng.random() < 0.65
            cs.append({"candidateId": cid, "word": "the", "expected": "DH", "actual": "D",
                       "atMs": 1000 * j, "detectorConfidence": 0.9,
                       "groundTruth": {"isTrueError": truth, "annotatedBy": "human",
                                        "intervalStartMs": 1000 * j, "intervalEndMs": 1000 * j + 100}})
            if k < nsess - 1:
                vs.append({"candidateId": cid, "verdict": "confirmed" if truth else "rejected",
                           "isCatchTrial": False})
        ss.append({"sessionId": f"s{k}", "recordedAt": f"2026-11-{10+k:02d}T00:00:00Z",
                   "candidates": cs, "verdicts": vs})
    return {"userId": uid, "sessions": ss}


def main():
    fails = []
    rc, obj, _ = run("schema")
    print("1. schema:", "PASS" if rc == 0 and obj else "FAIL")
    if rc != 0: fails.append("schema")

    rng = random.Random(1)
    single = {"schema": "bandroom-v3-multisession-v1",
              "users": [mk(f"u{i}", nsess=1, rng=rng) for i in range(8)]}
    (T / "t_single.json").write_text(json.dumps(single))
    rc, obj, _ = run("check", T / "t_single.json")
    ok = rc == 1 and obj and obj["adequate"] is False
    print("2. check refuses single-session:", "PASS" if ok else "FAIL")
    if not ok: fails.append("check-single")
    rc, obj, _ = run("evaluate", T / "t_single.json")
    ok = obj and obj.get("executed") is False and "refusal_reason" in obj
    print("3. evaluate refuses single-session:", "PASS" if ok else "FAIL")
    if not ok: fails.append("eval-single")

    # too few users
    few = {"schema": "bandroom-v3-multisession-v1", "users": [mk(f"u{i}", rng=rng) for i in range(3)]}
    (T / "t_few.json").write_text(json.dumps(few))
    rc, obj, _ = run("check", T / "t_few.json")
    ok = rc == 1 and obj and obj["adequate"] is False
    print("4. check refuses <6 users:", "PASS" if ok else "FAIL")
    if not ok: fails.append("check-few")

    # detector-labelled ground truth must be rejected
    bad = {"schema": "bandroom-v3-multisession-v1", "users": [mk(f"u{i}", rng=rng) for i in range(8)]}
    for u in bad["users"]:
        for c in u["sessions"][-1]["candidates"]:
            c["groundTruth"]["annotatedBy"] = "detector"
    (T / "t_badgt.json").write_text(json.dumps(bad))
    rc, obj, _ = run("check", T / "t_badgt.json")
    ok = rc == 1 and obj and obj["adequate"] is False
    print("5. check refuses non-human ground truth:", "PASS" if ok else "FAIL")
    if not ok: fails.append("check-gt")

    # adequate synthetic data
    good = {"schema": "bandroom-v3-multisession-v1", "users": [mk(f"u{i}", rng=rng) for i in range(8)]}
    (T / "t_multi.json").write_text(json.dumps(good))
    rc, obj, _ = run("check", T / "t_multi.json")
    ok = rc == 0 and obj and obj["adequate"] is True
    print("6. check accepts adequate multi-session:", "PASS" if ok else "FAIL")
    if not ok:
        fails.append("check-multi")
        print("   problems:", obj.get("problems") if obj else None)

    rc, obj, _ = run("evaluate", T / "t_multi.json")
    ok = obj and obj.get("executed") is True and "verdict" in obj
    print("7. evaluate runs on adequate data:", "PASS" if ok else "FAIL")
    if ok:
        v = obj["verdict"]
        print("   synthetic verdict:", json.dumps({k: v[k] for k in
              ("users_evaluated", "users_with_nonempty_t2", "mean_gain", "gain_ci_lower", "mean_t2_precision", "PASS")}, ensure_ascii=False))
        print("   consequence:", v["consequence"])
        # synthetic data has truthful confirmations, so promotion should work;
        # we only assert the machinery ran and produced a decision, not that it passes
        if not isinstance(v["PASS"], bool): fails.append("verdict-shape")
    else:
        fails.append("eval-multi")

    shutil.rmtree(T, ignore_errors=True)
    print("\nRESULT:", "ALL PASS" if not fails else f"FAILURES: {fails}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
