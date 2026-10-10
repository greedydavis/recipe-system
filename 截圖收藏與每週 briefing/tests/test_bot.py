"""Telegram 介面層：用假的 bot 物件跑完整的「傳圖 → 已收藏 → 整理結果」流程。"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from telegram.error import BadRequest, RetryAfter, TimedOut
from telegram.ext import ApplicationHandlerStop

from conftest import USER, make_png
from screenshot_bot.bot import BotApp, with_retry
from screenshot_bot.formatting import split_message

STRANGER = 999


class FakeSent:
    def __init__(self, bot, chat_id, text, **kw):
        self.bot, self.chat_id, self.text, self.kw = bot, chat_id, text, kw
        self.edits: list[str] = []

    def get_bot(self):
        return self.bot

    async def edit_text(self, text, **kw):
        self.edits.append(text)
        self.text = text


class FakeBot:
    id = 4242

    def __init__(self, files: dict[str, bytes] | None = None, download_error: Exception | None = None):
        self.files = files or {}
        self.download_error = download_error
        self.sent: list[FakeSent] = []
        self.documents: list[dict] = []
        self.downloads = 0

    async def send_message(self, chat_id, text, **kw):
        msg = FakeSent(self, chat_id, text, **kw)
        self.sent.append(msg)
        return msg

    async def send_chat_action(self, *a, **kw):
        return True

    async def get_file(self, file_id):
        if self.download_error:
            raise self.download_error
        data = self.files[file_id]

        async def download_as_bytearray():
            self.downloads += 1
            return bytearray(data)

        return SimpleNamespace(download_as_bytearray=download_as_bytearray)

    async def send_document(self, chat_id, document, filename, caption):
        self.documents.append({"chat_id": chat_id, "bytes": document.read(), "filename": filename})


def photo_update(bot, message_id, file_id, *, user=USER, unique_id=None, caption=None, chat_type="private"):
    photo = SimpleNamespace(file_id=file_id, file_unique_id=unique_id or file_id, file_size=1000)
    msg = SimpleNamespace(
        chat_id=user, message_id=message_id, photo=[photo], document=None, caption=caption,
        date=datetime(2026, 10, 7, 3, 0, tzinfo=timezone.utc),
        parse_caption_entities=lambda types: {},
        get_bot=lambda: bot,
    )
    return SimpleNamespace(
        effective_message=msg,
        effective_user=SimpleNamespace(id=user),
        effective_chat=SimpleNamespace(id=user, type=chat_type),
        callback_query=None,
    )


@pytest.fixture
def app(settings, db, collector, make_briefings):
    return BotApp(settings, db, collector, make_briefings())


async def test_photo_flow_replies_saved_then_analysis(app, db):
    bot = FakeBot({"f1": make_png(1)})
    update = photo_update(bot, 10, "f1", caption="之後要看")
    await app.on_image(update, SimpleNamespace(bot=bot, args=[]))

    assert len(bot.sent) == 1
    reply = bot.sent[0]
    assert "已收藏" in reply.text and "#1" in reply.text
    assert reply.kw.get("reply_to_message_id") == 10
    final = reply.edits[-1]
    assert "✅ 已收藏" in final and "測試標題" in final and "分類：科技" in final
    assert "試用看看" in final  # 待辦
    assert db.get_item(1).status == "done"


async def test_same_photo_twice_is_friendly_duplicate(app, db):
    data = make_png(2)
    bot = FakeBot({"a": data, "b": data})
    ctx = SimpleNamespace(bot=bot, args=[])
    await app.on_image(photo_update(bot, 1, "a"), ctx)
    await app.on_image(photo_update(bot, 2, "b"), ctx)  # 不同 file_id、相同內容
    assert "已經收藏過了" in bot.sent[-1].text and "#1" in bot.sent[-1].text
    assert len(db.recent_items(USER)) == 1

    # 同一個 file_unique_id：連下載都不用
    downloads = bot.downloads
    await app.on_image(photo_update(bot, 3, "a", unique_id="a"), ctx)
    assert bot.downloads == downloads
    assert "已經收藏過了" in bot.sent[-1].text

    # Telegram 重送同一則訊息：靜默略過
    count = len(bot.sent)
    await app.on_image(photo_update(bot, 1, "a"), ctx)
    assert len(bot.sent) == count


async def test_ai_failure_still_confirms_saved(app, analyzer, db):
    from screenshot_bot.ai.base import AIError

    analyzer.fail_analysis = AIError("連不上 Anthropic API")
    bot = FakeBot({"f": make_png(3)})
    await app.on_image(photo_update(bot, 1, "f"), SimpleNamespace(bot=bot, args=[]))
    final = bot.sent[0].edits[-1]
    assert "已收藏" in final and "AI 整理暫時失敗" in final and "/retry 1" in final
    assert db.get_item(1).status == "failed"


async def test_download_failure_is_reported_and_nothing_saved(app, db):
    bot = FakeBot(download_error=BadRequest("File is too big"))
    await app.on_image(photo_update(bot, 1, "f"), SimpleNamespace(bot=bot, args=[]))
    assert "檔案太大" in bot.sent[-1].text
    bot = FakeBot(download_error=TimedOut())
    app_ctx = SimpleNamespace(bot=bot, args=[])
    # with_retry 會重試，這裡把等待時間拿掉
    import screenshot_bot.bot as botmod

    original_sleep = botmod.asyncio.sleep

    async def no_sleep(_):
        return None

    botmod.asyncio.sleep = no_sleep
    try:
        await app.on_image(photo_update(bot, 2, "f"), app_ctx)
    finally:
        botmod.asyncio.sleep = original_sleep
    assert "下載圖片失敗" in bot.sent[-1].text
    assert db.recent_items(USER) == []


async def test_get_returns_original_bytes(app):
    data = make_png(4)
    bot = FakeBot({"f": data})
    await app.on_image(photo_update(bot, 1, "f"), SimpleNamespace(bot=bot, args=[]))
    update = photo_update(bot, 2, "unused")
    await app.cmd_get(update, SimpleNamespace(bot=bot, args=["1"]))
    assert bot.documents[0]["bytes"] == data
    # 別人的編號拿不到
    other = photo_update(bot, 3, "unused", user=222)
    await app.cmd_get(other, SimpleNamespace(bot=bot, args=["1"]))
    assert len(bot.documents) == 1 and "找不到收藏 #1" in bot.sent[-1].text


async def test_category_command_and_search(app, db):
    bot = FakeBot({"f": make_png(5)})
    await app.on_image(photo_update(bot, 1, "f"), SimpleNamespace(bot=bot, args=[]))
    upd = photo_update(bot, 2, "x")
    await app.cmd_category(upd, SimpleNamespace(bot=bot, args=["1", "理財"]))
    assert db.get_item(1).category == "理財" and db.get_item(1).category_source == "user"
    await app.cmd_category(upd, SimpleNamespace(bot=bot, args=["1", "亂填"]))
    assert "沒有「亂填」這個分類" in bot.sent[-1].text
    await app.cmd_search(upd, SimpleNamespace(bot=bot, args=["測試標題"]))
    assert "#1" in bot.sent[-1].text


async def test_gate_blocks_strangers_and_group_chats(app):
    bot = FakeBot()
    replies = []

    async def reply_text(text):
        replies.append(text)

    stranger = photo_update(bot, 1, "f", user=STRANGER)
    stranger.effective_message.reply_text = reply_text
    with pytest.raises(ApplicationHandlerStop):
        await app.gate(stranger, SimpleNamespace(bot=bot))
    assert str(STRANGER) in replies[0] and "沒有使用權限" in replies[0]

    in_group = photo_update(bot, 2, "f", chat_type="group")
    in_group.effective_message.reply_text = reply_text
    with pytest.raises(ApplicationHandlerStop):
        await app.gate(in_group, SimpleNamespace(bot=bot))

    await app.gate(photo_update(bot, 3, "f"), SimpleNamespace(bot=bot))  # 擁有者：放行


async def test_with_retry_handles_flood_control(monkeypatch):
    import screenshot_bot.bot as botmod

    waits = []

    async def fake_sleep(seconds):
        waits.append(seconds)

    monkeypatch.setattr(botmod.asyncio, "sleep", fake_sleep)
    calls = {"n": 0}

    async def flaky():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RetryAfter(3)
        if calls["n"] == 2:
            raise TimedOut()
        return "ok"

    assert await with_retry(flaky) == "ok"
    assert waits[0] >= 3 and len(waits) == 2

    async def bad():
        raise BadRequest("chat not found")

    with pytest.raises(BadRequest):
        await with_retry(bad)


def test_split_message_respects_telegram_limit():
    text = "\n".join(f"第 {i} 行 " + "字" * 50 for i in range(300))
    chunks = split_message(text)
    assert len(chunks) > 1
    assert all(len(c) <= 4096 for c in chunks)
    assert "\n".join(chunks) == text
