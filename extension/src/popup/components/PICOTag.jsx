import { Tag } from "lucide-react";

const STYLES = {
  P: "bg-pico-p/15 text-pico-p border-pico-p/30",
  I: "bg-pico-i/15 text-pico-i border-pico-i/30",
  C: "bg-pico-c/15 text-pico-c border-pico-c/30",
  O: "bg-pico-o/15 text-pico-o border-pico-o/30",
};

export default function PICOTag({ type, children }) {
  return (
    <span
      className={`inline-flex items-start gap-1.5 rounded border px-2 py-1 text-[11px] leading-snug ${STYLES[type] || ""}`}
    >
      <span className="mt-0.5 inline-flex items-center gap-0.5 font-mono font-medium shrink-0">
        <Tag size={10} strokeWidth={2.5} />
        {type}
      </span>
      <span className="text-ink-800">{children}</span>
    </span>
  );
}
