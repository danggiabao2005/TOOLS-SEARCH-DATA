import { useRef, useState } from "react";
import { FileSpreadsheet, Loader2 } from "lucide-react";

export default function CsvDrop({ onFile, busy, compact = false, error = "" }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);

  const take = (files) => {
    const file = files?.[0];
    if (!file || busy) return;
    onFile(file);
  };

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          take(e.dataTransfer.files);
        }}
        className={`w-full rounded border-2 border-dashed text-left transition
          ${over ? "border-accent bg-accent-soft" : "border-ink-200 bg-white/80 hover:border-accent/50"}
          ${compact ? "px-3 py-2" : "px-4 py-8"}
          disabled:opacity-50`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv,text/plain"
          className="hidden"
          onChange={(e) => {
            take(e.target.files);
            e.target.value = "";
          }}
        />
        <div className={`flex items-center gap-2 ${compact ? "" : "flex-col text-center"}`}>
          {busy ? (
            <Loader2 size={compact ? 16 : 28} className="animate-spin text-accent" />
          ) : (
            <FileSpreadsheet size={compact ? 16 : 28} className="text-accent" />
          )}
          <div>
            <p className={`font-medium ${compact ? "text-[12px]" : "text-sm"}`}>
              {busy ? "Đang nhập CSV…" : "Kéo thả file CSV vào đây, hoặc bấm để chọn"}
            </p>
            {!compact && (
              <p className="mt-1 text-[11px] text-ink-700/60">
                Cần cột title (authors, year, doi, abstract, url). Sau đó làm vòng tiêu chí →
                dedup → AI screening.
              </p>
            )}
          </div>
        </div>
      </button>
      {error ? <p className="mt-1.5 text-[12px] text-red-700">{error}</p> : null}
    </div>
  );
}
