# Academic PICO Extractor

Hệ thống hỗ trợ nghiên cứu khoa học: keyword → cào đa nguồn → dedup 3 lớp → trích xuất PICO → SSE realtime → xuất CSV/JSON/RIS.

Repo: https://github.com/danggiabao2005/TOOLS-SEARCH-DATA

## Chạy sau khi clone / pull GitHub (Windows)

Cần sẵn: **Python 3.11+**, **Node.js 18+**, **Chrome**. GitHub **không** chứa `.venv`, `node_modules`, hay `.env` (có API key) — máy mới phải cài lại.

### 1. Clone (nếu chưa có thư mục)

```powershell
git clone https://github.com/danggiabao2005/TOOLS-SEARCH-DATA.git
cd TOOLS-SEARCH-DATA
```

Nếu đã clone rồi, chỉ cần `git pull` trong thư mục project.

### 2. Backend — cài lần đầu

Trong PowerShell, **không cần** `activate` (tránh lỗi *running scripts is disabled*):

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
copy .env.example .env
```

Mở `backend\.env`, điền:

- `GEMINI_API_KEY=` key lấy tại https://aistudio.google.com/apikey
- `UNPAYWALL_EMAIL=` và `CROSSREF_MAILTO=` email của bạn
- `LLM_PROVIDER=gemini`
- `GEMINI_MODEL=gemini-2.5-flash`

### 3. Chạy API (giữ cửa sổ này mở)

```powershell
cd backend
.\.venv\Scripts\python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Mở http://127.0.0.1:8000/health — phải thấy `"status":"ok"`.

Lần sau chỉ cần bước 3 (venv và pip đã có).

### 4. Chrome extension — cửa sổ PowerShell khác

```powershell
cd extension
npm install
npm run build
```

Chrome → `chrome://extensions` → bật **Developer mode** → **Load unpacked** → chọn thư mục `extension\dist`.

Mở popup extension, API endpoint để `http://127.0.0.1:8000`, nhập keywords → **Bắt đầu quét PICO**.

---

## Cấu trúc


```text
pico-extractor-system/
├── backend/          # FastAPI + async fetcher + LLM extractor
└── extension/        # Chrome Extension (Manifest V3, React/Vite/Tailwind)
```

## Backend

### Setup

```powershell
cd backend
python -m venv .venv
```

**Windows — cách chắc chắn nhất** (không cần `activate`, tránh lỗi *running scripts is disabled*):

```powershell
.\.venv\Scripts\python -m pip install -r requirements.txt
copy .env.example .env
```

Rồi sửa `.env` (điền `GEMINI_API_KEY` hoặc `OPENAI_API_KEY`, email Unpaywall, …).

Nếu muốn `activate` trên PowerShell mà bị chặn script:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
.\.venv\Scripts\activate
```

**macOS/Linux:**

```bash
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

### Chạy

Phải **bật `.venv` trước**, nếu không PowerShell sẽ báo `uvicorn is not recognized`.

**Windows (PowerShell)** — không cần `activate`:

```powershell
cd backend
.\.venv\Scripts\python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

**macOS/Linux:**

```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Thấy `(.venv)` ở đầu dòng terminal là đúng. Health check: `GET http://127.0.0.1:8000/health`

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

1. **Fetch** chỉ các nguồn bạn chọn trên popup (không tự thêm nguồn khác). Tick **Lấy hết bài** để phân trang đến hết kết quả (trần an toàn 10.000/nguồn; Google Scholar ~100). Không tick thì dùng limit nhỏ. PICO vẫn chạy từng bài nên vài trăm bài sẽ lâu.
2. **Dedup** 3 lớp: DOI → title chuẩn hóa → fuzzy (`rapidfuzz` ≥ 90 + year ±1)
3. **Open access**: Unpaywall / Europe PMC khi abstract &lt; 100 ký tự
4. **Extract**: LLM structured output (`instructor` + Pydantic `PICOResult`)
5. **Stream**: từng paper ngay khi extract xong

## Chrome Extension

### Build (nếu đã làm bước 4 ở trên thì bỏ qua)

```powershell
cd extension
npm install
npm run build
```

Load unpacked trong `chrome://extensions` → **Load unpacked** → chọn thư mục `extension/dist`.

### UI states

- **Idle** — form sẵn sàng
- **Streaming** — progress + paper cards tăng dần; nút Hủy (AbortController)
- **Completed / Error** — export CSV / JSON / RIS
- **Nhập CSV** — popup hoặc trang Screening: kéo thả / chọn file CSV (cần cột `title`; nên có `authors`, `year`, `doi`, `abstract`, `url`). Hệ thống gom trùng rồi mở vòng **tiêu chí → dedup → AI screening**. File xuất của tool (`pico-export-*.csv`, `slr-dedup-*.csv`, `slr-screening-r1-*.csv`) cũng đọc được.

API mặc định: `http://127.0.0.1:8000` (chỉnh trong popup → API endpoint).

## Biến môi trường (backend `.env`)

| Key | Bắt buộc | Mô tả |
|-----|----------|--------|
| `GEMINI_API_KEY` | Có (khi `LLM_PROVIDER=gemini`) | Key Google AI Studio |
| `OPENAI_API_KEY` | Chỉ khi dùng OpenAI | Không có key nào → PICO stub (dev) |
| `UNPAYWALL_EMAIL` | Nên có | Email Unpaywall |
| `CROSSREF_MAILTO` | Nên có | Polite pool Crossref |
| `SEMANTIC_SCHOLAR_API_KEY` | Không | Tăng rate limit |
| `SERPAPI_KEY` | Không | Google Scholar (nguồn chính hoặc fallback) |
| `IEEE_XPLORE_API_KEY` | Không | IEEE Metadata API; không có thì dùng OpenAlex/Crossref (prefix 10.1109) |

## Lưu ý

- Backend chỉ dùng `httpx.AsyncClient` (không `requests`).
- Một nguồn lỗi/timeout không dừng toàn pipeline.
- Task store in-memory: phù hợp local/extension; production nên dùng Redis/DB.
