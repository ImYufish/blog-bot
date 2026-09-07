import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
ed.hashes.sha512 = sha512;

// QQ 机器人业务层：dispatch / publish / github* / friends* / 解析等
import { dispatch } from "./src/shared.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---------- QQ 机器人 Webhook 入口 ----------
    if ((env.QQ_CALLBACK_PATH || "/qq/callback") === path && (request.method === "POST" || request.method === "GET")) {
      return await handleQQCallback(request, env, url, ctx);
    }

    // ---------- 健康检查 / 探活端点（供 UptimeRobot 等外部监控探测）----------
    // 极简：立即返回 200，不碰 KV / 不调外部接口，避免被响应时间或 Cloudflare Bot 防护误判为 down。
    // UptimeRobot 监控 https://bot.yufish.cn/health 即可（HTTP 状态监测、无需关键词）。
    if (path === "/health" || path === "/healthz") {
      return new Response(
        JSON.stringify({ status: "ok", ts: Date.now(), service: "blog-bot" }),
        { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }
      );
    }

    // QQ 自定义菜单一次性设置（调试/初始化用）：curl https://bot.yufish.cn/__qqmenu
    if (path === "/__qqmenu") {
      try {
        const res = await qqSetMenu(env, QQ_MENU_ITEMS);
        return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ err: (e && e.message) || String(e) }), { status: 500, headers: { "content-type": "application/json" } });
      }
    }

    // QQ 指令面板一次性设置（全部单聊用户生效）：curl https://bot.yufish.cn/__qqpanel
    if (path === "/__qqpanel") {
      try {
        const res = await qqSetPanel(env, QQ_PANEL_ITEMS);
        return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ err: (e && e.message) || String(e) }), { status: 500, headers: { "content-type": "application/json" } });
      }
    }

    // ---------- 告警推送（供 FCL 等 CI 调用）：POST /api/alert { token, text } ----------
    // 用 QQ 单聊主动消息把告警文本推给 QQ_OWNER_OPENID。AppSecret 只存在 Worker 环境里，
    // CI 侧只需要这一个接口 + ALERT_TOKEN，不用碰 QQ 凭据、也不用管 OpenAPI 鉴权。
    if (path === "/api/alert" && request.method === "POST") {
      const j = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...QQ_NO_CACHE } });
      try {
        const d = await request.json().catch(() => ({}));
        if (!env.ALERT_TOKEN) return j({ ok: false, error: "ALERT_TOKEN 未配置" }, 503);
        if (!d || d.token !== env.ALERT_TOKEN) return j({ ok: false, error: "unauthorized" }, 401);
        const text = typeof d.text === "string" ? d.text.trim().slice(0, 2000) : "";
        if (!text) return j({ ok: false, error: "missing text" }, 400);
        const openid = (env.QQ_OWNER_OPENID || "").trim();
        if (!openid) return j({ ok: false, error: "QQ_OWNER_OPENID 未配置：先给机器人发条消息，再访问 /__qqwho?token=... 获取 openid 并 secret put" }, 500);
        await sendQQMessage(env, openid, text, ""); // 空 msg_id = 主动消息
        return j({ ok: true }, 200);
      } catch (e) {
        return j({ ok: false, error: (e && e.message) || String(e) }, 502);
      }
    }

    // ---------- Waline 评论通知桥接：Waline 的 WEBHOOK 环境变量指向这里 ----------
    // 新评论时 Waline 向本地址 POST 一条评论 JSON，我们格式化成文本、复用 sendQQMessage 推给博客主 QQ。
    // 与 /api/alert 共用 ALERT_TOKEN 鉴权（token 放 URL query，Waline 原样 POST 过来，无需新增 secret）。
    // 比 Waline 原生 QQ(Qmsg 酱) 好：不依赖第三方中转、QQ 凭据全在我们 Worker 里。
    if (path === "/api/waline" && request.method === "POST") {
      const j = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...QQ_NO_CACHE } });
      try {
        if (!env.ALERT_TOKEN) return j({ ok: false, error: "ALERT_TOKEN 未配置" }, 503);
        if (url.searchParams.get("token") !== env.ALERT_TOKEN) return j({ ok: false, error: "unauthorized" }, 401);
        const body = await request.json().catch(() => ({}));
        // Waline webhook 实际结构：{ type:"new_comment", data:{ comment:{...} } }（评论包在 data.comment）。
        // 老版本/部分场景则是 body.comment 或 body 本身。这里逐层兜底，避免整包被当成评论导致 nick=匿名、正文变 raw JSON。
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
        // 博主自己的评论不通知（可选）：仅按 Worker 自己的 WALINE_AUTHOR_MAIL 精确匹配评论 mail。
        // 注意：Waline 的 AUTHOR_EMAIL（Vercel 侧）与本 Worker 无关，不会自动生效；昵称匹配已移除（会误伤同名读者）。
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
        // 关键优化：先立即回 200 给 Waline。Waline 会等 webhook 返回才结束评论提交流程，
        // 若同步发 QQ（含 token 获取 + OpenAPI 调用，可能数百毫秒）会显著拖慢用户提交体感。
        // 改为 ctx.waitUntil 后台推送，用户提交不再被 QQ 发送耗时阻塞。
        const push = sendQQMessage(env, openid, msg, "").catch((e) => console.error("[waline] QQ 推送失败:", (e && e.message) || e));
        if (ctx && ctx.waitUntil) ctx.waitUntil(push);
        else await push;
        return j({ ok: true }, 200);
      } catch (e) {
        return j({ ok: false, error: (e && e.message) || String(e) }, 502);
      }
    }

    // 查询告警推送目标：GET /__qqwho?token=<ALERT_TOKEN>
    // QQ_OWNER_OPENID 未配置时，先给机器人发条私聊（C2C 会自动记 KV），用这里返回的 last_openid 去 put。
    if (path === "/__qqwho") {
      const j = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...QQ_NO_CACHE } });
      if (!env.ALERT_TOKEN || url.searchParams.get("token") !== env.ALERT_TOKEN) return j({ ok: false, error: "unauthorized" }, 401);
      const kvOpenid = env.DRAFTS ? await env.DRAFTS.get("qq_last_openid").catch(() => null) : null;
      return j({ ok: true, owner_configured: !!(env.QQ_OWNER_OPENID || "").trim(), last_openid: kvOpenid || null }, 200);
    }

    return new Response("not found", { status: 404 });
  },
};

// ---------- QQ 机器人适配层（Webhook 模式，并入 worker.js，业务逻辑复用 dispatch）----------
// 前置：QQ 开放平台「尚未添加 IP 白名单」时所有来源 IP 均可调 OpenAPI，CF Worker 动态出口可直接用，无需白名单。
// 配置：wrangler [vars] QQ_APPID / QQ_CALLBACK_PATH；secrets: QQ_APP_SECRET（换 token + Ed25519 签名/验签都用这一个，无独立 BotSecret）。

// QQ Webhook 签名 = Ed25519。密钥即 AppSecret（开发管理里那个）。没有独立 BotSecret。
// 官方算法：把 AppSecret 当 seed，不足 32 字节就整段重复拼接补到 32 字节，再生成 Ed25519 密钥对。
function qqSeedBytes(appSecret) {
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

// op13 回调地址验证：用 (event_ts + plain_token) 签名，返回 hex（与官方 golang 实现一致）。
async function qqSignValidation(eventTs, plainToken, appSecret) {
  const seed = qqSeedBytes(appSecret);
  const sig = await ed.signAsync(new TextEncoder().encode(eventTs + plainToken), seed);
  return ed.etc.bytesToHex(sig);
}

// 事件推送签名校验：X-Signature-Ed25519(hex) 对 (timestamp + 原 body) 的 Ed25519 验签。
// 用 @noble/ed25519 纯 JS 实现，绕开 CF WebCrypto Ed25519 raw/spki 在 workerd 上的行为坑。
async function qqVerifyEvent(rawBody, sigHex, ts, appSecret) {
  try {
    const seed = qqSeedBytes(appSecret);
    const pub = await ed.getPublicKeyAsync(seed);
    const sig = ed.etc.hexToBytes(sigHex);
    if (sig.length !== 64) return false;
    return await ed.verifyAsync(sig, new TextEncoder().encode(ts + rawBody), pub);
  } catch { return false; }
}

async function getQQToken(env) {
  const cached = await env.DRAFTS.get("qq_token", { type: "json" }).catch(() => null);
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const r = await fetch("https://bots.qq.com/app/getAppAccessToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: env.QQ_APPID, clientSecret: env.QQ_APP_SECRET }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error("QQ token 获取失败: " + JSON.stringify(j));
  await env.DRAFTS.put("qq_token", JSON.stringify({ token: j.access_token, exp: Date.now() + (j.expires_in || 7200) * 1000 }));
  return j.access_token;
}

// 拉取 QQ C2C 图片字节：附件 url 需带 QQBot token 才能下载（QQ 图床 CDN 鉴权）
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
  // msg_id 为空 → 主动消息（不带该字段）；带 msg_id → 被动回复（60 分钟内、每条限回数次）
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

// 设置 QQ 单聊「自定义菜单」（一次性全局配置，常驻窗口底部）。PUT /v2/menu
// 菜单是全局对所有人生效，设一次即可，不需每条消息都跑。
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

// 默认单聊菜单（按 bot 实际支持的指令）。send_message 点一下把文本填入输入框，link 跳转。
const QQ_MENU_ITEMS = [
  { type: "send_message", name: "帮助", send_message: "/帮助" },
  { type: "send_message", name: "加友链", send_message: "/友链 " },
  { type: "link", name: "我的博客", link: "https://blog.x1anyu.cn" },
  { type: "menu", name: "更多", sub_menu_items: [
    { type: "send_message", name: "查草稿", send_message: "/草稿" },
  ] },
];

// 设置 QQ 单聊「指令面板」（面板形式入口，独立于底部菜单）。POST /v2/panels
// scope=c2c / target_type=all → 对所有单聊用户生效。command 点一下把 name 填入输入框，link 跳转。
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

// 默认指令面板项（按 bot 实际支持的指令）。command 的 name 即点击后填入输入框的文本。
const QQ_PANEL_ITEMS = [
  { type: "command", name: "/帮助", desc: "查看全部指令与用法" },
  { type: "command", name: "/友链", desc: "添加友链到博客" },
  { type: "command", name: "/草稿", desc: "查看当前草稿内容" },
  { type: "link", name: "我的博客", desc: "前往博客首页", link: "https://blog.x1anyu.cn" },
];

// QQ Webhook 主流程：op13 验证（不验签名）→ C2C 事件验签 → 复用 dispatch → OpenAPI 回
// 关键：所有回包都带 Cache-Control: no-store。QQ 的 op13 签名每请求必不同，
// 若回调域名(bot.yufish.cn)前面压着 EdgeOne，EO 默认会缓存 JSON 回包，
// 命中旧签名→平台判失败、未命中→成功，表现为「时灵时不灵」。no-store 是给 EO 的「别缓存」指令
// （EO 有时仍会忽略 origin 头的缓存规则，需在 EO 控制台对 /qq/callback 加节点缓存 bypass，见 README §QQ）。
const QQ_NO_CACHE = { "cache-control": "no-store" };
async function handleQQCallback(request, env, url, ctx) {
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

    // (a) 回调地址验证（op 13）：平台发来 plain_token + event_ts，我们用 (event_ts + plain_token) 签名回包。
    //     op13 本身就是验证握手，千万不要对它做 X-Signature 事件验签——平台发的握手请求有时带/有时不带签名头，
    //     带了又验不过就会被我们 401 挡掉，表现为「点几次突然成功、再点又失败」的假象。
    if (payload.op === 13 || (payload.d && payload.d.plain_token)) {
      const plain = payload.d.plain_token;
      const eventTs = String(payload.d.event_ts != null ? payload.d.event_ts : (url.searchParams.get("event_ts") || ""));
      const signature = await qqSignValidation(eventTs, plain, env.QQ_APP_SECRET);
      return new Response(JSON.stringify({ plain_token: plain, signature }), {
        status: 200, headers: { "content-type": "application/json", ...QQ_NO_CACHE },
      });
    }

    // (b) 真正的事件推送（op 0 / 带 t 字段）才做 X-Signature-Ed25519 验签，防伪造。AppSecret 即签名私钥。
    if (payload.op === 0 || payload.t) {
      const sigHead = request.headers.get("X-Signature-Ed25519");
      const tsHead = request.headers.get("X-Signature-Timestamp");
      if (sigHead && tsHead) {
        const ok = await qqVerifyEvent(rawBody, sigHead, tsHead, env.QQ_APP_SECRET);
        if (!ok) return new Response("invalid signature", { status: 401, headers: QQ_NO_CACHE });
      }
    }

    // (c) C2C 单聊消息：复用 dispatch。关键——用 ctx.waitUntil 把 dispatch+发消息挪到后台，
    //     回调立即回 200，避免同步 await 发消息时 api.bot.qq.com 偶发卡顿拖垮回调 → QQ 平台超时重试 → 请求暴增。
    if (payload.t === "C2C_MESSAGE_CREATE" && payload.d) {
      const d = payload.d;
      // 图片消息：附件里取第一张 image/*，拉成 bytes 后交给 dispatch 上传图床塞进草稿
      const imgs = Array.isArray(d.attachments) ? d.attachments.filter((a) => (a.content_type || "").startsWith("image/")) : [];
      if (imgs.length) {
        const a = imgs[0];
        const imgUrl = a.url;
        const filename = a.filename || "image.png";
        const mime = a.content_type || "image/png";
        ctx.waitUntil((async () => {
          try {
            if (env.DRAFTS) await env.DRAFTS.put("qq_last_openid", d.author.user_openid);
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
      if (d.message_type !== 0) return new Response("ok", QQ_NO_CACHE); // 只处理文本（QQ 字段名是 message_type）
      const m = { msgType: "text", content: d.content || "", fromUser: d.author.user_openid };
      ctx.waitUntil((async () => {
        try {
          // 记录最近单聊用户：/api/alert 的推送目标需要显式配 QQ_OWNER_OPENID，
          // 这里只做记录，供 /__qqwho 查询拿到自己的 openid（首次配置用）。
          if (env.DRAFTS) await env.DRAFTS.put("qq_last_openid", d.author.user_openid);
        } catch { /* KV 失败不影响主流程 */ }
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
    // 任何内部异常都吞掉并返回 200，避免持续刷 CF Workers 错误计数；调试期可在 body 看错误信息。
    const info = (e && e.message) ? e.message : String(e);
    console.error("QQ callback error:", info);
    return new Response("qq internal: " + info, { status: 200, headers: QQ_NO_CACHE });
  }
}
