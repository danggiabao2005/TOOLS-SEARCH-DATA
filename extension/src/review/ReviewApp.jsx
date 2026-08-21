import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  HelpCircle,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  DEFAULT_CRITERIA,
  USER_FILL_CODES,
  groupDuplicateClusters,
  mergeMissingDefaults,
  nextCustomCode,
  paperMetaLine,
} from "./criteria.js";
import { exportDedupCSV, exportScreeningCSV } from "../popup/export.js";
import { readSSE } from "./sse.js";
import CsvDrop from "./CsvDrop.jsx";
import {
  clusterImportedPapers,
  parseCsvFileText,
  readFileAsText,
} from "./csvImport.js";

const REVIEW_KEY = "pico_review";
const SESSION_KEY = "pico_session";
const DEFAULT_API = "http://127.0.0.1:8000";

const emptyReview = () => ({
  criteria: DEFAULT_CRITERIA.map((c) => ({ ...c })),
  phase: "criteria",
  keepByCluster: {},
  decisions: {},
  screenIndex: 0,
  aiStatus: "idle",
  aiMessage: "",
});

function loadLocal(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (data) => resolve(data[key]));
  });
}

function saveLocal(key, value) {
  return chrome.storage.local.set({ [key]: value });
}

function resolveKept(papers, keepByCluster) {
  const { duplicates, singles } = groupDuplicateClusters(papers);
  const kept = [...singles];
  const discarded = [];
  for (const g of duplicates) {
    const choice = keepByCluster[g.id];
    if (choice === "all") {
      kept.push(...g.members);
      continue;
    }
    if (choice) {
      for (const m of g.members) {
        if (m.id === choice) kept.push(m);
        else discarded.push(m);
      }
    }
  }
  return { kept, discarded, duplicates, singles };
}

function StepPill({ n, label, active, done }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-medium
        ${active ? "border-accent bg-accent text-white" : done ? "border-accent/40 bg-accent-soft text-accent" : "border-ink-200 bg-white/70 text-ink-700/70"}`}
    >
      <span className="font-mono">{n}</span>
      {label}
    </div>
  );
}

function CodeChip({ code, kind, selected, onClick }) {
  const on =
    selected
      ? kind === "IC"
        ? "bg-accent text-white border-accent"
        : "bg-red-700 text-white border-red-700"
      : kind === "IC"
        ? "bg-white text-accent border-accent/30"
        : "bg-white text-red-700 border-red-200";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2 py-1 font-mono text-[11px] ${on}`}
    >
      {code}
    </button>
  );
}

export default function ReviewApp() {
  const [papers, setPapers] = useState([]);
  const [apiBase, setApiBase] = useState(DEFAULT_API);
  const [review, setReview] = useState(emptyReview);
  const [ready, setReady] = useState(false);
  const [customKind, setCustomKind] = useState("IC");
  const [customMeaning, setCustomMeaning] = useState("");
  const [aiProgress, setAiProgress] = useState(0);
  const [importBusy, setImportBusy] = useState(false);
  const [importErr, setImportErr] = useState("");
  const aiLock = useRef(false);
  const skipReviewEcho = useRef(false);

  const persist = useCallback((patch) => {
    setReview((prev) => {
      const next = { ...prev, ...patch };
      skipReviewEcho.current = true;
      saveLocal(REVIEW_KEY, next);
      return next;
    });
  }, []);

  useEffect(() => {
    (async () => {
      const session = await loadLocal(SESSION_KEY);
      const saved = await loadLocal(REVIEW_KEY);
      setPapers(session?.papers || []);
      if (session?.apiBase) setApiBase(session.apiBase);
      if (saved?.criteria) {
        const merged = {
          ...emptyReview(),
          ...saved,
          criteria: mergeMissingDefaults(saved.criteria),
        };
        setReview(merged);
        saveLocal(REVIEW_KEY, merged);
      } else {
        setReview(emptyReview());
      }
      setReady(true);
    })();
    const onChange = (changes, area) => {
      if (area !== "local") return;
      if (changes[SESSION_KEY]?.newValue?.papers) {
        setPapers(changes[SESSION_KEY].newValue.papers);
      }
      if (changes[REVIEW_KEY]?.newValue) {
        if (skipReviewEcho.current) {
          skipReviewEcho.current = false;
          return;
        }
        const saved = changes[REVIEW_KEY].newValue;
        setReview({
          ...emptyReview(),
          ...saved,
          criteria: mergeMissingDefaults(saved.criteria),
        });
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const clusters = useMemo(() => groupDuplicateClusters(papers), [papers]);
  const resolved = useMemo(
    () => resolveKept(papers, review.keepByCluster),
    [papers, review.keepByCluster]
  );
  const unresolvedN = clusters.duplicates.filter(
    (g) => !review.keepByCluster[g.id]
  ).length;
  const screenList = resolved.kept;
  const current = screenList[review.screenIndex] || null;
  const decision = current ? review.decisions[current.id] || { verdict: "", reasons: [] } : null;
  const screenedN = screenList.filter((p) => review.decisions[p.id]?.verdict).length;

  const userFieldsFilled = review.criteria
    .filter((c) => !c.locked && USER_FILL_CODES.includes(c.code))
    .every((c) => (c.meaning || "").trim().length > 0);

  const icCodes = review.criteria.filter((c) => c.kind === "IC");
  const ecCodes = review.criteria.filter((c) => c.kind === "EC");

  const goDedup = () => persist({ phase: "dedup" });
  const goScreen = () => {
    if (resolved.kept.length > 300) {
      window.alert(
        `AI screening tối đa 300 bài (hiện giữ ${resolved.kept.length}). Hãy loại thêm bài trùng ở vòng dedup.`
      );
      return;
    }
    const { discarded } = resolveKept(papers, review.keepByCluster);
    const decisions = { ...review.decisions };
    for (const p of discarded) {
      decisions[p.id] = { verdict: "exclude", reasons: ["EC-D"], by_ai: false };
    }
    persist({
      phase: "screen",
      decisions,
      screenIndex: 0,
      aiStatus: "queued",
      aiMessage: "",
    });
  };

  const runAiScreen = useCallback(
    async (list, criteria, seedDecisions) => {
      if (aiLock.current || !list.length) return;
      aiLock.current = true;
      persist({ aiStatus: "running", aiMessage: "Đang gọi LLM…" });
      setAiProgress(0);
      const todo = list.filter((p) => seedDecisions[p.id]?.reasons?.[0] !== "EC-D");
      try {
        const res = await fetch(`${apiBase.replace(/\/$/, "")}/api/v1/screening/title-abstract`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            criteria: criteria.map((c) => ({
              code: c.code,
              kind: c.kind,
              meaning: c.meaning || "",
            })),
            papers: todo.map((p) => ({
              id: p.id,
              title: p.title,
              abstract: p.abstract || "",
              year: p.year || null,
              authors: p.authors || [],
            })),
          }),
        });
        const next = { ...seedDecisions };
        await readSSE(res, async (name, data) => {
          if (name === "status") {
            persist({ aiMessage: data.message || "AI screening…" });
            if (typeof data.progress === "number") setAiProgress(data.progress);
          } else if (name === "decision") {
            next[data.paper_id] = {
              verdict: data.verdict,
              reasons: data.reasons || [],
              by_ai: true,
              confidence_score: data.confidence_score,
            };
            persist({ decisions: { ...next } });
          } else if (name === "complete") {
            persist({
              aiStatus: "done",
              aiMessage: `AI xong: include ${data.include} · exclude ${data.exclude} · maybe ${data.maybe}`,
              decisions: { ...next },
            });
          }
        });
        persist({ aiStatus: "done" });
      } catch (err) {
        persist({
          aiStatus: "error",
          aiMessage: err.message || "AI screening lỗi",
        });
      } finally {
        aiLock.current = false;
      }
    },
    [apiBase, persist]
  );

  useEffect(() => {
    if (!ready) return;
    if (review.phase !== "screen") return;
    if (review.aiStatus !== "queued") return;
    const { kept, discarded } = resolveKept(papers, review.keepByCluster);
    const seed = { ...review.decisions };
    for (const p of discarded) {
      seed[p.id] = { verdict: "exclude", reasons: ["EC-D"], by_ai: false };
    }
    runAiScreen(kept, review.criteria, seed);
  }, [
    ready,
    review.phase,
    review.aiStatus,
    papers,
    review.keepByCluster,
    review.criteria,
    runAiScreen,
  ]);

  const setKeep = (clusterId, paperId) => {
    persist({
      keepByCluster: { ...review.keepByCluster, [clusterId]: paperId },
    });
  };

  const updateCriterion = (code, meaning) => {
    persist({
      criteria: review.criteria.map((c) =>
        c.code === code ? { ...c, meaning } : c
      ),
    });
  };

  const addCustom = () => {
    const code = nextCustomCode(review.criteria, customKind);
    persist({
      criteria: [
        ...review.criteria,
        {
          code,
          kind: customKind,
          locked: false,
          meaning: customMeaning.trim(),
        },
      ],
    });
    setCustomMeaning("");
  };

  const removeCustom = (code) => {
    persist({
      criteria: review.criteria.filter((c) => c.code !== code),
    });
  };

  const setVerdict = (verdict) => {
    if (!current) return;
    const allowedKind = verdict === "exclude" ? "EC" : verdict === "include" ? "IC" : null;
    let reasons = decision.reasons || [];
    if (allowedKind) {
      reasons = reasons.filter((code) => {
        const row = review.criteria.find((c) => c.code === code);
        return row?.kind === allowedKind;
      });
    }
    persist({
      decisions: {
        ...review.decisions,
        [current.id]: { verdict, reasons, by_ai: false },
      },
    });
  };

  const toggleReason = (code) => {
    if (!current) return;
    const reasons = new Set(decision.reasons || []);
    if (reasons.has(code)) reasons.delete(code);
    else reasons.add(code);
    persist({
      decisions: {
        ...review.decisions,
        [current.id]: { verdict: decision.verdict || "", reasons: [...reasons], by_ai: false },
      },
    });
  };

  const canSaveCurrent =
    decision &&
    ((decision.verdict === "include" && (decision.reasons || []).some((c) => icCodes.find((x) => x.code === c))) ||
      (decision.verdict === "exclude" && (decision.reasons || []).some((c) => ecCodes.find((x) => x.code === c))) ||
      decision.verdict === "maybe");

  const jump = (delta) => {
    const next = Math.min(
      screenList.length - 1,
      Math.max(0, review.screenIndex + delta)
    );
    persist({ screenIndex: next });
  };

  const handleCsvFile = async (file) => {
    setImportErr("");
    if (
      papers.length &&
      !window.confirm(
        `Thay ${papers.length} bài hiện có bằng CSV mới và làm lại từ vòng tiêu chí?`
      )
    ) {
      return;
    }
    setImportBusy(true);
    try {
      const text = await readFileAsText(file);
      const { papers: parsed } = parseCsvFileText(text);
      const clustered = await clusterImportedPapers(parsed, apiBase);
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
      setPapers(clustered);
    } catch (err) {
      setImportErr(err?.message || String(err));
    } finally {
      setImportBusy(false);
    }
  };

  if (!ready) {
    return <p className="p-8 text-sm text-ink-700/60">Đang tải…</p>;
  }

  if (!papers.length) {
    return (
      <div className="mx-auto max-w-xl px-6 py-16">
        <h1 className="text-center font-display text-2xl font-bold">Vòng screening</h1>
        <p className="mt-3 text-center text-sm text-ink-700/70">
          Quét từ popup, hoặc bỏ file CSV vào để làm tiêu chí → dedup → AI screening.
        </p>
        <div className="mt-6">
          <CsvDrop onFile={handleCsvFile} busy={importBusy} error={importErr} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-ink-200/80 bg-white/80 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-5 py-3">
          <div>
            <p className="font-display text-xl font-bold leading-none">SLR Screening</p>
            <p className="mt-1 text-[11px] text-ink-700/60">
              {papers.length} bài · Title / Abstract
            </p>
          </div>
          <div className="flex min-w-[220px] max-w-sm flex-col gap-1.5">
            <CsvDrop
              compact
              onFile={handleCsvFile}
              busy={importBusy}
              error={importErr}
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <StepPill n="1" label="Tiêu chí" active={review.phase === "criteria"} done={review.phase !== "criteria"} />
            <StepPill n="2" label="Dedup" active={review.phase === "dedup"} done={review.phase === "screen" || review.phase === "done"} />
            <StepPill n="3" label="Screen" active={review.phase === "screen" || review.phase === "done"} done={review.phase === "done"} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-5">
        {review.phase === "criteria" && (
          <section className="space-y-4">
            <p className="text-sm text-ink-700/80">
              Mã mặc định đã khóa. Điền IC-P, IC-I, IC-C, EC-O, EC-W. Sau dedup, AI tự Include/Exclude/Maybe theo mã.
            </p>
            <div className="overflow-hidden rounded border border-ink-200 bg-white/80">
              <table className="w-full text-left text-[12px]">
                <thead className="bg-ink-50 text-[10px] uppercase tracking-wide text-ink-700/60">
                  <tr>
                    <th className="px-3 py-2 w-24">Mã</th>
                    <th className="px-3 py-2">Ý nghĩa</th>
                    <th className="px-3 py-2 w-16" />
                  </tr>
                </thead>
                <tbody>
                  {review.criteria.map((row) => (
                    <tr key={row.code} className="border-t border-ink-100">
                      <td className="px-3 py-2 font-mono font-medium">
                        <span className={row.kind === "IC" ? "text-accent" : "text-red-700"}>
                          {row.code}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {row.locked ? (
                          row.meaning
                        ) : (
                          <textarea
                            value={row.meaning}
                            placeholder={row.placeholder || ""}
                            onChange={(e) => updateCriterion(row.code, e.target.value)}
                            rows={2}
                            className="w-full rounded border border-ink-200 px-2 py-1 text-[12px] outline-none focus:border-accent"
                          />
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {!row.locked && /^\w+-\d+$/.test(row.code) && (
                          <button
                            type="button"
                            onClick={() => removeCustom(row.code)}
                            className="text-red-600 hover:underline"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-end gap-2 rounded border border-ink-200 bg-white/70 p-3">
              <label className="text-[11px] text-ink-700/70">
                Loại
                <select
                  value={customKind}
                  onChange={(e) => setCustomKind(e.target.value)}
                  className="mt-0.5 block rounded border border-ink-200 px-2 py-1.5 text-[12px]"
                >
                  <option value="IC">IC (include)</option>
                  <option value="EC">EC (exclude)</option>
                </select>
              </label>
              <label className="flex-1 min-w-[200px] text-[11px] text-ink-700/70">
                Ý nghĩa mã mới ({nextCustomCode(review.criteria, customKind)})
                <input
                  value={customMeaning}
                  onChange={(e) => setCustomMeaning(e.target.value)}
                  className="mt-0.5 w-full rounded border border-ink-200 px-2 py-1.5 text-[12px]"
                  placeholder="Mô tả tiêu chí…"
                />
              </label>
              <button
                type="button"
                onClick={addCustom}
                disabled={!customMeaning.trim()}
                className="inline-flex items-center gap-1 rounded bg-ink-800 px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
              >
                <Plus size={14} /> Thêm
              </button>
            </div>

            {!userFieldsFilled && (
              <p className="text-[12px] text-amber-800">
                Hãy điền IC-P, IC-I, IC-C, EC-O và EC-W trước khi sang bước dedup.
              </p>
            )}
            <button
              type="button"
              disabled={!userFieldsFilled}
              onClick={goDedup}
              className="rounded bg-accent px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
            >
              Tiếp: duyệt trùng (dedup)
            </button>
          </section>
        )}

        {review.phase === "dedup" && (
          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-ink-700/80">
                {clusters.duplicates.length} nhóm trùng · {clusters.singles.length} bài không trùng (giữ tự động).
                Chọn 1 bài để giữ; bài bỏ đi sẽ gắn <span className="font-mono">EC-D</span>.
              </p>
              <button
                type="button"
                onClick={() =>
                  exportDedupCSV(papers, {
                    keptIds: resolved.kept.map((p) => p.id),
                    discardedIds: resolved.discarded.map((p) => p.id),
                  })
                }
                className="inline-flex items-center gap-1 rounded border border-ink-200 bg-white px-2.5 py-1.5 text-[12px] font-medium hover:bg-accent-soft"
              >
                <Download size={14} /> CSV sau dedup
              </button>
            </div>

            {clusters.duplicates.length === 0 && (
              <p className="rounded border border-ink-200 bg-white/80 px-3 py-3 text-sm text-ink-700/70">
                Không phát hiện nhóm trùng. Có thể sang vòng screening.
              </p>
            )}

            {clusters.duplicates.map((g) => (
              <article key={g.id} className="rounded border border-ink-200 bg-white/85 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="font-mono text-[11px] text-ink-700/60">
                    {g.id} · khớp {g.reason || "?"} · {g.members.length} bản
                  </p>
                  <button
                    type="button"
                    onClick={() => setKeep(g.id, "all")}
                    className={`text-[11px] underline ${review.keepByCluster[g.id] === "all" ? "text-accent" : "text-ink-700/50"}`}
                  >
                    Giữ tất cả (không trùng)
                  </button>
                </div>
                <div className="space-y-2">
                  {g.members.map((p) => {
                    const on = review.keepByCluster[g.id] === p.id;
                    return (
                      <label
                        key={p.id}
                        className={`block cursor-pointer rounded border p-2.5 ${on ? "border-accent bg-accent-soft/60" : "border-ink-100 hover:bg-ink-50"}`}
                      >
                        <div className="flex items-start gap-2">
                          <input
                            type="radio"
                            name={g.id}
                            checked={on}
                            onChange={() => setKeep(g.id, p.id)}
                            className="mt-1"
                          />
                          <div className="min-w-0">
                            <p className="font-display text-[13px] font-semibold">{p.title}</p>
                            <p className="text-[11px] text-ink-700/60">{paperMetaLine(p)}</p>
                            <p className="mt-1 font-mono text-[10px] uppercase text-ink-700/45">
                              {(p.sources || [p.source]).join(" + ")}
                              {p.doi ? ` · ${p.doi}` : ""}
                            </p>
                            {p.abstract && (
                              <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-ink-700/80">
                                {p.abstract}
                              </p>
                            )}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </article>
            ))}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => persist({ phase: "criteria" })}
                className="rounded border border-ink-200 bg-white px-3 py-2 text-[12px]"
              >
                ← Tiêu chí
              </button>
              <button
                type="button"
                disabled={unresolvedN > 0}
                onClick={goScreen}
                className="rounded bg-accent px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
              >
                {unresolvedN > 0
                  ? `Còn ${unresolvedN} nhóm chưa chọn`
                  : `AI screening (${resolved.kept.length} bài)`}
              </button>
            </div>
          </section>
        )}

        {(review.phase === "screen" || review.phase === "done") && (
          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-ink-700/70">
                {review.aiStatus === "running" && (review.aiMessage || "AI đang screening…")}
                {review.aiStatus === "done" && (review.aiMessage || "AI đã xong — có thể sửa tay nếu cần.")}
                {review.aiStatus === "error" && (review.aiMessage || "AI lỗi")}
                {review.aiStatus === "queued" && "Chuẩn bị AI screening…"}
                {review.aiStatus === "idle" && `${screenedN}/${screenList.length} bài đã có quyết định`}
              </p>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={review.aiStatus === "running" || !screenList.length}
                  onClick={() => persist({ aiStatus: "queued", aiMessage: "" })}
                  className="inline-flex items-center gap-1 rounded border border-ink-200 bg-white px-2.5 py-1.5 text-[12px] font-medium hover:bg-accent-soft disabled:opacity-40"
                >
                  {review.aiStatus === "running" ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Sparkles size={14} />
                  )}
                  {review.aiStatus === "running" ? "Đang chạy…" : "Chạy lại AI"}
                </button>
                <button
                  type="button"
                  onClick={() => exportScreeningCSV(screenList, review.decisions)}
                  className="inline-flex items-center gap-1 rounded border border-ink-200 bg-white px-2.5 py-1.5 text-[12px] font-medium hover:bg-accent-soft"
                >
                  <Download size={14} /> CSV screening
                </button>
              </div>
            </div>

            {review.aiStatus === "running" && (
              <div className="h-1.5 overflow-hidden rounded bg-ink-100">
                <div
                  className="h-full bg-accent transition-all"
                  style={{ width: `${Math.round(aiProgress * 100)}%` }}
                />
              </div>
            )}

            <div className="overflow-hidden rounded border border-ink-200 bg-white/85">
              <table className="w-full text-left text-[12px]">
                <thead className="bg-ink-50 text-[10px] uppercase tracking-wide text-ink-700/60">
                  <tr>
                    <th className="px-3 py-2 w-24">Verdict</th>
                    <th className="px-3 py-2 w-40">Mã</th>
                    <th className="px-3 py-2">Title</th>
                  </tr>
                </thead>
                <tbody>
                  {screenList.map((p, idx) => {
                    const d = review.decisions[p.id] || {};
                    const tone =
                      d.verdict === "include"
                        ? "text-accent"
                        : d.verdict === "exclude"
                          ? "text-red-700"
                          : d.verdict === "maybe"
                            ? "text-amber-700"
                            : "text-ink-700/40";
                    const on = idx === review.screenIndex;
                    return (
                      <tr
                        key={p.id}
                        onClick={() => persist({ screenIndex: idx })}
                        className={`cursor-pointer border-t border-ink-100 ${on ? "bg-accent-soft/50" : "hover:bg-ink-50"}`}
                      >
                        <td className={`px-3 py-2 font-semibold capitalize ${tone}`}>
                          {d.verdict || "…"}
                          {d.by_ai ? (
                            <span className="ml-1 font-normal text-[9px] text-ink-700/40">AI</span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 font-mono text-[11px]">
                          {(d.reasons || []).join(", ") || "—"}
                        </td>
                        <td className="px-3 py-2">{p.title}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {current && (
              <>
                <article className="rounded border border-ink-200 bg-white/90 p-4">
                  <h2 className="font-display text-[18px] font-bold leading-snug">{current.title}</h2>
                  <p className="mt-1 text-[12px] text-ink-700/65">{paperMetaLine(current)}</p>
                  <p className="mt-3 text-[13px] leading-relaxed text-ink-800">
                    {current.abstract || "(Không có abstract — AI quyết theo title.)"}
                  </p>
                </article>

                <p className="text-[11px] text-ink-700/55">
                  AI đã gán verdict. Sửa tay nếu cần, rồi xuất CSV.
                </p>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setVerdict("include")}
                    className={`inline-flex items-center gap-1 rounded border px-3 py-2 text-[12px] font-semibold ${decision?.verdict === "include" ? "border-accent bg-accent text-white" : "border-ink-200 bg-white"}`}
                  >
                    <Check size={14} /> Include
                  </button>
                  <button
                    type="button"
                    onClick={() => setVerdict("exclude")}
                    className={`inline-flex items-center gap-1 rounded border px-3 py-2 text-[12px] font-semibold ${decision?.verdict === "exclude" ? "border-red-700 bg-red-700 text-white" : "border-ink-200 bg-white"}`}
                  >
                    <X size={14} /> Exclude
                  </button>
                  <button
                    type="button"
                    onClick={() => setVerdict("maybe")}
                    className={`inline-flex items-center gap-1 rounded border px-3 py-2 text-[12px] font-semibold ${decision?.verdict === "maybe" ? "border-amber-600 bg-amber-500 text-white" : "border-ink-200 bg-white"}`}
                  >
                    <HelpCircle size={14} /> Maybe
                  </button>
                </div>

                <div>
                  <p className="mb-1.5 text-[11px] font-medium text-ink-700/70">Reason (chỉ mã)</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(decision?.verdict === "exclude"
                      ? ecCodes
                      : decision?.verdict === "include"
                        ? icCodes
                        : review.criteria
                    ).map((row) => (
                      <CodeChip
                        key={row.code}
                        code={row.code}
                        kind={row.kind}
                        selected={(decision?.reasons || []).includes(row.code)}
                        onClick={() => toggleReason(row.code)}
                      />
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => persist({ phase: "dedup" })}
                    className="rounded border border-ink-200 bg-white px-3 py-2 text-[12px]"
                  >
                    ← Dedup
                  </button>
                  <button
                    type="button"
                    disabled={review.screenIndex === 0}
                    onClick={() => jump(-1)}
                    className="inline-flex items-center gap-1 rounded border border-ink-200 bg-white px-3 py-2 text-[12px] disabled:opacity-40"
                  >
                    <ChevronLeft size={14} /> Trước
                  </button>
                  <button
                    type="button"
                    disabled={review.screenIndex >= screenList.length - 1}
                    onClick={() => jump(1)}
                    className="inline-flex items-center gap-1 rounded bg-accent px-3 py-2 text-[12px] font-semibold text-white disabled:opacity-40"
                  >
                    Tiếp <ChevronRight size={14} />
                  </button>
                </div>
              </>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
