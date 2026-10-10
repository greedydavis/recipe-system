"""每週 briefing：計算期間、產生內容、確保同一週只寄一次。"""

from __future__ import annotations

import logging
import math
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Sequence

from .ai.base import (
    Action,
    Analyzer,
    BriefingDraft,
    BriefingItem,
    BriefingRequest,
    Highlight,
    Theme,
)
from .config import Settings
from .db import Database, Item, from_db_time, to_db_time
from .formatting import period_label, render_briefing, render_empty_briefing

log = logging.getLogger(__name__)

FAILED_RETRY_COOLDOWN = timedelta(minutes=10)
MAX_SEND_ATTEMPTS = 5

Sender = Callable[[int, str], Awaitable[None]]


@dataclass(frozen=True)
class Period:
    start: datetime  # 含
    end: datetime  # 不含


def latest_period_end(now: datetime, settings: Settings) -> datetime:
    """回傳 ≤ now 的最近一次排程時間（例如上一個週日 20:00，Asia/Taipei），以 UTC 表示。"""
    local = now.astimezone(settings.tz)
    days_back = (local.weekday() - settings.briefing_weekday) % 7
    candidate = (local - timedelta(days=days_back)).replace(
        hour=settings.briefing_hour, minute=settings.briefing_minute, second=0, microsecond=0
    )
    if candidate > local:
        candidate -= timedelta(days=7)
    return candidate.astimezone(timezone.utc)


def due_period(now: datetime, settings: Settings) -> Period:
    """最近一個已經到期的完整週期：[上上次排程, 上次排程)。"""
    end = latest_period_end(now, settings)
    start = (end.astimezone(settings.tz) - timedelta(days=7)).astimezone(timezone.utc)
    return Period(start, end)


def preview_period(now: datetime, settings: Settings) -> Period:
    """本週到目前為止：[上次排程, now)。"""
    return Period(latest_period_end(now, settings), now)


def _fallback_draft(items: Sequence[Item]) -> BriefingDraft:
    """AI 無法使用時的自動統計版，仍然是彙整而不是逐則重複。"""
    by_category: dict[str, list[Item]] = {}
    for it in items:
        by_category.setdefault(it.category or "未分類", []).append(it)
    ranked_categories = sorted(by_category.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    tag_counts = Counter(tag for it in items for tag in it.tags)

    top = "、".join(f"「{c}」（{len(v)} 則）" for c, v in ranked_categories[:3])
    overview = f"本週共收藏 {len(items)} 則，主要集中在{top}。"
    if tag_counts:
        overview += "常出現的標籤：" + "、".join(f"#{t}" for t, _ in tag_counts.most_common(5)) + "。"

    themes = []
    for category, members in ranked_categories[:4]:
        tags = Counter(t for it in members for t in it.tags).most_common(3)
        summary = ("常見標籤：" + " ".join(f"#{t}" for t, _ in tags)) if tags else f"{len(members)} 則"
        themes.append(Theme(category, summary, [it.id for it in members][:8]))

    def score(it: Item) -> tuple[int, datetime]:
        points = 3 * bool(it.todos) + bool(it.source_url) + bool(it.caption) + (it.category_source == "user")
        return points, it.received_at

    n = len(items)
    k = n if n <= 5 else min(10, max(5, math.ceil(n / 2)))
    picked = sorted(items, key=score, reverse=True)[:k]
    highlights = []
    for it in sorted(picked, key=lambda i: i.received_at):
        reason = "有待辦事項" if it.todos else (it.summary or it.caption or "")
        highlights.append(Highlight(it.id, reason[:80]))

    actions = [Action(todo, [it.id]) for it in items for todo in it.todos][:8]
    return BriefingDraft(overview=overview, themes=themes, highlights=highlights, actions=actions)


class BriefingService:
    def __init__(
        self,
        db: Database,
        settings: Settings,
        analyzer: Analyzer,
        clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ):
        self.db = db
        self.settings = settings
        self.analyzer = analyzer
        self.clock = clock
        # 第一次啟動的時間；在這之前結束的週期不補寄（避免剛安裝就收到一封空週報）
        installed = self.db.set_meta_if_absent("installed_at", to_db_time(clock()))
        self.installed_at = from_db_time(installed)

    async def build(self, user_id: int, period: Period, *, preview: bool = False) -> tuple[str, int]:
        items = self.db.items_between(user_id, period.start, period.end)
        label = period_label(period.start, period.end, self.settings.tz)
        if not items:
            return render_empty_briefing(label, preview), 0
        request = BriefingRequest(
            period_label=label,
            categories=self.settings.categories,
            items=[
                BriefingItem(
                    id=it.id,
                    received_at=it.received_at.astimezone(self.settings.tz),
                    title=it.title or "",
                    summary=it.summary or "",
                    category=it.category or "",
                    tags=it.tags,
                    todos=it.todos,
                    caption=it.caption,
                    source_url=it.source_url,
                    analyzed=it.status == "done",
                )
                for it in items
            ],
        )
        ai_ok = True
        try:
            draft = await self.analyzer.compose_briefing(request)
            if not draft.overview and not draft.themes and not draft.highlights:
                raise ValueError("AI 回傳空白 briefing")
        except Exception as exc:  # noqa: BLE001 — 週報一定要寄得出去，AI 失敗就用統計版
            log.warning("AI 產生 briefing 失敗，改用統計版：%s", exc)
            draft = _fallback_draft(items)
            ai_ok = False
        text = render_briefing(items=items, draft=draft, label=label, ai_ok=ai_ok, preview=preview)
        return text, len(items)

    async def run_due(self, send: Sender) -> list[int]:
        """排程每分鐘呼叫一次。回傳這次真的寄出的使用者 ID。"""
        now = self.clock()
        period = due_period(now, self.settings)
        if self.installed_at and period.end <= self.installed_at:
            return []
        if now - period.end > timedelta(hours=self.settings.briefing_grace_hours):
            return []
        sent = []
        for user_id in sorted(self.settings.allowed_user_ids):
            claimed = self.db.claim_briefing(
                user_id, period.start, period.end, now,
                retry_failed_before=now - FAILED_RETRY_COOLDOWN,
                max_attempts=MAX_SEND_ATTEMPTS,
            )
            if not claimed:
                continue
            text: str | None = None
            count: int | None = None
            try:
                text, count = await self.build(user_id, period)
                await send(user_id, text)
            except Exception as exc:  # noqa: BLE001
                log.exception("寄送 briefing 給 %s 失敗", user_id)
                self.db.finish_briefing(
                    user_id, period.end, ok=False, now=self.clock(), text=text,
                    item_count=count, error=str(exc)[:500],
                )
                continue
            self.db.finish_briefing(
                user_id, period.end, ok=True, now=self.clock(), text=text, item_count=count
            )
            sent.append(user_id)
        return sent
