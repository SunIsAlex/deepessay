# EdgeOne Pages 开发踩坑指南

> 基于 DeepEssay（AI 作文批改）项目的实战记录。EdgeOne Pages 和 Cloudflare Pages、Vercel 有不少差异，很多约定不踩一遍不会知道。本文把踩过的坑和对应的正确写法整理出来，供后续项目避雷。

---

## 速查表：先记住这几条

| 坑点 | 错误做法 | 正确做法 |
|------|----------|----------|
| **KV 访问方式** | `env.KV.get()` | 直接用全局变量 `my_kv.get()` |
| **KV 在哪能用** | 放在 Cloud Functions 里 | **只能在 Edge Functions 里用** |
| **SSE 流式在哪能用** | 放在 Edge Functions 里 | **只能在 Cloud Functions 里用** |
| **两类函数目录名** | 混用一个目录 | Cloud → `node-functions/`，Edge → `edge-functions/` |
| **KV key 字符** | `report:abc123`（带冒号） | `report_abc123`（只允许字母数字下划线） |
| **环境变量** | 多服务共用 `OPENAI_*` | 按服务加前缀隔离，如 `GRADE_*` / `OCR_*` |

---

## 坑 1：KV 只能在 Edge Functions 中使用

这是最容易踩、也最隐蔽的坑。官方文档原文：

> Currently, it is only supported for use within Edge Functions.

如果你把 KV 操作写在 Cloud Function（`node-functions/`）里，运行时 KV 的全局变量**根本不存在**，`typeof my_kv` 会是 `"undefined"`。更坑的是：如果你像下面这样做了「容错」，它会**静默失败**，让你以为是别的问题：

```javascript
// ❌ 这段在 Cloud Function 里永远走 else 分支，但不会报错
let sessionId = null;
try {
  if (typeof my_kv !== "undefined" && my_kv) {
    sessionId = genId();
    await my_kv.put("report_" + sessionId, payload);
  }
  // KV 不存在 -> 静默跳过 -> sessionId 一直是 null -> 前端拿不到分享链接
} catch (e) {
  sessionId = null;
}
```

**症状**：功能"不报错但也不生效"。比如分享链接不出现、URL 不变化，前端却没有任何报错。排查时容易往前端或网络方向找，其实是函数类型放错了。

**正确做法**：所有 KV 读写放进 `edge-functions/`。

---

## 坑 2：SSE 流式只能在 Cloud Functions 中使用

和坑 1 正好相反。Edge Functions 对 SSE（`text/event-stream`）有缓冲问题——输出不会逐字流出，而是**憋到最后一次性吐出**，打字机效果完全失效。

**所以流式接口（如 LLM 逐 token 输出）必须放在 Cloud Functions（`node-functions/`）。**

这就和坑 1 形成一个硬约束：

```
KV       → 只能 Edge Functions
SSE 流式 → 只能 Cloud Functions
```

如果一个功能**既要流式、又要写 KV**（例如"流式批改完后把结果存起来"），不能塞进同一个函数。解法是拆开：

```
1. /grade   (Cloud Function, SSE)  ── 流式输出，不碰 KV
2. 前端拿到完整结果后
3. /save    (Edge Function)        ── 单独写 KV，返回 id
4. /report  (Edge Function)        ── 读 KV（分享链接打开时）
```

前端在流式结束后，再发一个普通请求去 `/save`。代价是多一次请求，但各自待在能用的环境里。

---

## 坑 3：KV 用全局变量，不是 `env.KV`

和 Cloudflare Workers 不同。CF 里 KV 绑定挂在 `env` 上（`env.MY_KV`），但 **EdgeOne 的 KV 绑定是一个直接可用的全局变量**——绑定时你在控制台填的「变量名」就是全局名。

```javascript
// ❌ Cloudflare 写法，在 EdgeOne 上 env.deepessay_kv 是 undefined
export async function onRequest({ env }) {
  await env.deepessay_kv.put("k", "v");
}

// ✅ EdgeOne：直接用全局变量名（控制台绑定时填的名字）
export async function onRequest(context) {
  await deepessay_kv.put("k", "v");
}
```

> 注意：环境变量（API key 等）仍然走 `context.env.XXX`。只有 **KV 命名空间**是全局变量。别把两者搞混。

---

## 坑 4：两类函数的目录名不同

| 函数类型 | 目录 | 能力 |
|----------|------|------|
| Cloud Functions | `node-functions/` | Node.js 运行时、SSE 流式、npm 依赖 |
| Edge Functions | `edge-functions/` | 边缘运行时、KV、低延迟 |

放错目录会导致函数不被识别或能力不可用。两类可以并存于同一个项目，各放各的目录。

> 历史叫法：Cloud Functions 的目录早期文档里也出现过 `cloud-functions` 的写法。以你项目实际识别的为准，部署后在控制台确认函数是否被正确加载。

---

## 坑 5：KV key 只能用字母、数字、下划线

官方对 key 的限制：

> 长度 ≤ 512 B，只能包含数字、字母和下划线。

常见的 `namespace:id` 冒号分隔风格在这里**非法**：

```javascript
// ❌ 冒号是非法字符，put 会失败
await deepessay_kv.put("report:" + id, payload);

// ✅ 用下划线
await deepessay_kv.put("report_" + id, payload);
```

生成随机 id 时也要保证字符集干净（纯字母数字）：

```javascript
// 12 位 base36 随机 id，只含 a-z0-9
function genId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => alphabet[b % 36]).join("");
}
```

---

## 坑 6：value 写入要 `await`，get 不存在返回 null

```javascript
// put / delete 返回 Promise，必须 await 才能确认成功
await deepessay_kv.put(key, value);   // value 必须是 string / ArrayBuffer 等，对象要先 JSON.stringify
await deepessay_kv.delete(key);

// get：key 不存在或值为空时返回 null（不是抛错）
const raw = await deepessay_kv.get(key);
if (!raw) { /* 不存在 */ }

// 也可以让 KV 直接帮你反序列化 JSON
const obj = await deepessay_kv.get(key, "json");  // 或 { type: "json" }
```

注意 KV 是**最终一致**：写入只更新当前边缘节点缓存，其他节点最多 60 秒后才读到新值。需要强一致就用 Blob 存储。

---

## 坑 7：环境变量按服务隔离命名

项目接了多个 AI 供应商（批改用 DeepSeek、OCR 用硅基流动），如果都用通用名 `OPENAI_API_KEY` 会互相撞车、看代码也分不清。**按服务加前缀**：

```
# 批改（DeepSeek）
GRADE_API_URL = https://api.deepseek.com
GRADE_API_KEY = sk-...
GRADE_MODEL   = deepseek-v4-flash

# OCR（硅基流动）
OCR_API_URL = https://api.siliconflow.cn/v1
OCR_API_KEY = sk-...
OCR_MODEL   = Qwen/Qwen3.5-397B-A17B
```

读取（Cloud Function 里走 `context.env`）：

```javascript
export async function onRequest(context) {
  const { env } = context;
  const openai = new OpenAI({
    apiKey: env.GRADE_API_KEY,
    baseURL: env.GRADE_API_URL,
  });
  const model = env.GRADE_MODEL || "deepseek-v4-flash";
  // ...
}
```

---

## 坑 8：第三方模型的 thinking / 参数差异

接 LLM 时容易踩两个与平台无关、但同样耗时间的坑：

**(a) 推理模型默认开 thinking，导致首字极慢。** 比如 DeepSeek V4、部分 Qwen-VL，默认开启推理，首字前有长时间静默（推理 token 不输出），看着像卡死。OCR / 结构化输出这类任务不需要推理，关掉它：

```javascript
// JS SDK 把未知字段直接透传进请求 body
const completion = await openai.chat.completions.create({
  model,
  messages,
  thinking: { type: "disabled" },   // DeepSeek 系
  // enable_thinking: false,        // 部分 Qwen 系用这个字段
});
```

**(b) `extra_body` 是 Python SDK 专有，JS SDK 没有。** Python 里要 `extra_body={"thinking": {...}}`，但 **JS SDK 直接把顶层多余字段透传**，所以 JS 里写顶层 `thinking: {...}` 即可，写 `extra_body` 反而无效。

> 验证参数有没有真的发出去：临时拦截 SDK 的 fetch 打印最终 body，比猜靠谱。

---

## 完整代码示例

### 示例 A：SSE 流式（Cloud Function，`node-functions/grade.js`）

```javascript
import OpenAI from "openai";

export async function onRequest(context) {
  const { request, env } = context;

  const openai = new OpenAI({
    apiKey: env.GRADE_API_KEY,
    baseURL: env.GRADE_API_URL,
  });

  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  const send = (event, data) =>
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  (async () => {
    try {
      const completion = await openai.chat.completions.create({
        model: env.GRADE_MODEL || "deepseek-v4-flash",
        stream: true,
        max_tokens: 2048,
        thinking: { type: "disabled" }, // 关推理，避免首字静默
        messages: [/* ... */],
      });

      for await (const chunk of completion) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) await send("token", { text: delta });
      }
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
```

### 示例 B：写 KV（Edge Function，`edge-functions/save.js`）

```javascript
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function genId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => alphabet[b % 36]).join("");
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // KV 是全局变量，不是 env.deepessay_kv
  if (typeof deepessay_kv === "undefined" || !deepessay_kv) {
    return json({ error: "KV 未绑定（控制台变量名需为 deepessay_kv）" }, 503);
  }

  const body = await request.json();
  const sessionId = genId();

  try {
    // key 用下划线；value 必须是字符串，对象先 stringify
    await deepessay_kv.put("report_" + sessionId, JSON.stringify({
      ts: Date.now(),
      data: body,
    }));
    return json({ sessionId });
  } catch (err) {
    return json({ error: "保存失败：" + err.message }, 500);
  }
}
```

### 示例 C：读 KV（Edge Function，`edge-functions/report.js`）

```javascript
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const id = (new URL(request.url).searchParams.get("id") || "").trim();
  // 校验格式，避免拿非法字符串去查 KV
  if (!/^[a-z0-9]{8,32}$/i.test(id)) return json({ error: "无效 ID" }, 400);

  if (typeof deepessay_kv === "undefined" || !deepessay_kv) {
    return json({ error: "KV 未绑定" }, 503);
  }

  const raw = await deepessay_kv.get("report_" + id);
  if (!raw) return json({ error: "不存在或已过期" }, 404); // get 不存在返回 null

  return json(JSON.parse(raw));
}
```

### 示例 D：请求体解析 helper（两类函数通用）

```javascript
export default async function getRequestBody(request) {
  const contentType = request.headers.get?.("content-type") || "";
  if (contentType.includes("application/json")) return await request.json();
  const text = await request.text();
  try { return JSON.parse(text); } catch { return text; }
}
```

---

## 部署前检查清单

- [ ] 流式接口在 `node-functions/`，KV 接口在 `edge-functions/`，没放反
- [ ] KV 用全局变量名访问，控制台绑定的变量名与代码一致（本项目为 `deepessay_kv`）
- [ ] KV key 只含字母数字下划线，无冒号等非法字符
- [ ] `put` / `delete` 都 `await` 了；写入对象记得 `JSON.stringify`
- [ ] 环境变量按服务加前缀，控制台已配齐
- [ ] 用 OpenAI SDK 的话，`package.json` 声明了 `"openai"` 依赖 + `"type":"module"`，本地先 `npm install`
- [ ] prompt / 模板字符串里的反引号已转义（否则报 "Missing semicolon"）
- [ ] LLM 若默认开 thinking，已按需关闭

---

## 参考

- [EdgeOne Pages KV 文档](https://pages.edgeone.ai/document/kv-storage)
- [Cloud Functions 文档](https://pages.edgeone.ai/document/cloud-functions)
- [Edge Functions 文档](https://pages.edgeone.ai/document/edge-functions)
