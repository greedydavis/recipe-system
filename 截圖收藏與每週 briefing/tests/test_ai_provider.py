"""Claude 供應商：送出的請求形狀、拒答與錯誤處理（不連網）。"""

from __future__ import annotations

import io
import json
from types import SimpleNamespace

import pytest
from PIL import Image

from conftest import make_png
from screenshot_bot.ai.anthropic_provider import AnthropicAnalyzer
from screenshot_bot.ai.base import AIError, AnalysisRequest, BriefingItem, BriefingRequest, ImagePart
from screenshot_bot.config import DEFAULT_CATEGORIES
from screenshot_bot.images import prepare_for_vision


class FakeMessages:
    def __init__(self, payload=None, stop_reason="end_turn", error=None):
        self.payload = payload
        self.stop_reason = stop_reason
        self.error = error
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        text = json.dumps(self.payload, ensure_ascii=False) if self.payload is not None else ""
        return SimpleNamespace(
            stop_reason=self.stop_reason,
            content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=text)],
        )


def analyzer_with(messages: FakeMessages) -> AnthropicAnalyzer:
    client = SimpleNamespace(beta=SimpleNamespace(messages=messages))
    return AnthropicAnalyzer("claude-opus-5-5", client=client)


def request(**kw):
    return AnalysisRequest(
        images=[ImagePart(b"img", "image/jpeg")], caption=kw.get("caption"),
        source_url=None, categories=DEFAULT_CATEGORIES,
    )


async def test_analysis_request_shape_and_parsing():
    messages = FakeMessages({
        "title": "台積電法說會重點", "summary": "可能提到資本支出", "category": "理財",
        "tags": ["半導體"], "todos": [], "uncertain": ["數字模糊"], "key_text": "原文",
        "source_platform": "Facebook",
    })
    result = await analyzer_with(messages).analyze_image(request(caption="之後研究"))
    call = messages.calls[0]
    assert call["model"] == "claude-opus-5-5"
    assert call["fallbacks"] == "default" and call["betas"]
    content = call["messages"][0]["content"]
    assert content[0]["type"] == "image" and content[0]["source"]["type"] == "base64"
    assert "之後研究" in content[-1]["text"]
    schema = call["output_config"]["format"]["schema"]
    assert schema["properties"]["category"]["enum"] == list(DEFAULT_CATEGORIES)
    assert "不要產生或猜測任何網址" in call["system"]
    assert result.category == "理財" and result.uncertain == ["數字模糊"]


async def test_refusal_and_bad_json_become_ai_errors():
    with pytest.raises(AIError, match="拒絕"):
        await analyzer_with(FakeMessages({}, stop_reason="refusal")).analyze_image(request())
    with pytest.raises(AIError, match="沒有回傳"):
        await analyzer_with(FakeMessages(None)).analyze_image(request())


async def test_connection_error_becomes_ai_error():
    import anthropic
    import httpx2

    err = anthropic.APIConnectionError(request=httpx2.Request("POST", "https://api.anthropic.com"))
    with pytest.raises(AIError, match="連不上"):
        await analyzer_with(FakeMessages(error=err)).analyze_image(request())


async def test_briefing_request_only_keeps_real_ids():
    from datetime import datetime, timezone

    messages = FakeMessages({
        "overview": "這週關注 AI", "themes": [{"name": "AI", "summary": "s", "item_ids": [5, 77]}],
        "highlights": [{"item_id": 5, "reason": "r"}, {"item_id": 77, "reason": "編的"}],
        "actions": [],
    })
    item = BriefingItem(5, datetime(2026, 10, 7, tzinfo=timezone.utc), "t", "s", "科技", [], [], None, None, True)
    draft = await analyzer_with(messages).compose_briefing(
        BriefingRequest("10/04–10/11", [item], DEFAULT_CATEGORIES)
    )
    assert [h.item_id for h in draft.highlights] == [5]
    assert draft.themes[0].item_ids == [5]


def test_tall_screenshot_is_split_into_readable_segments():
    tall = make_png(1, size=(1080, 7000))
    parts = prepare_for_vision(tall)
    assert 2 <= len(parts) <= 5
    for data, media in parts:
        assert media == "image/jpeg"
        with Image.open(io.BytesIO(data)) as img:
            assert max(img.size) <= 1568
            assert img.width >= 400  # 寬度沒有被縮到看不清楚


def test_normal_screenshot_is_single_part_and_transparent_png_ok():
    img = Image.new("RGBA", (300, 600), (0, 0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    assert len(prepare_for_vision(buf.getvalue())) == 1
