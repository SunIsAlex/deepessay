/**
 * PaddleOCR-VL-1.5 识别测试脚本（硅基流动）
 *
 * 用法：
 *   1. 安装依赖：  npm install openai
 *   2. 设置 key：  export SILICONFLOW_API_KEY="sk-xxxx"
 *   3. 运行：      node test-ocr.mjs ./your-essay-photo.jpg
 *
 * 可选环境变量：
 *   OCR_MODEL        默认 PaddlePaddle/PaddleOCR-VL-1.5
 *   SILICONFLOW_API_URL  默认 https://api.siliconflow.cn/v1
 */

import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";

const API_KEY = process.env.SILICONFLOW_API_KEY;
const API_URL = process.env.SILICONFLOW_API_URL || "https://api.siliconflow.cn/v1";
const MODEL = process.env.OCR_MODEL || "Qwen/Qwen3.5-397B-A17B";

const imgPath = process.argv[2];

function fail(msg) {
  console.error("❌ " + msg);
  process.exit(1);
}

if (!API_KEY) fail("缺少 SILICONFLOW_API_KEY 环境变量。先 export SILICONFLOW_API_KEY=\"sk-...\"");
if (!imgPath) fail("用法：node test-ocr.mjs <图片路径>");
if (!fs.existsSync(imgPath)) fail("找不到图片文件：" + imgPath);

// 推断 MIME 类型
const ext = path.extname(imgPath).toLowerCase();
const mimeMap = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};
const mime = mimeMap[ext];
if (!mime) fail("不支持的图片格式：" + ext + "（支持 jpg/png/gif/webp/bmp）");

// 读图转 base64 data URL
const buf = fs.readFileSync(imgPath);
const sizeKB = (buf.length / 1024).toFixed(1);
const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;

console.log("──────────────────────────────────");
console.log("模型 :", MODEL);
console.log("端点 :", API_URL);
console.log("图片 :", imgPath, `(${sizeKB} KB, ${mime})`);
console.log("──────────────────────────────────\n");

const openai = new OpenAI({ apiKey: API_KEY, baseURL: API_URL, timeout: 120 * 1000, maxRetries: 0 });

// OCR 提示词：只要纯文本，保留换行/段落，不要额外解释
const OCR_PROMPT =
  "Extract all the text from this image exactly as written. " +
  "Preserve line breaks and paragraph structure. " +
  "Output ONLY the recognized text, with no commentary, no explanations, no markdown fences.";

const t0 = Date.now();

try {
  console.log("⏳ 已发送请求，等待响应...（流式，首字出现即代表已连通）\n");

  const stream = await openai.chat.completions.create({
    model: MODEL,
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
    stream: true,
    // 关闭 thinking：该模型默认带推理模式，OCR 不需要，会拖慢首字、烧 token。
    // 硅基流动 / Qwen 系一般认 enable_thinking；JS SDK 直接顶层透传。
    enable_thinking: false,
  });

  let text = "";
  let firstTokenAt = null;
  process.stdout.write("===== 识别结果（流式） =====\n\n");

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      if (firstTokenAt === null) {
        firstTokenAt = ((Date.now() - t0) / 1000).toFixed(1);
      }
      text += delta;
      process.stdout.write(delta);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log("\n\n===== 统计 =====");
  console.log("首字耗时 :", (firstTokenAt ?? "—") + "s");
  console.log("总耗时   :", elapsed + "s");
  console.log("字数     :", (text.trim().match(/\S+/g) || []).length, "words /", text.trim().length, "chars");
  if (!text.trim()) console.log("⚠️ 空结果——可能模型未读到图片，或图片输入格式不被接受。");
  console.log("──────────────────────────────────");
} catch (err) {
  console.error("\n❌ 请求失败：", err.message);
  if (err.status) console.error("   HTTP 状态：", err.status);
  if (err.error) console.error("   详情：", JSON.stringify(err.error));
  // 常见原因提示
  if (err.status === 400) {
    console.error("\n   提示：400 多半是模型名不对或图片格式问题。");
    console.error("   确认模型名是否为 PaddlePaddle/PaddleOCR-VL-1.5（去硅基流动模型广场核对准确写法）。");
  }
  if (err.status === 401) console.error("\n   提示：401 是 API key 无效。");
  if (err.status === 429) console.error("\n   提示：429 是余额不足或限流。");
  process.exit(1);
}
