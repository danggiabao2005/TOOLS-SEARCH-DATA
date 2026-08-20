import { useState } from "react";
import { ChevronDown, ExternalLink, BookOpen } from "lucide-react";
import PICOTag from "./PICOTag.jsx";

export default function PaperCard({ paper }) {
  const [open, setOpen] = useState(false);
  const pico = paper.pico;
  const sources = paper.sources?.length ? paper.sources : [paper.source];

  return (
    <article className="border-b border-ink-200/80 last:border-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-3 py-2.5 hover:bg-ink-50/80 transition-colors"
      >
        <div className="flex items-start gap-2">
          <ChevronDown
            size={16}
            className={`mt-0.5 shrink-0 text-ink-700 transition-transform duration-200 ${open ? "rotate-0" : "-rotate-90"}`}
          />
          <div className="min-w-0 flex-1">
            <h3 className="font-display text-[13px] font-semibold leading-snug text-ink-900">
              {paper.title}
            </h3>
            <p className="mt-0.5 text-[11px] text-ink-700/70 truncate">
              {(paper.authors || []).slice(0, 3).join(", ")}
              {(paper.authors || []).length > 3 ? " et al." : ""}
              {paper.year ? ` · ${paper.year}` : ""}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {pico?.paper_type && (
                <span className="font-mono text-[9px] px-1.5 py-0.5 bg-accent text-white">
                  {pico.paper_type}
                </span>
              )}
              {sources.map((s) => (
                <span
                  key={s}
                  className="font-mono text-[9px] uppercase tracking-wide px-1.5 py-0.5 bg-ink-100 text-ink-700"
                >
                  {s}
                </span>
              ))}
              {pico?.study_type && pico.study_type !== "N/A" && (
                <span className="font-mono text-[9px] px-1.5 py-0.5 bg-accent-soft text-accent">
                  {pico.study_type}
                </span>
              )}
              {typeof pico?.confidence_score === "number" && (
                <span className="font-mono text-[9px] px-1.5 py-0.5 text-ink-700/60">
                  conf {pico.confidence_score.toFixed(2)}
                </span>
              )}
            </div>
          </div>
        </div>
      </button>

      <div
        className={`grid transition-[grid-template-rows] duration-250 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="overflow-hidden">
          <div className="px-3 pb-3 pl-8 space-y-2">
            {pico ? (
              <div className="flex flex-col gap-1.5">
                <PICOTag type="P">{pico.population}</PICOTag>
                <PICOTag type="I">{pico.intervention}</PICOTag>
                <PICOTag type="C">{pico.comparison || "N/A"}</PICOTag>
                <PICOTag type="O">
                  {(pico.outcomes || []).join(" · ") || "N/A"}
                </PICOTag>
              </div>
            ) : (
              <p className="text-[11px] text-ink-700/60 italic">
                {paper.extraction_error || "Chưa có PICO."}
              </p>
            )}

            {paper.abstract && (
              <p className="text-[11px] leading-relaxed text-ink-700/80 line-clamp-4">
                <BookOpen size={11} className="inline mr-1 opacity-60" />
                {paper.abstract}
              </p>
            )}

            <div className="flex items-center gap-3 text-[11px]">
              {paper.doi && (
                <span className="font-mono text-ink-700/50 truncate">
                  DOI: {paper.doi}
                </span>
              )}
              {paper.url && (
                <a
                  href={paper.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-accent hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink size={11} />
                  Mở bài
                </a>
              )}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
