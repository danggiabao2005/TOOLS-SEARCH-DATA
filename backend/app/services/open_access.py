"""Unpaywall / Europe PMC fallback for short or missing abstracts."""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Optional

import httpx

from app.api.schemas import RawPaper
from app.core.config import Settings, get_settings

logger = logging.getLogger(__name__)

UNPAYWALL_API = "https://api.unpaywall.org/v2"
EUROPE_PMC_API = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
MIN_ABSTRACT_LEN = 100
OA_TIMEOUT = 10.0
OA_CONCURRENCY = 8

ProgressCallback = Callable[[int, int], Awaitable[None]]


class OpenAccessEnricher:
    """Enrich papers with short/missing abstracts via Unpaywall + Europe PMC."""

    def __init__(self, settings: Optional[Settings] = None) -> None:
        self.settings = settings or get_settings()

    async def enrich(
        self,
        papers: list[RawPaper],
        on_progress: Optional[ProgressCallback] = None,
    ) -> list[RawPaper]:
        timeout = httpx.Timeout(OA_TIMEOUT)
        sem = asyncio.Semaphore(OA_CONCURRENCY)
        done = 0
        lock = asyncio.Lock()
        total = len(papers)

        async def process(paper: RawPaper) -> RawPaper:
            nonlocal done
            if paper.doi and self._needs_work(paper):
                async with sem:
                    try:
                        paper = await self._enrich_one(client, paper)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "Open-access enrichment failed for '%s': %s",
                            paper.title[:60],
                            exc,
                        )
            async with lock:
                done += 1
                current = done
            if on_progress:
                await on_progress(current, total)
            return paper

        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            return list(await asyncio.gather(*[process(p) for p in papers]))

    @staticmethod
    def _needs_enrichment(paper: RawPaper) -> bool:
        abstract = paper.abstract or ""
        return len(abstract.strip()) < MIN_ABSTRACT_LEN

    def _needs_work(self, paper: RawPaper) -> bool:
        return self._needs_enrichment(paper) or not paper.url

    async def _enrich_one(
        self, client: httpx.AsyncClient, paper: RawPaper
    ) -> RawPaper:
        need_abstract = self._needs_enrichment(paper)
        need_url = not paper.url
        if not paper.doi or (not need_abstract and not need_url):
            return paper

        tasks: list[asyncio.Task[Optional[dict[str, str]]]] = []
        labels: list[str] = []
        if need_url:
            tasks.append(asyncio.create_task(self._fetch_unpaywall(client, paper.doi)))
            labels.append("unpaywall")
        if need_abstract:
            tasks.append(asyncio.create_task(self._fetch_europe_pmc(client, paper.doi)))
            labels.append("epmc")

        results = await asyncio.gather(*tasks, return_exceptions=True)
        updates: dict[str, object] = {}
        for label, result in zip(labels, results):
            if isinstance(result, BaseException) or not result:
                continue
            if label == "unpaywall":
                if result.get("url") and not paper.url:
                    updates["url"] = result["url"]
                if result.get("snippet"):
                    updates["full_text_snippet"] = result["snippet"]
            elif label == "epmc":
                if result.get("abstract") and (
                    not paper.abstract
                    or len(result["abstract"]) > len(paper.abstract or "")
                ):
                    updates["abstract"] = result["abstract"]
                if result.get("pmid") and not paper.pmid:
                    updates["pmid"] = result["pmid"]

        if updates:
            return paper.model_copy(update=updates)
        return paper

    async def _fetch_unpaywall(
        self, client: httpx.AsyncClient, doi: str
    ) -> Optional[dict[str, str]]:
        url = f"{UNPAYWALL_API}/{doi}"
        try:
            resp = await client.get(
                url, params={"email": self.settings.unpaywall_email}
            )
            if resp.status_code != 200:
                return None
            data = resp.json()
        except httpx.HTTPError as exc:
            logger.debug("Unpaywall error: %s", exc)
            return None

        best = data.get("best_oa_location") or {}
        result: dict[str, str] = {}
        oa_url = best.get("url_for_pdf") or best.get("url") or data.get("doi_url")
        if oa_url:
            result["url"] = oa_url
        title = data.get("title")
        if title:
            result["snippet"] = f"Open-access record: {title}"
        return result or None

    async def _fetch_europe_pmc(
        self, client: httpx.AsyncClient, doi: str
    ) -> Optional[dict[str, str]]:
        try:
            resp = await client.get(
                EUROPE_PMC_API,
                params={
                    "query": f'DOI:"{doi}"',
                    "format": "json",
                    "resultType": "core",
                    "pageSize": 1,
                },
            )
            if resp.status_code != 200:
                return None
            results = resp.json().get("resultList", {}).get("result", [])
            if not results:
                return None
            item = results[0]
        except httpx.HTTPError as exc:
            logger.debug("Europe PMC error: %s", exc)
            return None

        abstract = item.get("abstractText")
        if abstract:
            abstract = re.sub(r"\s+", " ", abstract).strip()
        result: dict[str, str] = {}
        if abstract:
            result["abstract"] = abstract
        if item.get("pmid"):
            result["pmid"] = str(item["pmid"])
        return result or None
