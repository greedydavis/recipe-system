"""SQLite 資料層。所有時間都以 UTC ISO 字串（秒）儲存，方便以字串比較範圍。"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = 1

_MIGRATIONS = {
    1: """
    CREATE TABLE items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        received_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        file_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        dhash TEXT,
        tg_file_unique_id TEXT,
        mime_type TEXT,
        file_size INTEGER,
        width INTEGER,
        height INTEGER,
        caption TEXT,
        source_url TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
        title TEXT,
        summary TEXT,
        category TEXT,
        category_source TEXT CHECK (category_source IN ('ai', 'user')),
        tags TEXT NOT NULL DEFAULT '[]',
        todos TEXT NOT NULL DEFAULT '[]',
        uncertain TEXT NOT NULL DEFAULT '[]',
        key_text TEXT,
        source_platform TEXT,
        ai_attempts INTEGER NOT NULL DEFAULT 0,
        ai_last_error TEXT,
        ai_next_retry_at TEXT,
        ai_model TEXT,
        analyzed_at TEXT,
        UNIQUE (user_id, sha256)
    );
    CREATE INDEX items_user_received ON items (user_id, received_at);
    CREATE INDEX items_retry ON items (status, ai_next_retry_at);
    CREATE INDEX items_unique_id ON items (user_id, tg_file_unique_id);

    -- 每則處理過的 Telegram 圖片訊息；同一則訊息被重送時直接略過
    CREATE TABLE processed_messages (
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        item_id INTEGER,
        created_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, message_id)
    );

    -- 每位使用者每一週只會有一列；status 用來確保重啟後不重寄
    CREATE TABLE briefings (
        user_id INTEGER NOT NULL,
        period_end TEXT NOT NULL,
        period_start TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 1,
        item_count INTEGER,
        text TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        PRIMARY KEY (user_id, period_end)
    );

    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """,
}


def to_db_time(dt: datetime) -> str:
    if dt.tzinfo is None:
        raise ValueError("datetime 必須帶時區")
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def from_db_time(raw: str | None) -> datetime | None:
    if raw is None:
        return None
    return datetime.fromisoformat(raw)


@dataclass
class Item:
    id: int
    user_id: int
    chat_id: int
    message_id: int
    received_at: datetime
    created_at: datetime
    file_path: str
    sha256: str
    dhash: str | None
    tg_file_unique_id: str | None
    mime_type: str | None
    file_size: int | None
    width: int | None
    height: int | None
    caption: str | None
    source_url: str | None
    status: str
    title: str | None
    summary: str | None
    category: str | None
    category_source: str | None
    tags: list[str]
    todos: list[str]
    uncertain: list[str]
    key_text: str | None
    source_platform: str | None
    ai_attempts: int
    ai_last_error: str | None
    ai_next_retry_at: datetime | None
    ai_model: str | None
    analyzed_at: datetime | None

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "Item":
        data = dict(row)
        for key in ("tags", "todos", "uncertain"):
            data[key] = json.loads(data[key] or "[]")
        for key in ("received_at", "created_at", "ai_next_retry_at", "analyzed_at"):
            data[key] = from_db_time(data[key])
        return cls(**data)

    @property
    def display_title(self) -> str:
        if self.title:
            return self.title
        if self.caption:
            return self.caption.strip().splitlines()[0][:40]
        return "（尚未整理）"


class Database:
    def __init__(self, path: Path | str):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.execute("PRAGMA busy_timeout = 5000")
        if self.path != ":memory:":
            self.conn.execute("PRAGMA journal_mode = WAL")
        self._migrate()

    def close(self) -> None:
        self.conn.close()

    def _migrate(self) -> None:
        current = self.conn.execute("PRAGMA user_version").fetchone()[0]
        for version in range(current + 1, SCHEMA_VERSION + 1):
            with self.conn:
                self.conn.executescript(_MIGRATIONS[version])
                self.conn.execute(f"PRAGMA user_version = {version}")

    # ---- meta ----
    def get_meta(self, key: str) -> str | None:
        row = self.conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def set_meta_if_absent(self, key: str, value: str) -> str:
        with self.conn:
            self.conn.execute(
                "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
                (key, value),
            )
        return self.get_meta(key)  # type: ignore[return-value]

    # ---- processed messages ----
    def is_message_processed(self, chat_id: int, message_id: int) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM processed_messages WHERE chat_id = ? AND message_id = ?",
            (chat_id, message_id),
        ).fetchone()
        return row is not None

    def record_message(
        self, chat_id: int, message_id: int, outcome: str, item_id: int | None, now: datetime
    ) -> None:
        with self.conn:
            self.conn.execute(
                "INSERT OR IGNORE INTO processed_messages "
                "(chat_id, message_id, outcome, item_id, created_at) VALUES (?, ?, ?, ?, ?)",
                (chat_id, message_id, outcome, item_id, to_db_time(now)),
            )

    # ---- items ----
    def insert_item(self, fields: dict[str, Any], now: datetime) -> int:
        cols = ", ".join(fields)
        marks = ", ".join("?" for _ in fields)
        with self.conn:
            cur = self.conn.execute(
                f"INSERT INTO items ({cols}) VALUES ({marks})", tuple(fields.values())
            )
            item_id = int(cur.lastrowid)
            self.conn.execute(
                "INSERT OR IGNORE INTO processed_messages "
                "(chat_id, message_id, outcome, item_id, created_at) VALUES (?, ?, 'saved', ?, ?)",
                (fields["chat_id"], fields["message_id"], item_id, to_db_time(now)),
            )
        return item_id

    def update_item(self, item_id: int, **fields: Any) -> None:
        for key in ("tags", "todos", "uncertain"):
            if key in fields:
                fields[key] = json.dumps(fields[key], ensure_ascii=False)
        for key, value in list(fields.items()):
            if isinstance(value, datetime):
                fields[key] = to_db_time(value)
        sets = ", ".join(f"{k} = ?" for k in fields)
        with self.conn:
            self.conn.execute(
                f"UPDATE items SET {sets} WHERE id = ?", (*fields.values(), item_id)
            )

    def get_item(self, item_id: int, user_id: int | None = None) -> Item | None:
        sql = "SELECT * FROM items WHERE id = ?"
        params: tuple[Any, ...] = (item_id,)
        if user_id is not None:
            sql += " AND user_id = ?"
            params += (user_id,)
        row = self.conn.execute(sql, params).fetchone()
        return Item.from_row(row) if row else None

    def find_by_sha(self, user_id: int, sha256: str) -> Item | None:
        row = self.conn.execute(
            "SELECT * FROM items WHERE user_id = ? AND sha256 = ?", (user_id, sha256)
        ).fetchone()
        return Item.from_row(row) if row else None

    def find_by_unique_id(self, user_id: int, unique_id: str) -> Item | None:
        row = self.conn.execute(
            "SELECT * FROM items WHERE user_id = ? AND tg_file_unique_id = ? ORDER BY id LIMIT 1",
            (user_id, unique_id),
        ).fetchone()
        return Item.from_row(row) if row else None

    def iter_dhashes(self, user_id: int) -> Iterable[tuple[int, str]]:
        for row in self.conn.execute(
            "SELECT id, dhash FROM items WHERE user_id = ? AND dhash IS NOT NULL", (user_id,)
        ):
            yield row["id"], row["dhash"]

    def recent_items(self, user_id: int, limit: int = 10) -> list[Item]:
        rows = self.conn.execute(
            "SELECT * FROM items WHERE user_id = ? ORDER BY received_at DESC, id DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
        return [Item.from_row(r) for r in rows]

    def search_items(self, user_id: int, keywords: list[str], limit: int = 10) -> list[Item]:
        fields = (
            "title", "summary", "category", "tags", "todos", "key_text",
            "caption", "source_url", "source_platform",
        )
        haystack = " || ' ' || ".join(f"COALESCE({f}, '')" for f in fields)
        where = ["user_id = ?"]
        params: list[Any] = [user_id]
        for word in keywords:
            escaped = word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            where.append(f"({haystack}) LIKE ? ESCAPE '\\'")
            params.append(f"%{escaped}%")
        params.append(limit)
        rows = self.conn.execute(
            f"SELECT * FROM items WHERE {' AND '.join(where)} "
            "ORDER BY received_at DESC, id DESC LIMIT ?",
            params,
        ).fetchall()
        return [Item.from_row(r) for r in rows]

    def items_between(self, user_id: int, start: datetime, end: datetime) -> list[Item]:
        rows = self.conn.execute(
            "SELECT * FROM items WHERE user_id = ? AND received_at >= ? AND received_at < ? "
            "ORDER BY received_at, id",
            (user_id, to_db_time(start), to_db_time(end)),
        ).fetchall()
        return [Item.from_row(r) for r in rows]

    def items_due_for_retry(self, now: datetime, stale_pending_before: datetime) -> list[Item]:
        rows = self.conn.execute(
            "SELECT * FROM items WHERE "
            "(status = 'failed' AND ai_next_retry_at IS NOT NULL AND ai_next_retry_at <= ?) "
            "OR (status = 'pending' AND created_at <= ?) ORDER BY id",
            (to_db_time(now), to_db_time(stale_pending_before)),
        ).fetchall()
        return [Item.from_row(r) for r in rows]

    def failed_items(self, user_id: int) -> list[Item]:
        rows = self.conn.execute(
            "SELECT * FROM items WHERE user_id = ? AND status = 'failed' ORDER BY id", (user_id,)
        ).fetchall()
        return [Item.from_row(r) for r in rows]

    def delete_item(self, item_id: int, user_id: int) -> Item | None:
        item = self.get_item(item_id, user_id)
        if item is None:
            return None
        with self.conn:
            self.conn.execute("DELETE FROM items WHERE id = ?", (item_id,))
            self.conn.execute(
                "UPDATE processed_messages SET item_id = NULL WHERE item_id = ?", (item_id,)
            )
        return item

    # ---- briefings ----
    def claim_briefing(
        self,
        user_id: int,
        period_start: datetime,
        period_end: datetime,
        now: datetime,
        retry_failed_before: datetime,
        max_attempts: int,
    ) -> bool:
        """原子地取得某週 briefing 的寄送權。

        已寄出（sent）或正在寄（sending，可能是寄到一半當機）的一律不再寄，寧可漏寄也不重複。
        只有明確失敗（failed）且已過冷卻時間、未超過次數上限的才會重試。
        """
        now_s = to_db_time(now)
        with self.conn:
            cur = self.conn.execute(
                """
                INSERT INTO briefings
                    (user_id, period_end, period_start, status, attempts, created_at, updated_at)
                VALUES (?, ?, ?, 'sending', 1, ?, ?)
                ON CONFLICT (user_id, period_end) DO UPDATE SET
                    status = 'sending', attempts = attempts + 1, updated_at = excluded.updated_at
                WHERE briefings.status = 'failed'
                  AND briefings.updated_at <= ?
                  AND briefings.attempts < ?
                """,
                (
                    user_id, to_db_time(period_end), to_db_time(period_start), now_s, now_s,
                    to_db_time(retry_failed_before), max_attempts,
                ),
            )
            return cur.rowcount == 1

    def finish_briefing(
        self,
        user_id: int,
        period_end: datetime,
        *,
        ok: bool,
        now: datetime,
        text: str | None,
        item_count: int | None,
        error: str | None = None,
    ) -> None:
        with self.conn:
            self.conn.execute(
                "UPDATE briefings SET status = ?, text = ?, item_count = ?, error = ?, "
                "updated_at = ?, sent_at = ? WHERE user_id = ? AND period_end = ?",
                (
                    "sent" if ok else "failed", text, item_count, error, to_db_time(now),
                    to_db_time(now) if ok else None, user_id, to_db_time(period_end),
                ),
            )

    def get_briefing(self, user_id: int, period_end: datetime) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM briefings WHERE user_id = ? AND period_end = ?",
            (user_id, to_db_time(period_end)),
        ).fetchone()
