from pathlib import Path

import pytest

from screenshot_bot.config import ConfigError, Settings, load_dotenv

BASE = {"TELEGRAM_BOT_TOKEN": "1:a", "ALLOWED_USER_IDS": "123, 456", "AI_PROVIDER": "none"}


def test_from_env_defaults():
    s = Settings.from_env(BASE)
    assert s.allowed_user_ids == frozenset({123, 456})
    assert (s.briefing_weekday, s.briefing_hour, s.briefing_minute) == (6, 20, 0)
    assert s.timezone == "Asia/Taipei"
    assert s.categories[0] == "工作／學習" and s.categories[-1] == "其他"


@pytest.mark.parametrize(
    "override,message",
    [
        ({"TELEGRAM_BOT_TOKEN": ""}, "TELEGRAM_BOT_TOKEN"),
        ({"ALLOWED_USER_IDS": ""}, "ALLOWED_USER_IDS"),
        ({"ALLOWED_USER_IDS": "me"}, "非數字"),
        ({"AI_PROVIDER": "anthropic"}, "ANTHROPIC_API_KEY"),
        ({"BRIEFING_TIME": "8pm"}, "BRIEFING_TIME"),
    ],
)
def test_from_env_errors(override, message):
    with pytest.raises(ConfigError, match=message):
        Settings.from_env({**BASE, **override})


def test_load_dotenv_does_not_override_existing(tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text('# 註解\nTELEGRAM_BOT_TOKEN="from-file"\nexport CATEGORIES=a,b\nEMPTY=\n', encoding="utf-8")
    environ = {"TELEGRAM_BOT_TOKEN": "from-shell"}
    assert load_dotenv(env_file, environ)
    assert environ == {"TELEGRAM_BOT_TOKEN": "from-shell", "CATEGORIES": "a,b", "EMPTY": ""}
    assert not load_dotenv(tmp_path / "missing", environ)
