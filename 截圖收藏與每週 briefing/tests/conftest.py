from __future__ import annotations

import os

os.environ.setdefault("PTB_TIMEDELTA", "1")  # 和 Docker 一樣使用 timedelta 版 retry_after

import io
import random
from datetime import datetime, timezone
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from screenshot_bot.ai.base import (
    AIError,
    Analysis,
    AnalysisRequest,
    BriefingDraft,
    BriefingRequest,
    Highlight,
    Theme,
)
from screenshot_bot.briefing import BriefingService
from screenshot_bot.collector import Collector
from screenshot_bot.config import Settings
from screenshot_bot.db import Database

USER = 111
OTHER_USER = 222


class Clock:
    def __init__(self, now: datetime):
        self.now = now

    def __call__(self) -> datetime:
        return self.now


class FakeAnalyzer:
    """可控制成功或失敗的假 AI，記錄收到的請求。"""

    name = "fake"

    def __init__(self) -> None:
        self.fail_analysis: Exception | None = None
        self.fail_briefing: Exception | None = None
        self.category = "科技"
        self.analysis_calls: list[AnalysisRequest] = []
        self.briefing_calls: list[BriefingRequest] = []
        self.briefing_raw_ids: list[int] | None = None

    async def analyze_image(self, request: AnalysisRequest) -> Analysis:
        self.analysis_calls.append(request)
        if self.fail_analysis:
            raise self.fail_analysis
        return Analysis(
            title="測試標題",
            summary="一句摘要",
            category=self.category,
            tags=["AI", "手機"],
            todos=["試用看看"],
            uncertain=[],
            key_text="截圖原文",
            source_platform="Facebook",
            model="fake-model",
        )

    async def compose_briefing(self, request: BriefingRequest) -> BriefingDraft:
        self.briefing_calls.append(request)
        if self.fail_briefing:
            raise self.fail_briefing
        ids = [it.id for it in request.items]
        return BriefingDraft(
            overview="本週綜合重點",
            themes=[Theme("AI 工具", "多則收藏討論 AI", ids)],
            highlights=[Highlight(i, "值得回看") for i in ids[:10]],
            actions=[],
        )


def make_png(seed: int, size: tuple[int, int] = (400, 800)) -> bytes:
    rng = random.Random(seed)
    img = Image.new("RGB", size, (rng.randrange(256), rng.randrange(256), rng.randrange(256)))
    draw = ImageDraw.Draw(img)
    for _ in range(12):
        x0, y0 = rng.randrange(size[0]), rng.randrange(size[1])
        x1, y1 = x0 + rng.randrange(20, 200), y0 + rng.randrange(20, 200)
        draw.rectangle((x0, y0, x1, y1), fill=(rng.randrange(256), rng.randrange(256), rng.randrange(256)))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def reencode_jpeg(data: bytes, quality: int = 80) -> bytes:
    with Image.open(io.BytesIO(data)) as img:
        buf = io.BytesIO()
        img.convert("RGB").save(buf, format="JPEG", quality=quality)
        return buf.getvalue()


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        telegram_bot_token="test-token",
        allowed_user_ids=frozenset({USER, OTHER_USER}),
        data_dir=tmp_path / "data",
        ai_provider="none",
    )


@pytest.fixture
def clock() -> Clock:
    return Clock(datetime(2026, 10, 7, 4, 0, tzinfo=timezone.utc))  # 週三 12:00 台北


@pytest.fixture
def db(settings: Settings):
    database = Database(settings.db_path)
    yield database
    database.close()


@pytest.fixture
def analyzer() -> FakeAnalyzer:
    return FakeAnalyzer()


@pytest.fixture
def collector(db: Database, settings: Settings, analyzer: FakeAnalyzer, clock: Clock) -> Collector:
    return Collector(db, settings, analyzer, clock=clock)


@pytest.fixture
def make_briefings(db: Database, settings: Settings, analyzer: FakeAnalyzer, clock: Clock):
    def _make(database: Database | None = None) -> BriefingService:
        return BriefingService(database or db, settings, analyzer, clock=clock)

    return _make


__all__ = ["AIError", "Clock", "FakeAnalyzer", "make_png", "reencode_jpeg", "USER", "OTHER_USER"]
