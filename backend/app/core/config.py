"""Environment variables & application settings."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # API
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    cors_origins: str = "chrome-extension://*,http://localhost:*,http://127.0.0.1:*"

    # LLM provider: "gemini" (free tier) | "openai"
    llm_provider: Literal["gemini", "openai"] = "gemini"

    # OpenAI
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    openai_base_url: str | None = None

    # Gemini (Google AI Studio — free tier)
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.5-flash"

    # External APIs
    unpaywall_email: str = "researcher@example.com"
    serpapi_key: str = ""
    semantic_scholar_api_key: str = ""
    crossref_mailto: str = "researcher@example.com"
    ieee_xplore_api_key: str = ""

    # Fetching
    http_timeout: float = 30.0
    max_retries: int = 3
    default_limit_per_source: int = 20
    fetch_all_cap_per_source: int = 500

    # Dedup
    fuzzy_title_threshold: float = 90.0

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    def resolve_llm(self) -> tuple[str, str | None, str]:
        """Return (api_key, base_url, model) for the active provider."""
        if self.llm_provider == "gemini":
            key = self.gemini_api_key.strip()
            if not key:
                return (
                    self.openai_api_key.strip(),
                    self.openai_base_url,
                    self.openai_model,
                )
            return key, GEMINI_OPENAI_BASE_URL, self.gemini_model

        return (
            self.openai_api_key.strip(),
            self.openai_base_url,
            self.openai_model,
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()


def clear_settings_cache() -> None:
    get_settings.cache_clear()
