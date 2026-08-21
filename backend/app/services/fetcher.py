"""Async multi-source academic paper fetcher with rate-limit retry."""

from __future__ import annotations

import asyncio
import logging
import re
import xml.etree.ElementTree as ET
from typing import Any, Optional
from urllib.parse import quote_plus

import httpx

from app.api.schemas import PicoSearchRequest, RawPaper, SourceName
from app.core.config import Settings, get_settings

logger = logging.getLogger(__name__)

PUBMED_EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
CROSSREF_API = "https://api.crossref.org/works"
S2_API = "https://api.semanticscholar.org/graph/v1/paper/search"
S2_BULK_API = "https://api.semanticscholar.org/graph/v1/paper/search/bulk"
ARXIV_API = "http://export.arxiv.org/api/query"
SERPAPI_URL = "https://serpapi.com/search.json"
OPENALEX_API = "https://api.openalex.org/works"
IEEE_XPLORE_API = "https://ieeexploreapi.ieee.org/api/v1/search/articles"

# OpenAlex publisher lineage IDs (parent org covers child societies)
OPENALEX_IEEE_PUBLISHER = "P4310319808"  # IEEE
OPENALEX_ACM_PUBLISHER = "P4310319798"  # Association for Computing Machinery

_SCHOLAR_SOURCES = {SourceName.SERPAPI, SourceName.GOOGLE_SCHOLAR}
PUBMED_ID_BATCH = 200
SCHOLAR_HARD_CAP = 100


class MultiSourceFetcher:
    """Fetch papers concurrently from academic databases (IEEE, ACM, OpenAlex, …)."""

    def __init__(self, settings: Optional[Settings] = None) -> None:
        self.settings = settings or get_settings()

    async def fetch_all(self, request: PicoSearchRequest) -> list[RawPaper]:
        timeout = httpx.Timeout(self.settings.http_timeout)
        mailto = self.settings.crossref_mailto
        headers = {"User-Agent": f"pico-extractor/1.0 (mailto:{mailto})"}
        async with httpx.AsyncClient(
            timeout=timeout, follow_redirects=True, headers=headers
        ) as client:
            papers: list[RawPaper] = []
            # Sequential when fetching large result sets to avoid 429 storms
            run_serial = request.fetch_all or len(request.sources) <= 2
            pending: list[SourceName] = []
            for source in request.sources:
                if source in _SCHOLAR_SOURCES and not self.settings.serpapi_key:
                    logger.warning(
                        "Google Scholar skipped: SERPAPI_KEY is not set"
                    )
                    continue
                pending.append(source)

            if run_serial:
                for source in pending:
                    batch = await self._safe_fetch(client, source, request)
                    papers.extend(batch)
                    await asyncio.sleep(0.4)
            else:
                tasks = [
                    asyncio.create_task(
                        self._safe_fetch(client, source, request),
                        name=source.value,
                    )
                    for source in pending
                ]
                results = await asyncio.gather(*tasks, return_exceptions=True)
                for result in results:
                    if isinstance(result, BaseException):
                        logger.warning("Source fetch failed: %s", result)
                        continue
                    papers.extend(result)

            return papers

    async def _safe_fetch(
        self,
        client: httpx.AsyncClient,
        source: SourceName,
        request: PicoSearchRequest,
    ) -> list[RawPaper]:
        try:
            handlers = {
                SourceName.PUBMED: self._fetch_pubmed,
                SourceName.CROSSREF: self._fetch_crossref,
                SourceName.SEMANTIC_SCHOLAR: self._fetch_semantic_scholar,
                SourceName.ARXIV: self._fetch_arxiv,
                SourceName.IEEE_XPLORE: self._fetch_ieee_xplore,
                SourceName.ACM_DL: self._fetch_acm_dl,
                SourceName.OPENALEX: self._fetch_openalex,
                SourceName.GOOGLE_SCHOLAR: self._fetch_serpapi,
                SourceName.SERPAPI: self._fetch_serpapi,
            }
            handler = handlers.get(source)
            if handler is None:
                return []
            return await handler(client, request)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Fetcher error for %s: %s", source.value, exc)
            return []

    async def _request_with_retry(
        self,
        client: httpx.AsyncClient,
        method: str,
        url: str,
        **kwargs: Any,
    ) -> httpx.Response:
        last_exc: Exception | None = None
        for attempt in range(self.settings.max_retries):
            try:
                response = await client.request(method, url, **kwargs)
                if response.status_code in (429, 500, 502, 503, 504):
                    wait = (
                        15 * (attempt + 1)
                        if response.status_code == 429
                        else min(20, 4 * (attempt + 1))
                    )
                    logger.warning(
                        "HTTP %s for %s — retry in %ss (attempt %s)",
                        response.status_code,
                        url,
                        wait,
                        attempt + 1,
                    )
                    await asyncio.sleep(wait)
                    continue
                response.raise_for_status()
                return response
            except httpx.HTTPStatusError as exc:
                last_exc = exc
                status = exc.response.status_code if exc.response is not None else 0
                if 400 <= status < 500 and status != 429:
                    raise
                wait = 2**attempt
                logger.warning(
                    "Request error %s — retry in %ss (attempt %s)",
                    exc,
                    wait,
                    attempt + 1,
                )
                await asyncio.sleep(wait)
            except httpx.HTTPError as exc:
                last_exc = exc
                wait = 2**attempt
                logger.warning(
                    "Request error %s — retry in %ss (attempt %s)",
                    exc,
                    wait,
                    attempt + 1,
                )
                await asyncio.sleep(wait)
        raise RuntimeError(f"Failed after retries: {url}") from last_exc

    def _source_cap(self, request: PicoSearchRequest) -> int:
        if request.fetch_all:
            return max(1, self.settings.fetch_all_cap_per_source)
        return max(1, request.limit)

    # ── PubMed ──────────────────────────────────────────────────────────────

    async def _fetch_pubmed(
        self, client: httpx.AsyncClient, request: PicoSearchRequest
    ) -> list[RawPaper]:
        term = request.keywords
        if request.year_min or request.year_max:
            y_min = request.year_min or 1900
            y_max = request.year_max or 2100
            term = f"({term}) AND ({y_min}:{y_max}[dp])"

        cap = min(self._source_cap(request), 10000)
        id_list: list[str] = []
        retstart = 0
        page = min(10000, cap)
        while len(id_list) < cap:
            search_resp = await self._request_with_retry(
                client,
                "GET",
                f"{PUBMED_EUTILS}/esearch.fcgi",
                params={
                    "db": "pubmed",
                    "term": term,
                    "retmax": min(page, cap - len(id_list)),
                    "retstart": retstart,
                    "retmode": "json",
                    "sort": "relevance",
                },
            )
            payload = search_resp.json().get("esearchresult", {})
            batch = payload.get("idlist") or []
            if not batch:
                break
            id_list.extend(str(pmid) for pmid in batch)
            retstart += len(batch)
            try:
                total = int(payload.get("count") or 0)
            except (TypeError, ValueError):
                total = retstart
            if retstart >= total or len(batch) < 1:
                break

        if not id_list:
            return []

        papers: list[RawPaper] = []
        for i in range(0, min(len(id_list), cap), PUBMED_ID_BATCH):
            chunk = id_list[i : i + PUBMED_ID_BATCH]
            papers.extend(await self._pubmed_hydrate(client, chunk))
            if request.fetch_all:
                await asyncio.sleep(0.15)
        return papers[:cap]

    async def _pubmed_hydrate(
        self, client: httpx.AsyncClient, id_list: list[str]
    ) -> list[RawPaper]:
        summary_resp = await self._request_with_retry(
            client,
            "GET",
            f"{PUBMED_EUTILS}/esummary.fcgi",
            params={
                "db": "pubmed",
                "id": ",".join(id_list),
                "retmode": "json",
            },
        )
        result = summary_resp.json().get("result", {})

        fetch_resp = await self._request_with_retry(
            client,
            "GET",
            f"{PUBMED_EUTILS}/efetch.fcgi",
            params={
                "db": "pubmed",
                "id": ",".join(id_list),
                "retmode": "xml",
            },
        )
        abstracts = self._parse_pubmed_abstracts(fetch_resp.text)

        papers: list[RawPaper] = []
        for pmid in id_list:
            item = result.get(pmid)
            if not item or not isinstance(item, dict):
                continue
            authors = [
                f"{a.get('name', '')}".strip()
                for a in item.get("authors", [])
                if a.get("name")
            ]
            doi = None
            for aid in item.get("articleids", []):
                if aid.get("idtype") == "doi":
                    doi = aid.get("value")
                    break
            year = self._parse_year(item.get("pubdate") or item.get("epubdate"))
            papers.append(
                RawPaper(
                    doi=doi,
                    title=item.get("title", "Untitled").strip(),
                    authors=authors,
                    year=year,
                    abstract=abstracts.get(pmid),
                    source=SourceName.PUBMED.value,
                    url=f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
                    venue=item.get("fulljournalname") or item.get("source"),
                    pmid=pmid,
                )
            )
        return papers

    @staticmethod
    def _parse_pubmed_abstracts(xml_text: str) -> dict[str, str]:
        abstracts: dict[str, str] = {}
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError:
            return abstracts
        for article in root.findall(".//PubmedArticle"):
            pmid_el = article.find(".//MedlineCitation/PMID")
            if pmid_el is None or not pmid_el.text:
                continue
            parts: list[str] = []
            for abs_text in article.findall(".//Abstract/AbstractText"):
                label = abs_text.attrib.get("Label")
                text = "".join(abs_text.itertext()).strip()
                if not text:
                    continue
                parts.append(f"{label}: {text}" if label else text)
            if parts:
                abstracts[pmid_el.text] = "\n".join(parts)
        return abstracts

    # ── Crossref ────────────────────────────────────────────────────────────

    async def _fetch_crossref(
        self,
        client: httpx.AsyncClient,
        request: PicoSearchRequest,
        extra_filters: Optional[list[str]] = None,
        source_name: Optional[str] = None,
    ) -> list[RawPaper]:
        filters: list[str] = list(extra_filters or [])
        if request.year_min:
            filters.append(f"from-pub-date:{request.year_min}")
        if request.year_max:
            filters.append(f"until-pub-date:{request.year_max}")

        cap = self._source_cap(request)
        source_label = source_name or SourceName.CROSSREF.value
        papers: list[RawPaper] = []
        cursor: Optional[str] = "*"
        while len(papers) < cap and cursor:
            params: dict[str, Any] = {
                "query": request.keywords,
                "rows": min(100, cap - len(papers)),
                "mailto": self.settings.crossref_mailto,
                "select": "DOI,title,author,published-print,published-online,abstract,URL,container-title",
                "cursor": cursor,
            }
            if filters:
                params["filter"] = ",".join(filters)
            resp = await self._request_with_retry(
                client, "GET", CROSSREF_API, params=params
            )
            message = resp.json().get("message", {}) or {}
            items = message.get("items") or []
            if not items:
                break
            papers.extend(self._crossref_items_to_papers(items, source_label))
            cursor = message.get("next-cursor")
        return papers[:cap]

    def _crossref_items_to_papers(
        self, items: list[dict[str, Any]], source_label: str
    ) -> list[RawPaper]:
        papers: list[RawPaper] = []
        for item in items:
            titles = item.get("title") or []
            title = titles[0] if titles else "Untitled"
            authors = []
            for a in item.get("author", []) or []:
                name = " ".join(
                    filter(None, [a.get("given"), a.get("family")])
                ).strip()
                if name:
                    authors.append(name)
            year = self._crossref_year(item)
            abstract = item.get("abstract")
            if abstract:
                abstract = re.sub(r"<[^>]+>", "", abstract).strip()
            venues = item.get("container-title") or []
            doi = item.get("DOI")
            papers.append(
                RawPaper(
                    doi=doi,
                    title=title.strip(),
                    authors=authors,
                    year=year,
                    abstract=abstract,
                    source=source_label,
                    url=self._canonical_url(doi, item.get("URL"), source_label),
                    venue=venues[0] if venues else None,
                )
            )
        return papers

    @staticmethod
    def _crossref_year(item: dict[str, Any]) -> Optional[int]:
        for key in ("published-print", "published-online", "created"):
            parts = (item.get(key) or {}).get("date-parts") or []
            if parts and parts[0]:
                try:
                    return int(parts[0][0])
                except (TypeError, ValueError, IndexError):
                    continue
        return None

    # ── Semantic Scholar ────────────────────────────────────────────────────

    async def _fetch_semantic_scholar(
        self, client: httpx.AsyncClient, request: PicoSearchRequest
    ) -> list[RawPaper]:
        cap = self._source_cap(request)
        headers: dict[str, str] = {}
        if self.settings.semantic_scholar_api_key:
            headers["x-api-key"] = self.settings.semantic_scholar_api_key

        year = None
        if request.year_min or request.year_max:
            y_min = request.year_min or 1900
            y_max = request.year_max or 2100
            year = f"{y_min}-{y_max}"

        if cap > 100 or request.fetch_all:
            return await self._fetch_semantic_scholar_bulk(
                client, request, cap, headers, year
            )

        params: dict[str, Any] = {
            "query": request.keywords,
            "limit": min(cap, 100),
            "fields": "title,authors,year,abstract,externalIds,url,venue",
        }
        if year:
            params["year"] = year
        resp = await self._request_with_retry(
            client, "GET", S2_API, params=params, headers=headers
        )
        data = resp.json().get("data", []) or []
        return [self._s2_item_to_paper(item) for item in data][:cap]

    async def _fetch_semantic_scholar_bulk(
        self,
        client: httpx.AsyncClient,
        request: PicoSearchRequest,
        cap: int,
        headers: dict[str, str],
        year: Optional[str],
    ) -> list[RawPaper]:
        papers: list[RawPaper] = []
        token: Optional[str] = None
        while len(papers) < cap:
            params: dict[str, Any] = {
                "query": request.keywords,
                "fields": "title,authors,year,abstract,externalIds,url,venue",
            }
            if year:
                params["year"] = year
            if token:
                params["token"] = token
            resp = await self._request_with_retry(
                client, "GET", S2_BULK_API, params=params, headers=headers
            )
            payload = resp.json()
            data = payload.get("data") or []
            if not data:
                break
            papers.extend(self._s2_item_to_paper(item) for item in data)
            token = payload.get("token")
            if not token:
                break
        return papers[:cap]

    def _s2_item_to_paper(self, item: dict[str, Any]) -> RawPaper:
        ext = item.get("externalIds") or {}
        authors = [
            a.get("name", "").strip()
            for a in (item.get("authors") or [])
            if a.get("name")
        ]
        return RawPaper(
            doi=ext.get("DOI"),
            title=(item.get("title") or "Untitled").strip(),
            authors=authors,
            year=item.get("year"),
            abstract=item.get("abstract"),
            source=SourceName.SEMANTIC_SCHOLAR.value,
            url=item.get("url"),
            venue=item.get("venue"),
            pmid=str(ext["PubMed"]) if ext.get("PubMed") else None,
            arxiv_id=ext.get("ArXiv"),
        )

    # ── arXiv ───────────────────────────────────────────────────────────────

    async def _fetch_arxiv(
        self, client: httpx.AsyncClient, request: PicoSearchRequest
    ) -> list[RawPaper]:
        query = f"all:{request.keywords}"
        cap = self._source_cap(request)
        papers: list[RawPaper] = []
        start = 0
        page_size = 100
        while len(papers) < cap:
            resp = await self._request_with_retry(
                client,
                "GET",
                ARXIV_API,
                params={
                    "search_query": query,
                    "start": start,
                    "max_results": min(page_size, cap - len(papers)),
                    "sortBy": "relevance",
                    "sortOrder": "descending",
                },
            )
            batch = self._parse_arxiv_feed(resp.text, request)
            if not batch:
                break
            papers.extend(batch)
            start += page_size
            if len(batch) < page_size:
                break
        return papers[:cap]

    def _parse_arxiv_feed(
        self, xml_text: str, request: PicoSearchRequest
    ) -> list[RawPaper]:
        ns = {
            "atom": "http://www.w3.org/2005/Atom",
            "arxiv": "http://arxiv.org/schemas/atom",
        }
        papers: list[RawPaper] = []
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError:
            return papers

        for entry in root.findall("atom:entry", ns):
            title_el = entry.find("atom:title", ns)
            title = (
                re.sub(r"\s+", " ", (title_el.text or "Untitled")).strip()
                if title_el is not None
                else "Untitled"
            )
            summary_el = entry.find("atom:summary", ns)
            abstract = (
                re.sub(r"\s+", " ", (summary_el.text or "")).strip()
                if summary_el is not None
                else None
            )
            authors = [
                (a.find("atom:name", ns).text or "").strip()
                for a in entry.findall("atom:author", ns)
                if a.find("atom:name", ns) is not None
            ]
            published = entry.find("atom:published", ns)
            year: Optional[int] = None
            if published is not None and published.text:
                year = self._parse_year(published.text[:4])

            if request.year_min and year and year < request.year_min:
                continue
            if request.year_max and year and year > request.year_max:
                continue

            id_el = entry.find("atom:id", ns)
            arxiv_url = id_el.text.strip() if id_el is not None and id_el.text else None
            arxiv_id = None
            if arxiv_url:
                arxiv_id = arxiv_url.rsplit("/abs/", 1)[-1]

            doi_el = entry.find("arxiv:doi", ns)
            doi = doi_el.text.strip() if doi_el is not None and doi_el.text else None

            papers.append(
                RawPaper(
                    doi=doi,
                    title=title,
                    authors=authors,
                    year=year,
                    abstract=abstract,
                    source=SourceName.ARXIV.value,
                    url=arxiv_url,
                    arxiv_id=arxiv_id,
                )
            )
        return papers

    # ── Google Scholar via SerpAPI ──────────────────────────────────────────
    # GET https://serpapi.com/search.json?engine=google_scholar&q=...&api_key=...

    async def _fetch_serpapi(
        self, client: httpx.AsyncClient, request: PicoSearchRequest
    ) -> list[RawPaper]:
        if not self.settings.serpapi_key:
            logger.warning("SERPAPI_KEY missing — skip Google Scholar")
            return []

        cap = min(self._source_cap(request), SCHOLAR_HARD_CAP)
        papers: list[RawPaper] = []
        start = 0

        while len(papers) < cap:
            # SerpAPI Google Scholar: max 20 results per page
            page_size = min(20, cap - len(papers))
            params: dict[str, Any] = {
                "engine": "google_scholar",
                "q": request.keywords,
                "api_key": self.settings.serpapi_key,
                "num": page_size,
                "start": start,
            }
            if request.year_min is not None:
                params["as_ylo"] = request.year_min
            if request.year_max is not None:
                params["as_yhi"] = request.year_max

            resp = await self._request_with_retry(
                client,
                "GET",
                SERPAPI_URL,
                params=params,
            )
            payload = resp.json()
            if payload.get("error"):
                logger.warning("SerpAPI error: %s", payload["error"])
                break

            results = payload.get("organic_results") or []
            if not results:
                break

            for item in results:
                paper = self._parse_serpapi_scholar_item(item)
                if paper is None:
                    continue
                if request.year_min and paper.year and paper.year < request.year_min:
                    continue
                if request.year_max and paper.year and paper.year > request.year_max:
                    continue
                papers.append(paper)

            start += len(results)
            # SerpAPI often returns fewer than requested near the end
            if len(results) < page_size:
                break
            await asyncio.sleep(0.25)

        return papers[:cap]

    @staticmethod
    def _parse_serpapi_scholar_item(item: dict[str, Any]) -> Optional[RawPaper]:
        title = (item.get("title") or "").strip()
        if not title:
            return None

        pub_info = item.get("publication_info") or {}
        authors_raw = pub_info.get("authors") or []
        authors: list[str] = []
        if isinstance(authors_raw, list):
            for a in authors_raw:
                if isinstance(a, dict) and a.get("name"):
                    authors.append(str(a["name"]).strip())
                elif isinstance(a, str) and a.strip():
                    authors.append(a.strip())

        summary = str(pub_info.get("summary") or "")
        year = MultiSourceFetcher._parse_year(summary)
        if year is None:
            year = MultiSourceFetcher._parse_year(item.get("publication_info"))

        # Prefer PDF / primary resource link when present
        resource = item.get("resources") or []
        url = item.get("link")
        if isinstance(resource, list) and resource:
            first = resource[0] if isinstance(resource[0], dict) else {}
            url = first.get("link") or url

        doi = MultiSourceFetcher._extract_doi_from_text(
            " ".join(
                filter(
                    None,
                    [
                        item.get("link"),
                        summary,
                        item.get("snippet"),
                    ],
                )
            )
        )

        return RawPaper(
            doi=doi,
            title=title,
            authors=authors,
            year=year,
            abstract=item.get("snippet"),
            source=SourceName.GOOGLE_SCHOLAR.value,
            url=url,
            venue=summary or None,
        )

    @staticmethod
    def _extract_doi_from_text(text: Optional[str]) -> Optional[str]:
        if not text:
            return None
        match = re.search(
            r"\b(10\.\d{4,9}/[-._;()/:A-Z0-9]+)\b",
            text,
            flags=re.IGNORECASE,
        )
        return match.group(1).rstrip(".)]") if match else None

    # ── IEEE Xplore ─────────────────────────────────────────────────────────

    async def _fetch_ieee_xplore(
        self, client: httpx.AsyncClient, request: PicoSearchRequest
    ) -> list[RawPaper]:
        if self.settings.ieee_xplore_api_key:
            try:
                papers = await self._fetch_ieee_api(client, request)
                if papers:
                    return papers
            except Exception as exc:  # noqa: BLE001
                logger.warning("IEEE Xplore API failed, falling back: %s", exc)

        try:
            papers = await self._fetch_openalex(
                client,
                request,
                publisher_id=OPENALEX_IEEE_PUBLISHER,
                source_name=SourceName.IEEE_XPLORE.value,
            )
            if papers:
                return papers
        except Exception as exc:  # noqa: BLE001
            logger.warning("IEEE via OpenAlex failed, falling back to Crossref: %s", exc)

        return await self._fetch_crossref(
            client,
            request,
            extra_filters=["prefix:10.1109"],
            source_name=SourceName.IEEE_XPLORE.value,
        )

    async def _fetch_ieee_api(
        self, client: httpx.AsyncClient, request: PicoSearchRequest
    ) -> list[RawPaper]:
        cap = self._source_cap(request)
        papers: list[RawPaper] = []
        start_record = 1
        while len(papers) < cap:
            params: dict[str, Any] = {
                "querytext": request.keywords,
                "apikey": self.settings.ieee_xplore_api_key,
                "max_records": min(200, cap - len(papers)),
                "start_record": start_record,
            }
            if request.year_min:
                params["start_year"] = request.year_min
            if request.year_max:
                params["end_year"] = request.year_max

            resp = await self._request_with_retry(
                client, "GET", IEEE_XPLORE_API, params=params
            )
            payload = resp.json()
            articles = payload.get("articles") or []
            if not articles:
                break
            papers.extend(self._ieee_item_to_paper(item) for item in articles if isinstance(item, dict))
            start_record += len(articles)
            total = payload.get("total_records")
            if total is not None and start_record > int(total):
                break
            if len(articles) < 1:
                break
        return papers[:cap]

    def _ieee_item_to_paper(self, item: dict[str, Any]) -> RawPaper:
        authors_block = item.get("authors") or {}
        if isinstance(authors_block, dict):
            raw_authors = authors_block.get("authors") or []
        elif isinstance(authors_block, list):
            raw_authors = authors_block
        else:
            raw_authors = []
        authors = [
            (a.get("full_name") or a.get("authorName") or "").strip()
            for a in raw_authors
            if isinstance(a, dict) and (a.get("full_name") or a.get("authorName"))
        ]
        doi = item.get("doi")
        html_url = item.get("html_url")
        return RawPaper(
            doi=doi,
            title=(item.get("title") or "Untitled").strip(),
            authors=authors,
            year=self._parse_year(item.get("publication_year")),
            abstract=item.get("abstract"),
            source=SourceName.IEEE_XPLORE.value,
            url=self._canonical_url(doi, html_url, SourceName.IEEE_XPLORE.value),
            venue=item.get("publication_title"),
        )

    # ── ACM Digital Library ─────────────────────────────────────────────────

    async def _fetch_acm_dl(
        self, client: httpx.AsyncClient, request: PicoSearchRequest
    ) -> list[RawPaper]:
        try:
            papers = await self._fetch_openalex(
                client,
                request,
                publisher_id=OPENALEX_ACM_PUBLISHER,
                source_name=SourceName.ACM_DL.value,
            )
            if papers:
                return papers
        except Exception as exc:  # noqa: BLE001
            logger.warning("ACM via OpenAlex failed, falling back to Crossref: %s", exc)

        return await self._fetch_crossref(
            client,
            request,
            extra_filters=["prefix:10.1145"],
            source_name=SourceName.ACM_DL.value,
        )

    # ── OpenAlex ────────────────────────────────────────────────────────────

    async def _fetch_openalex(
        self,
        client: httpx.AsyncClient,
        request: PicoSearchRequest,
        publisher_id: Optional[str] = None,
        source_name: Optional[str] = None,
    ) -> list[RawPaper]:
        source_label = source_name or SourceName.OPENALEX.value
        query = (request.keywords or "").replace(",", " ").strip()
        filters: list[str] = []
        if query:
            filters.append(f"title_and_abstract.search:{query}")
        if request.year_min or request.year_max:
            y_min = request.year_min or 1900
            y_max = request.year_max or 2100
            filters.append(f"publication_year:{y_min}-{y_max}")
        if publisher_id:
            filters.append(f"primary_location.source.publisher_lineage:{publisher_id}")

        cap = self._source_cap(request)
        params: dict[str, Any] = {
            "per_page": min(200, cap),
            "mailto": self.settings.crossref_mailto,
            "cursor": "*",
        }
        if filters:
            params["filter"] = ",".join(filters)

        papers: list[RawPaper] = []
        while len(papers) < cap:
            params["per_page"] = min(200, cap - len(papers))
            resp = await self._request_with_retry(
                client, "GET", OPENALEX_API, params=params
            )
            payload = resp.json()
            items = payload.get("results") or []
            if not items:
                break
            for item in items:
                if isinstance(item, dict):
                    papers.append(self._openalex_item_to_paper(item, source_label))
            next_cursor = (payload.get("meta") or {}).get("next_cursor")
            if not next_cursor:
                break
            params["cursor"] = next_cursor
        return papers[:cap]

    def _openalex_item_to_paper(
        self, item: dict[str, Any], source_label: str
    ) -> RawPaper:
        authors = []
        for authorship in item.get("authorships") or []:
            author = authorship.get("author") or {}
            name = (author.get("display_name") or "").strip()
            if name:
                authors.append(name)
        doi = self._normalize_openalex_doi(item.get("doi"))
        location = item.get("primary_location") or {}
        source_meta = location.get("source") or {}
        ids = item.get("ids") or {}
        return RawPaper(
            doi=doi,
            title=(item.get("display_name") or item.get("title") or "Untitled").strip(),
            authors=authors,
            year=item.get("publication_year"),
            abstract=self._openalex_abstract(item.get("abstract_inverted_index")),
            source=source_label,
            url=self._canonical_url(
                doi, location.get("landing_page_url"), source_label
            ),
            venue=source_meta.get("display_name"),
            pmid=self._id_tail(ids.get("pmid")),
            arxiv_id=self._id_tail(ids.get("arxiv")),
        )

    @staticmethod
    def _canonical_url(
        doi: Optional[str], landing: Optional[str], source: str
    ) -> Optional[str]:
        if landing:
            return landing
        if not doi:
            return None
        if source == SourceName.ACM_DL.value:
            return f"https://dl.acm.org/doi/{doi}"
        if source == SourceName.IEEE_XPLORE.value:
            return f"https://doi.org/{doi}"
        return f"https://doi.org/{doi}"

    @staticmethod
    def _normalize_openalex_doi(value: Any) -> Optional[str]:
        if not value:
            return None
        cleaned = str(value).strip()
        cleaned = cleaned.removeprefix("https://doi.org/")
        cleaned = cleaned.removeprefix("http://doi.org/")
        cleaned = cleaned.removeprefix("doi:")
        return cleaned.strip() or None

    @staticmethod
    def _id_tail(value: Any) -> Optional[str]:
        if not value:
            return None
        text = str(value).strip().rstrip("/")
        if "/" in text:
            text = text.rsplit("/", 1)[-1]
        return text or None

    @staticmethod
    def _openalex_abstract(inverted: Any) -> Optional[str]:
        if not inverted or not isinstance(inverted, dict):
            return None
        positions: list[tuple[int, str]] = []
        for word, idxs in inverted.items():
            if not isinstance(idxs, list):
                continue
            for idx in idxs:
                try:
                    positions.append((int(idx), str(word)))
                except (TypeError, ValueError):
                    continue
        if not positions:
            return None
        positions.sort(key=lambda item: item[0])
        text = " ".join(word for _, word in positions).strip()
        return text or None

    @staticmethod
    def _parse_year(value: Any) -> Optional[int]:
        if value is None:
            return None
        match = re.search(r"(19|20)\d{2}", str(value))
        if match:
            try:
                return int(match.group(0))
            except ValueError:
                return None
        return None


# Keep quote_plus available for potential URL building
_ = quote_plus
