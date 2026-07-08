// Serves the BOS iframe SDK as a plain JS file at /__bos/sdk.js.
// Iframe apps load this script to get a promise-based API backed by
// the postMessage broker in IframeApp.tsx. Only capabilities granted
// in app.json are honoured by the parent; the SDK surface is uniform.
export const dynamic = "force-dynamic";

const SDK = `
(function () {
  if (window.__bos) return;

  let _seq = 0;
  const _pending = new Map();

  window.addEventListener("message", function (e) {
    if (!e.data || e.data.__bos_response == null) return;
    const { seq, result, error } = e.data;
    const p = _pending.get(seq);
    if (!p) return;
    _pending.delete(seq);
    if (error) p.reject(new Error(error));
    else p.resolve(result);
  });

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      const seq = ++_seq;
      _pending.set(seq, { resolve, reject });
      window.parent.postMessage({ __bos_call: true, seq, method, params }, "*");
    });
  }

  window.__bos = {
    fs: {
      list:   function (p)    { return call("fs:list",   { path: p }); },
      read:   function (p)    { return call("fs:read",   { path: p }); },
      write:  function (p, c) { return call("fs:write",  { path: p, content: c }); },
      delete: function (p)    { return call("fs:delete", { path: p }); },
    },
    settings: {
      get: function () { return call("settings:get", {}); },
    },
    window: {
      setTitle: function (t) { return call("window:title", { title: t }); },
    },
    notify: function (msg, opts) { return call("notify", { message: msg, ...opts }); },
  };

  window.dispatchEvent(new Event("bos:ready"));
})();
`;

export function GET() {
  return new Response(SDK, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
