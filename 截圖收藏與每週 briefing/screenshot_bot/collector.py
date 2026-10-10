"""收藏流程：存原圖 → 去重 → 寫資料庫 → AI 整理（失敗可重試）。不依賴 Telegram。"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from .ai.base import AIError, AINotConfigured, AnalysisRequest, Analyzer, ImagePart
from .config import FALLBACK_CATEGORY, Settings
from .db import Database, Item, to_db_time
from .images import ImageTooLarge, hamming, inspect_image, prepare_for_vision, store_original

log = logging.getLogger(__name__)

URL_RE = re.compile(r"https?://[^\s<>\"'）」』]+", re.IGNORECASE)
# 有 pending 項目卡超過這個時間（例如分析途中服務重啟），就交給重試排程
STALE_PENDING = timedelta(minutes=10)
MAX_RETRY_DELAY = timedelta(hours=6)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def extract_url(text: str | None) -> str | None:
    """只從使用者自己打的文字取網址；絕不從截圖推測。"""
    if not text:
        return None
    match = URL_RE.search(text)
    return match.group(0).rstrip(".,;!?，。；！？") if match else None


@dataclass
class SaveResult:
    item: Item
    duplicate: bool = False
    similar_to: Item | None = None


class Collector:
    def __init__(
        self,
        db: Database,
        settings: Settings,
        analyzer: Analyzer,
        clock: Callable[[], datetime] = utcnow,
    ):
        self.db = db
        self.settings = settings
        self.analyzer = analyzer
        self.clock = clock

    # ---- 收藏 ----
    def already_handled(self, chat_id: int, message_id: int) -> bool:
        return self.db.is_message_processed(chat_id, message_id)

    def find_by_unique_id(self, user_id: int, unique_id: str | None) -> Item | None:
        if not unique_id:
            return None
        return self.db.find_by_unique_id(user_id, unique_id)

    def mark_duplicate_message(self, chat_id: int, message_id: int, item: Item) -> None:
        self.db.record_message(chat_id, message_id, "duplicate", item.id, self.clock())

    def save(
        self,
        *,
        user_id: int,
        chat_id: int,
        message_id: int,
        data: bytes,
        received_at: datetime,
        caption: str | None = None,
        source_url: str | None = None,
        file_unique_id: str | None = None,
    ) -> SaveResult:
        """保存原圖。InvalidImage / ImageTooLarge 會往外丟，由呼叫端回覆使用者。"""
        if len(data) > self.settings.max_image_bytes:
            raise ImageTooLarge(f"檔案 {len(data) / 1024 / 1024:.1f} MB 超過上限")
        info = inspect_image(data)

        existing = self.db.find_by_sha(user_id, info.sha256)
        if existing is not None:
            self.mark_duplicate_message(chat_id, message_id, existing)
            return SaveResult(item=existing, duplicate=True)

        similar_to = None
        best = self.settings.similar_hash_distance + 1
        for other_id, other_hash in self.db.iter_dhashes(user_id):
            distance = hamming(info.dhash, other_hash)
            if distance < best:
                best, similar_to = distance, other_id

        # 先把檔案寫進持久化目錄，再寫資料庫：資料庫裡的每一列一定找得到原圖
        local = received_at.astimezone(self.settings.tz)
        rel_dir = Path("images") / str(user_id) / f"{local:%Y}" / f"{local:%m}"
        rel_path = store_original(self.settings.data_dir, rel_dir, info, data)
        caption = caption.strip() if caption and caption.strip() else None
        source_url = source_url or extract_url(caption)
        item_id = self.db.insert_item(
            {
                "user_id": user_id,
                "chat_id": chat_id,
                "message_id": message_id,
                "received_at": to_db_time(received_at),
                "created_at": to_db_time(self.clock()),
                "file_path": rel_path,
                "sha256": info.sha256,
                "dhash": info.dhash,
                "tg_file_unique_id": file_unique_id,
                "mime_type": info.mime_type,
                "file_size": info.size,
                "width": info.width,
                "height": info.height,
                "caption": caption,
                "source_url": source_url,
                "status": "pending",
            },
            self.clock(),
        )
        item = self.db.get_item(item_id)
        assert item is not None
        similar = self.db.get_item(similar_to) if similar_to is not None else None
        return SaveResult(item=item, similar_to=similar)

    # ---- AI 整理 ----
    def _retry_delay(self, attempts: int) -> timedelta:
        base = timedelta(minutes=self.settings.ai_retry_base_minutes)
        return min(base * (2 ** max(attempts - 1, 0)), MAX_RETRY_DELAY)

    async def analyze(self, item_id: int) -> Item:
        """整理一則收藏。失敗不會丟例外，而是把狀態記成 failed 並排定下次重試。"""
        item = self.db.get_item(item_id)
        if item is None:
            raise KeyError(item_id)
        path = self.settings.data_dir / item.file_path
        try:
            data = path.read_bytes()
            parts = [ImagePart(d, m) for d, m in prepare_for_vision(data)]
            analysis = await self.analyzer.analyze_image(
                AnalysisRequest(
                    images=parts,
                    caption=item.caption,
                    source_url=item.source_url,
                    categories=self.settings.categories,
                )
            )
        except Exception as exc:  # noqa: BLE001 — 任何失敗都要記錄下來，圖片已經存好了
            attempts = item.ai_attempts + 1
            if isinstance(exc, AINotConfigured):
                next_retry = None
            elif attempts >= self.settings.ai_max_attempts:
                next_retry = None
            else:
                next_retry = self.clock() + self._retry_delay(attempts)
            message = str(exc) if isinstance(exc, (AIError, OSError)) else f"{type(exc).__name__}: {exc}"
            if not isinstance(exc, AIError):
                log.exception("分析 #%s 時發生非預期錯誤", item_id)
            else:
                log.warning("分析 #%s 失敗：%s", item_id, message)
            self.db.update_item(
                item_id,
                status="failed",
                ai_attempts=attempts,
                ai_last_error=message[:500],
                ai_next_retry_at=next_retry,
            )
            return self.db.get_item(item_id) or item

        # 使用者手動改過的分類不被 AI 覆蓋
        current = self.db.get_item(item_id)
        if current is None:  # 分析途中被刪除
            return item
        fields = dict(
            status="done",
            title=analysis.title,
            summary=analysis.summary,
            tags=analysis.tags,
            todos=analysis.todos,
            uncertain=analysis.uncertain,
            key_text=analysis.key_text,
            source_platform=analysis.source_platform,
            ai_attempts=current.ai_attempts + 1,
            ai_last_error=None,
            ai_next_retry_at=None,
            ai_model=analysis.model or self.analyzer.name,
            analyzed_at=self.clock(),
        )
        if current.category_source != "user":
            fields["category"] = analysis.category
            fields["category_source"] = "ai"
        self.db.update_item(item_id, **fields)
        return self.db.get_item(item_id)  # type: ignore[return-value]

    def due_for_retry(self) -> list[Item]:
        now = self.clock()
        return self.db.items_due_for_retry(now, now - STALE_PENDING)

    async def retry_due(self) -> list[Item]:
        """排程用：重試到期的失敗項目，回傳這次重試成功的收藏。"""
        recovered = []
        for item in self.due_for_retry():
            result = await self.analyze(item.id)
            if result.status == "done":
                recovered.append(result)
        return recovered

    # ---- 指令用 ----
    def set_category(self, user_id: int, item_id: int, category: str) -> Item | None:
        if category not in self.settings.categories:
            raise ValueError(category)
        item = self.db.get_item(item_id, user_id)
        if item is None:
            return None
        self.db.update_item(item_id, category=category, category_source="user")
        return self.db.get_item(item_id)

    def set_note(self, user_id: int, item_id: int, text: str) -> Item | None:
        """回覆收藏訊息補充附言／原文連結。"""
        item = self.db.get_item(item_id, user_id)
        if item is None:
            return None
        caption = "\n".join(x for x in (item.caption, text.strip()) if x)
        url = extract_url(text) or item.source_url
        self.db.update_item(item_id, caption=caption, source_url=url)
        return self.db.get_item(item_id)

    def delete(self, user_id: int, item_id: int) -> Item | None:
        item = self.db.delete_item(item_id, user_id)
        if item is not None:
            # 同一張圖（同 sha256）只會存一份，所以可以直接刪檔
            (self.settings.data_dir / item.file_path).unlink(missing_ok=True)
        return item

    def category_or_fallback(self, item: Item) -> str:
        return item.category or FALLBACK_CATEGORY
