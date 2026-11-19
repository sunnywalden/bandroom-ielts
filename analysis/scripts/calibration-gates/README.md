# Calibration gates (V3-G, V3-P and V3-P-A)

Evaluation machinery for personal pronunciation calibration. Versioned here so
the rules that gate T2 are reviewable and cannot be lost with a local directory.

**Neither gate is satisfied today.** T2 phoneme assertions remain globally
disabled and the product ships T1 (calibrated prosody with a per-user reliability
disclosure) plus T3 (uncalibrated self-listening suggestions).

## Why there are two gates

T2's actual claim is per-user: "your history suggests this class". Requiring
cross-user evidence for that claim binds a technical capability to user
acquisition, which is a category error. The two questions are separated:

| Gate | Question | Requirement | A PASS permits |
| --- | --- | --- | --- |
| **V3-G** (`v3_gate.py`) | Does the mechanism generalize across users? | >= 6 users, each with >= 2 time-ordered sessions and >= 20 future-session candidates, human ground truth | product-wide claims; T2 by default for new users |
| **V3-P** (`v3_personal_gate.py`) | Is **this user's** calibration reliable? | >= 2 history + >= 2 future sessions, >= 20 future candidates, human truth, catch trials present, not a constant confirmer | T2 **for that user only**, per class |
| **V3-P-A** (`v3_personal_gate_auto.py`) | Same question, judged by calibrated machine panels | Same thresholds as V3-P plus source separation, >= 90% determinate truth coverage, >= 5 determinate controls, sealed CG manifest | T2 **for that user only**, pooled promoted set; never a human blind-test claim |

V3-P **imports V3-G's constants and statistical helpers** (`T2_ABS_PRECISION`,
`T2_LB_FLOOR`, `TP_RETENTION_MIN`, `FROZEN_N`, `FROZEN_PROMOTE_POSTERIOR_LB`,
`wilson_lb`, `beta_ppf_10`). No threshold can drift between the gates; the tests
assert identity, including function-object identity.

## V3-P-A: machine-panel variant

`v3_personal_gate_auto.py` is the pre-registered machine-panel variant
(iteration-27 `V3PA_PREREGISTRATION.md`). It answers the same per-user question
as V3-P but permits the historical fit and the future-session ground truth to
come from calibrated panels rather than a human listener. The report label is
fixed to `V3-P-A(machine-panel)`; it never claims human blind testing.

The frozen `v3_gate.py` and `v3_personal_gate.py` are untouched. V3-P-A **copies**
the V3-P `check_user` / `evaluate_user` logic with a named disclosure of the
source lines, and imports every constant and statistical helper from the frozen
modules. It adds only the pre-registered differences:

- schema `bandroom-v3-multisession-auto-v2`; every verdict carries
  `verdictSource` (`human`, `machine-panel-A`, `machine-panel-B`, `anchors-only`);
  mixed fit sources are refused and the future-truth family must differ from the fit family;
- `groundTruth.annotatedBy` accepts `calibrated-panel` (never bare `detector`)
  and requires a sibling CG manifest
  `{panelId, modelIds, promptSha256, cgResultSha256, calibratedAt}` whose result
  file hash is verified fail-closed (`V3PA_CG_MANIFEST` or `--cg-manifest`);
- three-state mapping `unsure -> isTrueError=false` (primary), determinate
  coverage `>= 90%` or refusal, unsure count reported, and the
  `unsure -> true` sensitivity variant computed alongside;
- POOLED PASS only unlocks the promoted set; `per_promoted_class` is disclosure
  only (no per-class pass rule);
- sequential design: `>= 1` new future session per evaluation, fit frozen at the
  first `FROZEN_N` verdicts, deterministic demotion when the rolling future-window
  Wilson LB drops below 0.70;
- two catch-trial tracks: the original CG-3 gate-execution rule is retained
  unchanged (`>= 5` answered and `>= 0.80` confirmed -> refuse), and a separate
  panel-quality monitor invalidates a batch when determinate-control
  misconfirmation exceeds `0.20`;
- at least `MIN_DETERMINATE_CONTROLS = 5` determinate controls are required,
  fail-closed.

### Differential test (HARD GATE)

Because the V3-P logic is copied rather than imported, a **differential test is
mandatory**. On the same human-labelled document (schema v1,
`annotatedBy: "human"`, `verdictSource: "human"`) `v3_personal_gate_auto.py` and
`v3_personal_gate.py` must return field-by-field byte-identical output. The
human schema is the identity domain and stays on the copied V3-P path; the
machine-panel semantics exist only under the auto-v2 schema. Any drift fails
`test_v3_personal_gate_auto.py`.

All three were pre-registered before any real multi-session data existed. The
V3-P pre-registration is recorded in the acceptance workspace
(`iteration-25/V3P_PREREGISTRATION.md`) and the V3-P-A variant in
(`iteration-27/V3PA_PREREGISTRATION.md`). **Do not edit a constant to make a
result pass.**

## Replication level

Candidates within one recording are correlated, so for a single user the unit of
replication is the **session**, not the candidate. V3-P therefore requires at
least two future sessions and adds:

- `multi_session_evidence` — >= 2 future sessions each contributing T2 candidates
- `session_consistency` — at least half of those sessions meet their own baseline

A test proves that a perfect pooled precision driven entirely by one future
session still **FAILS**. This is the single-user analogue of the pseudo-replication
error that invalidated the earlier +7pp claim.

V3-G refuses to run on single-session data at all: the L2-ARCTIC Suitcase corpus
has exactly one recording per speaker, so a cross-session split is impossible
there.

## Data path

`v3_data_pipeline.py` reads the site's D1 tables and produces the
`bandroom-v3-multisession-v1` document the gates consume.

```
python3 -I v3_data_pipeline.py readiness --db prod      # distance to the requirements
python3 -I v3_data_pipeline.py export    --db prod      # D1 -> gate document
python3 -I v3_data_pipeline.py annotate  --input export.json   # HUMAN annotation
python3 -I v3_data_pipeline.py personal  --db prod --user <userId>   # run V3-P
```

`groundTruth` is left `null` by the exporter. The gates **refuse detector-labelled
truth**; annotation requires a person listening to the recording. Nothing here
manufactures data.

Readiness also excludes non-discriminating listeners: a user who confirms most
catch trials (>= 5 answered, >= 80% confirmed — the same frozen thresholds as
`lib/calibration.ts`) contributes no information and is not counted as adequate.

Credentials come from `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` in the
environment; they are never written to disk or printed.

Deployment identifiers are **not** committed, matching the project's practice of
gitignoring `config.{prod,qa}.toml`. Supply the database ids via
`BANDROOM_D1_PROD_ID` / `BANDROOM_D1_QA_ID`; the tool exits with a clear message
naming the missing variable rather than guessing.

## Running the gates directly

```
python3 -I v3_gate.py check    <data.json>
python3 -I v3_gate.py evaluate <data.json>
python3 -I v3_personal_gate.py check    <data.json> <userId>
python3 -I v3_personal_gate.py evaluate <data.json> <userId>
python3 -I v3_personal_gate_auto.py check    <data.json> <userId> --cg-manifest <manifest.json>
python3 -I v3_personal_gate_auto.py evaluate <data.json> <userId> --cg-manifest <manifest.json>
```

The V3-P-A command accepts the frozen v1 human schema (identity path) or the
auto-v2 machine-panel schema. The manifest path may also be supplied through
`V3PA_CG_MANIFEST`; a missing or hash-mismatched manifest is a refusal.

`check` exits non-zero when the data is inadequate; `evaluate` refuses to run
rather than degrading to a within-recording estimate.

## Mechanism simulation (NON-GATE)

`mechanism_simulation.py` exercises the V3-P feature subset on synthetic data:
candidate -> verdict -> profile promotion -> catch-trial handling -> pooled
statistics. It is **explicitly non-gate**:

- its output is labelled `NON-GATE SIMULATION — DOES NOT AUTHORIZE ANY UNLOCK`
  and can never enable T2;
- it **never writes `V3_GATE_RESULT.json`** and refuses to be pointed at that
  filename;
- it does **not** run V3-G on sentence-block splits (splitting one recording
  into sentence blocks is pseudo-replication); the replication unit is the
  session;
- it documents that V3-G does not check catch trials — catch-trial behaviour is
  a V3-P feature — so only V3-P is exercised;
- its synthetic speakers are disjoint by construction from any CG calibration
  set, and the output discloses that a simulation has no inferential power for
  the real gate.

```
python3 -I mechanism_simulation.py                          # non-gate JSON to stdout
python3 -I mechanism_simulation.py --listener constant-confirmer
python3 -I mechanism_simulation.py --output simulation.json  # any name but V3_GATE_RESULT.json
```

## Tests

```
python3 -I test_v3_gate.py                  # V3-G, including refusal on single-session data
python3 -I test_v3_personal_gate.py         # 32 assertions
python3 -I test_v3_data_pipeline.py         # 24 assertions
python3 -I test_v3_personal_gate_auto.py    # 80 assertions, incl. the differential HARD GATE
python3 -I test_mechanism_simulation.py     # 23 assertions
```

Fixtures are written to a temp directory, so running the tests never litters the
checkout. No network access and no paid model call is made by the tests.
