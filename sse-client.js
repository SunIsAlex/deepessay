(function (root) {
  "use strict";

  function createParser(onEvent) {
    var buffer = "";

    function dispatch(frame) {
      var event = "message";
      var data = [];
      var lines = frame.split(/\r?\n/);

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf("event:") === 0) {
          event = line.slice(6).replace(/^\s+/, "");
        } else if (line.indexOf("data:") === 0) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (data.length) onEvent(event, data.join("\n"));
    }

    function drain(finalChunk) {
      var match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        dispatch(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
      if (finalChunk && buffer) {
        dispatch(buffer);
        buffer = "";
      }
    }

    return {
      push: function (text) {
        buffer += text;
        drain(false);
      },
      finish: function () {
        drain(true);
      },
    };
  }

  function postWithXhr(url, body, onEvent) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var offset = 0;
      var parser = createParser(onEvent);
      var settled = false;

      function fail(message) {
        if (settled) return;
        settled = true;
        reject(new Error(message));
      }

      function consume() {
        var text = xhr.responseText || "";
        if (text.length > offset) {
          parser.push(text.slice(offset));
          offset = text.length;
        }
      }

      xhr.open("POST", url, true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.onprogress = function () {
        try {
          consume();
        } catch (err) {
          xhr.abort();
          fail(err.message);
        }
      };
      xhr.onload = function () {
        if (settled) return;
        try {
          consume();
          parser.finish();
        } catch (err) {
          fail(err.message);
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          fail("请求失败 (" + xhr.status + ")");
          return;
        }
        settled = true;
        resolve();
      };
      xhr.onerror = function () { fail("网络请求失败"); };
      xhr.ontimeout = function () { fail("请求超时"); };
      xhr.send(JSON.stringify(body));
    });
  }

  function canStreamFetch() {
    return typeof fetch === "function" &&
      typeof Response !== "undefined" &&
      "body" in Response.prototype &&
      typeof ReadableStream !== "undefined" &&
      typeof TextDecoder !== "undefined";
  }

  function postWithFetch(url, body, onEvent) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (response) {
      if (!response.ok) throw new Error("请求失败 (" + response.status + ")");
      if (!response.body || typeof response.body.getReader !== "function") {
        throw new Error("浏览器不支持流式响应");
      }

      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var parser = createParser(onEvent);

      function read() {
        return reader.read().then(function (part) {
          if (part.done) {
            parser.push(decoder.decode());
            parser.finish();
            return;
          }
          parser.push(decoder.decode(part.value, { stream: true }));
          return read();
        });
      }
      return read();
    });
  }

  root.SseClient = {
    createParser: createParser,
    post: function (url, body, onEvent) {
      // Selecting before sending avoids accidentally submitting the expensive
      // grading request twice when fetch exists but streaming responses do not.
      return canStreamFetch()
        ? postWithFetch(url, body, onEvent)
        : postWithXhr(url, body, onEvent);
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
