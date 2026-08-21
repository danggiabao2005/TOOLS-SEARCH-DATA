/** Default SLR inclusion/exclusion codes. IC = include, EC = exclude. */

export const DEFAULT_CRITERIA = [
  {
    code: "IC-L",
    kind: "IC",
    locked: true,
    meaning: "Paper phải bằng tiếng Anh",
  },
  {
    code: "IC-T",
    kind: "IC",
    locked: true,
    meaning: "Đăng trên conference hoặc journal (không phải blog, thesis)",
  },
  {
    code: "IC-E",
    kind: "IC",
    locked: true,
    meaning: "Có ít nhất 1 con số kết quả trong table hoặc figure",
  },
  {
    code: "EC-D",
    kind: "EC",
    locked: true,
    meaning: "Trùng với paper đã có",
  },
  {
    code: "EC-A",
    kind: "EC",
    locked: true,
    meaning: "Không tải được full-text",
  },
  {
    code: "EC-S",
    kind: "EC",
    locked: true,
    meaning: "Dưới 4 trang (abstract, poster)",
  },
  {
    code: "EC-N",
    kind: "EC",
    locked: true,
    meaning: "Không có thực nghiệm (vision paper, tutorial)",
  },
  {
    code: "IC-Y",
    kind: "IC",
    locked: true,
    meaning: "Từ năm 2020 trở đi (GPT-3 ra đời năm 2020)",
  },
  {
    code: "IC-P",
    kind: "IC",
    locked: false,
    meaning: "",
    placeholder:
      "VD: Phát hiện / phân loại biến cố hô hấp khi ngủ (OSA, AHI), tiếng ngáy, cử động khi ngủ…",
  },
  {
    code: "IC-I",
    kind: "IC",
    locked: false,
    meaning: "",
    placeholder:
      "VD: Không tiếp xúc / không đeo, AI/ML trên audio, motion/radar, hoặc multimodal…",
  },
  {
    code: "IC-C",
    kind: "IC",
    locked: false,
    meaning: "",
    placeholder:
      "VD: Đối chiếu PSG/HSAT hoặc tín hiệu được gắn nhãn ground truth…",
  },
  {
    code: "EC-O",
    kind: "EC",
    locked: false,
    meaning: "",
    placeholder:
      "VD: Chỉ khảo sát chủ quan (PSQI/ESS) hoặc đo vận động ban ngày, không có tín hiệu ngủ…",
  },
  {
    code: "EC-W",
    kind: "EC",
    locked: false,
    meaning: "",
    placeholder: "VD: Ngoài phạm vi / wrong topic — mô tả tiêu chí loại trừ của đề tài…",
  },
];

export const USER_FILL_CODES = ["IC-P", "IC-I", "IC-C", "EC-O", "EC-W"];

export function mergeMissingDefaults(saved) {
  const list = Array.isArray(saved) ? saved.map((c) => ({ ...c })) : [];
  const have = new Set(list.map((c) => c.code));
  for (const row of DEFAULT_CRITERIA) {
    if (!have.has(row.code)) list.push({ ...row });
  }
  return list;
}

export function nextCustomCode(criteria, kind) {
  const prefix = `${kind}-`;
  const used = new Set(
    criteria
      .filter((c) => c.kind === kind && /^\w+-\d+$/.test(c.code))
      .map((c) => Number(c.code.split("-")[1]))
  );
  let n = 1;
  while (used.has(n)) n += 1;
  return `${kind}-${n}`;
}

export function groupDuplicateClusters(papers) {
  const map = new Map();
  for (const paper of papers) {
    const cid = paper.dup_cluster_id || paper.id;
    if (!map.has(cid)) map.set(cid, []);
    map.get(cid).push(paper);
  }
  const duplicates = [];
  const singles = [];
  for (const [id, members] of map.entries()) {
    if (members.length > 1) duplicates.push({ id, members, reason: members[0].dup_reason || "match" });
    else singles.push(members[0]);
  }
  duplicates.sort((a, b) => a.id.localeCompare(b.id));
  return { duplicates, singles };
}

export function paperMetaLine(paper) {
  const authors = (paper.authors || []).slice(0, 3).join(", ");
  const extra = (paper.authors || []).length > 3 ? " et al." : "";
  const year = paper.year ? ` · ${paper.year}` : "";
  return `${authors}${extra}${year}`;
}
