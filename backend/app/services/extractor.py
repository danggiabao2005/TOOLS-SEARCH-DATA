"""LLM PICO structured extraction service (zero-hallucination)."""

from __future__ import annotations

import logging
from typing import Optional

import instructor
from openai import AsyncOpenAI

from app.api.schemas import PICOResult, RawPaper
from app.core.config import Settings, get_settings

logger = logging.getLogger(__name__)

EXTRACTION_SYSTEM_PROMPT = """You are a clinical research librarian extracting PICO elements from academic papers.
Rules:
- Chỉ trích xuất các thông tin được đề cập tường minh trong ngữ cảnh.
- Không suy diễn hoặc bịa đặt dữ liệu (Zero Hallucination).
- Nếu trường nào không có thông tin, đánh dấu là 'N/A'.
- outcomes phải là danh sách các kết quả được nêu rõ; nếu không có thì ["N/A"].
- confidence_score phản ánh mức độ rõ ràng của abstract (0.0–1.0).
Respond in the same language as the source abstract when possible; use English if mixed.
"""


class PICOExtractor:
    """Extract structured PICO via OpenAI-compatible APIs (OpenAI or Gemini)."""

    def __init__(self, settings: Optional[Settings] = None) -> None:
        self.settings = settings or get_settings()
        self._client: Optional[instructor.AsyncInstructor] = None

    def _get_client(self) -> instructor.AsyncInstructor:
        if self._client is None:
            api_key, base_url, _model = self.settings.resolve_llm()
            kwargs: dict[str, object] = {"api_key": api_key}
            if base_url:
                kwargs["base_url"] = base_url
            raw = AsyncOpenAI(**kwargs)  # type: ignore[arg-type]
            self._client = instructor.from_openai(raw)
            logger.info(
                "LLM client ready: provider=%s model=%s",
                self.settings.llm_provider,
                self.settings.resolve_llm()[2],
            )
        return self._client

    async def extract(self, paper: RawPaper) -> PICOResult:
        context_parts = [
            f"Title: {paper.title}",
            f"Authors: {', '.join(paper.authors) if paper.authors else 'N/A'}",
            f"Year: {paper.year or 'N/A'}",
            f"Source: {paper.source}",
        ]
        if paper.abstract:
            context_parts.append(f"Abstract:\n{paper.abstract}")
        if paper.full_text_snippet:
            context_parts.append(f"Additional context:\n{paper.full_text_snippet}")

        context = "\n\n".join(context_parts)

        api_key, _base_url, model = self.settings.resolve_llm()
        if not api_key:
            return self._fallback_result(paper)

        client = self._get_client()
        try:
            result = await client.chat.completions.create(
                model=model,
                response_model=PICOResult,
                messages=[
                    {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": (
                            "Extract PICO from the following paper context:\n\n"
                            f"{context}"
                        ),
                    },
                ],
                temperature=0.0,
                max_retries=2,
            )
            return result
        except Exception as exc:  # noqa: BLE001
            logger.exception("PICO extraction failed for '%s': %s", paper.title[:60], exc)
            reason = _friendly_llm_error(exc, self.settings.llm_provider)
            return PICOResult(
                population=f"N/A ({reason})",
                intervention=f"N/A ({reason})",
                comparison="N/A",
                outcomes=["N/A"],
                study_type="N/A",
                confidence_score=0.0,
            )

    @staticmethod
    def _fallback_result(paper: RawPaper) -> PICOResult:
        """Deterministic stub when no API key is configured (dev mode)."""
        has_abstract = bool(paper.abstract and len(paper.abstract) >= 50)
        return PICOResult(
            population="N/A (LLM API key not configured)",
            intervention="N/A (LLM API key not configured)",
            comparison="N/A",
            outcomes=["N/A"],
            study_type="N/A",
            confidence_score=0.1 if has_abstract else 0.0,
        )


def _friendly_llm_error(exc: BaseException, provider: str = "") -> str:
    text = str(exc).lower()
    if "no longer available" in text or ("404" in text and "model" in text):
        return "Model Gemini không khả dụng — đổi GEMINI_MODEL trong .env (vd. gemini-2.0-flash)"
    if "insufficient_quota" in text or "exceeded your current quota" in text:
        if provider == "gemini":
            return "Gemini free hết hạn mức (phút/ngày) — đợi rồi quét lại, hoặc giảm limit"
        return "Hết quota LLM — kiểm tra billing OpenAI hoặc dùng Gemini free"
    if "resource_exhausted" in text:
        return "Gemini free hết hạn mức tạm thời — đợi 1–2 phút rồi thử lại"
    if "invalid_api_key" in text or "incorrect api key" in text or "api key not valid" in text:
        return "API key không hợp lệ"
    if "rate_limit" in text or "429" in text:
        return "Rate limit — giảm limit/nguồn hoặc đợi vài phút"
    return "LLM extract lỗi — xem log backend"
