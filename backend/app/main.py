"""FastAPI entry point & CORS configuration."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.api.routes import router
from app.core.config import get_settings


class LocalNetworkAccessMiddleware(BaseHTTPMiddleware):
    """Chrome Local Network Access / Private Network Access preflight."""

    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers["Access-Control-Allow-Private-Network"] = "true"
        return response


def create_app() -> FastAPI:
    settings = get_settings()
    application = FastAPI(
        title="Academic PICO Extractor",
        description="Multi-source academic search with structured PICO extraction",
        version="1.0.0",
    )
    # allow_credentials=True cannot be combined with allow_origins=["*"]
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["*"],
    )
    application.add_middleware(LocalNetworkAccessMiddleware)
    application.include_router(router, prefix="/api/v1")

    @application.get("/health")
    async def health() -> dict[str, object]:
        s = get_settings()
        _key, _base, model = s.resolve_llm()
        return {
            "status": "ok",
            "llm_provider": s.llm_provider,
            "llm_model": model,
            "gemini_key_set": bool(s.gemini_api_key.strip()),
        }

    return application


app = create_app()
