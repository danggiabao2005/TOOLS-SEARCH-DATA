/**
 * Service worker: long-running PICO search + SSE streaming.
 * Popup talks via chrome.runtime messaging; state persists in chrome.storage.local.
 */

const DEFAULT_API = "http://127.0.0.1:8000";

/** @type {AbortController | null} */
let activeAbort = null;
/** @type {string | null} */
let activeTaskId = null;

const SESSION_KEY = "pico_session";

function localFetch(url, options = {}) {
  return fetch(url, {
    cache: "no-store",
    targetAddressSpace: "loopback",
    ...options,
  });
}

function describeNetworkError(err, apiBase) {
  const raw = err?.message || String(err);
  if (
    err?.name === "TypeError" ||
    /failed to fetch/i.test(raw) ||
    /networkerror/i.test(raw) ||
    /load failed/i.test(raw)
  ) {
    return (
      `Không kết nối được backend tại ${apiBase}. ` +
      "Hãy chạy server: cd backend → uvicorn app.main:app --reload --host 127.0.0.1 --port 8000"
    );
  }
  return raw;
}

async function loadSession() {
  const data = await chrome.storage.local.get(SESSION_KEY);
  return (
    data[SESSION_KEY] || {
      status: "idle",
      taskId: null,
      message: "",
      papers: [],
      error: null,
      apiBase: DEFAULT_API,
    }
  );
}

async function saveSession(patch) {
  const current = await loadSession();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [SESSION_KEY]: next });
  notifyPopup({ type: "SESSION_UPDATED", session: next });
  return next;
}

/** Popup may be closed; ignore "Receiving end does not exist". */
function notifyPopup(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    /* no receiver */
  }
}

async function startSearch(payload) {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }

  const apiBase = payload.apiBase || DEFAULT_API;
  await saveSession({
    status: "streaming",
    taskId: null,
    message: "Đang tạo tác vụ...",
    papers: [],
    error: null,
    apiBase,
    request: payload,
  });

  const controller = new AbortController();
  activeAbort = controller;

  try {
    const healthRes = await localFetch(`${apiBase}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!healthRes.ok) {
      throw new Error(`Backend health check HTTP ${healthRes.status}`);
    }

    const createRes = await localFetch(`${apiBase}/api/v1/tasks/pico-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keywords: payload.keywords,
        year_min: payload.yearMin || null,
        year_max: payload.yearMax || null,
        sources: payload.sources,
        limit: payload.fetchAll ? 500 : payload.limit || 20,
        fetch_all: Boolean(payload.fetchAll),
      }),
      signal: controller.signal,
    });

    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`Create task failed (${createRes.status}): ${text}`);
    }

    const { task_id: taskId } = await createRes.json();
    activeTaskId = taskId;
    await saveSession({ taskId, message: "Đã kết nối stream..." });

    await consumeSSE(`${apiBase}/api/v1/tasks/${taskId}/stream`, controller.signal);
  } catch (err) {
    if (err.name === "AbortError") {
      await saveSession({ status: "idle", message: "Đã hủy.", error: null });
      return;
    }
    const message = describeNetworkError(err, apiBase);
    await saveSession({
      status: "error",
      message,
      error: message,
    });
  } finally {
    if (activeAbort === controller) {
      activeAbort = null;
      activeTaskId = null;
    }
  }
}

async function consumeSSE(url, signal) {
  const res = await localFetch(url, {
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE connect failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines = [];

  const flushEvent = async () => {
    if (!dataLines.length) {
      eventName = "message";
      return;
    }
    const raw = dataLines.join("\n");
    dataLines = [];
    const name = eventName;
    eventName = "message";

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    const session = await loadSession();
    const papers = [...(session.papers || [])];

    if (name === "status") {
      const status =
        data.stage === "error"
          ? "error"
          : data.stage === "complete"
            ? "completed"
            : data.stage === "cancelled"
              ? "idle"
              : "streaming";
      await saveSession({
        status,
        message: data.message || "",
        error: data.stage === "error" ? data.message : null,
      });
    } else if (name === "paper_processed") {
      const exists = papers.some((p) => p.id === data.id);
      if (!exists) papers.push(data);
      await saveSession({
        status: "streaming",
        papers,
        message: `Đã xử lý ${papers.length} bài báo...`,
      });
    } else if (name === "complete") {
      await saveSession({
        status: "completed",
        message: `Hoàn tất: ${data.total} bài báo.`,
        papers,
      });
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      } else if (line === "") {
        await flushEvent();
      }
    }
  }
  await flushEvent();
}

async function cancelSearch() {
  const session = await loadSession();
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
  if (session.taskId && session.apiBase) {
    try {
      await localFetch(`${session.apiBase}/api/v1/tasks/${session.taskId}/cancel`, {
        method: "POST",
      });
    } catch {
      /* ignore */
    }
  }
  activeTaskId = null;
  await saveSession({ status: "idle", message: "Đã hủy.", error: null });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === "START_SEARCH") {
      // Fire-and-forget long task; respond immediately
      startSearch(message.payload).catch((err) => {
        console.warn("startSearch failed:", err);
      });
      sendResponse({ ok: true });
    } else if (message.type === "CANCEL_SEARCH") {
      await cancelSearch();
      sendResponse({ ok: true });
    } else if (message.type === "GET_SESSION") {
      const session = await loadSession();
      sendResponse({ ok: true, session });
    } else if (message.type === "CHECK_HEALTH") {
      const apiBase = (message.apiBase || DEFAULT_API).replace(/\/$/, "");
      try {
        const res = await localFetch(`${apiBase}/health`, { method: "GET" });
        if (!res.ok) {
          throw new Error(`Backend health check HTTP ${res.status}`);
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({
          ok: false,
          error: describeNetworkError(err, apiBase),
        });
      }
    } else if (message.type === "CLEAR_RESULTS") {
      await saveSession({
        status: "idle",
        taskId: null,
        message: "",
        papers: [],
        error: null,
      });
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: "Unknown message" });
    }
  })();
  return true;
});
