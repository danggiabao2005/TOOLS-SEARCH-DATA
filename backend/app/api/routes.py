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
    CompleteEvent,
    PaperWithPICO,
    PicoSearchRequest,
    StatusEvent,
    TaskCreateResponse,
    TaskStage,
    TaskState,
)
from app.services.dedup import DeduplicationEngine
from app.services.extractor import PICOExtractor
from app.services.fetcher import MultiSourceFetcher
from app.services.open_access import OpenAccessEnricher

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

        unique_papers = deduper.deduplicate(raw_papers)
        task.message = f"Hoàn tất lọc trùng: {len(unique_papers)} bài báo duy nhất."
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
            for p in unique_papers
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

        unique_papers = await enricher.enrich(unique_papers, on_progress=_oa_progress)

        if task.cancelled:
            return

        # Phase 5 + 6: Extract & stream each paper
        task.stage = TaskStage.EXTRACTING
        total = len(unique_papers)
        for idx, paper in enumerate(unique_papers):
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

            sources = [s for s in paper.source.split("+") if s]
            paper_out = PaperWithPICO(
                doi=paper.doi,
                title=paper.title,
                authors=paper.authors,
                year=paper.year,
                abstract=paper.abstract,
                source=sources[0] if sources else paper.source,
                sources=sources or [paper.source],
                url=paper.url,
                venue=paper.venue,
                pmid=paper.pmid,
                arxiv_id=paper.arxiv_id,
            )
            try:
                paper_out.pico = await extractor.extract(paper)
            except Exception as exc:  # noqa: BLE001
                paper_out.extraction_error = str(exc)
                logger.exception("Extraction error: %s", exc)

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
