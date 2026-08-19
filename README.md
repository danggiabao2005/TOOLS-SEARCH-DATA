# Academic PICO Extractor

Hệ thống hỗ trợ nghiên cứu khoa học: keyword → cào đa nguồn → dedup 3 lớp → trích xuất PICO → SSE realtime → xuất CSV/JSON/RIS.

## Cấu trúc

```text
pico-extractor-system/
├── backend/          # FastAPI + async fetcher + LLM extractor
└── extension/        # Chrome Extension (Manifest V3, React/Vite/Tailwind)
```

## Backend

### Setup

```bash
cd backend
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS/Linux
# source .venv/bin/activate

pip install -r requirements.txt
copy .env.example .env   # rồi điền OPENAI_API_KEY, UNPAYWALL_EMAIL, ...
```

### Chạy

```bash
cd backend
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Health check: `GET http://127.0.0.1:8000/health`

### API chính

| Method | Path | Mô tả |
|--------|------|--------|
| `POST` | `/api/v1/tasks/pico-search` | Tạo task, trả `task_id` |
| `GET`  | `/api/v1/tasks/{task_id}/stream` | SSE stream tiến trình + papers |
| `POST` | `/api/v1/tasks/{task_id}/cancel` | Hủy task |
| `GET`  | `/api/v1/tasks/{task_id}` | Trạng thái task |

### SSE events

- `status` — `{ stage, message, progress? }`
- `paper_processed` — object `PaperWithPICO`
- `complete` — `{ total, status: "done" }`

### Pipeline

1. **Fetch** song song: IEEE Xplore, ACM DL, Semantic Scholar, Google Scholar, OpenAlex, PubMed, Crossref, arXiv (+ Google Scholar bổ sung nếu &lt; 5 kết quả)
2. **Dedup** 3 lớp: DOI → title chuẩn hóa → fuzzy (`rapidfuzz` ≥ 90 + year ±1)
3. **Open access**: Unpaywall / Europe PMC khi abstract &lt; 100 ký tự
4. **Extract**: LLM structured output (`instructor` + Pydantic `PICOResult`)
5. **Stream**: từng paper ngay khi extract xong

## Chrome Extension

### Build

```bash
cd extension
npm install
npm run icons
npm run build
```

Load unpacked trong `chrome://extensions` → **Load unpacked** → chọn thư mục `extension/dist`.

### UI states

- **Idle** — form sẵn sàng
- **Streaming** — progress + paper cards tăng dần; nút Hủy (AbortController)
- **Completed / Error** — export CSV / JSON / RIS

API mặc định: `http://127.0.0.1:8000` (chỉnh trong popup → API endpoint).

## Biến môi trường (backend `.env`)

| Key | Bắt buộc | Mô tả |
|-----|----------|--------|
| `OPENAI_API_KEY` | Có (để extract thật) | Không có → stub PICO (dev) |
| `OPENAI_MODEL` | Không | Mặc định `gpt-4o-mini` |
| `UNPAYWALL_EMAIL` | Nên có | Email Unpaywall |
| `CROSSREF_MAILTO` | Nên có | Polite pool Crossref |
| `SEMANTIC_SCHOLAR_API_KEY` | Không | Tăng rate limit |
| `SERPAPI_KEY` | Không | Google Scholar (nguồn chính hoặc fallback) |
| `IEEE_XPLORE_API_KEY` | Không | IEEE Metadata API; không có thì dùng OpenAlex/Crossref (prefix 10.1109) |

## Lưu ý

- Backend chỉ dùng `httpx.AsyncClient` (không `requests`).
- Một nguồn lỗi/timeout không dừng toàn pipeline.
- Task store in-memory: phù hợp local/extension; production nên dùng Redis/DB.
