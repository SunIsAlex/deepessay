import OpenAI from "openai";
import getRequestBody from "./getRequestBody.js";

// 只提取学生作文正文，忽略页眉标题、页码、水印、印刷题干等无关文字
const OCR_PROMPT =
  "You are an OCR engine. Extract the student's handwritten essay text from this image, " +
  "exactly as written, preserving line breaks and paragraph structure. " +
  "IGNORE any printed headers, section titles, page numbers, watermarks, logos, or website/account tags " +
  "that are not part of the student's own writing. " +
  "Do NOT correct spelling or grammar — transcribe verbatim, including the student's original errors. " +
  "Output ONLY the recognized essay text, with no commentary, no explanations, no markdown fences.";

// 允许的图片 MIME
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp",
]);

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await getRequestBody(request);
    // 前端传 { image: "data:image/jpeg;base64,...." } 或裸 base64 + mime
    let dataUrl = "";
    if (body && typeof body === "object") {
      if (typeof body.image === "string") dataUrl = body.image;
      else if (typeof body.base64 === "string") {
        const mime = body.mime || "image/jpeg";
        dataUrl = `data:${mime};base64,${body.base64}`;
      }
    }

    if (!dataUrl) {
      return new Response(JSON.stringify({ error: "缺少图片数据（image 字段）" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 校验 data URL 格式与类型
    const m = dataUrl.match(/^data:([^;]+);base64,/);
    if (!m) {
      return new Response(JSON.stringify({ error: "图片必须是 base64 data URL 格式" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!ALLOWED_MIME.has(m[1])) {
      return new Response(JSON.stringify({ error: "不支持的图片格式：" + m[1] }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const openai = new OpenAI({
      apiKey: env.OCR_API_KEY,
      baseURL: env.OCR_API_URL,
      timeout: 120 * 1000,
      maxRetries: 1,
    });
    const model = env.OCR_MODEL || "Qwen/Qwen3.5-397B-A17B";

    const completion = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
            { type: "text", text: OCR_PROMPT },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 4096,
      // 该视觉模型默认带推理模式，OCR 不需要，关掉以加速首字、省 token
      enable_thinking: false,
    });

    const text = (completion.choices?.[0]?.message?.content || "").trim();

    if (!text) {
      return new Response(
        JSON.stringify({ error: "未识别到文字，请确认图片清晰、含作文内容后重试。" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ text }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
