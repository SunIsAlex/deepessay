import assert from "node:assert/strict";
import { onRequest as handleOcr } from "./edge-functions/ocr.js";
import {
  BRAINSTORM_SYSTEM_PROMPT,
  validatePrompt,
} from "./node-functions/brainstorm-core.js";

const originalFetch = globalThis.fetch;
const upstreamBodies = [];

globalThis.fetch = async (_url, init) => {
  upstreamBodies.push(JSON.parse(init.body));
  return new Response(JSON.stringify({
    choices: [{ message: { content: "Recognized text" } }],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const env = {
  OCR_API_KEY: "test-key",
  OCR_API_URL: "https://ocr.example/v1",
  OCR_MODEL: "test-model",
};

try {
  const promptResponse = await handleOcr({
    request: new Request("https://example.test/ocr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: "data:image/jpeg;base64,YQ==",
        purpose: "prompt",
      }),
    }),
    env,
  });
  assert.equal(promptResponse.status, 200);
  assert.match(
    upstreamBodies[0].messages[0].content[1].text,
    /complete essay prompt/,
  );

  const essayResponse = await handleOcr({
    request: new Request("https://example.test/ocr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: "data:image/png;base64,YQ==",
        purpose: "unknown",
      }),
    }),
    env,
  });
  assert.equal(essayResponse.status, 200);
  assert.match(
    upstreamBodies[1].messages[0].content[1].text,
    /student's handwritten essay/,
  );
} finally {
  globalThis.fetch = originalFetch;
}

assert.equal(validatePrompt("   "), "作文题目不能为空");
assert.equal(validatePrompt("a".repeat(12001)), "作文题目过长，请精简后重试");
assert.equal(validatePrompt("Write about technology."), "");
assert.match(BRAINSTORM_SYSTEM_PROMPT, /## 1\. 题意拆解/);
assert.match(BRAINSTORM_SYSTEM_PROMPT, /## 4\. 推荐大纲/);
assert.match(BRAINSTORM_SYSTEM_PROMPT, /Do not write a complete essay/);

console.log("Function route tests passed");
