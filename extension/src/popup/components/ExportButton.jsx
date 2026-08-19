import { Download } from "lucide-react";
import { exportPapers } from "../export.js";

const FORMATS = [
  { id: "csv", label: "CSV" },
  { id: "json", label: "JSON" },
  { id: "ris", label: "RIS" },
];

export default function ExportButton({ papers, disabled }) {
  return (
    <div className="flex items-center gap-1">
      {FORMATS.map((f) => (
        <button
          key={f.id}
          type="button"
          disabled={disabled || !papers?.length}
          onClick={() => exportPapers(papers, f.id)}
          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium
            border border-ink-200 bg-white/70 text-ink-800
            hover:bg-accent-soft hover:border-accent/40
            disabled:opacity-40 disabled:cursor-not-allowed
            transition-colors duration-150"
        >
          <Download size={11} />
          {f.label}
        </button>
      ))}
    </div>
  );
}
