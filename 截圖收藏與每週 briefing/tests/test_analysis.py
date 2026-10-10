"""AI 失敗時圖片仍保存、狀態正確，並能稍後重試。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from conftest import USER, make_png
from screenshot_bot.ai.base import AIError, AINotConfigured, normalize_analysis, normalize_briefing
from screenshot_bot.config import parse_categories

RECEIVED = datetime(2026, 10, 7, 3, 30, tzinfo=timezone.utc)


def save(collector, seed, message_id=1, **kw):
    return collector.save(
        user_id=USER, chat_id=USER, message_id=message_id, data=make_png(seed),
        received_at=RECEIVED, **kw,
    ).item


async def test_successful_analysis_fills_fields(collector, analyzer):
    item = save(collector, 1, caption="附言")
    done = await collector.analyze(item.id)
    assert done.status == "done"
    assert done.title == "測試標題" and done.category == "科技" and done.category_source == "ai"
    assert done.tags == ["AI", "手機"] and done.todos == ["試用看看"]
    assert done.ai_attempts == 1 and done.ai_last_error is None
    request = analyzer.analysis_calls[0]
    assert request.caption == "附言"
    assert request.images and request.images[0].media_type == "image/jpeg"


async def test_failure_keeps_image_and_schedules_retry(collector, analyzer, settings, clock, db):
    item = save(collector, 2)
    analyzer.fail_analysis = AIError("連不上 Anthropic API")
    failed = await collector.analyze(item.id)

    assert failed.status == "failed"
    assert (settings.data_dir / failed.file_path).exists()  # 原圖仍在
    assert failed.ai_attempts == 1
    assert failed.ai_last_error == "連不上 Anthropic API"
    assert failed.ai_next_retry_at == clock.now + timedelta(minutes=settings.ai_retry_base_minutes)
    assert db.get_item(item.id).title is None

    # 還沒到時間不重試
    assert collector.due_for_retry() == []
    assert await collector.retry_due() == []

    # 時間到、AI 恢復 → 自動補完
    clock.now = failed.ai_next_retry_at
    analyzer.fail_analysis = None
    recovered = await collector.retry_due()
    assert [r.id for r in recovered] == [item.id]
    done = db.get_item(item.id)
    assert done.status == "done" and done.ai_next_retry_at is None and done.ai_attempts == 2


async def test_backoff_grows_and_stops_after_max_attempts(collector, analyzer, settings, clock):
    item = save(collector, 3)
    analyzer.fail_analysis = AIError("額度用完")
    delays = []
    for _ in range(settings.ai_max_attempts):
        before = clock.now
        result = await collector.analyze(item.id)
        if result.ai_next_retry_at:
            delays.append(result.ai_next_retry_at - before)
            clock.now = result.ai_next_retry_at
    assert delays == sorted(delays) and delays[1] == 2 * delays[0]
    assert result.status == "failed" and result.ai_next_retry_at is None
    clock.now += timedelta(days=30)
    assert collector.due_for_retry() == []  # 超過次數只能手動 /retry


async def test_unexpected_exception_is_recorded_not_raised(collector, analyzer):
    item = save(collector, 4)
    analyzer.fail_analysis = ValueError("boom")
    failed = await collector.analyze(item.id)
    assert failed.status == "failed" and "boom" in failed.ai_last_error


async def test_ai_not_configured_does_not_auto_retry(collector, analyzer):
    item = save(collector, 5)
    analyzer.fail_analysis = AINotConfigured("尚未設定 AI")
    failed = await collector.analyze(item.id)
    assert failed.status == "failed" and failed.ai_next_retry_at is None


async def test_missing_file_is_a_failure_not_a_crash(collector, settings):
    item = save(collector, 6)
    (settings.data_dir / item.file_path).unlink()
    failed = await collector.analyze(item.id)
    assert failed.status == "failed"


async def test_stale_pending_item_is_picked_up(collector, clock):
    """分析途中服務重啟，pending 的項目之後會被重試排程接手。"""
    saved_at = clock.now
    item = save(collector, 7)
    clock.now = saved_at + timedelta(minutes=5)
    assert collector.due_for_retry() == []
    clock.now = saved_at + timedelta(minutes=11)
    assert [i.id for i in collector.due_for_retry()] == [item.id]


async def test_user_category_survives_reanalysis(collector, analyzer):
    item = save(collector, 8)
    analyzer.fail_analysis = AIError("x")
    await collector.analyze(item.id)
    collector.set_category(USER, item.id, "理財")
    analyzer.fail_analysis = None
    done = await collector.analyze(item.id)
    assert done.category == "理財" and done.category_source == "user"
    assert done.title == "測試標題"


def test_normalize_analysis_guards_ai_output():
    cats = parse_categories(None)
    a = normalize_analysis(
        {"title": "  很長 " * 30, "category": "不存在的分類", "tags": ["#AI", "AI", 3, "  "],
         "todos": "不是陣列", "summary": None},
        cats,
    )
    assert a.category == "其他"
    assert a.tags == ["AI"]
    assert a.todos == [] and a.summary == ""
    assert len(a.title) <= 40


def test_normalize_briefing_drops_unknown_ids():
    draft = normalize_briefing(
        {
            "overview": "重點",
            "themes": [{"name": "主題", "summary": "s", "item_ids": [1, 99, True, 1]}],
            "highlights": [{"item_id": 2, "reason": "r"}, {"item_id": 42, "reason": "編造"},
                           {"item_id": 2, "reason": "重複"}],
            "actions": [{"text": "去報名", "item_ids": [2, 7]}],
        },
        {1, 2},
    )
    assert draft.themes[0].item_ids == [1]
    assert [h.item_id for h in draft.highlights] == [2]
    assert draft.actions[0].item_ids == [2]


def test_categories_are_configurable():
    assert parse_categories("工作,副業，投資") == ("工作", "副業", "投資", "其他")
    assert parse_categories("")[-1] == "其他"
