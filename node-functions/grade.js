import OpenAI from "openai";
import getRequestBody from "./getRequestBody.js";

const SEP = "===SCORES===";

const SYSTEM_PROMPT = `# Role
You are an experienced English writing teacher evaluating a student's paragraph/essay.

# Task
Produce a friendly, specific evaluation in TWO parts.

## PART 1 — Written feedback (plain markdown, streamed to the student)
Write your evaluation as flowing markdown, organized under these three headings, IN THIS ORDER:

### Content
- Thesis Clarity: Quote the topic sentence. State whether it's clear; if not, suggest a rewrite.
- Relevance: Identify any off-topic or weakly-supporting sentences; list each with reasons.

### Language
- Accuracy: List each grammar/word-choice/expression issue: (1) original (2) problem type (3) correction.
- Variety: Point out monotonous patterns and show how to vary them.
- Precision: Highlight strong word choices; flag weak/vague words and suggest alternatives.

### Structure
- Cohesion: Check each transition point. Flag missing/abrupt transitions and give usable transitional phrases.

Feedback rules:
- Every comment must reference the original text. No vague praise.
- Always give the actual correction. Use <s>original</s> -> <strong>revised</strong> for fixes.
- Mark problems red <span style="color:#d93025">...</span>, strengths green <span style="color:#1e8e3e">...</span>, suggestions blue <span style="color:#1a73e8">...</span>.
- Note strengths before problems; keep an encouraging tone.

## PART 2 — Scores (machine-readable)
After ALL written feedback, output a line containing EXACTLY the token ${SEP} on its own line, then output ONLY a JSON object (no markdown fence, nothing after it) in EXACTLY this shape:
{"content":{"score":<1-5>},"language":{"score":<1-5>},"structure":{"score":<1-5>},"topPriority":"<1-2 sentence string>"}

Critical: The token ${SEP} must appear EXACTLY ONCE, only between Part 1 and Part 2. Never write it or raw JSON inside Part 1.`;

function extractScores(fullText) {
  const idx = fullText.lastIndexOf(SEP);
  if (idx === -1) return null;
  let jsonPart = fullText.slice(idx + SEP.length).trim();
  jsonPart = jsonPart.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const first = jsonPart.indexOf("{");
  const last = jsonPart.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    return JSON.parse(jsonPart.slice(first, last + 1));
  } catch {
    return null;
  }
}

function clampScore(v) {
  let s = parseInt(v, 10);
  if (isNaN(s)) s = 0;
  return Math.max(0, Math.min(5, s));
}

// 12-char base36 random id for shareable report URLs
function genId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => alphabet[b % 36]).join("");
}

function normalizeScores(obj, feedbackText) {
  const safe = obj && typeof obj === "object" ? obj : {};
  const get = (k) => clampScore(safe?.[k]?.score);
  let priority = typeof safe.topPriority === "string" ? safe.topPriority.trim() : "";
  if (!priority) {
    const order = [["Content", get("content")], ["Language", get("language")], ["Structure", get("structure")]];
    order.sort((a, b) => a[1] - b[1]);
    priority = `Focus first on improving ${order[0][0]}, which received the lowest score.`;
  }
  return {
    content: { score: get("content"), feedback: feedbackText },
    language: { score: get("language"), feedback: feedbackText },
    structure: { score: get("structure"), feedback: feedbackText },
    topPriority: priority,
  };
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await getRequestBody(request);
  const essayText = (typeof body === "object" ? body.essay : body) || "";

  if (!essayText.trim()) {
    return new Response(JSON.stringify({ error: "Essay text is empty" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const openai = new OpenAI({
    apiKey: env.GRADE_API_KEY,
    baseURL: env.GRADE_API_URL,
  });
  const model = env.GRADE_MODEL || "deepseek-v4-flash";

  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  const send = (event, data) =>
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  (async () => {
    try {
      const completion = await openai.chat.completions.create({
        model,
        stream: true,
        max_tokens: 2048,
        temperature: 0.3,
        // DeepSeek V4 thinking defaults to ON (effort=high) -> long silent delay
        // before first token. Disable it for fast streaming + stable output.
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: essayText },
        ],
      });

      let full = "";       // entire raw model output
      let emitted = 0;      // length of visible feedback already sent to client
      let sepSeen = false;  // separator encountered -> stop emitting visible tokens

      for await (const chunk of completion) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (!delta) continue;
        full += delta;

        if (sepSeen) continue; // past separator: buffer JSON only

        const sepIdx = full.indexOf(SEP);
        if (sepIdx !== -1) {
          // Separator found: flush remaining visible text (before SEP) then stop.
          sepSeen = true;
          const remaining = full.slice(emitted, sepIdx);
          if (remaining) await send("token", { text: remaining });
          emitted = sepIdx;
          continue;
        }

        // No separator yet. Emit everything except a trailing window that could be
        // the start of a split separator, so we never leak a partial "===SCORES===".
        const safeEnd = full.length - SEP.length;
        if (safeEnd > emitted) {
          await send("token", { text: full.slice(emitted, safeEnd) });
          emitted = safeEnd;
        }
      }

      // Compute clean feedback text (everything before separator)
      const sepIdx = full.indexOf(SEP);
      const feedbackText = (sepIdx === -1 ? full : full.slice(0, sepIdx)).trim();

      const parsed = extractScores(full);

      if (!parsed) {
        // Stream ended without a parseable score block — usually a truncated
        // response (timeout / max_tokens) or the model skipped Part 2.
        // Do NOT fake a 0/0/0 report; surface a real error so the client retries.
        await send("error", {
          message: feedbackText
            ? "评分数据缺失（输出可能被截断），请重试。"
            : "模型未返回内容，请重试。",
        });
        await send("done", { ok: false });
        return;
      }

      const result = normalizeScores(parsed, feedbackText);

      // ---- Persist to EdgeOne KV (best-effort; grading still works without it) ----
      // KV namespace must be bound with the variable name `deepessay_kv` in the
      // EdgeOne console. EdgeOne KV is accessed as a global, NOT via env.
      let sessionId = null;
      try {
        if (typeof deepessay_kv !== "undefined" && deepessay_kv) {
          sessionId = genId();
          await deepessay_kv.put(
            "report:" + sessionId,
            JSON.stringify({
              v: 1,
              ts: Date.now(),
              essay: essayText,
              feedbackText,
              scores: {
                content: result.content.score,
                language: result.language.score,
                structure: result.structure.score,
              },
              topPriority: result.topPriority,
            })
          );
        }
      } catch (e) {
        sessionId = null; // persistence failure must not break grading
      }
      if (sessionId) result.sessionId = sessionId;

      await send("result", result);
      await send("done", { ok: true });
    } catch (err) {
      await send("error", { message: err.message });
    } finally {
      await writer.close();
    }
  })();

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
