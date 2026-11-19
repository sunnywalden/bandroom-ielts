"""Offline tests for the restructured G1 (rev2) — no model calls."""
from runner import gate1_restructured as g1r


def test_within1_agreement_perfect_and_poor():
    good = {"s1": {"evidence": [4, 4, 5], "correction": [5, 5, 5]}}
    a = g1r.within1_agreement(good)
    assert a["within1_fraction"] == 1.0
    assert a["fleiss_kappa"] is None or -1.0 <= a["fleiss_kappa"] <= 1.0
    poor = {"s1": {"evidence": [1, 3, 5], "correction": [1, 4, 5]}}
    assert g1r.within1_agreement(poor)["within1_fraction"] == 0.0


def test_fleiss_kappa_perfect_agreement():
    counts = [[3, 0, 0, 0, 0], [0, 0, 3, 0, 0], [0, 0, 0, 0, 3]]
    k = g1r.fleiss_kappa(counts)
    assert k is not None and k > 0.9


def test_bootstrap_ci_constant_and_contains_mean():
    assert g1r.bootstrap_ci([4.0, 4.0, 4.0]) == (4.0, 4.0)
    lo, hi = g1r.bootstrap_ci([3.0, 4.0, 5.0])
    assert lo <= 4.0 <= hi


def test_bootstrap_ni_ci_equal_and_superior():
    lo, hi = g1r.bootstrap_ni_ci([4, 4, 4], [4, 4, 4])
    assert lo <= 0 <= hi
    lo2, _ = g1r.bootstrap_ni_ci([5, 5, 5], [4, 4, 4])
    assert lo2 > 0


def test_anchor_requires_timed_hit():
    truth = {"events": [{"word": "business", "startMs": 3360}]}
    timed = {"id": "hjk", "feedback": "business at 0:03 is stressed", "pronunciation": {}}
    untimed = {"id": "hjk", "feedback": "business is stressed", "pronunciation": {}}
    other = {"id": "x", "feedback": "", "pronunciation": {}}
    assert g1r.anchor_timed_ok(timed, truth) is True
    assert g1r.anchor_timed_ok(untimed, truth) is False
    assert g1r.anchor_timed_ok(other, truth) is True


def test_sha256_dedup(tmp_path):
    a = tmp_path / "a.webm"; b = tmp_path / "b.webm"; c = tmp_path / "c.webm"
    a.write_bytes(b"same"); b.write_bytes(b"same"); c.write_bytes(b"diff")
    ha, hb, hc = (g1r.sha256_file(p) for p in (a, b, c))
    assert ha == hb and ha != hc


def test_critical_majority():
    assert g1r.critical_majority(["glm", "kimi"]) is True
    assert g1r.critical_majority(["glm"]) is False
    assert g1r.critical_majority(["glm", "glm"]) is False  # distinct judges
    assert g1r.critical_majority([]) is False


def test_quote_policy():
    l0 = [{"id": "a", "issues": ["mostly_unverified_quotes:0.10"], "pass": False},
          {"id": "b", "issues": ["mostly_unverified_quotes:0.30"], "pass": False},
          {"id": "c", "issues": ["overall_band_claim"], "pass": False}]
    out = g1r.apply_quote_policy(l0)
    assert out[0]["pass"] is False                      # <0.2 blocking
    assert out[1]["pass"] is True and out[1]["advisory"]  # 0.2-0.4 advisory
    assert out[2]["pass"] is False                      # other issue stays


def test_dedup_keeps_earliest():
    samples = [{"id": "p2", "audio_file": "a"}, {"id": "fu", "audio_file": "b"}, {"id": "hjk", "audio_file": "c"}]
    hashes = {"a": "H", "b": "H", "c": "K"}
    kept, dropped = g1r.dedup_samples(samples, hashes)
    assert [s["id"] for s in kept] == ["p2", "hjk"]
    assert dropped == ["fu"]


def test_corroborated_l3():
    assert g1r.corroborated_l3({"falsified": True, "items": [{"claim": "x", "why_wrong": "y"}]}) is True
    assert g1r.corroborated_l3({"falsified": True, "items": []}) is False
    assert g1r.corroborated_l3({"falsified": False}) is False


def test_decision_table():
    base = dict(missing=False, l0_pass=True, anchor_full=True, l1_pass=True, l3_pass=True, escalate=False, underpowered=False)
    assert g1r.decide(**base) == ("PASS", "G1-automated(machine-panel)")
    assert g1r.decide(**{**base, "underpowered": True})[1].endswith("[indicative]")
    assert g1r.decide(**{**base, "missing": True})[0] == "ERROR"
    assert g1r.decide(**{**base, "anchor_full": False})[0] == "FAIL"
    assert g1r.decide(**{**base, "l0_pass": False})[0] == "FAIL"
    assert g1r.decide(**{**base, "l1_pass": False})[0] == "FAIL"
    assert g1r.decide(**{**base, "l3_pass": False})[0] == "FAIL"
    assert g1r.decide(**{**base, "escalate": True})[0] == "ESCALATE"
