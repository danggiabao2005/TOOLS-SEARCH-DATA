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
      lines.push(
        `N1  - PICO | P: ${pico.population} | I: ${pico.intervention} | C: ${pico.comparison} | O: ${(pico.outcomes || []).join("; ")} | Type: ${pico.study_type}`
      );
    }
    lines.push("ER  - ");
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
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
