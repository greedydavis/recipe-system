"""每週 briefing：時間範圍、內容、以及重啟後不重寄。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from conftest import OTHER_USER, USER, make_png
from screenshot_bot.ai.base import AIError
from screenshot_bot.briefing import due_period, latest_period_end, preview_period
from screenshot_bot.db import Database

TPE = ZoneInfo("Asia/Taipei")


def tpe(*args) -> datetime:
    return datetime(*args, tzinfo=TPE)


# 2026-10-11 是週日
SUN_2000 = tpe(2026, 10, 11, 20, 0)
PREV_SUN_2000 = tpe(2026, 10, 4, 20, 0)


@pytest.mark.parametrize(
    "now,expected_end",
    [
        (tpe(2026, 10, 11, 19, 59, 59), PREV_SUN_2000),  # 週日 19:59 還沒到
        (tpe(2026, 10, 11, 20, 0), SUN_2000),  # 20:00 整點到期
        (tpe(2026, 10, 11, 23, 0), SUN_2000),
        (tpe(2026, 10, 12, 1, 0), SUN_2000),  # 週一凌晨（UTC 還是週日）
        (tpe(2026, 10, 14, 12, 0), SUN_2000),  # 週三
        (tpe(2026, 10, 18, 19, 0), SUN_2000),  # 下個週日 20:00 前
    ],
)
def test_period_end_uses_taipei_sunday_8pm(settings, now, expected_end):
    end = latest_period_end(now.astimezone(timezone.utc), settings)
    assert end == expected_end
    assert end.tzinfo == timezone.utc


def test_due_period_covers_exactly_seven_days(settings):
    period = due_period(tpe(2026, 10, 11, 20, 0, 30), settings)
    assert period.start == PREV_SUN_2000 and period.end == SUN_2000
    assert period.end - period.start == timedelta(days=7)


def test_preview_period_is_this_week_so_far(settings):
    now = tpe(2026, 10, 14, 9, 0)
    period = preview_period(now, settings)
    assert period.start == SUN_2000 and period.end == now


def add(collector, seed, received_at, user=USER, **kw):
    return collector.save(
        user_id=user, chat_id=user, message_id=seed, data=make_png(seed),
        received_at=received_at, **kw,
    ).item


async def test_items_on_boundaries(collector, make_briefings, analyzer, settings):
    before_start = add(collector, 1, PREV_SUN_2000 - timedelta(seconds=1))
    at_start = add(collector, 2, PREV_SUN_2000)
    inside = add(collector, 3, tpe(2026, 10, 8, 12, 0))
    last_second = add(collector, 4, SUN_2000 - timedelta(seconds=1))
    at_end = add(collector, 5, SUN_2000)
    add(collector, 6, tpe(2026, 10, 9, 12, 0), user=OTHER_USER)  # 別人的不算

    service = make_briefings()
    text, count = await service.build(USER, due_period(SUN_2000, settings))
    ids = [it.id for it in analyzer.briefing_calls[0].items]
    assert ids == [at_start.id, inside.id, last_second.id]
    assert before_start.id not in ids and at_end.id not in ids
    assert count == 3
    assert "本週收藏 <b>3</b> 則" in text


@pytest.fixture
def week_setup(collector, clock):
    """服務在這週之前就已安裝；週間收藏 3 則，時間停在週日 20:00:30。"""
    clock.now = tpe(2026, 10, 1, 9, 0).astimezone(timezone.utc)
    for n in range(3):
        add(collector, 10 + n, tpe(2026, 10, 6 + n, 21, 0), caption=f"第 {n} 則")
    return clock


class Outbox:
    def __init__(self, fail_times: int = 0):
        self.sent: list[tuple[int, str]] = []
        self.fail_times = fail_times

    async def __call__(self, user_id: int, text: str) -> None:
        if self.fail_times:
            self.fail_times -= 1
            raise RuntimeError("Telegram 暫時無法連線")
        self.sent.append((user_id, text))


async def test_sends_once_and_not_again_after_restart(week_setup, make_briefings, settings, analyzer):
    clock = week_setup
    service = make_briefings()  # installed_at = 10/01
    clock.now = (SUN_2000 + timedelta(seconds=30)).astimezone(timezone.utc)
    outbox = Outbox()

    assert await service.run_due(outbox) == [USER, OTHER_USER]
    mine = [t for u, t in outbox.sent if u == USER]
    assert len(mine) == 1 and "本週收藏 <b>3</b> 則" in mine[0]
    others = [t for u, t in outbox.sent if u == OTHER_USER]
    assert "沒有新收藏" in others[0]  # 沒收藏的人只收到簡短通知

    # 同一個程序下一分鐘再跑
    clock.now += timedelta(minutes=1)
    assert await service.run_due(outbox) == []

    # 模擬重啟：新的資料庫連線與新的 service
    restarted = make_briefings(Database(settings.db_path))
    clock.now += timedelta(hours=1)
    assert await restarted.run_due(outbox) == []
    assert len(outbox.sent) == 2
    assert len(analyzer.briefing_calls) == 1


async def test_failed_send_is_retried_later_but_only_delivered_once(week_setup, make_briefings, db):
    clock = week_setup
    service = make_briefings()
    clock.now = SUN_2000.astimezone(timezone.utc)
    outbox = Outbox(fail_times=1)

    sent = await service.run_due(outbox)
    assert USER not in sent
    assert db.get_briefing(USER, SUN_2000)["status"] == "failed"

    clock.now += timedelta(minutes=1)  # 冷卻中
    assert USER not in await service.run_due(outbox)
    clock.now += timedelta(minutes=10)
    assert await service.run_due(outbox) == [USER]
    clock.now += timedelta(minutes=30)
    assert await service.run_due(outbox) == []
    assert [u for u, _ in outbox.sent].count(USER) == 1
    row = db.get_briefing(USER, SUN_2000)
    assert row["status"] == "sent" and row["attempts"] == 2


async def test_crash_while_sending_never_resends(week_setup, make_briefings, settings):
    """寄到一半當機（狀態停在 sending）時，寧可不寄也不重複。"""
    clock = week_setup
    service = make_briefings()
    clock.now = SUN_2000.astimezone(timezone.utc)
    period = due_period(clock.now, settings)
    assert service.db.claim_briefing(
        USER, period.start, period.end, clock.now, clock.now, max_attempts=5
    )
    outbox = Outbox()
    clock.now += timedelta(hours=2)
    restarted = make_briefings(Database(settings.db_path))
    sent = await restarted.run_due(outbox)
    assert USER not in sent


async def test_downtime_within_grace_sends_late_but_not_after(week_setup, make_briefings, settings):
    clock = week_setup
    service = make_briefings()
    clock.now = (SUN_2000 + timedelta(hours=settings.briefing_grace_hours + 1)).astimezone(timezone.utc)
    assert await service.run_due(Outbox()) == []
    clock.now = (SUN_2000 + timedelta(hours=10)).astimezone(timezone.utc)
    assert USER in await service.run_due(Outbox())


async def test_no_briefing_for_weeks_before_installation(collector, make_briefings, clock):
    clock.now = tpe(2026, 10, 12, 9, 0).astimezone(timezone.utc)  # 週一才第一次啟動
    service = make_briefings()
    assert await service.run_due(Outbox()) == []


async def test_empty_week_short_notice_without_ai(make_briefings, settings, analyzer):
    text, count = await make_briefings().build(USER, due_period(SUN_2000, settings))
    assert count == 0 and "沒有新收藏" in text
    assert analyzer.briefing_calls == []
    assert len(text) < 200


async def test_ai_failure_falls_back_to_statistics(collector, make_briefings, settings, analyzer):
    items = [add(collector, 30 + n, tpe(2026, 10, 7, 10, n), caption=f"收藏 {n}") for n in range(12)]
    for it in items[:8]:
        await collector.analyze(it.id)  # 4 則保持未整理
    analyzer.fail_briefing = AIError("掛了")
    text, count = await make_briefings().build(USER, due_period(SUN_2000, settings))
    assert count == 12
    assert "自動統計版" in text
    assert "最值得回看" in text and "試用看看" in text  # 行動來自待辦
    highlights = text.split("最值得回看")[1].split("可以採取的行動")[0]
    assert 5 <= highlights.count("• <b>#") <= 10
    assert "4 則尚未完成 AI 整理" in text


async def test_briefing_text_escapes_html(collector, make_briefings, settings):
    add(collector, 50, tpe(2026, 10, 7, 10, 0), caption="<b>壞掉</b> & <script>")
    text, _ = await make_briefings().build(USER, due_period(SUN_2000, settings))
    assert "<script>" not in text
