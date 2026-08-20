"""Pydantic models for requests, papers, PICO results, and task state."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional
from uuid import uuid4

from pydantic import BaseModel, Field


class SourceName(str, Enum):
    PUBMED = "pubmed"
    ARXIV = "arxiv"
    CROSSREF = "crossref"
    SEMANTIC_SCHOLAR = "semantic_scholar"
    SERPAPI = "serpapi"
    IEEE_XPLORE = "ieee_xplore"
    ACM_DL = "acm_dl"
    GOOGLE_SCHOLAR = "google_scholar"
    OPENALEX = "openalex"


class TaskStage(str, Enum):
    IDLE = "idle"
    FETCHING = "fetching"
    DEDUP = "dedup"
    OPEN_ACCESS = "open_access"
    EXTRACTING = "extracting"
    COMPLETE = "complete"
    ERROR = "error"
    CANCELLED = "cancelled"


class PicoSearchRequest(BaseModel):
    keywords: str = Field(..., min_length=1, description="Search query / keywords")
    year_min: Optional[int] = Field(default=None, ge=1900, le=2100)
    year_max: Optional[int] = Field(default=None, ge=1900, le=2100)
    sources: list[SourceName] = Field(
        ...,
        min_length=1,
        description="Selected databases only — never implied defaults",
    )
    limit: int = Field(
        default=20,
        ge=1,
        le=10000,
        description="Max papers per source when fetch_all is false",
    )
    fetch_all: bool = Field(
        default=False,
        description="Paginate each source until exhausted or fetch_all_cap_per_source",
    )


class RawPaper(BaseModel):
    doi: Optional[str] = None
    title: str
    authors: list[str] = Field(default_factory=list)
    year: Optional[int] = None
    abstract: Optional[str] = None
    source: str
    url: Optional[str] = None
    venue: Optional[str] = None
    pmid: Optional[str] = None
    arxiv_id: Optional[str] = None
    full_text_snippet: Optional[str] = None


class PaperType(str, Enum):
    """Contribution class used in SLR/mapping studies (SE + empirical research)."""

    EMPIRICAL = "Empirical"
    EXPERIMENT = "Experiment"
    SURVEY = "Survey"
    CASE_STUDY = "Case Study"
    POSITION = "Position"
    REPLICATION = "Replication"
    REVIEW = "Review"
    OTHER = "Other"


class PICOResult(BaseModel):
    paper_type: PaperType = Field(
        description=(
            "Loại bài theo contribution: Empirical (nghiên cứu thực nghiệm chung), "
            "Experiment (thí nghiệm có kiểm soát), Survey (khảo sát/questionnaire), "
            "Case Study, Position (ý kiến/vision, không đánh giá thực nghiệm), "
            "Replication, Review (SLR/mapping/literature review), Other."
        )
    )
    population: str = Field(
        description="Đặc điểm người bệnh/đối tượng, tiêu chí chọn mẫu, bệnh lý nền"
    )
    intervention: str = Field(
        description="Phương pháp điều trị, can thiệp, loại thuốc, liều dùng"
    )
    comparison: Optional[str] = Field(
        default="N/A",
        description="Nhóm chứng, placebo, hoặc phương pháp đối chứng (Ghi 'N/A' nếu không có)",
    )
    outcomes: list[str] = Field(
        description="Danh sách kết quả chính đo lường được kèm số liệu/p-value nếu có"
    )
    study_type: str = Field(
        description="Phân loại thiết kế nghiên cứu: RCT, Meta-analysis, Cohort study, Case report, In-vitro, etc."
    )
    confidence_score: float = Field(
        ge=0.0,
        le=1.0,
        description="Độ tin cậy từ 0.0 - 1.0 dựa trên mức độ rõ ràng của Abstract",
    )


class PaperWithPICO(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    doi: Optional[str] = None
    title: str
    authors: list[str] = Field(default_factory=list)
    year: Optional[int] = None
    abstract: Optional[str] = None
    source: str
    sources: list[str] = Field(default_factory=list)
    url: Optional[str] = None
    venue: Optional[str] = None
    pmid: Optional[str] = None
    arxiv_id: Optional[str] = None
    pico: Optional[PICOResult] = None
    extraction_error: Optional[str] = None


class StatusEvent(BaseModel):
    stage: TaskStage
    message: str
    progress: Optional[float] = None
    detail: Optional[dict[str, Any]] = None


class CompleteEvent(BaseModel):
    total: int
    status: str = "done"


class TaskCreateResponse(BaseModel):
    task_id: str
    status: str = "accepted"


class TaskState(BaseModel):
    task_id: str
    request: PicoSearchRequest
    stage: TaskStage = TaskStage.IDLE
    message: str = ""
    papers: list[PaperWithPICO] = Field(default_factory=list)
    error: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    cancelled: bool = False
