from __future__ import annotations

import pytest

from runner.orchestrator import ConfigError, load_config


CONFIG = """
[site]
base_url = "https://bandroom.example.test"
client_id_env = "TEST_RUNNER_CLIENT_ID"
client_secret_env = "TEST_RUNNER_CLIENT_SECRET"

[model]
provider = "qwen"
api_key_env = "TEST_DASHSCOPE_KEY"

[runner]
interval_seconds = 300
state_dir = "~/.bandroom-runner-test"

[budget]
daily_cap_cny = 3.5
text_cost_cny = 0.01
audio_cost_cny = 0.2

[audio]
chunk_bytes = 24576
transcode_bitrates_kbps = [64, 32]
"""


def test_config_reads_secrets_only_from_environment(tmp_path, monkeypatch):
    path = tmp_path / "config.toml"
    path.write_text(CONFIG, encoding="utf-8")
    monkeypatch.setenv("TEST_RUNNER_CLIENT_ID", "client-id")
    monkeypatch.setenv("TEST_RUNNER_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv("TEST_DASHSCOPE_KEY", "sk-payg")
    config = load_config(path)
    assert config.client_id == "client-id"
    assert config.client_secret == "client-secret"
    assert config.api_key == "sk-payg"
    assert config.daily_cap_cny == 3.5
    assert config.transcode_bitrates_kbps == (64, 32)
    assert "sk-payg" not in path.read_text(encoding="utf-8")


def test_missing_service_token_fails_closed(tmp_path, monkeypatch):
    path = tmp_path / "config.toml"
    path.write_text(CONFIG, encoding="utf-8")
    monkeypatch.delenv("TEST_RUNNER_CLIENT_ID", raising=False)
    monkeypatch.delenv("TEST_RUNNER_CLIENT_SECRET", raising=False)
    with pytest.raises(ConfigError):
        load_config(path)