// GET /report?id=<sessionId>
// Reads a persisted grading report from EdgeOne KV.
// KV namespace must be bound as the global variable `deepessay_kv`
// (EdgeOne KV is accessed as a global, NOT via env).

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
  });

export async function onRequest(context) {
  const { request } = context;

  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").trim();

  // ids are 12-char base36 from grade.js; allow a small range for future-proofing
  if (!/^[a-z0-9]{8,32}$/i.test(id)) {
    return json({ error: "无效的报告 ID" }, 400);
  }

  if (typeof deepessay_kv === "undefined" || !deepessay_kv) {
    return json({ error: "KV 未绑定（请在控制台绑定变量名 deepessay_kv）" }, 503);
  }

  try {
    const raw = await deepessay_kv.get("report:" + id);
    if (!raw) {
      return json({ error: "报告不存在或已过期" }, 404);
    }

    let data;
    try {
      data = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return json({ error: "报告数据损坏" }, 500);
    }

    // Reshape to the same structure the front-end's renderReport expects
    return json({
      sessionId: id,
      essay: data.essay || "",
      feedbackText: data.feedbackText || "",
      topPriority: data.topPriority || "",
      content: { score: data.scores?.content ?? 0 },
      language: { score: data.scores?.language ?? 0 },
      structure: { score: data.scores?.structure ?? 0 },
      ts: data.ts || null,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
