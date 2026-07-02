import OpenAI from "openai";
import getRequestBody from "./getRequestBody.js";
import { BRAINSTORM_SYSTEM_PROMPT, validatePrompt } from "./brainstorm-core.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body;
  try {
    body = await getRequestBody(request);
  } catch {
    return json({ error: "请求体不是合法 JSON" }, 400);
  }
  const promptText = (body && typeof body === "object" ? body.prompt : body) || "";
  const validationError = validatePrompt(promptText);
  if (validationError) return json({ error: validationError }, 400);
  if (!env.GRADE_API_KEY || !env.GRADE_API_URL) {
    return json({ error: "审题服务环境变量未配置" }, 503);
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
        max_tokens: 3200,
        temperature: 0.45,
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: BRAINSTORM_SYSTEM_PROMPT },
          { role: "user", content: promptText.trim() },
        ],
      });

      let full = "";
      let truncated = false;
      for await (const chunk of completion) {
        if (chunk.choices?.[0]?.finish_reason === "length") truncated = true;
        const delta = chunk.choices?.[0]?.delta?.content;
        if (!delta) continue;
        full += delta;
        await send("token", { text: delta });
      }

      if (truncated) {
        await send("error", { message: "审题结果超出长度限制，请精简题目后重试。" });
        await send("done", { ok: false });
        return;
      }
      if (!full.trim()) {
        await send("error", { message: "模型未返回审题结果，请重试。" });
        await send("done", { ok: false });
        return;
      }

      await send("result", { outline: full.trim() });
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
