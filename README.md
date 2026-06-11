# DeepEssay · 作文批改

一个基于 AI 的英语作文批改工具，部署在 [EdgeOne Pages](https://edgeone.ai/products/pages)。支持**手写作文拍照识别**和**文本直接粘贴**两种输入方式，批改结果以 **Google Lighthouse 报告风格**呈现：环形评分 + 分维度可展开详情 + Top Priority 横幅。

## 功能

- 📷 **拍照识别**：上传手写作文照片，OCR 自动转文字，填入编辑框供核对修正
- ✍️ **文本输入**：直接粘贴作文，带字数统计
- 📊 **Lighthouse 风格报告**：
  - 顶部三个环形评分（Content / Language / Structure）+ 总分大环
  - Top Priority 横幅，突出最该优先改进的一点
  - 三张分维度详情卡片，可展开查看富文本反馈（红色标问题、绿色标优点、蓝色标建议）
- ⚡ **流式批改**：批改反馈实时逐字输出（打字机效果），结束后收起换成报告；采用块级增量渲染 + rAF 节流，已完成的段落 DOM 不再重建，可在生成过程中自由上下滚动阅读
- 🎨 Google / Material 设计语言，移动端适配

## 架构

```
                          ┌─────────────────────────────┐
  [拍照] ──base64──▶ /ocr │ SiliconFlow 视觉模型         │──识别文字──┐
   (Cloud Fn)             │ Qwen3.5-397B-A17B            │            │
                          └─────────────────────────────┘            ▼
                                                            填入 textarea，用户核对修正
                                                                       │
                          ┌─────────────────────────────┐            ▼
  [粘贴] ───────▶ /grade  │ DeepSeek                     │◀──批改──────┘
   (Cloud Fn, SSE)        │ deepseek-v4-flash (SSE 流式) │
                          └─────────────────────────────┘
                                       │
                                       ▼
                            Lighthouse 风格报告 ──▶ /save (Edge Fn) ──▶ KV
                                       ▲                                  │
                                       │                                  │
                            分享链接 ?s=<id> ◀── /report (Edge Fn) ◀──────┘
```

两个 AI 服务来自不同供应商，配置完全隔离：OCR 走硅基流动，批改走 DeepSeek 官方。报告持久化走 EdgeOne KV（仅 Edge Functions 可访问）。

## 目录结构

```
deepessay/
├── index.html              # 前端单页（输入态 / 流式加载态 / 报告态）
├── package.json            # 声明 openai 依赖 + "type":"module"
├── test-ocr.mjs            # OCR 本地测试脚本（独立运行，不参与部署）
├── test-api.sh             # 接口冒烟测试（curl）
├── node-functions/         # Cloud Functions —— 支持 SSE 流式
│   ├── grade.js            # 批改接口（SSE 流式输出反馈 + 末尾评分 JSON）
│   ├── ocr.js              # OCR 接口（图片转文字，非流式）
│   └── getRequestBody.js   # 请求体解析 helper
└── edge-functions/         # Edge Functions —— KV 仅在此可用（但不支持 SSE）
    ├── save.js             # 批改后写报告到 KV，返回 sessionId
    └── report.js           # 按 id 从 KV 读报告（分享链接打开时）
```

> **为什么分两类函数**：EdgeOne KV **只能在 Edge Functions 中访问**，而 SSE 流式在 Edge Functions 上有缓冲问题（会一次性吐出）、必须用 Cloud Functions。两个约束冲突，因此按能力拆分：流式批改（grade）留在 Cloud Functions 且不碰 KV；KV 读写（save / report）放在 Edge Functions。前端在批改完成后，再单独调用 `/save` 把结果持久化。

## 环境变量

在 EdgeOne 控制台 **Project Settings** 配置以下 6 个变量。两套前缀分别对应两个服务，互不混用。

### 批改服务（DeepSeek）

| 变量 | 说明 | 示例 |
|------|------|------|
| `GRADE_API_URL` | DeepSeek API 端点 | `https://api.deepseek.com` |
| `GRADE_API_KEY` | DeepSeek API Key | `sk-...` |
| `GRADE_MODEL` | 批改模型 | `deepseek-v4-flash` |

### OCR 服务（硅基流动 SiliconFlow）

| 变量 | 说明 | 示例 |
|------|------|------|
| `OCR_API_URL` | 硅基流动 API 端点 | `https://api.siliconflow.cn/v1` |
| `OCR_API_KEY` | 硅基流动 API Key | `sk-...` |
| `OCR_MODEL` | OCR 视觉模型 | `Qwen/Qwen3.5-397B-A17B` |

> ⚠️ 历史提示：批改服务的环境变量曾命名为 `OPENAI_*`，现已统一改为 `GRADE_*`。从旧版本升级时务必在控制台同步改名，否则批改会失效。

## 本地调试

```bash
# 安装依赖
npm install

# 启动本地开发服务器
edgeone pages dev
```

环境变量在本地可通过 `.env` 或 EdgeOne CLI 配置（参考 EdgeOne 文档）。

### 单独测试 OCR

`test-ocr.mjs` 是一个独立脚本，用于在接入前验证 OCR 模型的识别效果：

```bash
export SILICONFLOW_API_KEY="sk-..."
node test-ocr.mjs ./作文照片.jpg
```

可选环境变量：`OCR_MODEL`（默认 `Qwen/Qwen3.5-397B-A17B`）、`SILICONFLOW_API_URL`（默认 `https://api.siliconflow.cn/v1`）。脚本以流式输出识别结果，并打印首字耗时、总耗时、字数统计。

## 实现要点

### OCR（ocr.js）

- 接收前端传来的 base64 图片（`{ image: "data:image/...;base64,..." }`），调用硅基流动视觉模型识别
- 关闭模型的 thinking 推理模式（`enable_thinking: false`）——该模型默认带推理，会显著拖慢首字、浪费 token；关闭后实测首字 ~2s、总耗时 ~5s
- Prompt 约束：只提取学生作文正文，忽略印刷标题 / 页码 / 水印；逐字转写，**不纠正**原文错误（保留学生的错误供批改环节评判）
- 识别结果填进 textarea 而非直接批改——手写 OCR 必然有错字，需用户核对修正，否则模型会把 OCR 错误当成学生的语法错误来扣分

### 批改（grade.js）

- SSE 流式：模型先按 `### Content / ### Language / ### Structure` 逐节输出纯文本反馈（前端实时显示），最后以 `===SCORES===` 分隔输出评分 JSON
- 服务端边转发 `token` 事件边缓冲全文，用「保留尾部一个分隔符长度的安全窗口」的方式发送，确保分隔符即使被拆在两个 chunk 里也不会泄漏到正文
- 流结束后切出 JSON 段、解析、归一化（分数钳到 0–5；`topPriority` 缺失则回退到最低分维度），再发 `result` 事件
- 拿不到分数时发 `error` 而非伪造的 0 分报告，前端据此提示重试
- 评分采用 1–5 分制，映射三色：4–5 绿、3 橙、1–2 红（沿用 Lighthouse 心智模型）

### 前端（index.html）

- 三态切换：输入态 / 流式加载态（打字机正文）/ 报告态
- 环形评分用 SVG `<circle>` + `stroke-dasharray` 实现进度弧，弧线从 0 扫到目标值，颜色按分数区间动态取色
- Markdown 反馈经 `marked` 解析 + `DOMPurify` 消毒后渲染，防 XSS
- 维度卡片默认全部展开（报告型应用，用户想一次看全）

## 部署注意

- **函数分两类，不能混放**：
  - `node-functions/`（Cloud Functions）：`grade.js`、`ocr.js`。SSE 流式必须用 Cloud Functions——Edge Functions 上有缓冲问题（输出会一次性吐出而非流式）。
  - `edge-functions/`（Edge Functions）：`save.js`、`report.js`。EdgeOne KV **只能在 Edge Functions 中访问**。
- **绑定 KV 命名空间**：在控制台「Storage - KV」开通账户、创建命名空间，绑定到本项目时**变量名必须填 `deepessay_kv`**（代码以该全局名访问 KV，非 `env.xxx`）。绑定后 `save` / `report` 才能工作；未绑定时批改仍正常，只是没有分享链接。
- **KV key 限制**：key 只能含字母、数字、下划线（≤512B）。本项目用 `report_<id>`，id 为 12 位 base36（纯字母数字）。
- OpenAI SDK 依赖已在 `package.json` 声明，EdgeOne 部署时自动安装；本地需先 `npm install`。
- 模板字符串里若包含代码 / 命令示例，反引号需转义，否则可能报 "Missing semicolon"。

## 持久化与分享

- 批改完成后，前端把报告（作文原文 + 反馈 + 分数 + topPriority）POST 到 `/save`，由 Edge Function 写入 KV 并返回 `sessionId`，前端据此生成分享链接 `?s=<id>` 并展示复制按钮。
- 打开含 `?s=<id>` 的 URL 时，前端调 `/report?id=<id>` 直接拉取并渲染完整报告（含可折叠的「作文原文」卡片），跳过输入环节。
- 持久化是 best-effort：`/save` 失败不影响已展示的报告，仅无分享链接。
- KV 条目当前**不设过期**，报告永久留存。如需自动清理，确认 EdgeOne KV 的 `put` 是否支持 TTL 后再加。

## 后续可做

- [ ] 批改历史（localStorage，存作文 + 报告，可回看）
- [ ] 导出报告（打印友好 / 复制 markdown）
- [ ] 题目类型选择（议论文 / 记叙文 / 应用文，影响评分侧重）
- [ ] 字数 / 等级预设（高考 / 四六级 / 雅思，调整评分标准）
- [ ] 图片上传前端压缩（当前限制 5MB，过大直接拦截）
