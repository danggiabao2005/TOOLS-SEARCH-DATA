/** Parse CSV (comma or semicolon, quoted fields, UTF-8 BOM). */

const ALIASES = {
  id: ["id", "paper_id", "paperid"],
  title: [
    "title",
    "ti",
    "article title",
    "paper title",
    "document title",
    "item title",
    "tên bài",
    "ten bai",
  ],
  authors: ["authors", "author", "au", "tác giả", "tac gia"],
  year: ["year", "py", "publication year", "publication_year", "date", "năm", "nam"],
  doi: ["doi"],
  url: ["url", "link", "ur", "html_url"],
  abstract: ["abstract", "ab", "summary", "tóm tắt", "tom tat"],
  source: ["source", "sources", "database", "venue", "journal", "nguồn", "nguon"],
  dup_cluster_id: ["dup_cluster_id", "cluster_id", "cluster"],
  dup_reason: ["dup_reason"],
  dedup_decision: ["dedup_decision"],
  verdict: ["verdict", "decision", "screening"],
  reasons: ["reasons", "reason", "codes"],
};

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function detectDelim(headerLine) {
  const commas = (headerLine.match(/,/g) || []).length;
  const semis = (headerLine.match(/;/g) || []).length;
  return semis > commas ? ";" : ",";
}

export function parseCsv(text) {
  const src = stripBom(String(text || "")).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!src.trim()) return [];
  const firstLine = src.split("\n")[0] || "";
  const delim = detectDelim(firstLine);
  const rows = [];
  let row = [];
  let cell = "";
  let i = 0;
  let quoted = false;
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === delim) {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

function normHeader(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replace(/^\ufeff/, "");
}

function mapHeaders(headerRow) {
  const mapped = headerRow.map((h) => {
    const n = normHeader(h);
    for (const [field, names] of Object.entries(ALIASES)) {
      if (names.includes(n)) return field;
    }
    return n.replace(/\s+/g, "_");
  });
  return mapped;
}

function splitAuthors(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/\s*;\s*|\s*\|\s*|\s+and\s+/i)
    .map((a) => a.trim())
    .filter(Boolean);
}

function parseYear(raw) {
  if (raw == null || raw === "") return null;
  const m = String(raw).match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

let _seq = 0;
function newId() {
  _seq += 1;
  return `csv-${Date.now().toString(36)}-${_seq}`;
}

export function rowsToPapers(rows) {
  if (!rows.length) return { papers: [], extras: { decisions: {}, keepByCluster: {} } };
  const headers = mapHeaders(rows[0]);
  const papers = [];
  const decisions = {};
  const droppedIds = [];
  const keptIds = [];

  for (const cells of rows.slice(1)) {
    if (!cells.some((c) => String(c || "").trim())) continue;
    const rec = {};
    headers.forEach((h, i) => {
      rec[h] = cells[i] != null ? String(cells[i]).trim() : "";
    });
    const title = rec.title || rec.ti || "";
    if (!title) continue;
    const sourceRaw = rec.source || rec.sources || "csv";
    const sources = sourceRaw.split("+").map((s) => s.trim()).filter(Boolean);
    const paper = {
      id: rec.id || newId(),
      title,
      authors: splitAuthors(rec.authors),
      year: parseYear(rec.year),
      doi: rec.doi || null,
      url: rec.url || null,
      abstract: rec.abstract || "",
      source: sources[0] || "csv",
      sources: sources.length ? sources : ["csv"],
      dup_cluster_id: rec.dup_cluster_id || null,
      dup_reason: rec.dup_reason || null,
      venue: rec.venue || rec.journal || null,
    };
    papers.push(paper);
    if (rec.verdict) {
      const reasons = rec.reasons
        ? rec.reasons.split(/[;,]/).map((s) => s.trim()).filter(Boolean)
        : [];
      decisions[paper.id] = {
        verdict: String(rec.verdict).toLowerCase(),
        reasons,
        by_ai: false,
      };
    }
    if (String(rec.dedup_decision).toLowerCase() === "drop") droppedIds.push(paper.id);
    if (String(rec.dedup_decision).toLowerCase() === "keep") keptIds.push(paper.id);
  }

  return { papers, extras: { decisions, droppedIds, keptIds } };
}

export function parseCsvFileText(text) {
  const rows = parseCsv(text);
  const { papers, extras } = rowsToPapers(rows);
  if (!papers.length) {
    throw new Error("CSV không có cột title / không đọc được bài nào.");
  }
  return { papers, extras };
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Không đọc được file."));
    reader.readAsText(file, "UTF-8");
  });
}

function normalizeTitleKey(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeDoi(doi) {
  if (!doi) return "";
  return String(doi)
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .replace(/^doi:\s*/, "")
    .trim();
}

/** Fallback khi backend không chạy: gom theo DOI rồi title chuẩn hóa. */
export function clusterPapersLocal(papers) {
  const n = papers.length;
  const parent = papers.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const byDoi = new Map();
  papers.forEach((p, i) => {
    const doi = normalizeDoi(p.doi);
    if (!doi) return;
    if (byDoi.has(doi)) union(byDoi.get(doi), i);
    else byDoi.set(doi, i);
  });

  const byTitle = new Map();
  papers.forEach((p, i) => {
    const key = normalizeTitleKey(p.title);
    if (!key) return;
    if (byTitle.has(key)) union(byTitle.get(key), i);
    else byTitle.set(key, i);
  });

  const groups = new Map();
  papers.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });

  const out = [];
  let seq = 1;
  for (const members of groups.values()) {
    const clusterId = `C${String(seq).padStart(3, "0")}`;
    seq += 1;
    const reason = members.length > 1 ? "title" : "";
    for (const i of members) {
      out.push({
        ...papers[i],
        dup_cluster_id: clusterId,
        dup_reason: reason || papers[i].dup_reason || null,
      });
    }
  }
  return out;
}

function papersForClusterApi(papers) {
  return papers.map((p) => ({
    id: p.id,
    title: p.title,
    abstract: p.abstract || null,
    year: typeof p.year === "number" && Number.isFinite(p.year) ? p.year : null,
    authors: Array.isArray(p.authors) ? p.authors : [],
    doi: p.doi || null,
    url: p.url || null,
    source: p.source || "csv",
    sources: p.sources?.length ? p.sources : [p.source || "csv"],
    venue: p.venue || null,
  }));
}

export async function clusterImportedPapers(papers, apiBase) {
  const base = (apiBase || "http://127.0.0.1:8000").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/v1/dedup/cluster`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ papers: papersForClusterApi(papers) }),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.papers) && data.papers.length) return data.papers;
    }
  } catch {
    /* backend tắt → gom local */
  }
  return clusterPapersLocal(papers);
}
