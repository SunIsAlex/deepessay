#!/usr/bin/env bash
# DeepEssay 接口冒烟测试
#
# 用法：
#   BASE="https://你的域名" ./test-api.sh
#   # 本地：BASE="http://localhost:8088" ./test-api.sh
#   # 测 OCR 需提供图片：IMG=./essay.jpg BASE="..." ./test-api.sh
#
# 依赖：curl、jq（没有 jq 也能跑，只是输出不美化）

set -u
BASE="${BASE:-http://localhost:8088}"
IMG="${IMG:-}"
ESSAY="${ESSAY:-My favorite season is summer because it is very hot and sunny. I like to go to the beach. My mother say I should study but I dont want to.}"

have_jq() { command -v jq >/dev/null 2>&1; }
pp() { if have_jq; then jq .; else cat; fi; }
hr() { echo "──────────────────────────────────────────────"; }

echo "BASE = $BASE"
hr

# ── 1. /grade （SSE 流式，Cloud Function）──────────────────
echo "[1] POST /grade  (SSE 流式)"
echo "    期望：event: token 多行 → event: result → event: done"
hr
# -N 关闭缓冲，实时看流；--max-time 兜底
curl -sN --max-time 90 -X POST "$BASE/grade" \
  -H "Content-Type: application/json" \
  -d "{\"essay\": $(printf '%s' "$ESSAY" | jq -Rs . 2>/dev/null || echo "\"$ESSAY\"")}" \
  | head -c 4000
echo
echo "    ↑ 若看到 event: result 且含 content/language/structure 分数 = 批改链路 OK"
hr

# ── 2. /save （写 KV，Edge Function）───────────────────────
echo "[2] POST /save  (写入 KV)"
SAVE_RESP=$(curl -s --max-time 30 -X POST "$BASE/save" \
  -H "Content-Type: application/json" \
  -d '{
    "essay": "Test essay body.",
    "feedbackText": "### Content\nGood topic sentence.\n\n### Language\nMinor grammar issues.\n\n### Structure\nWeak transitions.",
    "topPriority": "Fix the subject-verb agreement first.",
    "scores": { "content": 4, "language": 3, "structure": 2 }
  }')
echo "$SAVE_RESP" | pp
SID=$(printf '%s' "$SAVE_RESP" | (jq -r '.sessionId // empty' 2>/dev/null || true))
if [ -z "$SID" ]; then
  # 没有 jq 时用 grep 兜底抠 sessionId
  SID=$(printf '%s' "$SAVE_RESP" | grep -oE '"sessionId":"[a-z0-9]+"' | head -1 | sed -E 's/.*:"([a-z0-9]+)"/\1/')
fi
echo "    sessionId = ${SID:-（未取到，KV 可能未绑定）}"
hr

# ── 3. /report （读 KV，Edge Function）─────────────────────
echo "[3] GET /report?id=\$SID  (读取刚写入的报告)"
if [ -n "${SID:-}" ]; then
  curl -s --max-time 30 "$BASE/report?id=$SID" | pp
  echo "    ↑ 应返回与 [2] 一致的 essay / feedbackText / scores"
else
  echo "    跳过：上一步没拿到 sessionId（先解决 KV 绑定）"
fi
hr

# ── 4. /report 错误路径 ───────────────────────────────────
echo "[4] GET /report 错误路径（期望非 200）"
echo -n "    非法 id  : "; curl -s -o /dev/null -w "%{http_code}\n" --max-time 15 "$BASE/report?id=!!!"
echo -n "    不存在 id: "; curl -s -o /dev/null -w "%{http_code}\n" --max-time 15 "$BASE/report?id=doesnotexist99"
echo "    期望：非法 id → 400，不存在 → 404"
hr

# ── 5. /ocr （可选，需要图片）─────────────────────────────
if [ -n "$IMG" ] && [ -f "$IMG" ]; then
  echo "[5] POST /ocr  (图片识别)"
  EXT="${IMG##*.}"; MIME="image/jpeg"
  case "$EXT" in png) MIME="image/png";; webp) MIME="image/webp";; gif) MIME="image/gif";; esac
  B64=$(base64 -w0 "$IMG" 2>/dev/null || base64 "$IMG" | tr -d '\n')
  curl -s --max-time 120 -X POST "$BASE/ocr" \
    -H "Content-Type: application/json" \
    -d "{\"image\":\"data:$MIME;base64,$B64\"}" | pp
  hr
else
  echo "[5] /ocr 跳过（设置 IMG=./essay.jpg 可测）"
  hr
fi

echo "完成。"
