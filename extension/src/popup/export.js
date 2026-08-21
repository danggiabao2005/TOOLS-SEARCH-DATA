/**
 * Export papers to CSV / JSON / RIS formats and trigger Chrome downloads.
 */

function escapeCsv(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function picoFields(paper) {
  const p = paper.pico || {};
  return {
    paper_type: p.paper_type || "",
    population: p.population || "",
    intervention: p.intervention || "",
    comparison: p.comparison || "",
    outcomes: Array.isArray(p.outcomes) ? p.outcomes.join("; ") : "",
    study_type: p.study_type || "",
    confidence_score: p.confidence_score ?? "",
  };
}

export function toCSV(papers) {
  const headers = [
    "title",
    "authors",
    "year",
    "paper_type",
    "doi",
    "source",
    "url",
    "population",
    "intervention",
    "comparison",
    "outcomes",
    "study_type",
    "confidence_score",
    "abstract",
  ];
  const rows = papers.map((paper) => {
    const pico = picoFields(paper);
    return [
      paper.title,
      (paper.authors || []).join("; "),
      paper.year ?? "",
      pico.paper_type,
      paper.doi || "",
      (paper.sources || [paper.source]).join("+"),
      paper.url || "",
      pico.population,
      pico.intervention,
      pico.comparison,
      pico.outcomes,
      pico.study_type,
      pico.confidence_score,
      paper.abstract || "",
    ]
      .map(escapeCsv)
      .join(",");
  });
  return [headers.join(","), ...rows].join("\n");
}

export function toJSON(papers) {
  return JSON.stringify(papers, null, 2);
}

export function toRIS(papers) {
  const blocks = papers.map((paper) => {
    const lines = ["TY  - JOUR", `TI  - ${paper.title || ""}`];
    for (const author of paper.authors || []) {
      lines.push(`AU  - ${author}`);
    }
    if (paper.year) lines.push(`PY  - ${paper.year}`);
    if (paper.doi) lines.push(`DO  - ${paper.doi}`);
    if (paper.url) lines.push(`UR  - ${paper.url}`);
    if (paper.abstract) lines.push(`AB  - ${paper.abstract}`);
    if (paper.venue) lines.push(`JO  - ${paper.venue}`);
    const pico = paper.pico;
    if (pico) {
      if (pico.paper_type) lines.push(`KW  - ${pico.paper_type}`);
      lines.push(
        `N1  - Type: ${pico.paper_type || ""} | PICO | P: ${pico.population} | I: ${pico.intervention} | C: ${pico.comparison} | O: ${(pico.outcomes || []).join("; ")} | Design: ${pico.study_type}`
      );
    }
    lines.push("ER  - ");
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

export function toDedupCSV(papers, { keptIds, discardedIds }) {
  const kept = new Set(keptIds);
  const discarded = new Set(discardedIds);
  const headers = [
    "id",
    "title",
    "authors",
    "year",
    "doi",
    "source",
    "url",
    "dup_cluster_id",
    "dup_reason",
    "dedup_decision",
    "abstract",
  ];
  const rows = papers.map((paper) => {
    let decision = "keep";
    if (discarded.has(paper.id)) decision = "drop";
    else if (kept.size && !kept.has(paper.id) && discarded.size) decision = "drop";
    return [
      paper.id,
      paper.title,
      (paper.authors || []).join("; "),
      paper.year ?? "",
      paper.doi || "",
      (paper.sources || [paper.source]).join("+"),
      paper.url || "",
      paper.dup_cluster_id || "",
      paper.dup_reason || "",
      decision,
      paper.abstract || "",
    ]
      .map(escapeCsv)
      .join(",");
  });
  return [headers.join(","), ...rows].join("\n");
}

export function toScreeningCSV(papers, decisions) {
  const headers = [
    "id",
    "title",
    "authors",
    "year",
    "doi",
    "source",
    "url",
    "verdict",
    "reasons",
    "by_ai",
    "confidence_score",
    "abstract",
  ];
  const rows = papers.map((paper) => {
    const d = decisions[paper.id] || {};
    return [
      paper.id,
      paper.title,
      (paper.authors || []).join("; "),
      paper.year ?? "",
      paper.doi || "",
      (paper.sources || [paper.source]).join("+"),
      paper.url || "",
      d.verdict || "",
      (d.reasons || []).join("; "),
      d.by_ai ? "ai" : "manual",
      d.confidence_score ?? "",
      paper.abstract || "",
    ]
      .map(escapeCsv)
      .join(",");
  });
  return [headers.join(","), ...rows].join("\n");
}

function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
}

export function exportDedupCSV(papers, keepState) {
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(
    `slr-dedup-${stamp}.csv`,
    toDedupCSV(papers, keepState),
    "text/csv;charset=utf-8"
  );
}

export function exportScreeningCSV(papers, decisions) {
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(
    `slr-screening-r1-${stamp}.csv`,
    toScreeningCSV(papers, decisions),
    "text/csv;charset=utf-8"
  );
}

export function exportPapers(papers, format) {
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "csv") {
    downloadBlob(`pico-export-${stamp}.csv`, toCSV(papers), "text/csv;charset=utf-8");
  } else if (format === "json") {
    downloadBlob(
      `pico-export-${stamp}.json`,
      toJSON(papers),
      "application/json;charset=utf-8"
    );
  } else if (format === "ris") {
    downloadBlob(
      `pico-export-${stamp}.ris`,
      toRIS(papers),
      "application/x-research-info-systems;charset=utf-8"
    );
  }
}
