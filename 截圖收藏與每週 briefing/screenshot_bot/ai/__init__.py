from .base import AIError, AINotConfigured, Analysis, Analyzer, BriefingDraft  # noqa: F401


def build_analyzer(settings):
    """依設定建立 AI 供應商。新增供應商時在這裡加一個分支。"""
    from .anthropic_provider import AnthropicAnalyzer, DisabledAnalyzer

    if settings.ai_provider == "anthropic":
        return AnthropicAnalyzer(settings.ai_model, use_fallbacks=settings.ai_fallbacks)
    return DisabledAnalyzer()
