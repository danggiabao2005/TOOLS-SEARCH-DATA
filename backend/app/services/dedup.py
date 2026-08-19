"""3-layer deduplication engine for academic papers."""

from __future__ import annotations

import re
from typing import Optional

from rapidfuzz import fuzz

from app.api.schemas import RawPaper
from app.core.config import Settings, get_settings


def normalize_doi(doi: Optional[str]) -> Optional[str]:
    if not doi:
        return None
    cleaned = doi.lower().strip()
    cleaned = cleaned.removeprefix("https://doi.org/")
    cleaned = cleaned.removeprefix("http://doi.org/")
    cleaned = cleaned.removeprefix("doi:")
    return cleaned.strip() or None


def normalize_title(title: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]", "", title.lower())


def _abstract_len(paper: RawPaper) -> int:
    return len(paper.abstract or "")


def _merge_papers(primary: RawPaper, secondary: RawPaper) -> RawPaper:
    """Merge metadata; prefer the record with the longest abstract."""
    if _abstract_len(secondary) > _abstract_len(primary):
        primary, secondary = secondary, primary

    data = primary.model_dump()
    other = secondary.model_dump()

    for key in ("doi", "year", "url", "venue", "pmid", "arxiv_id", "full_text_snippet"):
        if not data.get(key) and other.get(key):
            data[key] = other[key]

    if not data.get("abstract") and other.get("abstract"):
        data["abstract"] = other["abstract"]
    elif other.get("abstract") and len(other["abstract"]) > len(data.get("abstract") or ""):
        data["abstract"] = other["abstract"]

    authors = list(dict.fromkeys([*(data.get("authors") or []), *(other.get("authors") or [])]))
    data["authors"] = authors

    # Track combined sources in title-adjacent field via source string join
    src_a = data.get("source") or ""
    src_b = other.get("source") or ""
    if src_b and src_b not in src_a:
        data["source"] = f"{src_a}+{src_b}" if src_a else src_b

    return RawPaper(**data)


class DeduplicationEngine:
    """L1 DOI exact → L2 normalized title → L3 fuzzy title + year."""

    def __init__(self, settings: Optional[Settings] = None) -> None:
        self.settings = settings or get_settings()
        self.threshold = self.settings.fuzzy_title_threshold

    def deduplicate(self, papers: list[RawPaper]) -> list[RawPaper]:
        if not papers:
            return []

        # Layer 1: DOI exact match
        by_doi: dict[str, RawPaper] = {}
        no_doi: list[RawPaper] = []
        for paper in papers:
            doi = normalize_doi(paper.doi)
            if doi:
                if doi in by_doi:
                    by_doi[doi] = _merge_papers(by_doi[doi], paper)
                else:
                    by_doi[doi] = paper.model_copy(update={"doi": doi})
            else:
                no_doi.append(paper)

        candidates = list(by_doi.values()) + no_doi

        # Layer 2: Exact normalized title
        by_title: dict[str, RawPaper] = {}
        for paper in candidates:
            key = normalize_title(paper.title)
            if not key:
                by_title[f"__empty_{id(paper)}"] = paper
                continue
            if key in by_title:
                by_title[key] = _merge_papers(by_title[key], paper)
            else:
                by_title[key] = paper

        candidates = list(by_title.values())

        # Layer 3: Fuzzy title match + year ±1
        unique: list[RawPaper] = []
        for paper in candidates:
            matched_idx: Optional[int] = None
            for idx, existing in enumerate(unique):
                score = fuzz.token_set_ratio(paper.title, existing.title)
                if score < self.threshold:
                    continue
                year_ok = True
                if paper.year is not None and existing.year is not None:
                    year_ok = abs(paper.year - existing.year) <= 1
                if year_ok:
                    matched_idx = idx
                    break
            if matched_idx is not None:
                unique[matched_idx] = _merge_papers(unique[matched_idx], paper)
            else:
                unique.append(paper)

        return unique
