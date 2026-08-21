import { useCallback, useEffect, useRef, useState } from "react";
import {
  Search,
  Loader2,
  Square,
  RotateCcw,
  FlaskConical,
  AlertCircle,
  CheckCircle2,
  ClipboardList,
  FileSpreadsheet,
} from "lucide-react";
import PaperCard from "./components/PaperCard.jsx";
import ExportButton from "./components/ExportButton.jsx";
import {
  clusterImportedPapers,
  parseCsvFileText,
  readFileAsText,
} from "../review/csvImport.js";

const ALL_SOURCES = [
  { id: "ieee_xplore", label: "IEEE Xplore", hint: "SE conference: ICSE, TSE, ASE" },
  { id: "acm_dl", label: "ACM DL", hint: "SE: ISSTA, FSE, ESEC" },
  {
    id: "semantic_scholar",
    label: "Semantic Scholar",
    hint: "AI/ML papers, miễn phí",
  },
  {
    id: "google_scholar",
    label: "Google Scholar",
    hint: "SerpAPI GET /search.json?engine=google_scholar (cần SERPAPI_KEY)",
  },
  { id: "openalex", label: "OpenAlex", hint: "Hoàn toàn mở, bulk export" },
  { id: "pubmed", label: "PubMed" },
  { id: "arxiv", label: "arXiv" },
  { id: "crossref", label: "Crossref" },
];

const DEFAULT_API = "http://127.0.0.1:8000";
const FETCH_ALL_CAP = 10000;

function hydrateFormFromRequest(req, setters, { restoreSources = false } = {}) {
  if (!req) return;
  if (req.keywords) setters.setKeywords(req.keywords);
  const yMin = req.yearMin ?? req.year_min;
  const yMax = req.yearMax ?? req.year_max;
  setters.setYearMin(yMin != null && yMin !== "" ? String(yMin) : "");
  setters.setYearMax(yMax != null && yMax !== "" ? String(yMax) : "");
  if (req.limit && !req.fetchAll && !req.fetch_all) {
    setters.setLimit(req.limit);
  }
  if (typeof req.fetchAll === "boolean") {
    setters.setFetchAll(req.fetchAll);
  } else if (typeof req.fetch_all === "boolean") {
    setters.setFetchAll(req.fetch_all);
  }
  if (restoreSources && Array.isArray(req.sources) && req.sources.length) {
    setters.setSources(req.sources);
  }
}

function StatusBanner({ status, message, error }) {
  if (status === "idle" && !message) return null;

  const tone =
    status === "error"
      ? "border-red-300/60 bg-red-50 text-red-800"
      : status === "completed"
        ? "border-accent/30 bg-accent-soft text-accent"
        : status === "streaming"
          ? "border-ink-200 bg-white/80 text-ink-800"
          : "border-ink-200 bg-white/60 text-ink-700";

  const Icon =
    status === "error"
      ? AlertCircle
      : status === "completed"
        ? CheckCircle2
        : status === "streaming"
          ? Loader2
          : FlaskConical;

  return (
    <div className={`mx-3 mt-2 flex items-start gap-2 rounded border px-2.5 py-2 text-[11px] ${tone}`}>
      <Icon
        size={14}
        className={`mt-0.5 shrink-0 ${status === "streaming" ? "animate-spin" : ""}`}
      />
      <span className="leading-snug">{error || message}</span>
    </div>
  );
}

export default function App() {
  const [keywords, setKeywords] = useState("");
  const [yearMin, setYearMin] = useState("");
  const [yearMax, setYearMax] = useState("");
  const [limit, setLimit] = useState(15);
  const [fetchAll, setFetchAll] = useState(true);
  const [sources, setSources] = useState([]);
  const [apiBase, setApiBase] = useState(DEFAULT_API);

  const [session, setSession] = useState({
    status: "idle",
    message: "",
    papers: [],
    error: null,
  });
  const csvInputRef = useRef(null);
  const [importBusy, setImportBusy] = useState(false);

  const refreshSession = useCallback(() => {
    chrome.runtime.sendMessage({ type: "GET_SESSION" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res?.ok && res.session) {
        setSession(res.session);
        if (res.session.apiBase) setApiBase(res.session.apiBase);
        hydrateFormFromRequest(res.session.request, {
          setKeywords,
          setYearMin,
          setYearMax,
          setLimit,
          setFetchAll,
          setSources,
        }, { restoreSources: true });
      }
    });
  }, []);

  useEffect(() => {
    refreshSession();
    chrome.runtime.sendMessage(
      { type: "CHECK_HEALTH", apiBase: apiBase.trim() || DEFAULT_API },
      (res) => {
        if (chrome.runtime.lastError || res?.ok) return;
        setSession((prev) => {
          if (prev.status === "streaming") return prev;
          return {
            ...prev,
            status: "error",
            message: res?.error || "Không kết nối được backend.",
            error: res?.error || "Không kết nối được backend.",
          };
        });
      }
    );
    const onMessage = (msg) => {
      if (msg.type === "SESSION_UPDATED" && msg.session) {
        setSession(msg.session);
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [refreshSession, apiBase]);

  const toggleSource = (id) => {
    setSources((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  };

  const isStreaming = session.status === "streaming";

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!keywords.trim() || !sources.length || isStreaming) return;
    chrome.runtime.sendMessage({
      type: "START_SEARCH",
      payload: {
        keywords: keywords.trim(),
        yearMin: yearMin ? Number(yearMin) : null,
        yearMax: yearMax ? Number(yearMax) : null,
        sources,
        limit: fetchAll ? FETCH_ALL_CAP : Number(limit) || 15,
        fetchAll,
        apiBase: apiBase.trim() || DEFAULT_API,
      },
    }, () => {
      void chrome.runtime.lastError;
    });
  };

  const handleCancel = () => {
    chrome.runtime.sendMessage({ type: "CANCEL_SEARCH" }, () => {
      void chrome.runtime.lastError;
    });
  };

  const handleClear = () => {
    const clear = () => {
      chrome.runtime.sendMessage({ type: "CLEAR_RESULTS" }, () => {
        if (chrome.runtime.lastError) return;
        refreshSession();
      });
    };
    if (isStreaming) {
      chrome.runtime.sendMessage({ type: "CANCEL_SEARCH" }, () => {
        void chrome.runtime.lastError;
        clear();
      });
      return;
    }
    clear();
  };

  const handleOpenReview = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("review.html") });
  };

  const handleImportCsv = async (file) => {
    if (!file || isStreaming || importBusy) return;
    const existing = session.papers?.length || 0;
    if (
      existing &&
      !window.confirm(`Thay ${existing} bài hiện có bằng CSV và mở các vòng screening?`)
    ) {
      return;
    }
    setImportBusy(true);
    try {
      const text = await readFileAsText(file);
      const { papers: parsed } = parseCsvFileText(text);
      const clustered = await clusterImportedPapers(parsed, apiBase.trim() || DEFAULT_API);
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: "IMPORT_PAPERS", papers: clustered }, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!res?.ok) {
            reject(new Error(res?.error || "Không lưu được CSV."));
            return;
          }
          resolve(res);
        });
      });
      chrome.tabs.create({ url: chrome.runtime.getURL("review.html") });
    } catch (err) {
      setSession((prev) => ({
        ...prev,
        status: "error",
        error: err?.message || String(err),
        message: err?.message || String(err),
      }));
    } finally {
      setImportBusy(false);
    }
  };

  const papers = session.papers || [];

  return (
    <div className="flex h-[600px] flex-col">
      <header className="relative overflow-hidden px-4 pt-4 pb-3">
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg width='40' height='40' viewBox='0 0 40 40' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='%231a6b5c' fill-opacity='0.06' fill-rule='evenodd'%3E%3Cpath d='M0 40L40 0H20L0 20M40 40V20L20 40'/%3E%3C/g%3E%3C/svg%3E\")",
          }}
        />
        <div className="relative">
          <p className="font-display text-[20px] font-bold tracking-tight text-ink-900 leading-none">
            PICO Extractor
          </p>
          <p className="mt-1 text-[11px] text-ink-700/70">
            Tìm kiếm đa nguồn · Dedup · Screening · PICO
          </p>
        </div>
      </header>

      <form onSubmit={handleSubmit} className="px-3 space-y-2.5 shrink-0">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-700/40"
          />
          <input
            type="text"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="Keywords / câu hỏi nghiên cứu..."
            disabled={isStreaming}
            className="w-full rounded border border-ink-200 bg-white/90 py-2 pl-8 pr-3 text-[13px]
              outline-none focus:border-accent focus:ring-1 focus:ring-accent/30
              disabled:opacity-60 placeholder:text-ink-700/35"
          />
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <label className="text-[10px] text-ink-700/60">
            Năm từ
            <input
              type="number"
              value={yearMin}
              onChange={(e) => setYearMin(e.target.value)}
              disabled={isStreaming}
              placeholder="yyyy"
              className="mt-0.5 w-full rounded border border-ink-200 bg-white/90 px-2 py-1.5 text-[12px] outline-none focus:border-accent disabled:opacity-60"
            />
          </label>
          <label className="text-[10px] text-ink-700/60">
            Năm đến
            <input
              type="number"
              value={yearMax}
              onChange={(e) => setYearMax(e.target.value)}
              disabled={isStreaming}
              placeholder="yyyy"
              className="mt-0.5 w-full rounded border border-ink-200 bg-white/90 px-2 py-1.5 text-[12px] outline-none focus:border-accent disabled:opacity-60"
            />
          </label>
          <label className="text-[10px] text-ink-700/60">
            {fetchAll ? "Trần / nguồn" : "Limit / nguồn"}
            <input
              type="number"
              min={1}
              max={FETCH_ALL_CAP}
              value={fetchAll ? FETCH_ALL_CAP : limit}
              onChange={(e) => setLimit(e.target.value)}
              disabled={isStreaming || fetchAll}
              className="mt-0.5 w-full rounded border border-ink-200 bg-white/90 px-2 py-1.5 text-[12px] outline-none focus:border-accent disabled:opacity-60"
            />
          </label>
        </div>

        <label className="flex items-start gap-2 text-[11px] text-ink-700/80">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={fetchAll}
            disabled={isStreaming}
            onChange={(e) => setFetchAll(e.target.checked)}
          />
          <span>
            Lấy hết bài liên quan (không giới hạn thực tế; trần an toàn {FETCH_ALL_CAP.toLocaleString("vi-VN")}/nguồn).
            Google Scholar tối đa ~100. PICO vẫn chạy từng bài nên vài trăm bài sẽ lâu.
          </span>
        </label>

        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] font-medium text-ink-700/70">
            Nguồn (bắt buộc chọn ít nhất 1)
          </p>
          <div className="flex gap-1">
            <button
              type="button"
              disabled={isStreaming}
              onClick={() => setSources(ALL_SOURCES.map((s) => s.id))}
              className="rounded border border-ink-200 bg-white/80 px-1.5 py-0.5 text-[10px] text-ink-700 hover:bg-ink-100 disabled:opacity-50"
            >
              Tất cả
            </button>
            <button
              type="button"
              disabled={isStreaming}
              onClick={() => setSources([])}
              className="rounded border border-ink-200 bg-white/80 px-1.5 py-0.5 text-[10px] text-ink-700 hover:bg-ink-100 disabled:opacity-50"
            >
              Bỏ chọn
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {ALL_SOURCES.map((s) => {
            const on = sources.includes(s.id);
            return (
              <button
                key={s.id}
                type="button"
                disabled={isStreaming}
                onClick={() => toggleSource(s.id)}
                title={s.hint}
                className={`px-2 py-1 text-[10px] font-medium border transition-colors duration-150
                  ${on ? "bg-ink-800 text-ink-50 border-ink-800" : "bg-white/70 text-ink-700 border-ink-200"}
                  disabled:opacity-50`}
              >
                {s.label}
              </button>
            );
          })}
        </div>

        <details className="text-[10px] text-ink-700/50">
          <summary className="cursor-pointer select-none">API endpoint</summary>
          <input
            type="text"
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            disabled={isStreaming}
            className="mt-1 w-full rounded border border-ink-200 bg-white/90 px-2 py-1 font-mono text-[11px] outline-none focus:border-accent"
          />
        </details>

        <div className="flex items-center gap-2">
          {!isStreaming ? (
            <button
              type="submit"
              disabled={!keywords.trim() || !sources.length}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded bg-accent py-2 text-[12px] font-semibold text-white
                hover:bg-ink-800 disabled:opacity-40 transition-colors duration-150"
            >
              <FlaskConical size={14} />
              Bắt đầu quét PICO
            </button>
          ) : (
            <button
              type="button"
              onClick={handleCancel}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded border border-red-300 bg-red-50 py-2 text-[12px] font-semibold text-red-700
                hover:bg-red-100 transition-colors duration-150"
            >
              <Square size={12} fill="currentColor" />
              Hủy tác vụ
            </button>
          )}
          <button
            type="button"
            onClick={handleClear}
            title="Xóa kết quả / bỏ trạng thái kẹt"
            className="rounded border border-ink-200 bg-white/80 p-2 text-ink-700 hover:bg-ink-100"
          >
            <RotateCcw size={14} />
          </button>
        </div>
        {(!keywords.trim() || !sources.length) && !isStreaming && (
          <p className="text-[10px] text-ink-700/50">
            {!keywords.trim() && !sources.length
              ? "Nhập keywords và chọn ít nhất 1 nguồn (hoặc bấm Tất cả)."
              : !keywords.trim()
                ? "Nhập keywords để bắt đầu quét."
                : "Chọn ít nhất 1 nguồn — bấm Tất cả nếu chưa chọn."}
          </p>
        )}
      </form>

      <StatusBanner
        status={session.status}
        message={session.message}
        error={session.error}
      />

      <div className="mt-2 flex items-center justify-between px-3 shrink-0">
        <p className="text-[11px] text-ink-700/60">
          {papers.length > 0 ? `${papers.length} bài báo` : "Chưa có kết quả"}
        </p>
        <div className="flex items-center gap-1">
          <input
            ref={csvInputRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) handleImportCsv(file);
            }}
          />
          <button
            type="button"
            disabled={isStreaming || importBusy}
            onClick={() => csvInputRef.current?.click()}
            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium
              border border-ink-200 bg-white/70 text-ink-800
              hover:bg-accent-soft hover:border-accent/40
              disabled:opacity-40 disabled:cursor-not-allowed"
            title="Nhập CSV rồi làm các vòng screening"
          >
            {importBusy ? <Loader2 size={11} className="animate-spin" /> : <FileSpreadsheet size={11} />}
            {importBusy ? "Đang nhập…" : "Nhập CSV"}
          </button>
          <button
            type="button"
            disabled={!papers.length || isStreaming}
            onClick={handleOpenReview}
            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium
              border border-ink-200 bg-white/70 text-ink-800
              hover:bg-accent-soft hover:border-accent/40
              disabled:opacity-40 disabled:cursor-not-allowed"
            title="Dedup thủ công + screening title/abstract"
          >
            <ClipboardList size={11} />
            Screening
          </button>
          <ExportButton
            papers={papers}
            disabled={session.status === "streaming" && papers.length === 0}
          />
        </div>
      </div>

      <div className="mt-1 flex-1 overflow-y-auto scrollbar-thin mx-3 mb-3 rounded border border-ink-200/80 bg-white/70 shadow-panel">
        {papers.length === 0 ? (
          <div className="flex h-full min-h-[120px] items-center justify-center px-6 text-center">
            <p className="text-[12px] text-ink-700/45 leading-relaxed">
              Quét theo keywords, hoặc bấm <span className="font-medium text-ink-700/70">Nhập CSV</span> rồi làm các vòng screening.
            </p>
          </div>
        ) : (
          papers.map((paper) => <PaperCard key={paper.id} paper={paper} />)
        )}
      </div>
    </div>
  );
}
