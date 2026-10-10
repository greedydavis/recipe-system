"""存檔與重複圖片。"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone

import pytest

from conftest import OTHER_USER, USER, make_png, reencode_jpeg
from screenshot_bot.collector import extract_url
from screenshot_bot.images import ImageTooLarge, InvalidImage

RECEIVED = datetime(2026, 10, 7, 3, 30, tzinfo=timezone.utc)


def save(collector, data, message_id, user=USER, **kw):
    return collector.save(
        user_id=user, chat_id=user, message_id=message_id, data=data, received_at=RECEIVED, **kw
    )


def test_saves_original_bytes_and_metadata(collector, settings, db):
    data = make_png(1)
    result = save(
        collector, data, 10, caption="想試試這個 https://example.com/post/1 ",
        file_unique_id="uniq-1",
    )
    item = result.item
    assert not result.duplicate
    stored = settings.data_dir / item.file_path
    # 原圖原封不動存在持久化目錄（不是 Telegram 暫存）
    assert stored.read_bytes() == data
    assert stored.is_relative_to(settings.data_dir / "images")
    assert item.sha256 == hashlib.sha256(data).hexdigest()
    assert item.user_id == USER and item.message_id == 10 and item.chat_id == USER
    assert item.received_at == RECEIVED
    assert item.caption == "想試試這個 https://example.com/post/1"
    assert item.source_url == "https://example.com/post/1"
    assert item.tg_file_unique_id == "uniq-1"
    assert item.status == "pending"
    assert (item.width, item.height) == (400, 800)
    assert db.is_message_processed(USER, 10)


def test_same_bytes_twice_is_duplicate_and_not_stored_again(collector, settings, db):
    data = make_png(2)
    first = save(collector, data, 1).item
    second = save(collector, data, 2)
    assert second.duplicate
    assert second.item.id == first.id
    assert len(db.recent_items(USER, 50)) == 1
    files = [p for p in (settings.data_dir / "images").rglob("*") if p.is_file()]
    assert len(files) == 1
    # 重複的那則訊息也記錄為已處理，Telegram 重送時不會再回覆一次
    assert collector.already_handled(USER, 2)


def test_duplicate_detected_by_telegram_unique_id_before_download(collector):
    save(collector, make_png(3), 1, file_unique_id="same-file")
    found = collector.find_by_unique_id(USER, "same-file")
    assert found is not None
    assert collector.find_by_unique_id(USER, "other") is None
    assert collector.find_by_unique_id(OTHER_USER, "same-file") is None


def test_redelivered_message_is_recognised(collector):
    assert not collector.already_handled(USER, 77)
    save(collector, make_png(4), 77)
    assert collector.already_handled(USER, 77)


def test_collections_are_per_user(collector, db):
    data = make_png(5)
    a = save(collector, data, 1, user=USER)
    b = save(collector, data, 1, user=OTHER_USER)
    assert not b.duplicate
    assert a.item.file_path != b.item.file_path
    assert db.get_item(a.item.id, OTHER_USER) is None  # 其他人讀不到我的收藏


def test_reencoded_copy_is_saved_but_flagged_similar(collector):
    original = make_png(6)
    first = save(collector, original, 1).item
    copy = save(collector, reencode_jpeg(original), 2)
    assert not copy.duplicate
    assert copy.similar_to is not None and copy.similar_to.id == first.id
    different = save(collector, make_png(999), 3)
    assert different.similar_to is None


def test_invalid_and_oversized_images_are_rejected_without_saving(collector, settings, db):
    with pytest.raises(InvalidImage):
        save(collector, b"not an image at all", 1)
    big = b"\x89PNG" + b"0" * (settings.max_image_bytes + 1)
    with pytest.raises(ImageTooLarge):
        save(collector, big, 2)
    assert db.recent_items(USER) == []
    assert not collector.already_handled(USER, 1)


def test_delete_removes_file_and_allows_saving_again(collector, settings):
    data = make_png(7)
    item = save(collector, data, 1).item
    path = settings.data_dir / item.file_path
    assert collector.delete(OTHER_USER, item.id) is None  # 不能刪別人的
    assert collector.delete(USER, item.id) is not None
    assert not path.exists()
    again = save(collector, data, 2)
    assert not again.duplicate


def test_search_and_recent(collector, db):
    a = save(collector, make_png(8), 1, caption="颱風 停班停課").item
    b = save(collector, make_png(9), 2, caption="ETF 配息").item
    assert [i.id for i in db.search_items(USER, ["ETF"])] == [b.id]
    assert [i.id for i in db.search_items(USER, ["颱風", "停課"])] == [a.id]
    assert db.search_items(USER, ["100%"]) == []
    assert {i.id for i in db.recent_items(USER)} == {a.id, b.id}


def test_reply_note_adds_link(collector):
    item = save(collector, make_png(10), 1).item
    updated = collector.set_note(USER, item.id, "原文在這 https://facebook.com/x/posts/1。")
    assert updated.source_url == "https://facebook.com/x/posts/1"
    assert "原文在這" in updated.caption


@pytest.mark.parametrize(
    "text,expected",
    [
        (None, None),
        ("沒有連結", None),
        ("看這篇（https://a.com/b）", "https://a.com/b"),
        ("https://a.com/b, 很好", "https://a.com/b"),
    ],
)
def test_extract_url(text, expected):
    assert extract_url(text) == expected
