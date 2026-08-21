"""Title/abstract SLR screening via structured LLM output."""

from __future__ import annotations

import logging
from typing import Optional

import instructor
from openai import AsyncOpenAI

from app.api.schemas import (
    ScreenCriterion,
    ScreenPaperIn,
    ScreeningDecision,
    ScreeningVerdict,
)
from app.core.config import Settings, get_settings

logger = logging.getLogger(__name__)

SCREEN_SYSTEM = """You are a systematic-review screener for ROUND 1 (title + abstract only).
Decide include / exclude / maybe using ONLY the provided protocol codes.

Rules:
- Use ONLY codes from the protocol list. Never invent codes.
- reasons must be the code strings only (e.g. IC-P, EC-W), no explanations.
- Do NOT use EC-D (duplicates were already resolved).
- Exclude if any exclusion (EC) criterion is clearly met from title/abstract/year.
- Include only if the paper appears to meet the relevant inclusion (IC) criteria
  that CAN be judged from title/abstract (language, year, topic, intervention, comparison).
  Criteria that need full text (page count, numbers in figures, downloadable PDF)
  should NOT cause exclude unless the title/abstract clearly proves failure.
- Maybe if evidence is insufficient or conflicting.
- Be conservative: when unsure, prefer maybe over include.
- confidence_score 0.0–1.0 for how clear the title/abstract is.
"""


class TitleAbstractScreener:
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
        return self._client

    async def screen(
        self,
        paper: ScreenPaperIn,
        criteria: list[ScreenCriterion],
    ) -> ScreeningDecision:
        allowed = {c.code for c in criteria}
        api_key, _base, model = self.settings.resolve_llm()
        if not api_key:
            return ScreeningDecision(
                paper_id=paper.id,
                verdict=ScreeningVerdict.MAYBE,
                reasons=[],
                confidence_score=0.0,
                by_ai=True,
            )

        protocol_lines = []
        for c in criteria:
            if c.code == "EC-D":
                continue
            protocol_lines.append(f"- {c.code} [{c.kind}]: {c.meaning}")
        protocol = "\n".join(protocol_lines)

        authors = ", ".join(paper.authors) if paper.authors else "N/A"
        user = (
            f"PROTOCOL:\n{protocol}\n\n"
            f"PAPER:\n"
            f"Title: {paper.title}\n"
            f"Year: {paper.year or 'N/A'}\n"
            f"Authors: {authors}\n"
            f"Abstract:\n{paper.abstract or '(none — decide from title only)'}\n\n"
            "Return verdict + reason codes only from the protocol."
        )

        try:
            client = self._get_client()
            result = await client.chat.completions.create(
                model=model,
                response_model=ScreeningDecision,
                messages=[
                    {"role": "system", "content": SCREEN_SYSTEM},
                    {"role": "user", "content": user},
                ],
                temperature=0.0,
                max_retries=2,
            )
            reasons = [r.strip() for r in result.reasons if r.strip() in allowed and r.strip() != "EC-D"]
            verdict = result.verdict
            if verdict == ScreeningVerdict.EXCLUDE and not any(r.startswith("EC") for r in reasons):
                verdict = ScreeningVerdict.MAYBE
            if verdict == ScreeningVerdict.INCLUDE and not any(r.startswith("IC") for r in reasons):
                verdict = ScreeningVerdict.MAYBE
            return ScreeningDecision(
                paper_id=paper.id,
                verdict=verdict,
                reasons=reasons,
                confidence_score=result.confidence_score,
                by_ai=True,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Screening failed for %s: %s", paper.id, exc)
            return ScreeningDecision(
                paper_id=paper.id,
                verdict=ScreeningVerdict.MAYBE,
                reasons=[],
                confidence_score=0.0,
                by_ai=True,
            )
