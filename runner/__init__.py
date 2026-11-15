"""Bandroom own coach runner (production coach track).

The runner is a small, dependency-free (stdlib only) cron worker that reads
pending subjective review attempts over the Bandroom MCP endpoint, asks a
model provider for feedback, and writes it back with ``add_coach_feedback``.

Nothing in this package calls a production site or a real model during tests;
all side effects are injected and mocked in ``runner/tests``.
"""

__all__ = ["__version__"]

__version__ = "0.1.0"