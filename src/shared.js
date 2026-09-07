// ---------- 共享业务层（QQ 机器人）----------
// 抽离自 worker.js，供根 worker.js（cf 模式）与 edge-functions/wxbot.js（eo 模式）两边复用。
// 本模块不依赖任何平台专属 SDK：只用到全局 fetch / TextEncoder / TextDecoder / atob / btoa。

// 中文/英文别名 → Firefly 标准字段名
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

// ---------- 内联属性解析（中英文键名都认，--- 包裹的 frontmatter 也认） ----------
function parseFrontmatter(text) {
  const fields = {};
  const bodyLines = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "---" || line === "...") continue; // frontmatter 分隔符，跳过
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

// ---------- 业务分发 ----------
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
    await env.DRAFTS.delete(m.fromUser);
    return "草稿已丢弃 🗑️（下次从头开始写）";
  }
  if (m.msgType === "text" && (m.content === "/修改" || m.content === "/edit" || m.content === "/xiugai")) {
    const d = (await env.DRAFTS.get(m.fromUser, { type: "json" })) || null;
    const hasText = d && d.text && d.text.trim();
    const hasImg = d && d.images && d.images.length;
    if (!hasText && !hasImg) {
      return "还没有草稿可修改，先发文字攒一篇。";
    }
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
        // /友链 不带信息块 → 进入（或退出）友链模式
        const d = (await env.DRAFTS.get(m.fromUser, { type: "json" })) || { mode: "post" };
        if (d.mode === "friendlink") {
          await appendDraft(env, m.fromUser, { mode: "post" });
          return "已退出友链模式 ↩️（回到文章模式）";
        }
        await appendDraft(env, m.fromUser, { mode: "friendlink" });
        return "已进入友链模式 🔗\n直接发友链信息块即可自动解析添加，标签支持：站点名称 / 头像链接 / 站点描述 / 站点链接 / 站点友链 / 站点RSS（也兼容 名称/链接/头像/描述 等写法）。\n继续发下一条可连续添加；发 /取消 或再发 /友链 退出。也可一步到位：/友链 站点名称：xxx 站点链接：xxx";
      }
      // /友链 站点名称：… （一步发完）
      return await handleFriendLink(env, m.content, m.fromUser);
    }
  }
  if (m.msgType === "text" && (m.content === "/状态" || m.content === "/status")) {
    const d = (await env.DRAFTS.get(m.fromUser, { type: "json" })) || null;
    const hasContent = d && ((d.text && d.text.trim()) || (d.images && d.images.length) || (d.fields && Object.keys(d.fields).length));
    if (!hasContent) {
      return "当前没有草稿。发文字开始写，攒齐后 /done 发布。";
    }
    const mode = d.mode === "dynamic" ? "动态" : "文章";
    const textLen = (d.text || "").replace(/\s/g, "").length;
    const fieldKeys = Object.keys(d.fields || {});
    let s = `模式：${mode}\n草稿：已攒 ${textLen} 字 / ${(d.images || []).length} 张图`;
    if (fieldKeys.length) s += `\n属性：${fieldKeys.join("、")}`;
    s += `\n（/预览 看全文 · /取消 丢弃 · /done 发布）`;
    return s;
  }
  if (m.msgType === "text" && (m.content === "/预览" || m.content === "/preview" || m.content === "/yulan" || m.content === "/y" || m.content === "/浏览" || m.content === "/liulan")) {
    const d = (await env.DRAFTS.get(m.fromUser, { type: "json" })) || { text: "", images: [], tags: undefined, fields: {}, mode: "post" };
    if (!d.text.trim() && (!d.images || !d.images.length)) {
      return "草稿还是空的，先发文字或图片，再 /预览。";
    }
    const now = new Date();
    const fmt = (env.FILENAME_FORMAT || "title").toLowerCase();
    const title = ((d.fields && d.fields.title) || d.text.trim().split("\n")[0] || "随笔").slice(0, 60);
    const { file } = makeFileMeta(now, d.mode, title, fmt);
    const { md } = buildDraftMarkdown(env, d, localDate(now), file);
    const preview = md.length > 1500 ? md.slice(0, 1500) + "\n…（已截断，完整内容以 /done 发布为准）" : md;
    return `📄 即将发布的 Markdown：\n${preview}\n\n（确认无误发 /done 真正发布）`;
  }
  // /删图：把草稿里最后一张图移出，并（token 有 delete 权限时）从图床真正删除。传错图时的兜底。
  if (m.msgType === "text" && (m.content === "/删图" || m.content === "/delimg" || m.content === "/撤销图" || m.content === "/rmimg")) {
    const d = (await env.DRAFTS.get(m.fromUser, { type: "json" })) || { text: "", images: [] };
    if (!d.images || !d.images.length) return "草稿里没有图片可删 🤔";
    const removed = d.images.pop();
    await env.DRAFTS.put(m.fromUser, JSON.stringify(d));
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
  // ⚠️ 标记不可用：消息里的 @提及 / #话题标签 等「标记」当前不解析，一律按纯文本处理（原样进正文）。
  // 若日后要支持，需在此分支识别正文里的 @xxx / #话题 并做特殊处理；当前版本不提供，帮助文案已注明「目前不可用」。
  if (m.msgType === "text") {
    const d = (await env.DRAFTS.get(m.fromUser, { type: "json" })) || { text: "", images: [], fields: {}, mode: "post" };
    if (d.mode === "friendlink") {
      return await handleFriendLink(env, m.content, m.fromUser);
    }
    const { fields, body } = parseFrontmatter(m.content);
    if (d.overwrite) {
      // 覆盖模式：本条消息整体替换正文，并重新解析属性（合并进已有字段），用完清除标记
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
  // 图片处理：收到图片 → 上传到图床（imgbed.yufish.cn）→ 拿公开 URL → 塞进草稿正文（draft.images），/done 时随文章带出，并回显链接给用户。
  // QQ / EO：worker.js 或 eo 函数已把附件图片拉成 bytes 传入（imageBytes），这里直接上传。
  if (m.msgType === "image") {
    if (!m.imageBytes) {
      return "图片暂不支持直接发 🚫\n图片请用链接写：封面「封面：https://…」、正文插图「![说明](https://…)」";
    }
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

// 文章 slug：以标题为准，转成文件名/URL 友好格式（去非法字符、空白转连字符）；空则回退
function slugifyTitle(t) {
  return String(t || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/^-+|-+$/g, "") || "随笔";
}

// 本地日期 YYYY-MM-DD（用于 frontmatter published，与动态 published 同源，避免 UTC 跨天）
function localDate(now) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// 文件名格式开关：
//   文章 env.FILENAME_FORMAT = "date"  → 带日期前缀（YYYY-MM-DD-标题.md）
//   文章 默认 / "title"              → 纯标题（标题.md），不带任何时间戳
//   动态始终用本地时间（YYYY-MM-DD-HHMMSS.md），无标题可命名
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

// 根据草稿拼出「将要发布」的 Markdown（不落库）。/done 与 /预览 共用，避免两套逻辑漂移。
// publishedDate：frontmatter 的 published 默认日期（与文件名格式无关）；file：最终文件名
function buildDraftMarkdown(env, draft, publishedDate, file) {
  const mode = draft.mode === "dynamic" ? "dynamic" : "post";
  const f = draft.fields || {};
  const now = new Date();
  const bodyText = draft.text.trim();

  // ===== 动态模式：写 src/content/dynamic，frontmatter 只需 published(+pinned) =====
  if (mode === "dynamic") {
    // published 用「YYYY-MM-DD HH:MM:SS」对齐 Firefly 文档示例；若构建报格式错，改成 ISO：YYYY-MM-DDTHH:MM:SS
    // 不填自动取当前时间；若发了 `日期：xxx` / `published：xxx` 则用你填的（与文章模式一致）
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

  // ===== 文章模式：写 src/content/posts（原逻辑）=====
  const title = (f.title || bodyText.split("\n")[0] || "随笔").slice(0, 60);

  // Firefly frontmatter：必填 title/published；其余字段若以 `键: 值` 写了就生效，没写则自动补。
  // 支持的可选字段：updated / description / image / tags / category / slug / pinned / draft / password / passwordHint
  // 按你的要求不处理的字段：lang / author / comment / licenseName / licenseUrl / sourceLink
  const fm = [];
  fm.push(`title: "${title.replace(/"/g, '\\"')}"`);
  fm.push(`published: ${f.published || publishedDate}`);
  let desc;
  if (f.description) desc = f.description;
  else if (f.title) desc = bodyText.split("\n")[0] || title;        // 标题来自属性，正文首行即摘要
  else desc = bodyText.split("\n").slice(1).join(" ").trim() || title; // 标题来自正文，跳过首行
  fm.push(`description: "${String(desc).slice(0, 80).replace(/"/g, '\\"')}"`);
  // 封面必须显式用「封面：外链」指定；没写就用主题随机封面（image: api）。发的图只进正文，不自动提为封面
  if (f.image) fm.push(`image: "${f.image.replace(/"/g, '\\"')}"`);
  else fm.push(`image: api`);
  // tags：`标签:` 写的最优先，其次 /tags 命令，最后回退默认 [随笔]
  const tags = Array.isArray(f.tags) ? f.tags : (Array.isArray(draft.tags) ? draft.tags : ["随笔"]);
  fm.push(`tags: [${tags.map((t) => `"${String(t).replace(/"/g, '\\"')}"`).join(", ")}]`);
  // 可选字段：写了才输出
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
  const draft = (await env.DRAFTS.get(user, { type: "json" })) || { text: "", images: [], tags: undefined, fields: {}, mode: "post" };
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
  await env.DRAFTS.delete(user);
  if (draft.mode === "dynamic") {
    return `动态已发布 💬\n稍等约 1 分钟部署完成后到动态页查看。`;
  }
  // 链接优先用 slug 字段（如 slug: 05 → /posts/05），未设置则退回文件名（urlSlug）
  const finalSlug = (f.slug && f.slug.trim()) ? f.slug.trim() : urlSlug;
  const postUrl = `${env.SITE_URL.replace(/\/$/, "")}/posts/${finalSlug}`;
  return `文章已发布 🎉\n稍等约 1 分钟部署完成后访问：\n${postUrl}`;
}

async function appendDraft(env, user, patch) {
  const d = (await env.DRAFTS.get(user, { type: "json" })) || { text: "", images: [] };
  if (patch.overwriteText) d.text = patch.text || "";
  else if (patch.text) d.text += patch.text;
  if (patch.images) d.images.push(...patch.images);
  if (patch.tags) d.tags = patch.tags;
  if (patch.fields) d.fields = Object.assign(d.fields || {}, patch.fields);
  if (patch.mode) d.mode = patch.mode;
  if (typeof patch.overwrite === "boolean") d.overwrite = patch.overwrite;
  await env.DRAFTS.put(user, JSON.stringify(d));
}

// ---------- GitHub 工具 ----------

// 通用 GitHub 文件写入：可指定 owner/repo/branch（同时支持写 my-blog 与 check-flink 两个仓库）
async function githubPutTo(env, owner, repo, branch, path, content, message) {
  const api = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const headers = { Authorization: `Bearer ${env.GH_TOKEN}`, "Content-Type": "application/json", "User-Agent": "wechat-bot" };
  const existing = await fetch(`${api}?ref=${branch}`, { headers });
  const body = { message, content: b64(content), branch };
  if (existing.ok) { try { body.sha = (await existing.json()).sha; } catch {} }
  const res = await fetch(api, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error("github put failed (" + repo + "/" + path + "): " + (await res.text()));
}

// 通用 GitHub 文件读取并解码文本
async function githubGetFrom(env, owner, repo, branch, path) {
  const api = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
  const headers = { Authorization: `Bearer ${env.GH_TOKEN}`, "User-Agent": "wechat-bot" };
  const r = await fetch(api, { headers });
  if (!r.ok) throw new Error("github get failed (" + repo + "/" + path + "): " + r.status);
  const j = await r.json();
  const bin = atob((j.content || "").replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// 博客文章/动态：写 my-blog 仓库（经 GH_OWNER/GH_REPO/GH_BRANCH 配置）
async function githubPut(env, path, content, message) {
  await githubPutTo(env, env.GH_OWNER, env.GH_REPO, env.GH_BRANCH, path, content, message);
}
async function githubGet(env, path) {
  return await githubGetFrom(env, env.GH_OWNER, env.GH_REPO, env.GH_BRANCH, path);
}

// ---------- 友链真源：check-flink 仓库 static/friends.json ----------
// 结构：{ version, updatedAt, friends: [ {name, link, avatar, linkpage?, verified, rss, desc, tags, enabled, weight} ] } —— 标准 Friend-Circle-Lite 字段命名（与用户维护的 friends.json 一致）
// 博客（my-blog）开 useRemote 时拉 friends.yufish.cn/friends.json，而那就是 check-flink 的 Vercel 部署，
// 所以 check-flink 才是「真源」；/友链 指令必须插入这里，博客才会显示。
function flRepo(env) {
  return {
    owner: env.FL_OWNER || env.GH_OWNER,
    repo: env.FL_REPO || "check-flink",
    branch: env.FL_BRANCH || "main",
    path: env.FL_PATH || "static/friends.json",
  };
}

// 读取 check-flink 真源（失败返回空骨架，不抛错，便于首次添加）
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

// 把一条友链插入/更新进 check-flink 真源（baseData 为已读取的对象，避免重复拉取）
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

// 解析用户输入的友链信息：顺序/换行随意，一行可含多字段，中英文键都认。
// 字段：名称/链接/头像/描述/标签/权重/友链页（反链检测用）
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

// 把一条 JSON 友链对象归一化到内部字段（兼容 Friend-Circle-Lite 默认命名 name/link/avatar 与 bot 自身命名 title/siteurl/imgurl）。
// verified 不入库（check-flink 反链检测会自动重算）。
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

// /友链 指令：解析 → 校验必填 → 读 check-flink 真源 → 插入/更新+补默认 → 按 weight 降序 → 写回真源（仅 GitHub，不写 R2）
async function handleFriendLink(env, text, fromUser) {
  const body = String(text || "").replace(/^\/友链\s*|^友链\s*|^friend\s*|^fl\s*/i, "").trim();
  if (!body) {
    return "📝 友链添加格式（顺序、换行随意，名称和链接必填）：\n名称：张三的博客\n链接：https://zhangsan.com\n头像：https://…（可选）\n描述：一句话简介（可选）\n标签：生活 技术（可选，默认 Blog）\n权重：5（可选，默认 5，越大越靠前）\n启用：是（可选，默认启用，写「否」可禁用）\n友链页：https://…（可选，反链检测用）\nRSS：https://…/rss.xml（可选）\n\n直接发「/友链 名称：xxx 链接：xxx」即可添加/更新。\n\n也支持直接粘贴 JSON 友链对象（从别的朋友圈导出那种）：\n{ \"name\": \"站点名\", \"link\": \"https://...\", \"avatar\": \"https://...\", \"desc\": \"简介\", \"tags\": [\"Blog\"], \"weight\": 5, \"enabled\": true, \"linkpage\": \"https://.../friends\", \"rss\": \"\" }";
  }
  // 直接粘贴 JSON 友链对象（如别的朋友圈导出的 {name,link,avatar,...}）→ 自动归一化；解析失败则回退到「键：值」文本解析
  let f = null;
  if (body.startsWith("{") && body.endsWith("}")) {
    try {
      const obj = JSON.parse(body);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) f = normalizeJsonFriend(obj);
    } catch (_) { /* 解析失败 → 回退到文本解析 */ }
  }
  if (!f) f = parseFriendFields(body);
  if (!f.title || !f.siteurl) {
    return "❌ 名称和链接是必填的。例：/友链 名称：张三 链接：https://zhangsan.com";
  }
  if (!env.GH_TOKEN) {
    return "❌ GitHub 凭证未配置（GH_TOKEN 缺失），无法写入友链真源。";
  }
  // 默认头像：R2 已弃用，这里用一个自包含的占位 SVG（避免再依赖外部图床域名）。
  const DEFAULT_AVATAR = env.FRIEND_DEFAULT_AVATAR || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect width='80' height='80' fill='%23d9d9d9'/%3E%3Ctext x='50%25' y='52%25' font-size='38' text-anchor='middle' fill='%23ffffff'%3E%3F%3C/text%3E%3C/svg%3E";
  const data = await readCheckFlink(env);
  const existingList = data.friends || [];
  // 写入 check-flink 真源用标准 Friend-Circle-Lite 字段命名 + 用户给定顺序（name/link/avatar/linkpage/verified/rss/desc/tags/enabled/weight），
  // 与用户维护的 friends.json 完全一致；否则 check-flink 按 name/link/avatar 读不到字段，友链不显示。
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

  // 主写：check-flink 真源（博客经 friends.yufish.cn 实时拉取）；不再写 R2 镜像。机器人只写不读，不单独提供友链读取端点。
  let action = "添加";
  try {
    action = await flAppendFriend(env, entry, data);
  } catch (e) {
    return "❌ 写入友链真源（check-flink）失败：" + ((e && e.message) || String(e)) + "\n请确认 GH_TOKEN 对 check-flink 仓库有写权限。";
  }

  const friendPage = (env.FRIEND_PAGE_URL || "https://x1anyu.cn/friends/").trim();
  return `✅ 友链已${action}：${f.title}\n${f.siteurl}\n浏览链接：${friendPage}`;
}

// ---------- 图床上传（cfbed.sanyue.de，CloudFlare ImgBed）----------
// 把图片二进制上传到图床，返回公开 URL。认证：Authorization: Bearer <IMG_BED_TOKEN>（用户选 API Token）。
// 普通上传：POST /upload?returnFormat=full，multipart file 字段。小文件（<100MB）一次成型。
// 返回 publicUrl（完整链接）；若图床未设默认前缀只回了 src(/file/id)，则拼回域名。
async function uploadToImageBed(env, bytes, filename, mime) {
  if (!env.IMG_BED_TOKEN && !env.IMG_BED_AUTH) {
    throw new Error("图床未配置：需 IMG_BED_TOKEN（或 IMG_BED_AUTH）");
  }
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

// ---------- 图床删除（CloudFlare ImgBed）----------
// 把已上传的图片从图床真正删除：/api/manage/delete/{path}，token 需 delete 权限。
// {path} 取自上传返回 URL 的文件名（publicUrl 末段 / src 里 /file/ 之后那段）。
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
  // 文档删除接口支持 GET/POST；先 DELETE，部分路由不支持时回退 GET
  let r = await fetch(delUrl, { method: "DELETE", headers });
  if (!r.ok) r = await fetch(delUrl, { method: "GET", headers });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error("HTTP " + r.status + " " + txt.slice(0, 150));
  }
}

// ---------- 基础工具 ----------
function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

export {
  FIELD_ALIASES,
  HELP_TEXT,
  parseFrontmatter,
  dispatch,
  slugifyTitle,
  localDate,
  makeFileMeta,
  buildDraftMarkdown,
  publish,
  appendDraft,
  githubPutTo,
  githubGetFrom,
  githubPut,
  githubGet,
  flRepo,
  readCheckFlink,
  flAppendFriend,
  parseFriendFields,
  handleFriendLink,
  uploadToImageBed,
  deleteFromImageBed,
  b64,
  pad,
};
