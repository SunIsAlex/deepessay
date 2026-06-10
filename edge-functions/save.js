// POST /save  (Edge Function — KV is only available in Edge Functions)
// Body: { essay, feedbackText, scores:{content,language,structure}, topPriority }
// Persists the report to KV and returns { sessionId }.
// KV namespace must be bound as the global `deepessay_kv` in the EdgeOne console.

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
  });

// 12-char base36 random id (letters + digits only — KV keys allow [A-Za-z0-9_])
function genId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => alphabet[b % 36]).join("");
}

function clampScore(v) {
  let s = parseInt(v, 10);
  if (isNaN(s)) s = 0;
  return Math.max(0, Math.min(5, s));
}

export async function onRequest(context) {
  const { request } = context;

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (typeof deepessay_kv === "undefined" || !deepessay_kv) {
    return json({ error: "KV 未绑定（请在控制台以变量名 deepessay_kv 绑定命名空间）" }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求体不是合法 JSON" }, 400);
  }

  const essay = typeof body.essay === "string" ? body.essay : "";
  const feedbackText = typeof body.feedbackText === "string" ? body.feedbackText : "";
  const topPriority = typeof body.topPriority === "string" ? body.topPriority : "";
  const scores = body.scores || {};

  if (!feedbackText && !essay) {
    return json({ error: "缺少报告内容" }, 400);
  }

  const sessionId = genId();
  const payload = JSON.stringify({
    v: 1,
    ts: Date.now(),
    essay,
    feedbackText,
    scores: {
      content: clampScore(scores.content),
      language: clampScore(scores.language),
      structure: clampScore(scores.structure),
    },
    topPriority,
  });

  try {
    await deepessay_kv.put("report_" + sessionId, payload);
    return json({ sessionId });
  } catch (err) {
    return json({ error: "保存失败：" + err.message }, 500);
  }
}
