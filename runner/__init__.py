"""Bandroom own coach runner (production coach track).

The text/legacy paths are a small, stdlib-only cron worker that reads pending
subjective review attempts over the Bandroom MCP endpoint, asks a model
provider for feedback, and writes it back with ``add_coach_feedback``.

The optional grounded speaking path (``coach_audio_mode = "grounded"``) lazily
imports the vendored ``runner.prosody`` module, which needs NumPy/SciPy in the
production interpreter.  Importing the orchestrator does not require them.

Nothing in this package calls a production site or a real model during tests;
all side effects are injected and mocked in ``runner/tests``.
"""

__all__ = ["__version__"]

__version__ = "0.1.0"