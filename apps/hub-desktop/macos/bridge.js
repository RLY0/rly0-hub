(() => {
  "use strict";
  const listeners = new Set();
  const native = window.webkit.messageHandlers.rly0Hub;
  const webview = Object.freeze({
    postMessage(message) {
      native.postMessage(message);
    },
    addEventListener(type, listener) {
      if (type === "message" && typeof listener === "function") listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "message") listeners.delete(listener);
    },
  });
  Object.defineProperty(window, "chrome", { value: Object.freeze({ webview }) });
  Object.defineProperty(window, "__rly0HubReceive", {
    value(message) {
      for (const listener of listeners) listener({ data: message });
    },
  });
})();
