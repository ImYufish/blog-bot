# blog-bot

QQ 机器人（首选通道）驱动的博客自动发布后端。在 QQ 里发文字、发图就能写博文、发动态、加友链，后端帮你拼成 Markdown 并提交到 GitHub 仓库触发部署。整套跑在 Serverless 上，零服务器成本。

> 已移除企业微信通道与 R2 存储：图片走自建图床 `imgbed.yufish.cn`，友链只写 check-flink GitHub 真源，不再依赖 R2。

---

## 目录结构

```
blog-bot/
├── worker.js              # Cloudflare Worker 主程序（DEPLOY_MODE=cf 时全量处理 QQ 回调 / 告警 / Waline）
├── src/
│   ├── shared.js          # 业务层（指令解析、发布、草稿、友链、图床），worker.js 引用
│   └── ed25519.js         # 纯 JS Ed25519（RFC 8032，仅依赖 Web Crypto SHA-512），供测试与跨环境复用
├── edge-functions/
│   └── [[default]].js      # EdgeOne Makers 边缘函数版（DEPLOY_MODE=eo 时全量独立处理；onRequest(context) 入口；Ed25519/业务层全部内联，无 npm import）
├── edgeone.json           # Makers 项目配置（声明无构建步骤，纯 edge-functions 部署）
├── test-ed25519.cjs       # Ed25519 纯 JS 实现对 RFC 8032 测试向量的校验（node test-ed25519.cjs）
├── test-qq-ed.mjs         # QQ Ed25519 签名往返（CF @noble 路径）
├── wrangler.toml          # Worker 的 KV 绑定与 [vars]
└── 部署指南.md            # 完整部署步骤（含 cf / eo 两种模式、Makers 节点缓存 bypass 规则）
```

---

## 它解决什么

不用开后台、不用记 Markdown 语法细节，在手机上用机器人发消息就能更新博客：

- 发一段文字 → 攒成草稿；直接发图片 → 自动传图床拿公开 URL 塞进草稿
- 用「键: 值」写标题、日期、标签、封面等属性，正文支持 Markdown（链接、图片引用）
- `/done` 一键发布到 GitHub，仓库部署完成后博客就更新了
- `/友链` 直接写 check-flink 真源，约 1~2 分钟生效（博客经 friends.yufish.cn 实时拉取）

---

## 两种运行文件，两种部署模式

代码逻辑（指令解析、发布、草稿、友链、图床）在两套运行时里是同源实现，靠 `DEPLOY_MODE` 切换入口形态：

| 模式 | 入口 | 谁干活 | 草稿存哪 | 适用 |
| --- | --- | --- | --- | --- |
| `cf` | Cloudflare Worker | `worker.js` + `src/shared.js` | CF KV（`DRAFTS`） | 想完全用 Cloudflare（当前默认） |
| `eo` | EdgeOne Makers | `edge-functions/[[default]].js` | Makers KV（`DRAFTS`） | 想完全用 EdgeOne，自己扛 QQ 回调 |

- 两个运行时**功能完全对等**：都内联了 QQ 适配层（Ed25519 验签 + 主动/被动消息）、业务层、图床上传、check-flink 友链读写。
- `cf` 走 `@noble/ed25519`（Worker 运行时原生支持）；`eo` 因 EdgeOne 不支持 npm import，改用内联的纯 JS Ed25519（`src/ed25519.js` 的同款实现，已对 RFC 8032 向量验证）。
- `hybrid` 模式已移除，不再有 EdgeOne 转发给 Worker 的 `/internal` 后端。
- 切换只是改对应侧的环境变量 `DEPLOY_MODE`，功能完全一致。详细步骤看 `部署指南.md` 第 10 节。

---

## 路由

| 路径 | 方法 | 作用 |
| --- | --- | --- |
| `/qq/callback` | POST/GET | QQ 机器人 Webhook：Ed25519 验签 → dispatch → 回包 |
| `/health` `/healthz` | GET | 探活（UptimeRobot 等外部监控用），立即返回 200，不碰 KV / 不调外部接口 |
| `/__qqmenu` | GET | 一次性设置 QQ 单聊底部菜单（`curl https://你的域名/__qqmenu`） |
| `/__qqpanel` | GET | 一次性设置 QQ 指令面板（全部单聊用户生效） |
| `/api/alert` | POST | CI 告警推送：`{"token","text"}` → QQ 单聊主动消息 |
| `/api/waline` | POST | Waline 评论 Webhook → 复用 QQ 推送通知博主 |
| `/__qqwho` | GET | 查询告警推送目标 openid（`?token=<ALERT_TOKEN>`） |

---

## 指令集

给 QQ 机器人发消息：

- **直接发文字** = 写博文。用「键: 值」写属性（标题、日期、标签、封面、置顶、草稿等，中英文键名都认），其余当正文；正文支持 Markdown 如 `[文字](链接)`。图片用链接写：封面 `封面：https://…`、正文插图 `![说明](https://…)`。
- **直接发图片** = 图片自动上传图床、拿公开 URL 塞进草稿 `images`，`/done` 时随文章带出，并回显链接给你。
- `/done` · `/发布` — 发布并清空草稿
- `/取消` · `/清空` — 只丢草稿，不发布
- `/动态` · `/文章` — 切到动态 / 文章模式
- `/修改` — 回显当前草稿（含已附图片 URL），下一条消息整体替换（从头重算，不动图片）
- `/状态` — 看当前模式 / 已攒字数 / 属性 / 图片链接
- `/预览` · `/浏览` — 看将要发布的 Markdown 全文（含图片，不真发）
- `/删图` · `/delimg` · `/撤销图` · `/rmimg` — 撤掉草稿里最后一张图，并在图床配了 token 时同步从图床删除
- `/tags 旅行 随笔` — 改标签（留空清空，回退默认 `[随笔]`）
- `/友链 站点名称：… 站点链接：…` — 添加或更新一条友链（头像/描述/标签/权重可选；也支持进入友链模式后整块发）
- `/部署模式` — 看当前架构（cf / eo）
- `/帮助` — 就是这条

---

## 友链（不再走 R2）

`/友链` 的数据**只写 check-flink 真源 GitHub 仓库**（`FL_*` 指向的仓库），不再读写 R2：

- 写入后约 1~2 分钟，博客经 `friends.yufish.cn` 实时拉取即生效，零部署、不耗部署次数。
- 友链未填头像时，用代码内自包含的占位 SVG（data-URI），不再依赖外部图床域名。

---

## 图片（不走 R2）

收到图片后上传到自建图床 `imgbed.yufish.cn`（CloudFlare ImgBed 实例），拿 `publicUrl` 塞进草稿。删除（`/删图`）时若图床配了 token，会同步调用图床删除接口真删文件。图床凭据为 `IMG_BED_TOKEN`（Authorization: Bearer，需 upload + delete 双权限）或可选的 `IMG_BED_AUTH`（authCode 兜底），二选一。

---

## 环境变量与密钥

### 绑定（wrangler.toml）

- KV 命名空间 `DRAFTS`（存草稿 + 缓存 QQ `access_token` + 最近单聊 openid），id 已在 `wrangler.toml` 里。
- 无 R2 绑定。

### [vars]（非敏感，已在 wrangler.toml）

| 变量 | 说明 | 当前值 |
| --- | --- | --- |
| `GH_OWNER` | 博客仓库 owner | `ImYufish` |
| `GH_REPO` | 博客仓库名 | `my-blog` |
| `GH_BRANCH` | 提交分支 | `master` |
| `GH_PATH` | 文章目录 | `src/content/posts` |
| `GH_DYNAMIC_PATH` | 动态目录 | `src/content/dynamic` |
| `SITE_URL` | 博客地址（不带末尾斜杠） | `https://x1anyu.cn` |
| `FILENAME_FORMAT` | 文件名格式：`title`=纯标题 / `date`=带日期前缀 | `title` |
| `DEPLOY_MODE` | 部署模式：`cf` / `eo`（不再支持 hybrid） | `cf` |
| `FRIEND_PAGE_URL` | `/友链` 添加成功后回显的浏览链接 | `https://x1anyu.cn/friends/` |
| `WALINE_AUTHOR_MAIL` | `/api/waline` 跳过博主自己评论：精确匹配评论 mail | `blog@x1anyu.cn` |
| `FL_OWNER` / `FL_REPO` / `FL_BRANCH` / `FL_PATH` | 友链真源仓库定位 | `ImYufish` / `Friend-Circle-Lite` / `main` / `friends.json` |
| `QQ_APPID` | QQ 机器人 AppID（非敏感放 vars） | （见 wrangler.toml） |
| `QQ_CALLBACK_PATH` | QQ Webhook 回调路径，与运行时路由一致 | `/qq/callback` |
| `IMG_BED_URL` | 图床地址 | `https://imgbed.yufish.cn` |
| `IMG_BED_CHANNEL` | 图床上传渠道（留空=实例默认；报 channel 错再填 cfr2/telegram/s3/discord） | （空） |

### secret（不进文件，用 `wrangler secret put`）

| 密钥 | 作用 |
| --- | --- |
| `QQ_APP_SECRET` | QQ 机器人 AppSecret：既换 `access_token`，又当 Ed25519 私钥做 Webhook 签名校验（QQ 无独立 BotSecret） |
| `GH_TOKEN` | GitHub PAT（写 my-blog 文章/动态、写 check-flink 友链真源、开友链申请 Issue） |
| `ALERT_TOKEN` | `/api/alert` 与 `/api/waline` 共用的鉴权 token（自定随机串；CI/FWaline 侧配同名值） |
| `QQ_OWNER_OPENID` | 告警推送目标 = 你自己的 user_openid（先给机器人发条私聊，再访问 `/__qqwho?token=...` 获取） |
| `IMG_BED_TOKEN` | 图床 API Token（需 upload + delete 双权限） |
| `IMG_BED_AUTH` | （可选）图床上传认证码 authCode，作为 `IMG_BED_TOKEN` 的兜底；二选一即可 |

---

## 部署

Cloudflare Worker 侧（cf 模式）：

```bash
npm i -g wrangler
wrangler login

# 绑定 secret（逐个执行，按提示粘贴）
wrangler secret put QQ_APP_SECRET
wrangler secret put GH_TOKEN
wrangler secret put ALERT_TOKEN
wrangler secret put QQ_OWNER_OPENID   # 可先跳过，配法见下方 /__qqwho
wrangler secret put IMG_BED_TOKEN      # 或 IMG_BED_AUTH

wrangler deploy          # 让 /qq/callback 等路由生效
```

EdgeOne 侧（eo 模式）用 **EdgeOne Makers** 部署：把本仓库导入 Makers 项目（或 `edgeone makers deploy`），Makers 自动识别 `edge-functions/[[default]].js` 作为全站函数入口；在 Makers 项目设置里配齐同款环境变量与 KV（`DRAFTS`）绑定，把 QQ 回调 URL 指向 `你的 Makers 域名/qq/callback`。详见 `部署指南.md` 第 10 节。

部署前可用 `node --check worker.js` 和 `node --check "edge-functions/[[default]].js"` 先过一遍语法。

---

## 本地测试

```bash
node test-ed25519.cjs   # 纯 JS Ed25519 对 RFC 8032 测试向量校验（两文件同源，覆盖 cf/eo 两条路径）
node test-qq-ed.mjs     # QQ Ed25519 签名往返（CF @noble 路径）
```

---

## QQ 机器人接入（首选，Webhook 模式）

`worker.js` 与 `edge-functions/[[default]].js`（EdgeOne Makers）都内联了 QQ 适配层（`handleQQCallback`）：收到 QQ 事件后验签、包成统一消息格式直接调 `dispatch`，写博文 / 友链 / 草稿流程原样可用。

前置：QQ 开放平台「尚未添加 IP 白名单」时所有来源 IP 都能调 OpenAPI，CF Worker / EO 动态出口能直接发消息，不用配白名单、也不用养服务器。**决定走这个方案就别手填 IP 白名单**（填了反而会把出口挡掉）。

配置步骤：
1. QQ 开放平台创建机器人，拿到 AppID / AppSecret（在「开发管理」。**注意：QQ 只有一个 AppSecret，没有独立 BotSecret**，它既换 access_token 又当 Ed25519 私钥做 Webhook 签名校验）。
2. 填 Webhook 回调地址：`你的域名 + /qq/callback`（路径与 `QQ_CALLBACK_PATH` 一致）。
3. 勾选 C2C 单聊消息事件。
4. `wrangler.toml` 里已加好 `QQ_APPID`、`QQ_CALLBACK_PATH` 两个 vars；再 put 一个 secret 即可：
   ```bash
   wrangler secret put QQ_APP_SECRET   # 开放平台「开发管理」里的 AppSecret
   ```
5. `wrangler deploy` 生效。
6. （一次性）设置菜单与面板：
   ```bash
   curl https://你的域名/__qqmenu
   curl https://你的域名/__qqpanel
   ```

**回调域名若压在 EdgeOne 前面（如 `bot.yufish.cn`），必须给 `/qq/callback` 加节点缓存 bypass：** op13 验签每请求必不同，EdgeOne 默认会缓存回包 → 命中旧签名就判失败、未命中才成功，表现为「时灵时不灵」。运行时已在所有回包加 `Cache-Control: no-store` 作为源头指令，但 EdgeOne 有时仍按自己的缓存规则缓存，所以**同时**在 EdgeOne Makers 控制台「节点缓存规则」里对 `/qq/callback` 设 bypass / 不缓存最稳妥。临时验证可直接把 QQ 回调地址改成裸 `*.workers.dev`（不经 EO），能稳定通过即坐实是 EO 缓存在作怪。

说明：QQ 纯文本通道不渲染 Markdown，`[文字](链接)` 会原样显示；要超链接可后续改 ark / markdown 消息类型。C2C 单聊够自用，群聊收全量消息需额外审核。

### 告警推送接口（供 CI 调用）

`POST /api/alert`，body `{"token": "<ALERT_TOKEN>", "text": "告警文本"}`，用 QQ 单聊**主动消息**推给 `QQ_OWNER_OPENID`（不带 msg_id；用户在 QQ 客户端关闭「允许主动发送」会失败，失败原因原样返回）。QQ 凭据只存在运行时环境，CI 侧只拿这一个接口 + token。

```bash
# secret（逐个执行）
wrangler secret put ALERT_TOKEN      # 自定随机串，CI 仓库 Secrets 配同名值
wrangler secret put QQ_OWNER_OPENID  # 推送目标 = 你自己的 openid
```

openid 获取方式：先给你的 QQ 机器人发条私聊（任意内容），C2C 事件会把最近单聊用户记进 KV，然后：

```bash
curl "https://你的域名/__qqwho?token=<ALERT_TOKEN>"
# → {"ok":true,"owner_configured":false,"last_openid":"XXXX"}  把 last_openid put 进 QQ_OWNER_OPENID
```

CI 侧配置两个 Secrets：`QQ_BOT_ALERT_URL=https://你的域名/api/alert`、`QQ_BOT_ALERT_TOKEN=<同 ALERT_TOKEN>`。

---

## Waline 评论通知桥接（复用 QQ 推送）

Waline 自带 `WEBHOOK` 环境变量：每次新评论会向该地址 POST 一条评论 JSON。直接把它指向 blog-bot 的 `/api/waline`，由运行时格式化成文本、复用 QQ 推送推到博客主 QQ——**不依赖 Qmsg 酱等第三方中转**，QQ 凭据始终只在运行时里。

前提：已配置 `ALERT_TOKEN`（上方）和 `QQ_OWNER_OPENID`（上方 openid 流程）。

Waline 侧（在你的 Waline 服务端环境变量里加一行）：

```bash
WEBHOOK=https://你的域名/api/waline?token=<ALERT_TOKEN>
SITE_NAME=临渊羡鱼                 # 可选，通知里显示的站名；不配默认「博客」
SITE_URL=https://blog.x1anyu.cn    # 可选，部分 Waline 版本会带进 payload 的 url 字段
```

运行时侧**无需改代码**（端点已在 `worker.js` / `edge-functions/[[default]].js` 里），但首次要 `wrangler deploy`（cf）或在 Makers 重新部署（eo）让新路由生效。

行为细节：

- 复用 `ALERT_TOKEN` 做鉴权（token 放 URL query，Waline 原样 POST 过来），不新增 secret；
- payload 防御式解析：评论对象可能是 `data.comment`、直接 `comment` 或整个 body，都能取到 `nick` / `comment` / `url` / `status`；
- 通知文本最长 2000 字，超长截断；
- 可选跳过博主自己的评论：配 `WALINE_AUTHOR_MAIL`（与 Waline 的 `AUTHOR_EMAIL` 同值）即跳过该邮箱的评论，避免自己评论也响铃；
- 走 QQ **主动消息**，对方在 QQ 关掉「允许主动发送」会失败，失败原因原样返回给 Waline。

如果想走 Waline 原生 QQ 而非我们的机器人：在 Waline 侧配 `QMSG_KEY` + `QQ_ID`（Qmsg 酱，需去 qmsg.zendee.cn 注册并把你的 QQ 加进列表），完全不碰本仓库。两边都用我们自己的 bot 更省心：凭据可控、不依赖第三方可用性，也契合「QQ 机器人是首选通道」的定位。
