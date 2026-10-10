"""AI 供應商介面。要換供應商，只要實作 Analyzer 這兩個方法即可。"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol, Sequence

from ..config import FALLBACK_CATEGORY


class AIError(RuntimeError):
    """AI 呼叫失敗（網路、額度、拒答、格式錯誤等）。圖片已保存，稍後可重試。"""


class AINotConfigured(AIError):
    pass


@dataclass(frozen=True)
class ImagePart:
    data: bytes
    media_type: str


@dataclass(frozen=True)
class AnalysisRequest:
    images: Sequence[ImagePart]
    caption: str | None
    source_url: str | None
    categories: Sequence[str]


@dataclass
class Analysis:
    title: str
    summary: str
    category: str
    tags: list[str] = field(default_factory=list)
    todos: list[str] = field(default_factory=list)
    uncertain: list[str] = field(default_factory=list)
    key_text: str = ""
    source_platform: str = ""
    model: str = ""


@dataclass(frozen=True)
class BriefingItem:
    id: int
    received_at: datetime
    title: str
    summary: str
    category: str
    tags: Sequence[str]
    todos: Sequence[str]
    caption: str | None
    source_url: str | None
    analyzed: bool


@dataclass(frozen=True)
class BriefingRequest:
    period_label: str
    items: Sequence[BriefingItem]
    categories: Sequence[str]


@dataclass
class Theme:
    name: str
    summary: str
    item_ids: list[int]


@dataclass
class Highlight:
    item_id: int
    reason: str


@dataclass
class Action:
    text: str
    item_ids: list[int]


@dataclass
class BriefingDraft:
    overview: str
    themes: list[Theme]
    highlights: list[Highlight]
    actions: list[Action]


class Analyzer(Protocol):
    name: str

    async def analyze_image(self, request: AnalysisRequest) -> Analysis: ...

    async def compose_briefing(self, request: BriefingRequest) -> BriefingDraft: ...


# ---- 共用的輸出清理：不論哪家 AI，都不能讓格式錯誤或亂填的值進資料庫 ----

def _clean_str(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:limit]


def _clean_list(value: Any, limit_items: int, limit_len: int) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for v in value:
        s = _clean_str(v, limit_len)
        if s and s not in out:
            out.append(s)
        if len(out) >= limit_items:
            break
    return out


def normalize_analysis(raw: dict[str, Any], categories: Sequence[str], model: str = "") -> Analysis:
    category = _clean_str(raw.get("category"), 20)
    if category not in categories:
        category = FALLBACK_CATEGORY
    raw_tags = raw.get("tags")
    if isinstance(raw_tags, list):
        raw_tags = [t.lstrip("#＃") if isinstance(t, str) else t for t in raw_tags]
    tags = _clean_list(raw_tags, 8, 20)
    title = _clean_str(raw.get("title"), 40) or "（未命名）"
    return Analysis(
        title=title,
        summary=_clean_str(raw.get("summary"), 200),
        category=category,
        tags=tags,
        todos=_clean_list(raw.get("todos"), 5, 100),
        uncertain=_clean_list(raw.get("uncertain"), 5, 100),
        key_text=_clean_str(raw.get("key_text"), 1000),
        source_platform=_clean_str(raw.get("source_platform"), 30),
        model=model,
    )


def normalize_briefing(raw: dict[str, Any], valid_ids: set[int]) -> BriefingDraft:
    """只保留本週真的存在的收藏編號，避免 AI 編出不存在的編號。"""

    def ids(value: Any) -> list[int]:
        out: list[int] = []
        if isinstance(value, list):
            for v in value:
                if isinstance(v, int) and not isinstance(v, bool) and v in valid_ids and v not in out:
                    out.append(v)
        return out

    themes = []
    for t in raw.get("themes") or []:
        if isinstance(t, dict) and _clean_str(t.get("name"), 30):
            themes.append(Theme(
                name=_clean_str(t.get("name"), 30),
                summary=_clean_str(t.get("summary"), 300),
                item_ids=ids(t.get("item_ids")),
            ))
    highlights: list[Highlight] = []
    seen: set[int] = set()
    for h in raw.get("highlights") or []:
        if not isinstance(h, dict):
            continue
        item_id = h.get("item_id")
        if isinstance(item_id, int) and item_id in valid_ids and item_id not in seen:
            seen.add(item_id)
            highlights.append(Highlight(item_id=item_id, reason=_clean_str(h.get("reason"), 150)))
    actions = []
    for a in raw.get("actions") or []:
        if isinstance(a, dict) and _clean_str(a.get("text"), 150):
            actions.append(Action(text=_clean_str(a.get("text"), 150), item_ids=ids(a.get("item_ids"))))
    return BriefingDraft(
        overview=_clean_str(raw.get("overview"), 600),
        themes=themes[:5],
        highlights=highlights[:10],
        actions=actions[:8],
    )
