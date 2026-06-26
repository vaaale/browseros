import "server-only";
import { toProxyPath, PROXY_PREFIX } from "@/lib/proxy-path";

// Rewrites proxied content so a page stays same-origin inside the BOS browser
// iframe: static URLs (src/href/action/poster) and CSS url()/@import are routed
// back through the path-based proxy, and a small runtime shim re-routes the
// page's dynamic fetch()/XHR calls too. Path-based proxying (see proxy-path.ts)
// also makes the browser's own relative resolution (e.g. ES module imports)
// resolve to proxied URLs instead of our app origin.

export function proxify(value: string, base: string): string {
  if (!value) return value;
  const v = value.trim();
  if (/^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i.test(v)) return value;
  if (v.startsWith(PROXY_PREFIX)) return value;
  let abs: string;
  try {
    abs = new URL(v, base).href;
  } catch {
    return value;
  }
  if (!/^https?:\/\//i.test(abs)) return value;
  return toProxyPath(abs);
}

function runtimeShim(base: string): string {
  return `<script>(function(){try{
var BASE=${JSON.stringify(base)};
function tp(a){try{var u=new URL(a);return "/api/proxy/"+u.protocol.replace(":","")+"/"+u.host+u.pathname+u.search;}catch(e){return a;}}
function prox(u){try{if(typeof u!=="string"||!u)return u;if(/^(data:|blob:|javascript:|#|about:)/i.test(u))return u;if(u.indexOf("/api/proxy/")===0)return u;var a=new URL(u,BASE).href;if(/^https?:\\/\\//i.test(a))return tp(a);}catch(e){}return u;}
var of=window.fetch;if(of)window.fetch=function(i,init){try{if(typeof i==="string")i=prox(i);else if(i&&i.url)i=new Request(prox(i.url),i);}catch(e){}return of.call(this,i,init);};
var oo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){try{arguments[1]=prox(u);}catch(e){}return oo.apply(this,arguments);};
}catch(e){}})();</script>`;
}

export function rewriteHtml(html: string, base: string): string {
  let out = html;
  out = out.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");
  out = out.replace(/<base[^>]*>/gi, "");
  out = out.replace(/\b(src|href|action|poster)\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, attr, _q, dq, sq) => {
    const val = dq ?? sq ?? "";
    const r = proxify(val, base);
    return r === val ? m : `${attr}="${r}"`;
  });
  const shim = runtimeShim(base);
  out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => `${m}${shim}`) : shim + out;
  return out;
}

export function rewriteCss(css: string, base: string): string {
  let out = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, url) => {
    const r = proxify(url, base);
    return r === url ? m : `url(${q}${r}${q})`;
  });
  out = out.replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, url) => {
    const r = proxify(url, base);
    return r === url ? m : `@import ${q}${r}${q}`;
  });
  return out;
}
