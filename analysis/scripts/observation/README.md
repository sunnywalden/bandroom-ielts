# Observation-window evaluator

Automated evaluation of the production 24h observation window against **frozen
criteria**. Versioned here (same convention as `../calibration-gates/`) so the
machinery that decides whether a window passed is reviewable and cannot be lost
with a local directory.

The live copy is staged at `~/.bandroom-acoustic/observation_window_eval.py`
because **launchd cannot read `~/Documents`** (macOS TCC). This directory is the
canonical source; after any change, copy the evaluator and the run script to
`~/.bandroom-acoustic/` and keep them byte-identical.

## Frozen criteria

| # | Criterion |
| --- | --- |
| C1 | Full 24h elapsed since the window opened |
| C2 | Deployed Worker version unchanged since the window opened |
| C3 | Runner alive; recent runs non-fatal, no errors |
| C4 | Unauthenticated request to the site root redirected to Access (**302**) |
| C5 | Authenticated MCP read still works |
| C6 | No failed/blocked review accumulation |
| C7 | Safety config unchanged (assertions OFF, Stage B ON, grounded mode) |

A window interrupted by a production change is **never** claimed passed. Before
the scheduled end the evaluator writes nothing. At/after the end it evaluates
once, writes `~/.bandroom-acoustic/OBSERVATION_WINDOW_VERDICT.json`, and the
existing-verdict guard refuses to re-evaluate the same window.

**Do not edit a criterion, a threshold, or a sealed verdict to make a result
pass.**

## launchd wiring

`~/Library/LaunchAgents/com.bandroom.observation-eval.plist`:
`StartInterval` 1800, `RunAtLoad` true, program
`~/.bandroom-acoustic/run-observation-eval.sh` (sources the 600-permission
credential files, never prints them, then `exec python3 -I` the evaluator,
forwarding `"$@"`). Logs: `~/.bandroom-acoustic/logs/observation-eval.{log,err}`.

The window itself is declared in `OBSERVATION_WINDOW.json` (canonical:
`acceptance-2026-11-10/iteration-25/`; mirror: `~/.bandroom-acoustic/`, preferred
by the evaluator). Opening a new window means updating **both** copies.

## The C4 instrument bug (2026-11-17 FAILED verdict)

The first window ever to run its full 24h (2026-11-16T04:47:50Z →
2026-11-17T04:47:50Z, Worker `2d62b693`) was recorded **FAILED** with only C4
false. Root cause: the C4 probe, not production.

1. The probe used urllib's default `Python-urllib` UA. Cloudflare blocks that UA
   string on this site (403, sometimes a dropped TLS connection) — the same
   class of block the coach runner hit and fixed earlier.
2. Even with an unblocked UA, `urlopen` **follows redirects**: the correct 302
   became the Access login page's 200, so `== 302` could never hold.

Reproducible cross-checks (2026-11-18): `curl` default UA → 302; `curl -A
Python-urllib/3.13` → 403; urllib browser UA with a no-redirect opener → 302;
urllib browser UA following redirects → 200. Production was correct throughout;
the other six criteria passed at window end.

Fix: the probe now sends a browser-like UA (`PROBE_UA`) through a no-redirect
opener and asserts on the first hop. C4's meaning is unchanged. Full record:
`iteration-25/OBSERVATION_C4_INSTRUMENT_FIX.md` (acceptance workspace), with the
original evaluator and the original FAILED verdict archived byte-for-byte under
`iteration-25/observation-instrument-archive/`.

## Probe hardening (second round, 2026-11-18)

The first re-evaluation (09:55:38Z) itself failed transiently: both network
probes errored at that instant (C2 observed `None`, C4 unrecorded) while the
runner's authenticated MCP path was healthy before and after — a transient
edge/transport block, not a production change. Two instrument gaps were fixed:

- **Bounded retries for transport failures only** (`PROBE_ATTEMPTS=4`, backoff
  2/5/11s): connection errors and edge blocks/5xx that prevent the probe from
  reaching the Worker are retried. A **measured** value (302, 200, a different
  worker version, an auth error) is final and never retried — fail-closed.
- **Raw probe evidence in every verdict**: `evidence.c4Probe.attempts` and
  `evidence.workerVersionProbe.attempts` record each attempt's status/error, so
  a failure is diagnosable from the artifact alone.

A single-shot network probe must never decide a 24h verdict; equally, retries
must never talk a measured failure into a pass.

## Re-evaluation protocol (instrument failure only)

Never verdict-shop. A recorded verdict may be superseded only when:

1. The failure is proven to be an instrument artifact with reproducible evidence.
2. The original verdict is archived byte-for-byte (never edited).
3. The instrument is fixed and a regression test reproduces the original failure.
4. The archived verdict is moved out of the verdict path and the evaluator runs
   once with `--note-file <json>`; the note is embedded verbatim as
   `evaluation_note` in the new verdict.

The existing-verdict guard still blocks any further re-evaluation of the window.

## Tests

```
python3 -I test_observation_eval.py
```

Loopback HTTP server only — no external network, no paid model call. The probe
tests fail against the original (pre-fix) implementation by construction.
