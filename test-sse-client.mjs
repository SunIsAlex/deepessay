import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./sse-client.js", import.meta.url), "utf8");
const context = {};
vm.runInNewContext(source, context);

const events = [];
const parser = context.SseClient.createParser((event, data) => {
  events.push({ event, data });
});

parser.push("event: tok");
parser.push("en\r\ndata: {\"text\":\"a");
parser.push("\"}\r\n\r\nevent: result\ndata: first\n");
parser.push("data: second\n\n");
parser.finish();

assert.deepEqual(
  JSON.parse(JSON.stringify(events)),
  [
    { event: "token", data: "{\"text\":\"a\"}" },
    { event: "result", data: "first\nsecond" },
  ],
);

let xhr;
class FakeXhr {
  constructor() {
    xhr = this;
    this.responseText = "";
    this.status = 200;
    this.headers = {};
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name, value) {
    this.headers[name] = value;
  }
  send(body) {
    this.body = body;
  }
  abort() {}
}

const fallbackContext = { XMLHttpRequest: FakeXhr };
vm.runInNewContext(source, fallbackContext);
const fallbackEvents = [];
const request = fallbackContext.SseClient.post("/grade", { essay: "test" }, (event, data) => {
  fallbackEvents.push({ event, data });
});

xhr.responseText = "event: token\ndata: {\"text\":\"hel";
xhr.onprogress();
xhr.responseText += "lo\"}\n\n";
xhr.onprogress();
xhr.responseText += "event: done\ndata: {\"ok\":true}\n\n";
xhr.onload();
await request;

assert.equal(xhr.method, "POST");
assert.equal(xhr.url, "/grade");
assert.equal(xhr.body, '{"essay":"test"}');
assert.deepEqual(
  JSON.parse(JSON.stringify(fallbackEvents)),
  [
    { event: "token", data: '{"text":"hello"}' },
    { event: "done", data: '{"ok":true}' },
  ],
);

console.log("SSE parser tests passed");
