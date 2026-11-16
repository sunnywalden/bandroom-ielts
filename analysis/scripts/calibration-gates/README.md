# Calibration gates (V3-G and V3-P)

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

V3-P **imports V3-G's constants and statistical helpers** (`T2_ABS_PRECISION`,
`T2_LB_FLOOR`, `TP_RETENTION_MIN`, `FROZEN_N`, `FROZEN_PROMOTE_POSTERIOR_LB`,
`wilson_lb`, `beta_ppf_10`). No threshold can drift between the gates; the tests
assert identity, including function-object identity.

Both were pre-registered before any real multi-session data existed. The V3-P
pre-registration is recorded in the acceptance workspace
(`iteration-25/V3P_PREREGISTRATION.md`). **Do not edit a constant to make a result
pass.**

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
```

`check` exits non-zero when the data is inadequate; `evaluate` refuses to run
rather than degrading to a within-recording estimate.

## Tests

```
python3 -I test_v3_gate.py            # V3-G, including refusal on single-session data
python3 -I test_v3_personal_gate.py   # 32 assertions
python3 -I test_v3_data_pipeline.py   # 24 assertions
```

Fixtures are written to a temp directory, so running the tests never litters the
checkout. No network access and no paid model call is made by the tests.
