"""Telegram 介面層：接收圖片、指令、按鈕，以及定時任務。"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import timedelta
from pathlib import Path
from typing import Any, Awaitable, Callable, TypeVar

from telegram import (
    BotCommand,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    LinkPreviewOptions,
    Message,
    MessageEntity,
    Update,
)
from telegram.constants import ChatAction, ChatType, ParseMode
from telegram.error import BadRequest, NetworkError, RetryAfter, TelegramError, TimedOut
from telegram.ext import (
    Application,
    ApplicationHandlerStop,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    TypeHandler,
    filters,
)

from .ai import build_analyzer
from .briefing import BriefingService, preview_period
from .collector import Collector
from .config import Settings, load_dotenv
from .db import Database, Item
from .formatting import esc, item_card, item_list, local_time, split_message
from .images import ImageTooLarge, InvalidImage

log = logging.getLogger(__name__)
T = TypeVar("T")

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
ITEM_REF_RE = re.compile(r"#(\d+)")

HELP_TEXT = """📸 <b>截圖收藏機器人</b>

<b>收藏</b>：在手機截圖後「分享」給我（照片或檔案都可以）。可以在附言寫下想法或貼上原文連結。
已收藏的訊息可以直接「回覆」它，補充附言或連結。

<b>指令</b>
/recent [數量] — 最近的收藏
/search 關鍵字 — 搜尋（也可以直接傳文字）
/get 編號 — 取回原圖
/category 編號 [分類] — 更正分類
/categories — 分類清單
/retry [編號] — 重新 AI 整理失敗的收藏
/delete 編號 — 刪除收藏
/briefing — 預覽本週 briefing（會呼叫 AI）

每週日晚上 8 點（台北時間）會自動寄出本週 briefing。"""


def _seconds(value: Any) -> float:
    return value.total_seconds() if isinstance(value, timedelta) else float(value)


async def with_retry(
    fn: Callable[..., Awaitable[T]], *args: Any, attempts: int = 4, **kwargs: Any
) -> T:
    """處理 Telegram 的流量限制（RetryAfter）與暫時性網路錯誤。"""
    delay = 2.0
    for attempt in range(1, attempts + 1):
        try:
            return await fn(*args, **kwargs)
        except RetryAfter as exc:
            if attempt == attempts:
                raise
            wait = _seconds(exc.retry_after) + 1
            log.warning("Telegram 流量限制，%.0f 秒後重試", wait)
            await asyncio.sleep(wait)
        except BadRequest:
            raise  # BadRequest 是 NetworkError 的子類別，但重試也不會成功
        except (TimedOut, NetworkError) as exc:
            if attempt == attempts:
                raise
            log.warning("Telegram 連線問題（%s），%.0f 秒後重試", exc, delay)
            await asyncio.sleep(delay)
            delay *= 2
    raise AssertionError("unreachable")


async def send_text(
    bot: Any,
    chat_id: int,
    text: str,
    *,
    reply_markup: InlineKeyboardMarkup | None = None,
    reply_to: int | None = None,
) -> Message:
    chunks = split_message(text)
    last: Message | None = None
    for n, chunk in enumerate(chunks):
        is_last = n == len(chunks) - 1
        kwargs: dict[str, Any] = dict(
            chat_id=chat_id,
            text=chunk,
            parse_mode=ParseMode.HTML,
            link_preview_options=LinkPreviewOptions(is_disabled=True),
        )
        if is_last and reply_markup is not None:
            kwargs["reply_markup"] = reply_markup
        if n == 0 and reply_to is not None:
            kwargs["reply_to_message_id"] = reply_to
            kwargs["allow_sending_without_reply"] = True
        last = await with_retry(bot.send_message, **kwargs)
    assert last is not None
    return last


def item_keyboard(item: Item) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[
        InlineKeyboardButton("🏷 更正分類", callback_data=f"cat:{item.id}"),
        InlineKeyboardButton("🖼 取回原圖", callback_data=f"get:{item.id}"),
    ]])


def category_keyboard(item_id: int, categories: tuple[str, ...]) -> InlineKeyboardMarkup:
    buttons = [
        InlineKeyboardButton(name, callback_data=f"setcat:{item_id}:{i}")
        for i, name in enumerate(categories)
    ]
    rows = [buttons[i:i + 3] for i in range(0, len(buttons), 3)]
    rows.append([InlineKeyboardButton("取消", callback_data=f"back:{item_id}")])
    return InlineKeyboardMarkup(rows)


def _parse_id(raw: str | None) -> int | None:
    if raw is None:
        return None
    raw = raw.strip().lstrip("#＃")
    return int(raw) if raw.isdigit() else None


class BotApp:
    def __init__(self, settings: Settings, db: Database, collector: Collector, briefings: BriefingService):
        self.settings = settings
        self.db = db
        self.collector = collector
        self.briefings = briefings
        self._warned_users: set[int] = set()

    # ---- 權限 ----
    def is_authorized(self, update: Update) -> bool:
        user = update.effective_user
        chat = update.effective_chat
        if user is None or user.id not in self.settings.allowed_user_ids:
            return False
        # 只在私訊運作，避免在群組裡把截圖內容回覆給其他人看
        return chat is None or chat.type == ChatType.PRIVATE

    async def gate(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if self.is_authorized(update):
            return
        user = update.effective_user
        chat = update.effective_chat
        log.warning("拒絕未授權的使用者 %s（chat %s）", user.id if user else None, chat.id if chat else None)
        try:
            if update.callback_query:
                await update.callback_query.answer("沒有使用權限")
            elif (
                user and chat and chat.type == ChatType.PRIVATE
                and update.effective_message and user.id not in self._warned_users
            ):
                self._warned_users.add(user.id)
                await update.effective_message.reply_text(
                    f"這是私人機器人，你沒有使用權限。\n（你的 Telegram 使用者 ID：{user.id}）"
                )
        except TelegramError:
            pass
        raise ApplicationHandlerStop

    # ---- 收圖 ----
    async def on_image(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        msg = update.effective_message
        user = update.effective_user
        if msg is None or user is None:
            return
        if self.collector.already_handled(msg.chat_id, msg.message_id):
            log.info("訊息 %s 已處理過，略過重送", msg.message_id)
            return

        if msg.photo:
            photo = msg.photo[-1]
            file_id, unique_id, size = photo.file_id, photo.file_unique_id, photo.file_size
        elif msg.document:
            doc = msg.document
            ext = Path(doc.file_name or "").suffix.lower()
            if not ((doc.mime_type or "").startswith("image/") or ext in IMAGE_EXTENSIONS):
                await self._reply(msg, "目前只收藏圖片（截圖或照片）。這個檔案格式不支援喔。")
                return
            file_id, unique_id, size = doc.file_id, doc.file_unique_id, doc.file_size
        else:
            return

        if size and size > self.settings.max_image_bytes:
            await self._reply(msg, self._too_large_text(size))
            return

        dup = self.collector.find_by_unique_id(user.id, unique_id)
        if dup is not None:
            self.collector.mark_duplicate_message(msg.chat_id, msg.message_id, dup)
            await self._reply(msg, self._duplicate_text(dup), markup=item_keyboard(dup))
            return

        try:
            await context.bot.send_chat_action(msg.chat_id, ChatAction.TYPING)
        except TelegramError:
            pass

        try:
            tg_file = await with_retry(context.bot.get_file, file_id)
            data = bytes(await with_retry(tg_file.download_as_bytearray))
        except BadRequest as exc:
            if "too big" in str(exc).lower():
                await self._reply(msg, self._too_large_text(size))
            else:
                log.warning("下載圖片失敗：%s", exc)
                await self._reply(msg, "❌ 下載圖片失敗，請再傳一次。")
            return
        except TelegramError as exc:
            log.warning("下載圖片失敗：%s", exc)
            await self._reply(msg, "❌ 下載圖片失敗（Telegram 連線問題），請稍後再傳一次。")
            return

        caption = msg.caption
        source_url = None
        for entity, text in msg.parse_caption_entities(
            [MessageEntity.URL, MessageEntity.TEXT_LINK]
        ).items():
            source_url = entity.url if entity.type == MessageEntity.TEXT_LINK else text
            break

        try:
            result = self.collector.save(
                user_id=user.id,
                chat_id=msg.chat_id,
                message_id=msg.message_id,
                data=data,
                received_at=msg.date,
                caption=caption,
                source_url=source_url,
                file_unique_id=unique_id,
            )
        except ImageTooLarge:
            await self._reply(msg, self._too_large_text(len(data)))
            return
        except InvalidImage as exc:
            await self._reply(
                msg,
                f"❌ 無法讀取這張圖片（{esc(str(exc))}）。如果是 iPhone 的 HEIC 檔，請改用「照片」方式傳送。",
            )
            return

        if result.duplicate:
            await self._reply(msg, self._duplicate_text(result.item), markup=item_keyboard(result.item))
            return

        item = result.item
        extra = ""
        if result.similar_to is not None:
            extra = (
                f"\n\n🔍 這張看起來和 <b>#{result.similar_to.id}</b>"
                f"（{esc(result.similar_to.display_title)}）很像；如果是重複的，可以輸入 /delete {item.id}。"
            )
        placeholder = await self._reply(msg, item_card(item, self.settings.tz, header="📥 已收藏") + extra)
        item = await self.collector.analyze(item.id)
        header = "✅ 已收藏" if item.status == "done" else "📥 已收藏"
        await self._edit_or_send(placeholder, item_card(item, self.settings.tz, header=header) + extra, item_keyboard(item))

    def _too_large_text(self, size: int | None) -> str:
        mb = f"{size / 1024 / 1024:.1f} MB" if size else "超過上限"
        return (
            f"❌ 檔案太大（{mb}）。Telegram 機器人最多只能下載 {self.settings.max_image_mb} MB，"
            "請改用一般「照片」方式傳送（Telegram 會自動壓縮）。"
        )

    def _duplicate_text(self, item: Item) -> str:
        when = local_time(item.received_at, self.settings.tz)
        return (
            f"👌 這張之前已經收藏過了：<b>#{item.id}</b>（{when}）\n"
            f"📌 {esc(item.display_title)}\n"
            f"不會重複保存。輸入 /get {item.id} 可以取回原圖。"
        )

    async def _reply(self, msg: Message, text: str, markup: InlineKeyboardMarkup | None = None) -> Message:
        return await send_text(msg.get_bot(), msg.chat_id, text, reply_markup=markup, reply_to=msg.message_id)

    async def _edit_or_send(self, sent: Message, text: str, markup: InlineKeyboardMarkup | None) -> None:
        try:
            await with_retry(
                sent.edit_text, text, parse_mode=ParseMode.HTML, reply_markup=markup,
                link_preview_options=LinkPreviewOptions(is_disabled=True),
            )
        except BadRequest as exc:
            if "not modified" in str(exc).lower():
                return
            await send_text(sent.get_bot(), sent.chat_id, text, reply_markup=markup)

    # ---- 指令 ----
    async def cmd_help(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        await self._reply(update.effective_message, HELP_TEXT)

    async def cmd_recent(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        limit = _parse_id(context.args[0]) if context.args else None
        limit = min(max(limit or 10, 1), 30)
        items = self.db.recent_items(update.effective_user.id, limit)
        if not items:
            await self._reply(update.effective_message, "還沒有任何收藏。截圖後分享給我試試看！")
            return
        await self._reply(update.effective_message, item_list(items, self.settings.tz, f"🗂 最近 {len(items)} 則收藏"))

    async def _search(self, update: Update, query: str) -> None:
        keywords = query.split()[:5]
        items = self.db.search_items(update.effective_user.id, keywords, limit=10)
        if not items:
            await self._reply(update.effective_message, f"🔎 找不到符合「{esc(query)}」的收藏。")
            return
        await self._reply(
            update.effective_message,
            item_list(items, self.settings.tz, f"🔎「{esc(query)}」找到 {len(items)} 則（最多顯示 10 則）"),
        )

    async def cmd_search(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not context.args:
            await self._reply(update.effective_message, "用法：/search 關鍵字（可以輸入多個關鍵字，以空白分隔）")
            return
        await self._search(update, " ".join(context.args))

    async def _send_original(self, chat_id: int, bot: Any, user_id: int, item_id: int) -> None:
        item = self.db.get_item(item_id, user_id)
        if item is None:
            await send_text(bot, chat_id, f"找不到收藏 #{item_id}。")
            return
        path = self.settings.data_dir / item.file_path
        if not path.exists():
            await send_text(bot, chat_id, f"⚠️ 收藏 #{item_id} 的原圖檔案不見了（{esc(item.file_path)}），請檢查資料目錄。")
            return
        filename = f"{item.id}{path.suffix}"
        caption = f"#{item.id} {item.display_title}"[:1000]

        async def _send() -> Any:
            with path.open("rb") as fh:
                return await bot.send_document(chat_id, document=fh, filename=filename, caption=caption)

        try:
            await bot.send_chat_action(chat_id, ChatAction.UPLOAD_DOCUMENT)
        except TelegramError:
            pass
        await with_retry(_send)

    async def cmd_get(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        item_id = _parse_id(context.args[0]) if context.args else None
        if item_id is None:
            await self._reply(update.effective_message, "用法：/get 編號，例如 /get 12")
            return
        await self._send_original(update.effective_chat.id, context.bot, update.effective_user.id, item_id)

    async def cmd_categories(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        text = "🏷 目前的分類：\n" + "\n".join(f"• {esc(c)}" for c in self.settings.categories)
        text += "\n\n要調整分類清單，請修改 .env 的 CATEGORIES 後重新啟動。"
        await self._reply(update.effective_message, text)

    async def cmd_category(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        args = context.args or []
        item_id = _parse_id(args[0]) if args else None
        if item_id is None:
            await self._reply(update.effective_message, "用法：/category 編號 [分類]，例如 /category 12 理財")
            return
        user_id = update.effective_user.id
        item = self.db.get_item(item_id, user_id)
        if item is None:
            await self._reply(update.effective_message, f"找不到收藏 #{item_id}。")
            return
        if len(args) < 2:
            await self._reply(
                update.effective_message,
                f"請選擇 #{item_id} 的新分類（目前：{esc(item.category or '未分類')}）",
                markup=category_keyboard(item_id, self.settings.categories),
            )
            return
        name = " ".join(args[1:]).strip().replace("/", "／")
        if name not in self.settings.categories:
            await self._reply(
                update.effective_message,
                f"沒有「{esc(name)}」這個分類。可用分類：{esc('、'.join(self.settings.categories))}",
            )
            return
        self.collector.set_category(user_id, item_id, name)
        await self._reply(update.effective_message, f"✅ 已將 #{item_id} 的分類改為「{esc(name)}」。")

    async def cmd_retry(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        user_id = update.effective_user.id
        msg = update.effective_message
        if context.args:
            item_id = _parse_id(context.args[0])
            item = self.db.get_item(item_id, user_id) if item_id is not None else None
            if item is None:
                await self._reply(msg, "找不到這則收藏。用法：/retry 編號，或只輸入 /retry 重試全部失敗的收藏。")
                return
            targets = [item]
        else:
            targets = self.db.failed_items(user_id)[:20]
            if not targets:
                await self._reply(msg, "目前沒有整理失敗的收藏 👍")
                return
            await self._reply(msg, f"開始重新整理 {len(targets)} 則收藏…")
        ok = 0
        for item in targets:
            result = await self.collector.analyze(item.id)
            ok += result.status == "done"
            if len(targets) == 1:
                header = "✅ 重新整理完成" if result.status == "done" else "⚠️ 重新整理失敗"
                await self._reply(msg, item_card(result, self.settings.tz, header=header), markup=item_keyboard(result))
                return
        await self._reply(msg, f"完成：{ok} 則成功，{len(targets) - ok} 則仍失敗。可輸入 /recent 查看。")

    async def cmd_delete(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        item_id = _parse_id(context.args[0]) if context.args else None
        item = self.db.get_item(item_id, update.effective_user.id) if item_id is not None else None
        if item is None:
            await self._reply(update.effective_message, "用法：/delete 編號（找不到這則收藏）")
            return
        markup = InlineKeyboardMarkup([[
            InlineKeyboardButton("🗑 確定刪除", callback_data=f"del:{item.id}"),
            InlineKeyboardButton("取消", callback_data="cancel"),
        ]])
        await self._reply(
            update.effective_message,
            f"確定要刪除 <b>#{item.id}</b>「{esc(item.display_title)}」嗎？原圖也會一併刪除，無法復原。",
            markup=markup,
        )

    async def cmd_briefing(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        try:
            await context.bot.send_chat_action(update.effective_chat.id, ChatAction.TYPING)
        except TelegramError:
            pass
        period = preview_period(self.briefings.clock(), self.settings)
        text, _ = await self.briefings.build(update.effective_user.id, period, preview=True)
        await self._reply(update.effective_message, text)

    async def on_text(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        msg = update.effective_message
        text = (msg.text or "").strip()
        if not text:
            return
        replied = msg.reply_to_message
        if replied is not None and replied.from_user and replied.from_user.id == context.bot.id:
            match = ITEM_REF_RE.search(replied.text or replied.caption or "")
            if match:
                item = self.collector.set_note(update.effective_user.id, int(match.group(1)), text)
                if item is not None:
                    await self._reply(msg, item_card(item, self.settings.tz, header="✏️ 已更新附言"), markup=item_keyboard(item))
                    return
        await self._search(update, text)

    # ---- 按鈕 ----
    async def on_callback(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        query = update.callback_query
        data = query.data or ""
        user_id = update.effective_user.id
        parts = data.split(":")
        action = parts[0]
        item_id = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else None
        item = self.db.get_item(item_id, user_id) if item_id is not None else None

        if action == "cancel":
            await query.answer("已取消")
            await query.edit_message_reply_markup(None)
            return
        if item is None:
            await query.answer("找不到這則收藏（可能已刪除）", show_alert=True)
            return
        if action == "get":
            await query.answer("傳送原圖中…")
            await self._send_original(query.message.chat.id, context.bot, user_id, item.id)
        elif action == "cat":
            await query.answer()
            await query.edit_message_reply_markup(category_keyboard(item.id, self.settings.categories))
        elif action == "back":
            await query.answer()
            await query.edit_message_reply_markup(item_keyboard(item))
        elif action == "setcat" and len(parts) == 3 and parts[2].isdigit():
            index = int(parts[2])
            if index >= len(self.settings.categories):
                await query.answer("分類清單已變更，請重新選擇", show_alert=True)
                return
            name = self.settings.categories[index]
            item = self.collector.set_category(user_id, item.id, name)
            await query.answer(f"已改為「{name}」")
            try:
                await query.edit_message_text(
                    item_card(item, self.settings.tz, header="✅ 已收藏"),
                    parse_mode=ParseMode.HTML,
                    reply_markup=item_keyboard(item),
                    link_preview_options=LinkPreviewOptions(is_disabled=True),
                )
            except BadRequest:
                await send_text(context.bot, query.message.chat.id, f"✅ 已將 #{item.id} 的分類改為「{esc(name)}」。")
        elif action == "del":
            self.collector.delete(user_id, item.id)
            await query.answer("已刪除")
            await query.edit_message_text(f"🗑 已刪除 #{item.id}「{esc(item.display_title)}」。", parse_mode=ParseMode.HTML)
        else:
            await query.answer()

    # ---- 定時任務 ----
    async def job_briefing(self, context: ContextTypes.DEFAULT_TYPE) -> None:
        async def send(user_id: int, text: str) -> None:
            await send_text(context.bot, user_id, text)

        try:
            sent = await self.briefings.run_due(send)
            if sent:
                log.info("已寄出 briefing：%s", sent)
        except Exception:  # noqa: BLE001
            log.exception("briefing 排程發生錯誤")

    async def job_retry(self, context: ContextTypes.DEFAULT_TYPE) -> None:
        try:
            recovered = await self.collector.retry_due()
        except Exception:  # noqa: BLE001
            log.exception("重試排程發生錯誤")
            return
        for item in recovered:
            try:
                await send_text(
                    context.bot, item.chat_id,
                    item_card(item, self.settings.tz, header="🔁 補完整理"),
                    reply_markup=item_keyboard(item), reply_to=item.message_id,
                )
            except TelegramError:
                log.exception("通知 #%s 補完整理失敗", item.id)

    async def on_error(self, update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
        log.error("處理更新時發生錯誤", exc_info=context.error)
        if isinstance(update, Update) and update.effective_message and self.is_authorized(update):
            try:
                await update.effective_message.reply_text("😵 發生錯誤，請稍後再試一次。")
            except TelegramError:
                pass

    async def post_init(self, app: Application) -> None:
        await app.bot.set_my_commands([
            BotCommand("recent", "最近的收藏"),
            BotCommand("search", "搜尋收藏"),
            BotCommand("get", "取回原圖"),
            BotCommand("category", "更正分類"),
            BotCommand("retry", "重新 AI 整理"),
            BotCommand("delete", "刪除收藏"),
            BotCommand("briefing", "預覽本週 briefing"),
            BotCommand("categories", "分類清單"),
            BotCommand("help", "使用說明"),
        ])

    def build_application(self) -> Application:
        app = (
            Application.builder()
            .token(self.settings.telegram_bot_token)
            .concurrent_updates(True)
            .post_init(self.post_init)
            .build()
        )
        app.add_handler(TypeHandler(Update, self.gate), group=-1)
        app.add_handler(CommandHandler(["start", "help"], self.cmd_help))
        app.add_handler(CommandHandler("recent", self.cmd_recent))
        app.add_handler(CommandHandler("search", self.cmd_search))
        app.add_handler(CommandHandler("get", self.cmd_get))
        app.add_handler(CommandHandler(["category", "cat"], self.cmd_category))
        app.add_handler(CommandHandler("categories", self.cmd_categories))
        app.add_handler(CommandHandler("retry", self.cmd_retry))
        app.add_handler(CommandHandler("delete", self.cmd_delete))
        app.add_handler(CommandHandler("briefing", self.cmd_briefing))
        new_messages = filters.UpdateType.MESSAGE  # 編輯過的舊訊息不重新處理
        app.add_handler(MessageHandler(new_messages & (filters.PHOTO | filters.Document.ALL), self.on_image))
        app.add_handler(MessageHandler(new_messages & filters.TEXT & ~filters.COMMAND, self.on_text))
        app.add_handler(CallbackQueryHandler(self.on_callback))
        app.add_error_handler(self.on_error)
        assert app.job_queue is not None, "請安裝 python-telegram-bot[job-queue]"
        app.job_queue.run_repeating(self.job_briefing, interval=60, first=15, name="briefing")
        app.job_queue.run_repeating(self.job_retry, interval=300, first=60, name="ai-retry")
        return app


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    # httpx 的 INFO log 會印出含 bot token 的網址，關掉
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpx2").setLevel(logging.WARNING)

    load_dotenv()
    settings = Settings.from_env()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    db = Database(settings.db_path)
    analyzer = build_analyzer(settings)
    collector = Collector(db, settings, analyzer)
    briefings = BriefingService(db, settings, analyzer)
    log.info(
        "啟動：AI=%s 模型=%s 允許使用者=%d 位 資料目錄=%s",
        settings.ai_provider, settings.ai_model, len(settings.allowed_user_ids), settings.data_dir.resolve(),
    )
    app = BotApp(settings, db, collector, briefings).build_application()
    app.run_polling(allowed_updates=Update.ALL_TYPES)
