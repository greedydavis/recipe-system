"""從環境變數讀取設定。金鑰與使用者 ID 只從環境變數來，不寫在程式碼裡。"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping
from zoneinfo import ZoneInfo

DEFAULT_CATEGORIES: tuple[str, ...] = (
    "工作／學習",
    "科技",
    "理財",
    "健康",
    "旅遊",
    "美食",
    "購物",
    "娛樂",
    "其他",
)
FALLBACK_CATEGORY = "其他"

_WEEKDAYS = {
    "mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6,
}


class ConfigError(ValueError):
    pass


def parse_categories(raw: str | None) -> tuple[str, ...]:
    """逗號分隔的分類清單；一定保留「其他」作為無法判斷時的分類。"""
    if not raw or not raw.strip():
        return DEFAULT_CATEGORIES
    seen: list[str] = []
    for part in raw.replace("，", ",").split(","):
        name = part.strip()
        if name and name not in seen:
            seen.append(name)
    if FALLBACK_CATEGORY not in seen:
        seen.append(FALLBACK_CATEGORY)
    return tuple(seen)


def parse_user_ids(raw: str | None) -> frozenset[int]:
    if not raw or not raw.strip():
        raise ConfigError("請設定 ALLOWED_USER_IDS（你的 Telegram 數字 ID，多個用逗號分隔）")
    ids = set()
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            ids.add(int(part))
        except ValueError as exc:
            raise ConfigError(f"ALLOWED_USER_IDS 內含非數字：{part!r}") from exc
    if not ids:
        raise ConfigError("ALLOWED_USER_IDS 是空的")
    return frozenset(ids)


@dataclass(frozen=True)
class Settings:
    telegram_bot_token: str
    allowed_user_ids: frozenset[int]
    data_dir: Path
    ai_provider: str = "anthropic"  # anthropic | none
    ai_model: str = "claude-opus-5-5"
    ai_fallbacks: bool = True
    categories: tuple[str, ...] = DEFAULT_CATEGORIES
    timezone: str = "Asia/Taipei"
    briefing_weekday: int = 6  # 0=週一 … 6=週日
    briefing_hour: int = 20
    briefing_minute: int = 0
    # 服務在週日 20:00 時剛好停機的話，重啟後多久內仍補寄
    briefing_grace_hours: int = 48
    max_image_mb: int = 20
    ai_retry_base_minutes: int = 10
    ai_max_attempts: int = 6
    similar_hash_distance: int = 6

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)

    @property
    def max_image_bytes(self) -> int:
        return self.max_image_mb * 1024 * 1024

    @property
    def db_path(self) -> Path:
        return self.data_dir / "bot.sqlite3"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        env = os.environ if env is None else env
        token = env.get("TELEGRAM_BOT_TOKEN", "").strip()
        if not token:
            raise ConfigError("請設定 TELEGRAM_BOT_TOKEN（向 @BotFather 申請）")
        provider = env.get("AI_PROVIDER", "anthropic").strip().lower() or "anthropic"
        if provider not in {"anthropic", "none"}:
            raise ConfigError(f"AI_PROVIDER 只支援 anthropic 或 none，收到 {provider!r}")
        if provider == "anthropic" and not env.get("ANTHROPIC_API_KEY", "").strip():
            raise ConfigError(
                "AI_PROVIDER=anthropic 需要 ANTHROPIC_API_KEY；"
                "若暫時不想接 AI，可設定 AI_PROVIDER=none"
            )
        weekday_raw = env.get("BRIEFING_WEEKDAY", "sun").strip().lower()[:3]
        if weekday_raw not in _WEEKDAYS:
            raise ConfigError("BRIEFING_WEEKDAY 請填 mon/tue/wed/thu/fri/sat/sun")
        time_raw = env.get("BRIEFING_TIME", "20:00").strip()
        try:
            hour_s, minute_s = time_raw.split(":")
            hour, minute = int(hour_s), int(minute_s)
            assert 0 <= hour < 24 and 0 <= minute < 60
        except (ValueError, AssertionError) as exc:
            raise ConfigError("BRIEFING_TIME 格式為 HH:MM，例如 20:00") from exc
        timezone = env.get("TIMEZONE", "Asia/Taipei").strip() or "Asia/Taipei"
        try:
            ZoneInfo(timezone)
        except Exception as exc:  # noqa: BLE001
            raise ConfigError(f"TIMEZONE 無效：{timezone}") from exc

        def _int(name: str, default: int) -> int:
            raw = env.get(name, "").strip()
            if not raw:
                return default
            try:
                return int(raw)
            except ValueError as exc:
                raise ConfigError(f"{name} 必須是整數") from exc

        return cls(
            telegram_bot_token=token,
            allowed_user_ids=parse_user_ids(env.get("ALLOWED_USER_IDS")),
            data_dir=Path(env.get("DATA_DIR", "./data")).expanduser(),
            ai_provider=provider,
            ai_model=env.get("AI_MODEL", "claude-opus-5-5").strip() or "claude-opus-5-5",
            ai_fallbacks=env.get("AI_FALLBACKS", "default").strip().lower() != "off",
            categories=parse_categories(env.get("CATEGORIES")),
            timezone=timezone,
            briefing_weekday=_WEEKDAYS[weekday_raw],
            briefing_hour=hour,
            briefing_minute=minute,
            briefing_grace_hours=_int("BRIEFING_GRACE_HOURS", 48),
            max_image_mb=min(_int("MAX_IMAGE_MB", 20), 20),
            ai_retry_base_minutes=_int("AI_RETRY_BASE_MINUTES", 10),
            ai_max_attempts=_int("AI_MAX_ATTEMPTS", 6),
        )


def load_dotenv(path: Path | str = ".env", environ: dict[str, str] | None = None) -> bool:
    """讀取 .env（KEY=VALUE 每行一筆）。已存在的環境變數優先，不會被覆蓋。"""
    environ = os.environ if environ is None else environ  # type: ignore[assignment]
    path = Path(path)
    if not path.is_file():
        return False
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        environ.setdefault(key, value)
    return True
