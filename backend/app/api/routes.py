"""FastAPI endpoints: task creation & SSE stream."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncIterator, Optional
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from sse_starlette.sse import EventSourceResponse

from app.api.schemas import (
    ClusterImportRequest,
    CompleteEvent,
    PaperWithPICO,
    PicoSearchRequest,
    RawPaper,
    ScreenRequest,
    ScreeningDecision,
    StatusEvent,
    TaskCreateResponse,
    TaskStage,
    TaskState,
)
from app.services.dedup import DeduplicationEngine
from app.services.extractor import PICOExtractor
from app.services.fetcher import MultiSourceFetcher
from app.services.open_access import OpenAccessEnricher
from app.services.screener import TitleAbstractScreener

logger = logging.getLogger(__name__)

router = APIRouter(tags=["pico"])

# In-memory task store (single-process; sufficient for local / extension use)
_tasks: dict[str, TaskState] = {}
_queues: dict[str, asyncio.Queue[Optional[dict[str, Any]]]] = {}
_runners: dict[str, asyncio.Task[None]] = {}


def _get_task(task_id: str) -> TaskState:
    task = _tasks.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
    return task


async def _emit(task_id: str, event: str, data: dict[str, Any]) -> None:
    queue = _queues.get(task_id)
    if queue is not None:
        await queue.put({"event": event, "data": data})


async def _run_pipeline(task_id: str) -> None:
    task = _tasks[task_id]
    fetcher = MultiSourceFetcher()
    deduper = DeduplicationEngine()
    enricher = OpenAccessEnricher()
    extractor = PICOExtractor()

    try:
        # Phase 2: Fetch
        source_labels = ", ".join(s.value for s in task.request.sources)
        task.stage = TaskStage.FETCHING
        task.message = (
            f"Đang quét {source_labels}"
            + (" — lấy hết kết quả liên quan..." if task.request.fetch_all else "...")
        )
        await _emit(
            task_id,
            "status",
            StatusEvent(stage=TaskStage.FETCHING, message=task.message).model_dump(
                mode="json"
            ),
        )

        if task.cancelled:
            return

        raw_papers = await fetcher.fetch_all(task.request)
        task.message = f"Quét xong {len(task.request.sources)} nguồn: {len(raw_papers)} bài báo..."
        await _emit(
            task_id,
            "status",
            StatusEvent(stage=TaskStage.FETCHING, message=task.message).model_dump(
                mode="json"
            ),
        )

        if task.cancelled:
            return

        # Phase 3: Dedup
        task.stage = TaskStage.DEDUP
        task.message = "Đang lọc trùng lặp (3 lớp)..."
        await _emit(
            task_id,
            "status",
            StatusEvent(stage=TaskStage.DEDUP, message=task.message).model_dump(
                mode="json"
            ),
        )

        clusters = deduper.cluster(raw_papers)
        dup_n = sum(1 for _cid, _reason, members in clusters if len(members) > 1)
        merged_papers = [deduper.merge_group(members) for _cid, _reason, members in clusters]
        task.message = (
            f"Gom trùng: {len(raw_papers)} bài → {len(merged_papers)} nhóm "
            f"({dup_n} nhóm trùng — giữ bản gốc để bạn chọn)."
        )
        await _emit(
            task_id,
            "status",
            StatusEvent(stage=TaskStage.DEDUP, message=task.message).model_dump(
                mode="json"
            ),
        )

        if task.cancelled:
            return

        # Phase 4: Open access enrichment
        task.stage = TaskStage.OPEN_ACCESS
        task.message = "Bổ sung abstract / open-access khi thiếu..."
        await _emit(
            task_id,
            "status",
            StatusEvent(stage=TaskStage.OPEN_ACCESS, message=task.message).model_dump(
                mode="json"
            ),
        )
        need_oa = sum(
            1
            for p in merged_papers
            if (not p.url) or len((p.abstract or "").strip()) < 100
        )
        task.message = (
            f"Bổ sung abstract / open-access ({need_oa} bài thiếu metadata)..."
        )
        await _emit(
            task_id,
            "status",
            StatusEvent(stage=TaskStage.OPEN_ACCESS, message=task.message).model_dump(
                mode="json"
            ),
        )

        async def _oa_progress(done: int, total: int) -> None:
            if task.cancelled:
                return
            if done == total or done % 8 == 0:
                task.message = f"Bổ sung abstract / open-access ({done}/{total})..."
                await _emit(
                    task_id,
                    "status",
                    StatusEvent(
                        stage=TaskStage.OPEN_ACCESS,
                        message=task.message,
                        progress=done / max(total, 1),
                    ).model_dump(mode="json"),
                )

        unique_papers = await enricher.enrich(merged_papers, on_progress=_oa_progress)

        if task.cancelled:
            return

        # Phase 5 + 6: Extract once per cluster, stream every original record
        task.stage = TaskStage.EXTRACTING
        total = len(unique_papers)
        for idx, ((cluster_id, dup_reason, members), enriched) in enumerate(
            zip(clusters, unique_papers)
        ):
            if task.cancelled:
                task.stage = TaskStage.CANCELLED
                await _emit(
                    task_id,
                    "status",
                    StatusEvent(
                        stage=TaskStage.CANCELLED, message="Tác vụ đã bị hủy."
                    ).model_dump(mode="json"),
                )
                return

            task.message = f"Đang trích xuất PICO ({idx + 1}/{total})..."
            await _emit(
                task_id,
                "status",
                StatusEvent(
                    stage=TaskStage.EXTRACTING,
                    message=task.message,
                    progress=(idx + 1) / max(total, 1),
                ).model_dump(mode="json"),
            )

            pico = None
            extraction_error: Optional[str] = None
            try:
                pico = await extractor.extract(enriched)
            except Exception as exc:  # noqa: BLE001
                extraction_error = str(exc)
                logger.exception("Extraction error: %s", exc)

            for member in members:
                sources = [s for s in member.source.split("+") if s]
                paper_out = PaperWithPICO(
                    doi=member.doi or enriched.doi,
                    title=member.title,
                    authors=member.authors or enriched.authors,
                    year=member.year or enriched.year,
                    abstract=member.abstract or enriched.abstract,
                    source=sources[0] if sources else member.source,
                    sources=sources or [member.source],
                    url=member.url or enriched.url,
                    venue=member.venue or enriched.venue,
                    pmid=member.pmid or enriched.pmid,
                    arxiv_id=member.arxiv_id or enriched.arxiv_id,
                    pico=pico,
                    extraction_error=extraction_error,
                    dup_cluster_id=cluster_id,
                    dup_reason=dup_reason or None,
                )
                task.papers.append(paper_out)
                await _emit(
                    task_id,
                    "paper_processed",
                    paper_out.model_dump(mode="json"),
                )

        task.stage = TaskStage.COMPLETE
        task.message = "Hoàn tất."
        await _emit(
            task_id,
            "complete",
            CompleteEvent(total=len(task.papers), status="done").model_dump(
                mode="json"
            ),
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Pipeline failed for task %s: %s", task_id, exc)
        task.stage = TaskStage.ERROR
        task.error = str(exc)
        task.message = f"Lỗi: {exc}"
        await _emit(
            task_id,
            "status",
            StatusEvent(stage=TaskStage.ERROR, message=task.message).model_dump(
                mode="json"
            ),
        )
    finally:
        queue = _queues.get(task_id)
        if queue is not None:
            await queue.put(None)  # sentinel — end stream


@router.post("/tasks/pico-search", response_model=TaskCreateResponse)
async def create_pico_search(request: PicoSearchRequest) -> TaskCreateResponse:
    if request.year_min and request.year_max and request.year_min > request.year_max:
        raise HTTPException(
            status_code=400, detail="year_min must be <= year_max"
        )

    task_id = str(uuid4())
    state = TaskState(task_id=task_id, request=request, stage=TaskStage.IDLE)
    _tasks[task_id] = state
    _queues[task_id] = asyncio.Queue()
    _runners[task_id] = asyncio.create_task(_run_pipeline(task_id))
    return TaskCreateResponse(task_id=task_id, status="accepted")


@router.get("/tasks/{task_id}/stream")
async def stream_task(task_id: str) -> EventSourceResponse:
    _get_task(task_id)
    queue = _queues.get(task_id)
    if queue is None:
        raise HTTPException(status_code=404, detail="Stream queue not found")

    async def event_generator() -> AsyncIterator[dict[str, str]]:
        # Replay already-processed papers for late subscribers
        task = _tasks[task_id]
        for paper in task.papers:
            yield {
                "event": "paper_processed",
                "data": json.dumps(paper.model_dump(mode="json")),
            }
        if task.stage == TaskStage.COMPLETE:
            yield {
                "event": "complete",
                "data": json.dumps(
                    CompleteEvent(total=len(task.papers), status="done").model_dump(
                        mode="json"
                    )
                ),
            }
            return
        if task.stage == TaskStage.ERROR:
            yield {
                "event": "status",
                "data": json.dumps(
                    StatusEvent(
                        stage=TaskStage.ERROR,
                        message=task.message or task.error or "Error",
                    ).model_dump(mode="json")
                ),
            }
            return

        while True:
            item = await queue.get()
            if item is None:
                break
            yield {
                "event": item["event"],
                "data": json.dumps(item["data"]),
            }

    return EventSourceResponse(event_generator())


@router.get("/tasks/{task_id}")
async def get_task(task_id: str) -> dict[str, Any]:
    task = _get_task(task_id)
    return {
        "task_id": task.task_id,
        "stage": task.stage.value,
        "message": task.message,
        "paper_count": len(task.papers),
        "error": task.error,
        "cancelled": task.cancelled,
    }


@router.post("/tasks/{task_id}/cancel")
async def cancel_task(task_id: str) -> dict[str, str]:
    task = _get_task(task_id)
    task.cancelled = True
    task.stage = TaskStage.CANCELLED
    task.message = "Đang hủy..."
    await _emit(
        task_id,
        "status",
        StatusEvent(stage=TaskStage.CANCELLED, message="Tác vụ đã bị hủy.").model_dump(
            mode="json"
        ),
    )
    return {"task_id": task_id, "status": "cancelled"}


@router.post("/screening/title-abstract")
async def screen_title_abstract(request: ScreenRequest) -> EventSourceResponse:
    screener = TitleAbstractScreener()

    async def event_generator() -> AsyncIterator[dict[str, str]]:
        total = len(request.papers)
        include = exclude = maybe = 0
        for idx, paper in enumerate(request.papers):
            yield {
                "event": "status",
                "data": json.dumps(
                    {
                        "stage": "screening",
                        "message": f"AI screening ({idx + 1}/{total})…",
                        "progress": (idx + 1) / max(total, 1),
                    }
                ),
            }
            decision: ScreeningDecision = await screener.screen(paper, request.criteria)
            if decision.verdict.value == "include":
                include += 1
            elif decision.verdict.value == "exclude":
                exclude += 1
            else:
                maybe += 1
            yield {
                "event": "decision",
                "data": json.dumps(decision.model_dump(mode="json")),
            }
            await asyncio.sleep(0.3)
        yield {
            "event": "complete",
            "data": json.dumps(
                {
                    "total": total,
                    "include": include,
                    "exclude": exclude,
                    "maybe": maybe,
                    "status": "done",
                }
            ),
        }

    return EventSourceResponse(event_generator())


@router.post("/dedup/cluster")
async def cluster_imported_papers(request: ClusterImportRequest) -> dict[str, Any]:
    """Gán dup_cluster_id cho danh sách bài nhập từ CSV (không gọi LLM)."""
    raw: list[RawPaper] = []
    for item in request.papers:
        src = item.source or (item.sources[0] if item.sources else "csv")
        raw.append(
            RawPaper(
                doi=item.doi,
                title=item.title,
                authors=item.authors,
                year=item.year,
                abstract=item.abstract,
                source=src,
                url=item.url,
                venue=item.venue,
            )
        )

    clustered = DeduplicationEngine().cluster(raw)
    index_of = {id(paper): idx for idx, paper in enumerate(raw)}
    out: list[dict[str, Any]] = []
    for cluster_id, reason, members in clustered:
        for member in members:
            idx = index_of[id(member)]
            orig = request.papers[idx]
            sources = orig.sources or ([orig.source] if orig.source else ["csv"])
            out.append(
                {
                    "id": orig.id or str(uuid4()),
                    "title": orig.title,
                    "authors": orig.authors,
                    "year": orig.year,
                    "doi": orig.doi,
                    "url": orig.url,
                    "abstract": orig.abstract,
                    "source": sources[0] if sources else "csv",
                    "sources": sources,
                    "venue": orig.venue,
                    "dup_cluster_id": cluster_id,
                    "dup_reason": reason or None,
                }
            )
    return {"count": len(out), "papers": out}
