"""Versioned model prompts for the production coach runner.

Prompt provenance:
- ``lib/coach.ts:214`` reviewWorkflow instructions (exact attempt ids, quote
  actual wording, hear audio before pronunciation/fluency, no progression).
- Content/evidence discipline (see Wiki: Quality-Gates / Pronunciation-Coaching):
  learner material is data, restricted structure, Chinese reasons, one next
  practice step, logs never contain answer text.
- ``runner/content_rules.py`` PROMPT_VERSION is recorded by the orchestrator.
"""