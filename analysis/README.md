# Bandroom acoustic analysis bundle

This package owns the part of the D2 pipeline that can be made reproducible
before a qualified acoustic model exists:

- decode the original browser file to a canonical 16 kHz mono sample timeline;
- record input SHA-256, byte count, container/decoded duration and codec;
- plan sample-exact chunks with overlap and complete-tail coverage;
- emit an `analysis.json` contract with an honest `blocked` state when no
  frozen model is configured;
- build and verify a private bundle for `get_analysis_bundle`.

It **does not** claim pronunciation accuracy. `UnavailableAnalyzer` returns
`blocked / qualified_analyzer_unavailable` and zero errors. A future model must
be added behind the `analyzer.py` contract and pass the sealed holdout gate
before any error reaches a learner.

## Local run

```sh
PYTHONPATH=analysis/src python3 -m bandroom_acoustic.cli \
  --audio /path/to/clip.wav \
  --out /tmp/analysis.json \
  --analysis-version bandroom-acoustic-dev
# exit 3 while blocked; inspect state/reason, never treat it as feedback
```

## Test

```sh
PYTHONPATH=analysis/src python3 -m unittest discover -s analysis/tests -v
```

## Build a bundle

```sh
python3 analysis/scripts/build_bundle.py --version bandroom-acoustic-0.1.0 \
  --out-dir analysis/bundle/bandroom-acoustic-0.1.0
python3 analysis/scripts/verify_bundle.py \
  --bundle analysis/bundle/bandroom-acoustic-0.1.0/bundle.tar.zst \
  --manifest analysis/bundle/bandroom-acoustic-0.1.0/manifest.json
```

Upload both files to private R2:

```text
analysis/<version>/bundle.tar.zst
analysis/<version>/manifest.json
```

Then configure `ANALYSIS_BUNDLE_VERSION`, `ANALYSIS_SIGNING_KEY` and
`BANDROOM_PUBLIC_ORIGIN` before `get_analysis_bundle` can issue a URL.

## Boundaries

- The bundle contains no learner audio, labels or signing keys.
- `analysis.json` is a measurement/contract, not a pronunciation verdict.
- The CLI exits 3 for blocked/failed results; callers must call
  `fail_review_task` with the exact reason, not fabricate feedback.
- `containerDurationMs` and `decodedDurationMs` are different measurements;
  a >5% difference is rejected for manual investigation.
