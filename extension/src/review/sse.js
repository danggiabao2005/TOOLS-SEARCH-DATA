/** Parse a fetch() SSE body (POST-friendly). */

export async function readSSE(response, onEvent) {
  if (!response.ok || !response.body) {
    throw new Error(`SSE failed (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines = [];

  const flush = async () => {
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
    await onEvent(name, data);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      else if (line === "") await flush();
    }
  }
  await flush();
}
