# G3-local / G5-owner-attested toolchain (new contract, P4)

New namespace: **`bandroom-d2-local-attestation-v1`**
Protocol label: **`G5-owner-attested(single-root-four-key)`**
Identity scope: **`local-attestation`**

This directory is a **derived, versioned** toolchain. Rev2 §8.1 freezes the
formal artifacts (`acceptance-2026-11-10/iteration-23/run-side/export_g5_evidence.py`,
`analysis/scripts/verify_cloud_release.py`, `analysis/scripts/verify_release.py`,
and the V3 gates). The frozen verifier hardcodes cloud identity
(`source == "scheduled-cloud"`, `clientExecution is False`, `cloud-executor`,
`localExecution is False`), so a Mac-local run can **never** pass it. That is
why this is a NEW contract, not a re-verification. Nothing frozen is edited or
imported; `export_g5_evidence_qa.py` is the derivation precedent.

## 1. Files

| File | Role |
| --- | --- |
| `export_g5_evidence_local.py` | Derived exporter. New namespace, clause map, informational M4-local profile, single-root disclosure, separate `check_local()`. Never signs, never contacts the network. |
| `verify_local_release.py` | Derived verifier. Signers-outside-bundle, exact four-role set, four distinct Ed25519 keys, `ssh-keygen -Y verify` per role, SHA256SUMS recomputation, local-execution attestation instead of cloud identity. Prints the single-root disclosure. |
| `gen_local_keys.py` | Generates four distinct Ed25519 keys, one per frozen role, private keys under `~/.bandroom-g5-local/keys/<role>/` (0700 dirs, 0600 files), public keys + `allowed-signers` outside the bundle. Never prints private material. |
| `seal_local_bundle.py` | Separate signing / seal step. Four detached signatures into the PRIVATE bundle; copies only public artifacts (verifier, manifest hashes, public keys) to the public directory. |
| `g5_observation_eval.py` | Independent G5 24h evaluator (separate instance from the production evaluator; env-configurable window/verdict paths so it coexists with production window #10). |
| `reverify_local_cd.py` | Drives the existing local machinery (`qa_v26_hjk_cloud_v2.py`) for the retained C/D clauses and records pass/fail/waiver honestly. |
| `test_g5_local.py` | Tests for all of the above. |

## 2. Role model and the single-root loss of trust

The **frozen four role names** are kept verbatim:

* `release-owner`
* `holdout-custodian`
* `work-auditor`
* `site-auditor`

There are **four distinct Ed25519 keys**, all generated on one machine. Under
the approved Z-D4 model the lost properties are explicit and non-negotiable:

* a **single compromise** forges all four signatures and a package that passes
  verification;
* an external verifier **cannot distinguish an honest package from a forged
  one from the bundle alone**;
* trust comes from **public reproducibility + owner attestation**, **NOT**
  multi-party independence.

Z-D9 (one key on an independent device) is optional; if declined, this
disclosure is the final state. The verifier prints it on every run and the
manifest embeds it.

## 3. Signers-outside rule (frozen N10)

`verify_local_release.py` enforces:

```python
require(not trusted_signers.resolve().is_relative_to(bundle.resolve()),
        "the allowed-signers file must be distributed outside the evidence bundle")
```

The `allowed-signers` file (`<role> ssh-ed25519 <base64>` per line) is never
written inside the bundle. It is produced outside the bundle by
`gen_local_keys.py` and must be delivered over a separate channel. An external
verifier can also rebuild it from the published public keys.

## 4. Public vs private artifacts

**Private (never published)** — this bundle can contain model-derived output
and would redistribute non-commercial/CC-BY-SA material if published:

```
private/bundle/
  manifest.json
  local-evidence.json
  clause-map.json
  runtime-profile.json
  cold-output.bin  resumed-output.bin  d-local-output.bin   (when measured)
  <role>.sig x4
  SHA256SUMS
```

**Public (safe to distribute)** — exactly verifier + manifest hashes + public
keys:

```
public/
  verify_local_release.py     # the verifier itself
  manifest.sha256             # sha256 of manifest.json bytes
  SHA256SUMS                  # every bundle file digest
  keys/<role>.pub             # four public keys
  keys/key-manifest.json      # role -> public key + fingerprint
  allowed-signers             # optional; still OUTSIDE the bundle
```

Publishing `cold-output.bin`/`resumed-output.bin` (model output) or any
model/runtime weights inside the private bundle would cross the CROTTC
"non-commercial only", WavLM CC BY-SA and L2-ARCTIC NC licence boundaries.
The public split deliberately excludes them.

## 5. Sealing and verifying

```bash
# 1. four keys (once; rotation invalidates old signatures)
python3 analysis/scripts/g5-local/gen_local_keys.py

# 2. build the private bundle from local evidence
python3 analysis/scripts/g5-local/export_g5_evidence_local.py \
  --build --run-dir ~/.bandroom-g5-local/work/export-input \
  --out ~/.bandroom-g5-local/seal/private/bundle

# 3. sign four roles + split public artifacts
python3 analysis/scripts/g5-local/seal_local_bundle.py \
  --bundle ~/.bandroom-g5-local/seal/private/bundle \
  --public ~/.bandroom-g5-local/seal/public \
  --signers ~/.bandroom-g5-local/allowed-signers

# 4. verify (external party needs only the verifier + manifest hashes + pubkeys)
python3 analysis/scripts/g5-local/verify_local_release.py \
  --evidence ~/.bandroom-g5-local/seal/private/bundle \
  --trusted-signers ~/.bandroom-g5-local/allowed-signers --json
```

An external party reproduces verification from the **public** artifacts only:

1. obtain `public/verify_local_release.py`, `public/SHA256SUMS`,
   `public/manifest.sha256`, `public/keys/*.pub`;
2. obtain the `allowed-signers` file over a separate channel (or rebuild it as
   `"<role> ssh-ed25519 <key>"` from the published public keys);
3. run the verifier against the evidence bundle and the signers file.

The verifier recomputes every `manifest.files` digest, re-verifies the four
detached signatures over the exact `manifest.json` bytes, checks the clause map
and informational profile, and rejects a signers file that lives inside the
bundle.

## 6. G3-local clause mapping (rev2 §8.2)

`clause-map.json` is generated on every build. **Replaced** clauses (all
approved by Z-D6 unless noted) each name the lost property and a disclosure:

| id | replaced frozen clause | local substitute | Z-D |
| --- | --- | --- | --- |
| `G3-M9-no-host` | M9: no local execution | local runner execution is the subject | Z-D6 |
| `G3-scheduled-cloud-identity` | `scheduled-cloud` / `clientExecution=false` / A-B-C | local scheduler wake equivalent | Z-D6 |
| `G3-chrome-5.2-two-human` | Chrome §5.2 two independent human listeners | machine-panel double-codec check (labelled substitution, not a silent waiver) | Z-D6 |
| `G3-M4-matrix` | coldTrials ≥ 3, 300 s, 900 s | **informational** measurement protocol | Z-D5 |
| `G3-D-cloud-bytes` | cloud-bytes reference run | D-local (local assets complete) | Z-D6 |

**Retained** clauses are evaluated from local evidence as `pass` / `fail` /
`waived`; a waived clause is explicit and is **never counted as a pass**:

* `G3-fence-monotonic`
* `G3-C-cold-equals-resumed` (byte-equal)
* `G3-D-local-same-sha`
* `G3-writeback-idempotent`
* `G3-writeback-lost-replay`
* `G3-writeback-old-fence-reject`

`D-local` is disclosed as a **same-host second-process determinism check, NOT
independent-party replication**.

## 7. M4-local is informational (Z-D5)

`runtime-profile.json` has `status: "informational"`, `gateRole: "none"`, and
`frozenRuntimeProfile.claimed: false`. It records the preregistered measurement
protocol (fresh VM, no pip/model cache, weights inclusion stated, 3 cold trials
per encoding, 300 s/900 s budgets) without pretending to fill the frozen
`runtimeProfile` schema. `check_local()` and `verify_local_release.py` fail if
anyone puts a fabricated `coldTrials` field or claims the frozen schema.

## 8. Independent G5 24h evaluator

`g5_observation_eval.py` is a separate instance, not a reuse of the production
evaluator. It is env-configurable so it coexists with production window #10:

| env | default |
| --- | --- |
| `BANDROOM_G5_WINDOW` | `~/.bandroom-acoustic/G5_OBSERVATION_WINDOW.json` |
| `BANDROOM_G5_VERDICT` | `~/.bandroom-acoustic/G5_OBSERVATION_WINDOW_VERDICT.json` |
| `BANDROOM_G5_WAKES` | optional separate wake log |
| `BANDROOM_G5_LAUNCHD_LABEL` | `com.bandroom.g5-scheduler` |
| `BANDROOM_G5_HEALTH_URL` | optional; adds criterion C7 |

G5-specific criteria are frozen: C1 full 24 h elapsed, C2 ≥ 3 local scheduled
wakes, C3 wake span ≥ 86400 s, C4 no manual intervention, C5 fail-closed with
no fatal wake, C6 local scheduler alive, optional C7 health endpoint. A verdict
is written only at/after `scheduled_end`, once per window; a missing
measurement is a FAILED criterion, never an inferred pass. The hardened
transport patterns (browser `PROBE_UA`, no-redirect opener, transport-only
retries) are inherited as a new versioned profile.

## 8.1 Independent G5 24h launchd window (iteration-27 closure)

`run-g5-observation-eval.sh` opens and drives a genuinely independent 24h
window without touching the production window (`~/.bandroom-acoustic/`):

- launchd label `com.bandroom.g5-observation-eval`, `StartInterval` 1800,
  `RunAtLoad` true;
- state under `~/.bandroom-g5-local/observation/` (`window.json`, `wakes.json`,
  `verdict.json`, `logs/`);
- the first scheduled wake opens the window (`start`=wake time,
  `scheduled_end`=+24h) and records a local-scheduler wake; every subsequent
  wake appends one wake record, then runs `g5_observation_eval.py`;
- once a verdict exists for the window the job goes quiescent (no further
  wakes, no re-evaluation).

macOS TCC: launchd cannot read `~/Documents`. The canonical source lives here;
the live copies are mirrored byte-identical to
`~/.bandroom-g5-local/bin/{run-g5-observation-eval.sh,g5_observation_eval.py}`
and the installed plist is
`~/Library/LaunchAgents/com.bandroom.g5-observation-eval.plist`. The evaluator
never reads or writes `~/.bandroom-acoustic/OBSERVATION_WINDOW*.json`.
`BANDROOM_G5_HEALTH_URL` is deliberately unset (C7 off): no production probe.

## 9. Local C/D result (this machine)

Run:

```bash
python3 analysis/scripts/g5-local/reverify_local_cd.py
```

It uses `qa_v26_hjk_cloud_v2.py` with a dedicated venv carrying
`onnxruntime==1.24.4` (`BANDROOM_G5_LOCAL_PYTHON` overrides; default
`~/.bandroom-g5-local/venv/bin/python`).

Measured 2026-11-19 (source `~/.bandroom-acoustic/score-sandbox/fixtures/hjk.wav`,
sha256 `82d5690d…`, 859 windows):

| clause | result |
| --- | --- |
| C cold == resumed | **PASS**, byte-equal, `768210edb3cb9cc636c82e4a0becf11c2071f498aa72178566758b444cf2ae22` (1,718,000 B) |
| D-local second process same SHA | **PASS**, same SHA |
| fence monotonic | WAIVED — no server lease/fence log locally |
| writeback idempotence / lost-replay / old-fence-reject | WAIVED — server-side, needs the Worker/DB harness |

Honest notes:

* The output SHA differs from the earlier `1556890f…` proof because the local
  input is the WAV fixture and the active runtime is ORT 1.24.4 / numpy 2.5.5,
  not necessarily the earlier container/runtime. The retained clause is the
  byte-equality, and it passes.
* The existing v2 runner's generic `probe prefix` branch assumes the head runs
  over the full window count while it computes only 8 windows; it raises a
  reshape error for the short prefix. We do **not** edit that artifact.
  `reverify_local_cd.py` builds the same 8-window prefix through the runner's
  own `window_features` / `prefix_chunk` / `restore_prefix` functions.
* `verify_official_run_v26_qa.py` consumes full stage reports
  (`bandroom.qa.acoustic-output.v1` with feedback/markers/anchors). The local
  probe emits probe JSON only, so the byte-level retained clauses are verified
  directly from the runner outputs; no fabricated stage reports were fed to the
  QA verifier.

## 10. Tests

```bash
python3 -I analysis/scripts/g5-local/test_g5_local.py
```

Covers key generation (distinct keys, 0600/0700 modes, no private material
printed, no overwrite, signers-outside guard), exporter pass/fail/waiver paths,
the informational profile, verifier (valid signatures, signers-inside-bundle
rejection, role set, distinct keys, tamper detection, wrong signing namespace),
and the G5 evaluator (hardened transport, early exit, wake/span/fail-closed
criteria, existing-verdict guard, coexistence with production paths).