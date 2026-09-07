// QQ 机器人 EdgeOne Makers 边缘函数（eo 模式，QQ-only，无微信、无 R2）
// 形态：EdgeOne Makers Edge Functions 约定 = export default function onRequest(context)
//       context.request / context.env（含 KV 绑定 DRAFTS）/ context.waitUntil 由平台注入。
//   不再使用旧版 EO 控制台的 addEventListener('fetch') —— Makers 不支持该入口。
//   无 npm import：Ed25519 / 业务层全部内联（Makers Edge Runtime 不支持 npm 依赖）。
// 与根 worker.js（cf 模式）逻辑同源：图片传图床（imgbed.yufish.cn）、友链写 check-flink 真源（GitHub）、草稿存 KV。
// 路由：本文件置于 edge-functions/[[default]].js，作为全站 catch-all，承载 /qq/callback、/health、/api/* 等全部路径。
export default function onRequest(context) {
  return handle(context.request, context.env, context.waitUntil);
}

async function handle(request, env, waitUntil) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // ---------- QQ 机器人 Webhook 入口 ----------
  if ((env.QQ_CALLBACK_PATH || "/qq/callback") === path && (method === "POST" || method === "GET")) {
    return await handleQQCallback(request, env, url, waitUntil);
  }

  // ---------- 健康检查 / 探活端点（供 UptimeRobot 等外部监控探测）----------
  if (path === "/health" || path === "/healthz") {
    return new Response(
      JSON.stringify({ status: "ok", ts: Date.now(), service: "blog-bot-eo" }),
      { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }
    );
  }

  // QQ 自定义菜单一次性设置：curl https://你的域名/__qqmenu
  if (path === "/__qqmenu") {
    try {
      const res = await qqSetMenu(env, QQ_MENU_ITEMS);
      return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ err: (e && e.message) || String(e) }), { status: 500, headers: { "content-type": "application/json" } });
    }
  }

  // QQ 指令面板一次性设置：curl https://你的域名/__qqpanel
  if (path === "/__qqpanel") {
    try {
      const res = await qqSetPanel(env, QQ_PANEL_ITEMS);
      return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ err: (e && e.message) || String(e) }), { status: 500, headers: { "content-type": "application/json" } });
    }
  }

  // ---------- 告警推送（供 FCL 等 CI 调用）：POST /api/alert { token, text } ----------
  if (path === "/api/alert" && method === "POST") {
    const j = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...QQ_NO_CACHE } });
    try {
      const d = await request.json().catch(() => ({}));
      if (!env.ALERT_TOKEN) return j({ ok: false, error: "ALERT_TOKEN 未配置" }, 503);
      if (!d || d.token !== env.ALERT_TOKEN) return j({ ok: false, error: "unauthorized" }, 401);
      const text = typeof d.text === "string" ? d.text.trim().slice(0, 2000) : "";
      if (!text) return j({ ok: false, error: "missing text" }, 400);
      const openid = (env.QQ_OWNER_OPENID || "").trim();
      if (!openid) return j({ ok: false, error: "QQ_OWNER_OPENID 未配置" }, 500);
      await sendQQMessage(env, openid, text, "");
      return j({ ok: true }, 200);
    } catch (e) {
      return j({ ok: false, error: (e && e.message) || String(e) }, 502);
    }
  }

  // ---------- Waline 评论通知桥接：Waline 的 WEBHOOK 指向这里 ----------
  if (path === "/api/waline" && method === "POST") {
    const j = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...QQ_NO_CACHE } });
    try {
      if (!env.ALERT_TOKEN) return j({ ok: false, error: "ALERT_TOKEN 未配置" }, 503);
      if (url.searchParams.get("token") !== env.ALERT_TOKEN) return j({ ok: false, error: "unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      let c = body;
      if (body && typeof body === "object") {
        if (body.comment && typeof body.comment === "object") c = body.comment;
        else if (body.data && typeof body.data === "object") {
          c = (body.data.comment && typeof body.data.comment === "object") ? body.data.comment : body.data;
        }
      }
      const nick = (c && (c.nick || c.user_id)) || "匿名";
      const mail = (c && c.mail) || "";
      const text = (c && (c.comment || c.text)) || "";
      const page = (c && c.url) || "";
      const status = (c && c.status) || "";
      const authorMail = (env.WALINE_AUTHOR_MAIL || "").trim().toLowerCase();
      if (authorMail && mail && String(mail).toLowerCase() === authorMail) {
        return j({ ok: true, skipped: "author self" }, 200);
      }
      const openid = (env.QQ_OWNER_OPENID || "").trim();
      if (!openid) return j({ ok: false, error: "QQ_OWNER_OPENID 未配置" }, 500);
      let msg = `💬 ${env.SITE_NAME || "博客"} 有新评论\n${nick}${mail ? `(${mail})` : ""} 评论道:\n${text || JSON.stringify(c).slice(0, 300)}`;
      if (page) msg += `\n页面: ${page}`;
      if (status && status !== "approved") msg += `\n状态: ${status}`;
      msg = msg.slice(0, 2000);
      const push = sendQQMessage(env, openid, msg, "").catch((e) => console.error("[waline] QQ 推送失败:", (e && e.message) || e));
      if (waitUntil) waitUntil(push); else await push;
      return j({ ok: true }, 200);
    } catch (e) {
      return j({ ok: false, error: (e && e.message) || String(e) }, 502);
    }
  }

  // 查询告警推送目标：GET /__qqwho?token=<ALERT_TOKEN>
  if (path === "/__qqwho") {
    const j = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...QQ_NO_CACHE } });
    if (!env.ALERT_TOKEN || url.searchParams.get("token") !== env.ALERT_TOKEN) return j({ ok: false, error: "unauthorized" }, 401);
    const kvOpenid = await kvGet(env, "qq_last_openid");
    return j({ ok: true, owner_configured: !!(env.QQ_OWNER_OPENID || "").trim(), last_openid: kvOpenid || null }, 200);
  }

  return new Response("not found", { status: 404 });
}

// =================== 纯 JS Ed25519（RFC 8032，仅依赖 Web Crypto SHA-512）===================
const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n; // 基点阶
const D = ((-121665n % P) + P) % P * _edpow(121666n, P - 2n) % P; // d = -121665/121666 mod P

function _edpow(b, e) {
  b %= P;
  let r = 1n;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
const _edinv = (a) => _edpow(((a % P) + P) % P, P - 2n);

const BY = (4n * _edinv(5n)) % P;
function _xFromY(y) {
  let v = (((y * y - 1n) % P) + P) % P * _edinv((((1n + D * y * y) % P) + P) % P) % P;
  let x = _edpow(v, (P + 3n) / 8n);
  if (x < 0n) x += P;
  if ((x * x - v) % P !== 0n) x = (x * _edpow(2n, (P - 1n) / 4n)) % P;
  if ((x * x - v) % P !== 0n) return null;
  if ((x & 1n) === 1n) x = (P - x) % P;
  return x;
}
const BX = _xFromY(BY);
const ED_B = [BX, BY, 1n, (BX * BY) % P];
const ED_I = [0n, 1n, 1n, 0n];

function _edAdd(p, q) {
  if (!p) return q;
  if (!q) return p;
  const [X1, Y1, Z1, T1] = p;
  const [X2, Y2, Z2, T2] = q;
  const A = (X1 * X2) % P;
  const Bv = (Y1 * Y2) % P;
  const C = (D * T1 * T2) % P;
  const Dd = (Z1 * Z2) % P;
  const E = ((((X1 + Y1) % P) * ((X2 + Y2) % P)) % P - A - Bv) % P;
  const F = (Dd - C) % P;
  const G = (Dd + C) % P;
  const Hh = (Bv + A) % P;
  const X3 = (E * F) % P;
  const Y3 = (G * Hh) % P;
  const T3 = (E * Hh) % P;
  const Z3 = (F * G) % P;
  return [((X3 % P) + P) % P, ((Y3 % P) + P) % P, ((Z3 % P) + P) % P, ((T3 % P) + P) % P];
}
function _scalarMult(k, point) {
  k = ((k % L) + L) % L;
  let r = null;
  let addend = point;
  while (k > 0n) {
    if (k & 1n) r = _edAdd(r, addend);
    addend = _edAdd(addend, addend);
    k >>= 1n;
  }
  return r || ED_I;
}
function _bytesToLE(bytes) {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}
function _leToBytes(n, len) {
  const out = new Uint8Array(len);
  let v = ((n % P) + P) % P;
  for (let i = 0; i < len; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}
let _subtle;
function _getSubtle() {
  if (_subtle) return _subtle;
  if (typeof crypto !== "undefined" && crypto.subtle) _subtle = crypto.subtle;
  else if (typeof require !== "undefined") {
    const nodeCrypto = require("crypto");
    _subtle = { digest: (algo, data) => nodeCrypto.webcrypto.subtle.digest(algo, data) };
  }
  return _subtle;
}
async function _sha512Async(bytes) {
  const buf = await _getSubtle().digest("SHA-512", bytes);
  return new Uint8Array(buf);
}
function concatBytes(...arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function bytesToHex(b) { return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join(""); }
function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
function _clampEd(sk32) {
  sk32[0] &= 248; sk32[31] &= 127; sk32[31] |= 64; return sk32;
}
function _encodePoint(p) {
  const x = ((p[0] * _edinv(p[2])) % P + P) % P;
  const y = ((p[1] * _edinv(p[2])) % P + P) % P;
  const out = _leToBytes(y, 32);
  if (((x & 1n) & 1n) === 1n) out[31] |= 0x80;
  return out;
}
function _decodePoint(bytes) {
  const y = _bytesToLE(bytes) & ((1n << 255n) - 1n);
  const xSign = (bytes[31] >> 7) & 1;
  let x = _xFromY(y);
  if (x === null) return null;
  if (Number(x & 1n) !== xSign) x = (P - x) % P;
  return [x, y, 1n, (x * y) % P];
}
async function edPublicKeyFromSeed(seed) {
  const h = await _sha512Async(seed);
  const s = _clampEd(new Uint8Array(h.slice(0, 32)));
  const a = _bytesToLE(s);
  return _encodePoint(_scalarMult(a, ED_B));
}
async function edSign(message, seed) {
  const h = await _sha512Async(seed);
  const aBytes = _clampEd(new Uint8Array(h.slice(0, 32)));
  const a = _bytesToLE(aBytes);
  const prefix = h.slice(32);
  const A = _encodePoint(_scalarMult(a, ED_B));
  let r = _bytesToLE(await _sha512Async(concatBytes(prefix, message))) % L;
  const R = _encodePoint(_scalarMult(r, ED_B));
  const k = _bytesToLE(await _sha512Async(concatBytes(R, A, message))) % L;
  const S = (r + k * a) % L;
  return concatBytes(R, _leToBytes(S, 32));
}
async function edVerify(signature, message, publicKey) {
  if (signature.length !== 64) return false;
  const R = signature.slice(0, 32);
  const S = _bytesToLE(signature.slice(32));
  if (S >= L) return false;
  const A = _decodePoint(publicKey);
  if (!A) return false;
  const k = _bytesToLE(await _sha512Async(concatBytes(R, publicKey, message))) % L;
  const lhs = _scalarMult(8n * S, ED_B);
  const rhs = _edAdd(_scalarMult(8n, _decodePoint(R)), _scalarMult(8n * k, A));
  if (!lhs || !rhs) return false;
  const lx = ((lhs[0] * _edinv(lhs[2])) % P + P) % P;
  const ly = ((lhs[1] * _edinv(lhs[2])) % P + P) % P;
  const rx = ((rhs[0] * _edinv(rhs[2])) % P + P) % P;
  const ry = ((rhs[1] * _edinv(rhs[2])) % P + P) % P;
  return lx === rx && ly === ry;
}
function edSeedFromAppSecret(appSecret) {
  const s = new TextEncoder().encode(appSecret || "");
  if (s.length === 0) throw new Error("QQ_APP_SECRET 未配置");
  let seed = s;
  while (seed.length < 32) {
    const doubled = new Uint8Array(seed.length * 2);
    doubled.set(seed, 0);
    doubled.set(seed, seed.length);
    seed = doubled;
  }
  return seed.subarray(0, 32);
}

// =================== QQ 适配层 ===================
// 所有回包带 Cache-Control: no-store（QQ op13 签名每请求不同，若 EO 缓存 JSON 回包会时灵时不灵）。
const QQ_NO_CACHE = { "cache-control": "no-store" };

async function qqSignValidation(eventTs, plainToken, appSecret) {
  const seed = edSeedFromAppSecret(appSecret);
  const sig = await edSign(new TextEncoder().encode(eventTs + plainToken), seed);
  return bytesToHex(sig);
}
async function qqVerifyEvent(rawBody, sigHex, ts, appSecret) {
  try {
    const seed = edSeedFromAppSecret(appSecret);
    const pub = await edPublicKeyFromSeed(seed);
    const sig = hexToBytes(sigHex);
    if (sig.length !== 64) return false;
    return await edVerify(sig, new TextEncoder().encode(ts + rawBody), pub);
  } catch { return false; }
}
async function getQQToken(env) {
  const cached = await kvGet(env, "qq_token", true);
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const r = await fetch("https://bots.qq.com/app/getAppAccessToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: env.QQ_APPID, clientSecret: env.QQ_APP_SECRET }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error("QQ token 获取失败: " + JSON.stringify(j));
  await kvPut(env, "qq_token", { token: j.access_token, exp: Date.now() + (j.expires_in || 7200) * 1000 }, true);
  return j.access_token;
}
async function fetchQQImageBytes(url, env) {
  const token = await getQQToken(env);
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 8000);
  let r;
  try {
    r = await fetch(url, { headers: { Authorization: `QQBot ${token}` }, signal: ac.signal });
  } catch (e) {
    clearTimeout(to);
    throw new Error("QQ 图片拉取网络失败: " + (e && e.name === "AbortError" ? "timeout(8s)" : (e && e.message)));
  }
  clearTimeout(to);
  if (!r.ok) throw new Error("QQ 图片拉取失败 HTTP " + r.status);
  return new Uint8Array(await r.arrayBuffer());
}
async function sendQQMessage(env, openid, content, msgId) {
  const token = await getQQToken(env);
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 8000);
  const body = { content, msg_type: 0 };
  if (msgId) body.msg_id = msgId;
  let r;
  try {
    r = await fetch(`https://api.bot.qq.com/v2/users/${openid}/messages`, {
      method: "POST",
      headers: { Authorization: `QQBot ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(to);
    throw new Error("QQ 发消息网络失败: " + (e && e.name === "AbortError" ? "timeout(8s)" : (e && e.message)));
  }
  clearTimeout(to);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("QQ 发消息失败: HTTP " + r.status + " " + JSON.stringify(j).slice(0, 200));
  if ((j.err_code && j.err_code !== 0) || (j.code && j.code !== 0)) throw new Error("QQ 发消息失败: " + JSON.stringify(j).slice(0, 200));
  return j;
}
async function qqSetMenu(env, items) {
  const token = await getQQToken(env);
  const r = await fetch("https://api.bot.qq.com/v2/menu", {
    method: "PUT",
    headers: { Authorization: `QQBot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ menu: { items } }),
  });
  const j = await r.json().catch(() => ({ status: r.status }));
  return { status: r.status, body: j };
}
const QQ_MENU_ITEMS = [
  { type: "send_message", name: "帮助", send_message: "/帮助" },
  { type: "send_message", name: "加友链", send_message: "/友链 " },
  { type: "link", name: "我的博客", link: "https://blog.x1anyu.cn" },
  { type: "menu", name: "更多", sub_menu_items: [
    { type: "send_message", name: "查草稿", send_message: "/草稿" },
  ] },
];
async function qqSetPanel(env, items) {
  const token = await getQQToken(env);
  const r = await fetch("https://api.bot.qq.com/v2/panels", {
    method: "POST",
    headers: { Authorization: `QQBot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "c2c", target_type: "all", panel: { items, remark: "blog-bot C2C 面板" } }),
  });
  const j = await r.json().catch(() => ({ status: r.status }));
  return { status: r.status, body: j };
}
const QQ_PANEL_ITEMS = [
  { type: "command", name: "/帮助", desc: "查看全部指令与用法" },
  { type: "command", name: "/友链", desc: "添加友链到博客" },
  { type: "command", name: "/草稿", desc: "查看当前草稿内容" },
  { type: "link", name: "我的博客", desc: "前往博客首页", link: "https://blog.x1anyu.cn" },
];

async function handleQQCallback(request, env, url, waitUntil) {
  try {
    let payload = {};
    let rawBody = "";
    if (request.method === "GET") {
      const pt = url.searchParams.get("plain_token");
      const ets = url.searchParams.get("event_ts") || "";
      if (pt) payload = { op: 13, d: { plain_token: pt, event_ts: ets } };
    } else {
      rawBody = await request.text();
      try { payload = JSON.parse(rawBody); } catch { return new Response("bad json", { status: 400, headers: QQ_NO_CACHE }); }
    }

    // (a) 回调地址验证（op 13）：用 (event_ts + plain_token) 签名回包。op13 本身即握手，切勿做 X-Signature 验签。
    if (payload.op === 13 || (payload.d && payload.d.plain_token)) {
      const plain = payload.d.plain_token;
      const eventTs = String(payload.d.event_ts != null ? payload.d.event_ts : (url.searchParams.get("event_ts") || ""));
      const signature = await qqSignValidation(eventTs, plain, env.QQ_APP_SECRET);
      return new Response(JSON.stringify({ plain_token: plain, signature }), {
        status: 200, headers: { "content-type": "application/json", ...QQ_NO_CACHE },
      });
    }

    // (b) 事件推送（op 0 / 带 t 字段）才做 Ed25519 验签，防伪造。
    if (payload.op === 0 || payload.t) {
      const sigHead = request.headers.get("X-Signature-Ed25519");
      const tsHead = request.headers.get("X-Signature-Timestamp");
      if (sigHead && tsHead) {
        const ok = await qqVerifyEvent(rawBody, sigHead, tsHead, env.QQ_APP_SECRET);
        if (!ok) return new Response("invalid signature", { status: 401, headers: QQ_NO_CACHE });
      }
    }

    // (c) C2C 单聊消息：复用 dispatch。用 waitUntil 把 dispatch+发消息挪到后台，回调立即回 200。
    if (payload.t === "C2C_MESSAGE_CREATE" && payload.d) {
      const d = payload.d;
      const imgs = Array.isArray(d.attachments) ? d.attachments.filter((a) => (a.content_type || "").startsWith("image/")) : [];
      if (imgs.length) {
        const a = imgs[0];
        const imgUrl = a.url;
        const filename = a.filename || "image.png";
        const mime = a.content_type || "image/png";
        waitUntil((async () => {
          try {
            if (env.DRAFTS) await kvPut(env, "qq_last_openid", d.author.user_openid);
            const bytes = await fetchQQImageBytes(imgUrl, env);
            const m = { msgType: "image", source: "qq", imageBytes: bytes, filename, mime, fromUser: d.author.user_openid };
            const reply = await dispatch(env, m);
            if (reply) await sendQQMessage(env, d.author.user_openid, reply, d.id);
          } catch (e) {
            console.error("[QQ] image handle error:", e && e.message);
            try { await sendQQMessage(env, d.author.user_openid, "图片上传失败：" + ((e && e.message) || "").slice(0, 100), d.id); } catch {}
          }
        })());
        return new Response("ok", QQ_NO_CACHE);
      }
      if (d.message_type !== 0) return new Response("ok", QQ_NO_CACHE);
      const m = { msgType: "text", content: d.content || "", fromUser: d.author.user_openid };
      waitUntil((async () => {
        try {
          if (env.DRAFTS) await kvPut(env, "qq_last_openid", d.author.user_openid);
        } catch {}
        try {
          const reply = await dispatch(env, m);
          if (reply) await sendQQMessage(env, d.author.user_openid, reply, d.id);
        } catch (e) {
          console.error("[QQ] C2C handle error:", e && e.message);
        }
      })());
      return new Response("ok", QQ_NO_CACHE);
    }
    return new Response("ok", QQ_NO_CACHE);
  } catch (e) {
    const info = (e && e.message) ? e.message : String(e);
    console.error("QQ callback error:", info);
    return new Response("qq internal: " + info, { status: 200, headers: QQ_NO_CACHE });
  }
}

// =================== 业务层（与 src/shared.js 同源，KV 用 kvGet/kvPut/kvDelete）===================
const FIELD_ALIASES = {
  title: "title", "标题": "title",
  published: "published", "日期": "published", "发布日期": "published",
  updated: "updated", "更新": "updated", "更新日期": "updated",
  description: "description", "描述": "description", "摘要": "description",
  image: "image", "封面": "image", "封面图": "image",
  tags: "tags", "标签": "tags",
  category: "category", "分类": "category",
  slug: "slug", "链接": "slug", "路径": "slug",
  pinned: "pinned", "置顶": "pinned",
  draft: "draft", "草稿": "draft",
  password: "password", "密码": "password",
  passwordHint: "passwordHint", "密码提示": "passwordHint",
  location: "location", "位置": "location", "地点": "location",
};

const HELP_TEXT = `📖 指令速查
• 写博文：直接发文字（用「键: 值」写属性，其余当正文，正文支持 Markdown 如 [文字](链接)）。可直接发图片（自动传图床、塞进草稿）。链接写图也支持：封面「封面：https://…」、正文插图「![说明](https://…)」
• /done · /发布      发布并清空草稿
• /取消 · /清空      只丢草稿、不发布
• /修改              把当前正文返回给你，下一条消息整体替换（从头重新算）
• /动态 · /文章      切到动态 / 文章模式
• /tags 旅行 随笔     改标签（留空则清空，回退默认 [随笔]）
• /状态              看当前写作模式 / 已攒字数 / 属性 / 图片链接
• /部署模式          看当前部署架构（cf / eo）
• /友链   进入友链模式，之后直接发「站点名称：… 站点链接：…」整块即自动解析添加（也支持 /友链 站点名称：… 一次发完；发 /取消 退出）
• /预览 · /浏览       看将要发布的 Markdown 全文（含图片，不真发）
• /删图 · /delimg     发错图时撤掉草稿里最后一张，并（图床配了 token）同步从图床删掉
• /帮助              就是这条
• 标记（@提及 / #话题标签）目前不可用，正文直接写文字即可

属性写法（中英文都认）：
  标题：西湖半日闲   描述：一句话摘要
  标签：旅行 随笔    分类：生活
  封面：https://…    置顶：是   草稿：是
  日期：2026-08-13   链接：my-url   密码：1234
  正文插图：![说明](https://…)   （也可直接发图，会自动传图床塞进草稿）

动态模式：发 /动态 后直接写内容，/done 发到动态页（支持 置顶：是 / 位置：广西，中英文 key 都认）`;

function parseFrontmatter(text) {
  const fields = {};
  const bodyLines = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "---" || line === "...") continue;
    const m = line.match(/^(\S+?)[:：]\s*(.*)$/);
    if (m) {
      const canon = FIELD_ALIASES[m[1]] || FIELD_ALIASES[m[1].toLowerCase()];
      if (canon) {
        const v = m[2].trim();
        if (canon === "tags") {
          fields.tags = v.split(/[\s,，、]+/).filter(Boolean);
        } else if (canon === "pinned" || canon === "draft") {
          fields[canon] = /^(是|true|yes|1|开|置顶|草稿)$/i.test(v);
        } else {
          fields[canon] = v;
        }
        continue;
      }
    }
    bodyLines.push(raw);
  }
  return { fields, body: bodyLines.join("\n") };
}

async function dispatch(env, m) {
  if (m.msgType === "text" && (m.content === "/done" || m.content === "/发布")) {
    return await publish(env, m.fromUser);
  }
  if (m.msgType === "text" && m.content.startsWith("/tags")) {
    const raw = m.content.slice(5).trim();
    const tags = raw ? raw.split(/\s+/).filter(Boolean) : [];
    await appendDraft(env, m.fromUser, { tags });
    return tags.length ? "已设置标签 🏷️：" + tags.join("、") : "已清空标签（将回退默认 [随笔]）";
  }
  if (m.msgType === "text" && (m.content === "/动态" || m.content === "/dynamic" || m.content === "/d")) {
    await appendDraft(env, m.fromUser, { mode: "dynamic" });
    return "已切换到动态模式 💬（发内容后 /done 发布到 src/content/dynamic）";
  }
  if (m.msgType === "text" && (m.content === "/文章" || m.content === "/post")) {
    await appendDraft(env, m.fromUser, { mode: "post" });
    return "已切回文章模式 📝";
  }
  if (m.msgType === "text" && (m.content === "/取消" || m.content === "/清空" || m.content === "/cancel" || m.content === "/reset")) {
    await kvDelete(env, m.fromUser);
    return "草稿已丢弃 🗑️（下次从头开始写）";
  }
  if (m.msgType === "text" && (m.content === "/修改" || m.content === "/edit" || m.content === "/xiugai")) {
    const d = (await kvGet(env, m.fromUser, true)) || null;
    const hasText = d && d.text && d.text.trim();
    const hasImg = d && d.images && d.images.length;
    if (!hasText && !hasImg) return "还没有草稿可修改，先发文字攒一篇。";
    await appendDraft(env, m.fromUser, { overwrite: true });
    const body = (d.text || "").trim();
    const fieldKeys = Object.keys(d.fields || {});
    let s = `📝 当前正文如下，直接回复即可整体替换（从头重新算）：\n\n${body || "（暂无文字，只有图片）"}`;
    if (hasImg) {
      s += `\n\n当前已附 ${d.images.length} 张图（/done 会随正文带出，/删图 可撤掉最后一张）：`;
      for (const u of d.images) s += `\n${u}`;
    }
    if (fieldKeys.length) s += `\n\n当前属性：${fieldKeys.join("、")}（回复里重写会更新，不写则保留）`;
    s += `\n\n（回复后此标记自动清除；想放弃就发 /取消）`;
    return s;
  }
  if (m.msgType === "text" && (m.content === "/帮助" || m.content === "/help" || m.content === "/h" || m.content === "/?")) {
    return HELP_TEXT;
  }
  if (m.msgType === "text" && (m.content === "/部署模式" || m.content === "/mode" || m.content === "/deploymode")) {
    const mode = (env.DEPLOY_MODE || "cf").toLowerCase();
    const modeLabel = mode === "cf" ? "Cloudflare" : mode === "eo" ? "EdgeOne" : "未知";
    return `🛰️ 当前部署模式：${modeLabel}`;
  }
  if (m.msgType === "text") {
    const flm = m.content.match(/^\/(友链|friend|fl)(?:\s|$)([\s\S]*)$/);
    if (flm) {
      const rest = flm[2].trim();
      if (!rest) {
        const d = (await kvGet(env, m.fromUser, true)) || { mode: "post" };
        if (d.mode === "friendlink") {
          await appendDraft(env, m.fromUser, { mode: "post" });
          return "已退出友链模式 ↩️（回到文章模式）";
        }
        await appendDraft(env, m.fromUser, { mode: "friendlink" });
        return "已进入友链模式 🔗\n直接发友链信息块即可自动解析添加，标签支持：站点名称 / 头像链接 / 站点描述 / 站点链接 / 站点友链 / 站点RSS（也兼容 名称/链接/头像/描述 等写法）。\n继续发下一条可连续添加；发 /取消 或再发 /友链 退出。也可一步到位：/友链 站点名称：xxx 站点链接：xxx";
      }
      return await handleFriendLink(env, m.content, m.fromUser);
    }
  }
  if (m.msgType === "text" && (m.content === "/状态" || m.content === "/status")) {
    const d = (await kvGet(env, m.fromUser, true)) || null;
    const hasContent = d && ((d.text && d.text.trim()) || (d.images && d.images.length) || (d.fields && Object.keys(d.fields).length));
    if (!hasContent) return "当前没有草稿。发文字开始写，攒齐后 /done 发布。";
    const mode = d.mode === "dynamic" ? "动态" : "文章";
    const textLen = (d.text || "").replace(/\s/g, "").length;
    const fieldKeys = Object.keys(d.fields || {});
    let s = `模式：${mode}\n草稿：已攒 ${textLen} 字 / ${(d.images || []).length} 张图`;
    if (fieldKeys.length) s += `\n属性：${fieldKeys.join("、")}`;
    s += `\n（/预览 看全文 · /取消 丢弃 · /done 发布）`;
    return s;
  }
  if (m.msgType === "text" && (m.content === "/预览" || m.content === "/preview" || m.content === "/yulan" || m.content === "/y" || m.content === "/浏览" || m.content === "/liulan")) {
    const d = (await kvGet(env, m.fromUser, true)) || { text: "", images: [], tags: undefined, fields: {}, mode: "post" };
    if (!d.text.trim() && (!d.images || !d.images.length)) return "草稿还是空的，先发文字或图片，再 /预览。";
    const now = new Date();
    const fmt = (env.FILENAME_FORMAT || "title").toLowerCase();
    const title = ((d.fields && d.fields.title) || d.text.trim().split("\n")[0] || "随笔").slice(0, 60);
    const { file } = makeFileMeta(now, d.mode, title, fmt);
    const { md } = buildDraftMarkdown(env, d, localDate(now), file);
    const preview = md.length > 1500 ? md.slice(0, 1500) + "\n…（已截断，完整内容以 /done 发布为准）" : md;
    return `📄 即将发布的 Markdown：\n${preview}\n\n（确认无误发 /done 真正发布）`;
  }
  if (m.msgType === "text" && (m.content === "/删图" || m.content === "/delimg" || m.content === "/撤销图" || m.content === "/rmimg")) {
    const d = (await kvGet(env, m.fromUser, true)) || { text: "", images: [] };
    if (!d.images || !d.images.length) return "草稿里没有图片可删 🤔";
    const removed = d.images.pop();
    await kvPut(env, m.fromUser, d, true);
    let bed = "";
    try {
      if (env.IMG_BED_TOKEN || env.IMG_BED_AUTH) {
        await deleteFromImageBed(env, removed);
        bed = "，并已从图床删除 ✅";
      } else {
        bed = "（图床未配置 token，仅移出草稿，文件仍留在图床）";
      }
    } catch (e) {
      bed = "（图床删除失败：" + ((e && e.message) || String(e)).slice(0, 100) + "，仅移出草稿）";
    }
    return "🗑️ 已移除最后一张图片" + bed;
  }
  if (m.msgType === "text") {
    const d = (await kvGet(env, m.fromUser, true)) || { text: "", images: [], fields: {}, mode: "post" };
    if (d.mode === "friendlink") return await handleFriendLink(env, m.content, m.fromUser);
    const { fields, body } = parseFrontmatter(m.content);
    if (d.overwrite) {
      await appendDraft(env, m.fromUser, { text: body ? body + "\n" : "", fields, overwriteText: true, overwrite: false });
      let reply = "已用新正文整体替换 ✅（从头重新算）";
      const keys = Object.keys(fields);
      if (keys.length) reply += "\n识别到属性：" + keys.join("、");
      if (!body.trim()) reply += "\n（本条无正文）";
      return reply;
    }
    const patch = {};
    if (body.trim()) patch.text = body + "\n";
    if (Object.keys(fields).length) patch.fields = fields;
    await appendDraft(env, m.fromUser, patch);
    let reply = "已记录 ✍️";
    const keys = Object.keys(fields);
    if (keys.length) reply += "\n识别到属性：" + keys.join("、");
    if (!body.trim()) reply += "\n（本条无正文）";
    return reply;
  }
  if (m.msgType === "image") {
    if (!m.imageBytes) return "图片暂不支持直接发 🚫\n图片请用链接写：封面「封面：https://…」、正文插图「![说明](https://…)」";
    try {
      const url = await uploadToImageBed(env, m.imageBytes, m.filename, m.mime);
      await appendDraft(env, m.fromUser, { images: [url] });
      return "📤 图片已上传图床并加入草稿 ✅\n链接：" + url + "\n（可直贴博客正文：" + "![" + (m.filename || "image") + "](" + url + ")；/done 发布时也会随文章带出）";
    } catch (e) {
      return "❌ 图片上传图床失败：" + ((e && e.message) || String(e)).slice(0, 140);
    }
  }
  return "暂不支持该类型";
}

function slugifyTitle(t) {
  return String(t || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/^-+|-+$/g, "") || "随笔";
}
function localDate(now) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
function makeFileMeta(now, mode, title, fmt) {
  if (mode === "dynamic") {
    const ld = localDate(now);
    const lt = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return { file: `${ld}-${lt}.md`, urlSlug: `${ld}-${lt}` };
  }
  const slug = slugifyTitle(title);
  if (fmt === "date") {
    const d = localDate(now);
    return { file: `${d}-${slug}.md`, urlSlug: `${d}-${slug}` };
  }
  return { file: `${slug}.md`, urlSlug: slug };
}
function buildDraftMarkdown(env, draft, publishedDate, file) {
  const mode = draft.mode === "dynamic" ? "dynamic" : "post";
  const f = draft.fields || {};
  const now = new Date();
  const bodyText = draft.text.trim();

  if (mode === "dynamic") {
    const dt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const fm = [`published: ${f.published || dt}`];
    if (typeof f.pinned === "boolean") fm.push(`pinned: ${f.pinned}`);
    if (f.location) fm.push(`location: "${f.location.replace(/"/g, '\\"')}"`);
    let body = bodyText;
    for (const u of draft.images) body += `\n\n![image](${u})`;
    const md = `---\n${fm.join("\n")}\n---\n\n${body}\n`;
    const path = `${env.GH_DYNAMIC_PATH || "src/content/dynamic"}/${file}`;
    return { md, path };
  }

  const title = (f.title || bodyText.split("\n")[0] || "随笔").slice(0, 60);
  const fm = [];
  fm.push(`title: "${title.replace(/"/g, '\\"')}"`);
  fm.push(`published: ${f.published || publishedDate}`);
  let desc;
  if (f.description) desc = f.description;
  else if (f.title) desc = bodyText.split("\n")[0] || title;
  else desc = bodyText.split("\n").slice(1).join(" ").trim() || title;
  fm.push(`description: "${String(desc).slice(0, 80).replace(/"/g, '\\"')}"`);
  if (f.image) fm.push(`image: "${f.image.replace(/"/g, '\\"')}"`);
  else fm.push(`image: api`);
  const tags = Array.isArray(f.tags) ? f.tags : (Array.isArray(draft.tags) ? draft.tags : ["随笔"]);
  fm.push(`tags: [${tags.map((t) => `"${String(t).replace(/"/g, '\\"')}"`).join(", ")}]`);
  if (f.category) fm.push(`category: "${f.category.replace(/"/g, '\\"')}"`);
  if (f.slug) fm.push(`slug: "${f.slug.replace(/"/g, '\\"')}"`);
  if (f.updated) fm.push(`updated: ${f.updated}`);
  if (typeof f.pinned === "boolean") fm.push(`pinned: ${f.pinned}`);
  if (typeof f.draft === "boolean") fm.push(`draft: ${f.draft}`);
  if (f.password) fm.push(`password: "${f.password.replace(/"/g, '\\"')}"`);
  if (f.passwordHint) fm.push(`passwordHint: "${f.passwordHint.replace(/"/g, '\\"')}"`);

  let md = `---\n${fm.join("\n")}\n---\n\n`;
  md += bodyText + "\n";
  for (const u of draft.images) md += `\n![image](${u})\n`;

  const path = `${env.GH_PATH}/${file}`;
  return { md, path };
}
async function publish(env, user) {
  const draft = (await kvGet(env, user, true)) || { text: "", images: [], tags: undefined, fields: {}, mode: "post" };
  const now = new Date();
  const fmt = (env.FILENAME_FORMAT || "title").toLowerCase();
  const f = draft.fields || {};
  const bodyText = draft.text.trim();
  const title = (f.title || bodyText.split("\n")[0] || "随笔").slice(0, 60);
  const { file, urlSlug } = makeFileMeta(now, draft.mode, title, fmt);
  const { md, path } = buildDraftMarkdown(env, draft, localDate(now), file);
  let commitMsg;
  if (draft.mode === "dynamic") {
    const firstLine = bodyText.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "新动态";
    commitMsg = `发布了一条新动态：${firstLine.slice(0, 40)}`;
  } else {
    commitMsg = `发布了一篇新博文：${title}`;
  }
  await githubPut(env, path, md, commitMsg);
  await kvDelete(env, user);
  if (draft.mode === "dynamic") return `动态已发布 💬\n稍等约 1 分钟部署完成后到动态页查看。`;
  const finalSlug = (f.slug && f.slug.trim()) ? f.slug.trim() : urlSlug;
  const postUrl = `${env.SITE_URL.replace(/\/$/, "")}/posts/${finalSlug}`;
  return `文章已发布 🎉\n稍等约 1 分钟部署完成后访问：\n${postUrl}`;
}
async function appendDraft(env, user, patch) {
  const d = (await kvGet(env, user, true)) || { text: "", images: [] };
  if (patch.overwriteText) d.text = patch.text || "";
  else if (patch.text) d.text += patch.text;
  if (patch.images) d.images.push(...patch.images);
  if (patch.tags) d.tags = patch.tags;
  if (patch.fields) d.fields = Object.assign(d.fields || {}, patch.fields);
  if (patch.mode) d.mode = patch.mode;
  if (typeof patch.overwrite === "boolean") d.overwrite = patch.overwrite;
  await kvPut(env, user, d, true);
}
async function githubPutTo(env, owner, repo, branch, path, content, message) {
  const api = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const headers = { Authorization: `Bearer ${env.GH_TOKEN}`, "Content-Type": "application/json", "User-Agent": "blog-bot" };
  const existing = await fetch(`${api}?ref=${branch}`, { headers });
  const body = { message, content: b64(content), branch };
  if (existing.ok) { try { body.sha = (await existing.json()).sha; } catch {} }
  const res = await fetch(api, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error("github put failed (" + repo + "/" + path + "): " + (await res.text()));
}
async function githubGetFrom(env, owner, repo, branch, path) {
  const api = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
  const headers = { Authorization: `Bearer ${env.GH_TOKEN}`, "User-Agent": "blog-bot" };
  const r = await fetch(api, { headers });
  if (!r.ok) throw new Error("github get failed (" + repo + "/" + path + "): " + r.status);
  const j = await r.json();
  const bin = atob((j.content || "").replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
async function githubPut(env, path, content, message) {
  await githubPutTo(env, env.GH_OWNER, env.GH_REPO, env.GH_BRANCH, path, content, message);
}
async function githubGet(env, path) {
  return await githubGetFrom(env, env.GH_OWNER, env.GH_REPO, env.GH_BRANCH, path);
}
function flRepo(env) {
  return {
    owner: env.FL_OWNER || env.GH_OWNER,
    repo: env.FL_REPO || "check-flink",
    branch: env.FL_BRANCH || "main",
    path: env.FL_PATH || "static/friends.json",
  };
}
async function readCheckFlink(env) {
  const { owner, repo, branch, path } = flRepo(env);
  try {
    const raw = await githubGetFrom(env, owner, repo, branch, path);
    const d = JSON.parse(raw);
    if (d && Array.isArray(d.friends)) return d;
    return { version: (d && d.version) || 1, updatedAt: localDate(new Date()), friends: [] };
  } catch (e) {
    return { version: 1, updatedAt: localDate(new Date()), friends: [] };
  }
}
async function flAppendFriend(env, entry, baseData) {
  const { owner, repo, branch, path } = flRepo(env);
  const data = (baseData && Array.isArray(baseData.friends)) ? baseData : { version: 1, updatedAt: localDate(new Date()), friends: [] };
  const list = data.friends;
  const idx = list.findIndex((x) => (x.link || x.siteurl) === entry.link);
  let action;
  if (idx >= 0) {
    const prev = list[idx];
    list[idx] = Object.assign({}, entry);
    if (prev.verified !== undefined) list[idx].verified = prev.verified;
    action = "更新";
  } else {
    list.push(entry);
    action = "添加";
  }
  list.sort((a, b) => (b.weight || 0) - (a.weight || 0));
  data.updatedAt = localDate(new Date());
  await githubPutTo(env, owner, repo, branch, path, JSON.stringify(data, null, 2), `${action}友链：${entry.name}`);
  return action;
}
function parseFriendFields(text) {
  const MAP = {
    title: ["title", "名称", "名字", "站点名", "站点名称", "博客名", "站名", "name"],
    siteurl: ["siteurl", "link", "url", "链接", "网址", "网站", "博客地址", "站点", "站点链接"],
    imgurl: ["imgurl", "img", "avatar", "头像", "头像链接", "logo", "图标", "图像"],
    desc: ["desc", "description", "描述", "站点描述", "简介", "介绍", "说明"],
    tags: ["tags", "tag", "标签", "分类"],
    weight: ["weight", "权重", "排序", "w"],
    linkpage: ["linkpage", "友链页", "站点友链", "反链页", "反链", "互链页", "友链页面"],
    rss: ["rss", "订阅", "feed", "站点rss", "站点RSS", "rss地址", "订阅地址"],
    enabled: ["enabled", "enable", "启用", "是否启用"],
  };
  const keyToField = {};
  for (const [field, keys] of Object.entries(MAP)) keys.forEach((k) => (keyToField[k.toLowerCase()] = field));
  const raw = {};
  const re = /([^\s:：]+)\s*[:：]\s*([\s\S]*?)(?=\s+[^\s:：]+\s*[:：]|\s*$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (keyToField[key] && val) raw[keyToField[key]] = val;
  }
  if (raw.tags) raw.tags = raw.tags.split(/[\s,，、]+/).filter(Boolean);
  if (raw.weight) raw.weight = parseInt(raw.weight, 10) || 0;
  if (raw.enabled !== undefined) {
    const ev = String(raw.enabled).toLowerCase().trim();
    raw.enabled = ["true", "1", "yes", "是", "开", "启用"].includes(ev);
  }
  return raw;
}
function normalizeJsonFriend(o) {
  const pick = (...ks) => {
    for (const k of ks) {
      const v = o[k];
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return undefined;
  };
  const rawTags = pick("tags", "标签");
  const rawEnabled = pick("enabled", "enable", "启用");
  const rawWeight = pick("weight", "权重");
  return {
    title: pick("title", "name", "名称", "站点名称", "博客名"),
    siteurl: pick("siteurl", "link", "url", "链接", "网址"),
    imgurl: pick("imgurl", "avatar", "头像", "logo", "图标"),
    desc: pick("desc", "description", "描述", "简介"),
    tags: Array.isArray(rawTags) ? rawTags.map(String) : (typeof rawTags === "string" && rawTags.trim() ? rawTags.split(/[\s,，、]+/).filter(Boolean) : undefined),
    weight: rawWeight !== undefined ? (parseInt(rawWeight, 10) || 0) : undefined,
    enabled: rawEnabled !== undefined ? (rawEnabled === true || rawEnabled === "true" || rawEnabled === 1 || rawEnabled === "1" || rawEnabled === "是") : undefined,
    linkpage: pick("linkpage", "友链页", "反链页", "互链页"),
    rss: pick("rss", "feed", "订阅", "订阅地址"),
  };
}
async function handleFriendLink(env, text, fromUser) {
  const body = String(text || "").replace(/^\/友链\s*|^友链\s*|^friend\s*|^fl\s*/i, "").trim();
  if (!body) {
    return "📝 友链添加格式（顺序、换行随意，名称和链接必填）：\n名称：张三的博客\n链接：https://zhangsan.com\n头像：https://…（可选）\n描述：一句话简介（可选）\n标签：生活 技术（可选，默认 Blog）\n权重：5（可选，默认 5，越大越靠前）\n启用：是（可选，默认启用，写「否」可禁用）\n友链页：https://…（可选，反链检测用）\nRSS：https://…/rss.xml（可选）\n\n直接发「/友链 名称：xxx 链接：xxx」即可添加/更新。\n\n也支持直接粘贴 JSON 友链对象：\n{ \"name\": \"站点名\", \"link\": \"https://...\", \"avatar\": \"https://...\", \"desc\": \"简介\", \"tags\": [\"Blog\"], \"weight\": 5, \"enabled\": true, \"linkpage\": \"https://.../friends\", \"rss\": \"\" }";
  }
  let f = null;
  if (body.startsWith("{") && body.endsWith("}")) {
    try {
      const obj = JSON.parse(body);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) f = normalizeJsonFriend(obj);
    } catch (_) {}
  }
  if (!f) f = parseFriendFields(body);
  if (!f.title || !f.siteurl) return "❌ 名称和链接是必填的。例：/友链 名称：张三 链接：https://zhangsan.com";
  if (!env.GH_TOKEN) return "❌ GitHub 凭证未配置（GH_TOKEN 缺失），无法写入友链真源。";
  // 默认头像：R2 已弃用，用自包含占位 SVG
  const DEFAULT_AVATAR = env.FRIEND_DEFAULT_AVATAR || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect width='80' height='80' fill='%23d9d9d9'/%3E%3Ctext x='50%25' y='52%25' font-size='38' text-anchor='middle' fill='%23ffffff'%3E%3F%3C/text%3E%3C/svg%3E";
  const data = await readCheckFlink(env);
  const entry = {
    name: f.title,
    link: f.siteurl,
    avatar: f.imgurl || DEFAULT_AVATAR,
    linkpage: f.linkpage || undefined,
    verified: false,
    rss: f.rss || "",
    desc: f.desc || "暂无简介",
    tags: Array.isArray(f.tags) ? f.tags : ["Blog"],
    enabled: f.enabled !== undefined ? f.enabled : true,
    weight: typeof f.weight === "number" && f.weight > 0 ? f.weight : 5,
  };
  // 仅写 check-flink 真源（不再写 R2）
  let action = "添加";
  try {
    action = await flAppendFriend(env, entry, data);
  } catch (e) {
    return "❌ 写入友链真源（check-flink）失败：" + ((e && e.message) || String(e)) + "\n请确认 GH_TOKEN 对 check-flink 仓库有写权限。";
  }
  const friendPage = (env.FRIEND_PAGE_URL || "https://x1anyu.cn/friends/").trim();
  return `✅ 友链已${action}：${f.title}\n${f.siteurl}\n浏览链接：${friendPage}`;
}
async function uploadToImageBed(env, bytes, filename, mime) {
  if (!env.IMG_BED_TOKEN && !env.IMG_BED_AUTH) throw new Error("图床未配置：需 IMG_BED_TOKEN（或 IMG_BED_AUTH）");
  const base = (env.IMG_BED_URL || "https://cfbed.sanyue.de").replace(/\/$/, "");
  let url = `${base}/upload?returnFormat=full`;
  if (env.IMG_BED_CHANNEL) url += `&uploadChannel=${encodeURIComponent(env.IMG_BED_CHANNEL)}`;
  if (env.IMG_BED_AUTH) url += `&authCode=${encodeURIComponent(env.IMG_BED_AUTH)}`;
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: mime || "application/octet-stream" }), filename || "image.png");
  const headers = {};
  if (env.IMG_BED_TOKEN) headers["Authorization"] = `Bearer ${env.IMG_BED_TOKEN}`;
  const r = await fetch(url, { method: "POST", headers, body: fd });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error("图床 HTTP " + r.status + " " + txt.slice(0, 200));
  }
  const j = await r.json().catch(() => null);
  const arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : (j ? [j] : []));
  const item = arr[0] || null;
  if (!item) throw new Error("图床返回无数据: " + JSON.stringify(j).slice(0, 200));
  let publicUrl = item.publicUrl;
  if (!publicUrl && item.src) publicUrl = item.src.startsWith("http") ? item.src : base + item.src;
  if (!publicUrl) throw new Error("图床返回无 publicUrl: " + JSON.stringify(item).slice(0, 200));
  return publicUrl;
}
async function deleteFromImageBed(env, publicUrl) {
  const u = (() => { try { return new URL(publicUrl); } catch { return null; } })();
  if (!u) throw new Error("图床删除：URL 非法");
  let path = decodeURIComponent(u.pathname).replace(/^\/file\//, "").replace(/^\/+/, "");
  if (!path) throw new Error("图床删除：无法从 URL 解析路径");
  const base = (env.IMG_BED_URL || "https://cfbed.sanyue.de").replace(/\/$/, "");
  let delUrl = `${base}/api/manage/delete/${encodeURIComponent(path)}`;
  const headers = {};
  if (env.IMG_BED_TOKEN) headers["Authorization"] = `Bearer ${env.IMG_BED_TOKEN}`;
  if (env.IMG_BED_AUTH) delUrl += `?authCode=${encodeURIComponent(env.IMG_BED_AUTH)}`;
  let r = await fetch(delUrl, { method: "DELETE", headers });
  if (!r.ok) r = await fetch(delUrl, { method: "GET", headers });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error("HTTP " + r.status + " " + txt.slice(0, 150));
  }
}
function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
function pad(n) { return String(n).padStart(2, "0"); }

// =================== EdgeOne KV 适配层 ===================
// EO 的 KV 绑定（变量名 DRAFTS）get 返回字符串；CF 的 DRAFTS.get(key,{type:"json"}) 直接返回对象。
// 这里包一层，使业务代码与 CF Worker 完全同源（不改一行业务逻辑）。
async function kvGet(env, key, json = false) {
  const v = await env.DRAFTS.get(key);
  if (v == null) return null;
  if (!json) return v;
  try { return JSON.parse(v); } catch { return null; }
}
async function kvPut(env, key, val, json = false) {
  await env.DRAFTS.put(key, json ? JSON.stringify(val) : val);
}
async function kvDelete(env, key) {
  await env.DRAFTS.delete(key);
}
