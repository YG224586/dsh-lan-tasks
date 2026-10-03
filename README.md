# dsh-lan-tasks · 局域网任务看板

在手机浏览器里实时看 DSH 当前在干什么：哪些会话在跑、跑到第几步、调用了什么工具、
团队任务板进展、后台作业、最近活动流水。

手机和电脑连同一个 Wi-Fi，打开 **http://<本机局域网IP>:8791** 即可。

不想手敲地址？v1.2.0 起在 DSH 桌面界面里就有入口：**设置 → 局域网任务看板**，
侧栏底部还有一个「局域网看板」按钮，点开是带二维码的浮层 —— 手机相机对着扫一下就能看。

v1.3.0 起手机端不只是「看」：点一下会话就能进去看完整时间线（谁说了什么、调了什么工具、
哪一步报错、历史里的图片），还能直接在手机上**发消息**（文字 + 图片），等于坐到电脑前敲回车。
⚠️ 这等于把「指挥 agent」的入口放到局域网里，见第 4 节末尾的安全说明。

---

## 1. 目标

DSH 自己的 Web 服务只监听回环地址（实测 `TCP 127.0.0.1:19387 LISTENING`，没有 0.0.0.0 绑定），
手机在局域网里根本连不上。所以这个插件**不依赖 DSH 的 `webServer`**，自己起一个监听
`0.0.0.0:8791` 的 HTTP 服务，用服务端渲染的移动端页面 + SSE 推送把任务情况送出去。

## 2. 关键决策与理由

| 决策 | 理由 |
| --- | --- |
| 自建 `node:http` 服务绑 `0.0.0.0`，不用 `ctx.webServer` | DSH 的 webServer 只绑回环，复用它手机照样连不上 |
| 页面服务端渲染、零外部资源 | 局域网可能没有外网，不能引 CDN；也省掉手机端的构建步骤 |
| SSE 优先，连续失败 2 次降级为 2.5s 轮询 | SSE 省电、实时；但手机切后台/断网时 `EventSource` 会静默失效，必须有兜底 |
| 在跑状态以 `sessionController.list()` 的 `SessionSummary.running` 为准 | 只订阅 `session/event` 的话，插件启动前就开始的回合永远显示「空闲」——页面会理直气壮地报错信息 |
| 拿不到上面那个服务时，回读会话日志尾巴推断 | 退化路径。从后往前找第一个 `turn/start`/`turn/end` 判断状态 |
| 所有数据读取各自 `try/catch`，读不到就留空 | 插件绝不能把宿主带崩；某个服务缺席时页面应该少一块，而不是白屏 |
| `token` 默认空 | 只在可信局域网用；需要时能在插件 config 里填一个共享密钥 |
| 手机页面继续自建服务，桌面面板另走宿主 `webServer` | 手机要在局域网里连上，必须自己绑 `0.0.0.0`；而 DSH 界面跑在 `127.0.0.1:19387`，跟 8791 不同源，面板里取数据只能走宿主 webServer 的同源路由，否则跨域 |
| 二维码在宿主侧生成 SVG，前端只放 `<img>` | 浏览器端不塞编码器：少一份依赖、少一份要调试的代码；宿主已经能算出局域网地址，顺手把图画出来 |
| 自己手写二维码编码器（`qrcode.js`，零依赖） | 不引 npm 包（这台机器 registry 不稳），只用字节模式 + 纠错等级 L + 版本 1-5，够放一条 `<200 字节的 URL`；正确性交给 OpenCV 独立解码验证（见第 7 节） |
| 面板请求按序号作废过期响应 | 5 秒轮询下慢响应回来会盖掉更新的状态（先发的失败被后到的成功覆盖），`usePanelData` 里用一个自增 ticket 丢掉过期结果 |
| 发消息复用 `sessionController.prompt()`，不自己造通路 | 宿主已有「把一句话送进会话」的官方入口（`mode: 'queue' \| 'steer'`），插件只做 HTTP 到它的搬运；`requestId` 自己生成，`clientTimeZone` 用手机时区 |
| 写入口只留一个 `POST /api/send`，且**强制 `Content-Type: application/json`** | 跨站表单只能发 `urlencoded`/`multipart`/`text-plain`，伪造不了 JSON 头；跨源 `fetch` 带这个头会先发预检 `OPTIONS`，而本服务对 `OPTIONS` 回 405 —— 两道都不用额外依赖就挡住了 CSRF |
| 图片在手机本地先缩到最长边 1600、转 JPEG 0.85 | 手机原图动辄 5-10 MB，局域网传着慢、宿主内存也吃紧；`gif` 不缩（缩了就不动了），缩图链路任何一步不可用就退回原图 |
| 「只收了前 N 张」单独放 `pickNote` 字段 | 读图是异步的：`addImage` 成功后会清 `sendError`，把超限提示放在同一个字段里会被随后到达的成功结果抹掉（冒烟测试抓到的真 bug） |
| `openSession()` 里先写 `lastTry = Date.now()` 再渲染 | 否则 `renderSheet` 的「跟着看板刷新」节流判定会因为 `lastTry` 还是 0 而立刻再发一次同样的 `/api/session`（冒烟测试抓到的重复请求） |

## 3. 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 插件本体：HTTP 服务、路由、数据投影、事件订阅、桌面面板的宿主侧路由 |
| `page.js` | `renderPage(meta)` 返回自包含的移动端 HTML；`ICON_SVG` 图标 |
| `qrcode.js` | 零依赖二维码（字节模式 / 纠错 L / 版本 1-5）：`qrMatrix` / `qrSvg` / `qrAscii` |
| `client.js` | DSH 桌面界面的客户端半边：设置页面板 + 侧栏按钮 + 扫码浮层 |
| `cordis.patch.yml` | 声明 loader 条目 `dsh-lan-tasks` → `@local/dsh-lan-tasks` |
| `package.json` | 包名、`exports`、`dsh.bundle.patch`、`dsh.client` |
| `icon.svg` | 页面/清单用的图标 |
| `README.md` | 本文件：原理、接口、安装、限制 |
| `交付说明.md` | 交付记录：现状、怎么用、怎么验、怎么回滚 |
| `install-lan-tasks.mjs` | 一键接进 desktop profile（幂等，可重复跑） |
| `smoke-lan-tasks.mjs` | 离线冒烟测试（宿主侧）：83 项断言（`SMOKE_NO_CONTROLLER=1` 68 项、`SMOKE_NO_WEB=1` 70 项） |
| `smoke-client.mjs` | 离线冒烟测试（桌面客户端插件）：48 项断言 |
| `smoke-page.mjs` | 离线冒烟测试（手机页面）：假 DOM 跑页面脚本 + 真 HTTP 打回插件，52 项断言 |

## 4. HTTP 接口与手机端怎么用

| 路由 | 说明 |
| --- | --- |
| `GET /` | 手机页面（自包含 HTML） |
| `GET /api/state` | 完整 JSON 快照 |
| `GET /api/stream` | SSE，每 `intervalMs` 推一次；无变化发 `: ping` 心跳 |
| `GET /api/session?id=<sessionId>&limit=N` | 会话详情：标题、在跑状态、轮数、错误数、时间线（`records`：`user` / `assistant` / `tool` / `err` / `sys`），`limit` 1-400（默认 80），`hasMore` 说明上面还有没有更早的 |
| `GET /api/image?id=<sessionId>&a=<attachmentId>` | 把会话日志里的图片代理成字节流（`private, max-age=3600`），手机不接触宿主的内部附件路径 |
| `POST /api/send` | **唯一写入口**：`{ sessionId, text, mode: 'queue'\|'steer', tz?, images: [{ mediaType, data, name? }] }` → `sessionController.prompt()`。等价于在桌面输入框敲一句话 |
| `GET /healthz` | 免鉴权自检：版本、监听地址、端口、可用 URL、`send: 'on'\|'off'` |
| `GET /icon.svg`、`/manifest.webmanifest` | 图标与 PWA 清单（免鉴权） |
| 其它 | 404；非 GET/HEAD（`POST /api/send` 除外）→ 405 |

`token` 非空时，除 `/healthz`、`/icon.svg`、`/manifest.webmanifest` 外都要求
`?k=<token>`、`x-dsh-token` 头或 `dsh_lan_token` cookie（包括 `POST /api/send`）。

`POST /api/send` 的拒绝方式：`Content-Type` 不是 `application/json` → 415；
`allowSend: false` → 403；宿主没有 `sessionController` → 503；会话 id 不认识 → 404；
空内容 → 400；`mediaType` 不在 `image/png|jpeg|webp|gif` → 400；单张超过 `maxImageBytes` → 400；
张数超过 `maxImages` → 400。**被拒绝的请求不会调用 `prompt()`**（冒烟测试专门断言了这条）。

### 桌面面板路由（注册在宿主 webServer 上，不在 8791 端口）

DSH 界面（`http://127.0.0.1:19387`）与插件的 8791 端口不同源，面板要取数据就得同源，
所以这三条挂在宿主 `ctx.webServer` 上（`inject: ['webServer']`）：

| 路由 | 说明 |
| --- | --- |
| `GET /lan-tasks/state` | 面板用的 JSON：版本、监听状态、端口、`token` 是否开启、本机入口、全部局域网地址、统计、`notes` |
| `GET /lan-tasks/qr.svg?i=N` | 第 N 个局域网地址的二维码（SVG，`image/svg+xml`，`no-store`）；没有局域网地址时 404 |
| `GET /lan-tasks/qr.txt?i=N` | 第一行是 URL，下面是终端可扫的字符画（半块字符 + ANSI 色） |

面板接口不受 `token` 影响（它只在回环地址上被 DSH 界面取用，等于已登录用户自己看自己的机器）。

### 三个挂载点（客户端插件 `client.js`）

| 槽 | 挂载位置 | 表现 |
| --- | --- | --- |
| `settings.section` | 设置页 | 「局域网任务看板」整块面板：二维码、入口 URL、复制/本机打开/刷新、多网卡切换、统计 |
| `sidebar.footer.action` | 侧栏底部（设置按钮旁） | 「局域网看板」按钮；侧栏收窄成 56px 时只剩二维码图标 |
| `shell.overlay` | 全屏浮层 | 点侧栏按钮弹出的卡片（Esc 或点空白处关闭），不用离开当前会话就能扫码 |

客户端插件在 DSH **启动时**装载，所以装完（或改完 `client.js`）必须重启 DSH 才会出现；
宿主侧的三条路由同理（它们是 `apply()` 里注册的）。

### 插件 config

```yaml
port: 8791             # 监听端口
host: '0.0.0.0'        # 绑定地址
token: ''              # 非空则开启鉴权（开了 allowSend 就强烈建议填一个）
history: 60            # 活动流水保留条数
intervalMs: 2000       # SSE 推送间隔
allowSend: true        # 手机端能否发消息/图片；false = 退回纯只读看板（POST /api/send 一律 403）
maxImageBytes: 6291456 # 单张图片上限（6 MB，按 base64 解码后的字节算）
maxImages: 4           # 一条消息最多几张图
```

### 手机端怎么用（v1.3.0 起）

看板「会话 / 代理」那一栏每条右边有个 `›`，点一下整屏打开这个会话：

- **时间线**：你说的话、助手的回复、工具调用（一行「工具名 + 命令摘要」）、出错的那一步（红行）、
  以及历史里出现过的图片（缩略图，点开看大图，字节是从 `/api/image` 拿的）。
  正常结束的工具结果不占行，否则时间线会被结果淹没。
- **底部输入区**：文本框 + `📷 图片` + `发送`。发送走 `POST /api/send`，默认 `mode: 'queue'`
  （排队等当前回合结束；`steer` 是插队打断，目前界面只用 queue）。
- **图片**：在手机上先缩到最长边 1600、转 JPEG 0.85 再传，选错的可以按 `×` 删掉；
  `gif` 不缩。上限由 `maxImageBytes` / `maxImages` 控制，超了会在输入框上方说明原因。
- 正在打字时页面不会重画浮层（免得光标乱跳），时间线每 2.5 秒跟着看板刷新一次。

### ⚠️ 安全：这等于把 agent 的输入框放到局域网里

`allowSend` 默认开。**同网段任何人都能打开 `http://<你的IP>:8791` 给会话发消息**，
而 agent 收到消息后是会真的执行工具的（跑命令、改文件）。所以：

- 插件启动横幅会在「开了发送但没设 token」时打三行警告 —— 看到就别在公用网络上跑。
- 公用网络（宿舍、咖啡馆、公司访客 Wi-Fi）请至少设一个 `token`，或者把 `allowSend` 关掉。
- `token` 只是「共享口令」级别：局域网里是明文 HTTP，能抓包的人看得到 `?k=`。
- 发送接口本身有 CSRF 防护（强制 JSON 头 + `OPTIONS` 405），但那只挡浏览器跨站，
  挡不住同网段直接 `curl`。

## 5. 数据来源（全部只读）

- `agents.list()` / `agents.roots()` — 活着的会话与 Agent
- `sessions.list()` — 每个会话的 `SessionHeader`（cwd、父子关系、委派深度）
- `sessionController.list()` — **权威在跑状态**（`SessionSummary.running` / `updatedAt` / `blank`）
- `session.snapshotEvents()` — 冷启动时回读日志尾巴，补最近一句话、最近工具调用、轮次
- `sessionTitle.get(session)` — 会话标题（用户在 DSH 里改过名也能跟上）
- `agentTeams.tryMembership()` / `listMembers()` / `listTasks()` — 团队看板
- `jobs.list()` + 按 session 逐个 `jobs.list(id)` 合并去重 — 后台作业
- `goals.get(rootAgent)` — 当前目标与进度
- 事件：`session/event`、`agent/status`、`subagent/start|end`

## 6. 安装方式

DSH 的插件注册 = 包自带 `cordis.patch.yml` + 包名列进 profile 的 `dsh.profile.bundles`
+ 包本体出现在 `profiles/desktop/node_modules/`。

源码就在这个工作区里（`D:\workspaces\dsh-lan-tasks`），
装、搬家、修链接都只要一条命令：

```powershell
node install-lan-tasks.mjs
```

脚本做三件事，可重复执行：

1. 建 junction `profiles\desktop\node_modules\@local\dsh-lan-tasks` → 本工作区。
   已存在但指向别处、**或者已经悬空**，都会先移除再重建；
   如果发现那里是真实目录则直接报错拒绝删除。
2. 往 `profiles\desktop\package.json` 写
   `dependencies."@local/dsh-lan-tasks" = "link:D:/workspaces/dsh-lan-tasks"`
3. 把 `"@local/dsh-lan-tasks"` 追加进 `dsh.profile.bundles`

之后在 DSH 里让 profile 重新应用补丁（宿主侧 `set_bundle`），或直接重启 DSH。

> 工作区搬走或改名后，重跑一次 `node install-lan-tasks.mjs` 就能把链接指到新位置。

**克隆到别的机器**（仓库地址 <https://github.com/YG224586/dsh-lan-tasks>）：

```powershell
git clone https://github.com/YG224586/dsh-lan-tasks.git D:\workspaces\dsh-lan-tasks
cd D:\workspaces\dsh-lan-tasks
node install-lan-tasks.mjs                                       # 默认这台机器的 desktop profile
$env:LAN_TASKS_PROFILE='C:\Users\你\.dsh\profiles\desktop'; node install-lan-tasks.mjs   # 别的机器覆盖一下
```

脚本用 `import.meta.url` 定位自己所在目录，克隆到哪儿都不用改路径。
包名固定是 `@local/dsh-lan-tasks`（`cordis.patch.yml` 按这个 id 注册），与仓库名无关。
脚本另外会拒绝相对路径的 profile 目录，避免写到意料之外的地方。

> 覆盖变量千万别用宿主已经占用的 `DSH_PROFILE` —— 在 DSH 会话里它的值是相对路径 `desktop`，
> 拿它当 profile 目录会把 `node_modules` 建到当前工作目录，并造出一个指向自己的 junction。

原始备份：`profiles\desktop\package.json.bak-20261003-154410` 与
`pnpm-lock.yaml.bak-20261003-154410`；搬家前又备份了一份 `package.json.bak-20261003-155546`。
回滚 = 把备份覆盖回去 + 删掉那个 junction。

**没有跑 `pnpm install`**：纯增量的 `link:` 依赖不需要动 lockfile，而这台机器上 pnpm
有过多次 registry 超时记录。事后确认插件正常加载。

## 7. 验证

### 7.1 宿主侧冒烟（`smoke-lan-tasks.mjs`）

用假 ctx 把**真插件**跑起来，覆盖 HTTP 层、快照组装、任务过滤/排序、SSE、鉴权、404/405，
桌面面板的宿主侧（三条路由的注册、状态 JSON、二维码 SVG 与 `qrSvg()` 逐字节一致、索引越界回退、
字符画首行），以及 v1.3.0 的三条新路由：会话详情的 400/404/200 与字段、老会话回退到 `inspect`、
图片代理的字节一致性、发送接口的各种拒绝（415/403/503/404/400）与「被拒的请求真的没调用 `prompt()`」、
发完 `activity` 里出现「你（手机）」。

```
node smoke-lan-tasks.mjs 8801                     # 83 项断言  PASS
$env:SMOKE_NO_CONTROLLER='1'; node smoke-lan-tasks.mjs 8802   # 回退路径   68 项 PASS
$env:SMOKE_NO_WEB='1'; node smoke-lan-tasks.mjs 8803          # 宿主没有 webServer  70 项 PASS
```

两条路径都验证过：有 `sessionController` 时 `running` 以它为准（假数据故意让
`mate` 的日志推断与 controller 结论相反，确认快照听的是 controller），
没有时回退到日志推断并在 `notes` 里给出提示。

### 7.2 客户端插件冒烟（`smoke-client.mjs`）

`node:vm` 把 `client.js` 当普通脚本加载，喂一个假 `__ModuleLoader__`、一个迷你 React
（`useState` 跨渲染持久化、`useEffect` 同步执行）和一个假 `fetch`，断言：加载器契约、
三个槽的注册项、渲染出的二维码/统计/按钮、多网卡切换、复制按钮、窄栏图标按钮、
浮层的开关与 Esc、接口挂掉时的降级与「迟到的成功不许盖掉新结果」。

```
node smoke-client.mjs                             # 48 项断言  PASS
```

### 7.3 二维码真的能扫吗（用 OpenCV 独立解码）

自己写的编码器不能自己证明自己对，所以用**另一个实现**解码：PIL 把 SVG/字符画栅格化，
交给 `cv2.QRCodeDetector` 认。

```powershell
# 1) 用冒烟测试把 HTTP 真实响应体落盘（不是直接调函数，是走完路由拿到的字节）
$env:SMOKE_DUMP_SERVED="$env:TEMP\lan-tasks-qr-verify\served.json"; node smoke-lan-tasks.mjs 8811
# 2) 交给 OpenCV 解码（D:\tool\python\python.exe 带 cv2/PIL；DSH 自带的运行时里没有 cv2）
D:\tool\python\python.exe "$env:TEMP\lan-tasks-qr-verify\verify_served.py" "$env:TEMP\lan-tasks-qr-verify\served.json"
```

结论：`http://192.168.1.32:8811/`（21→25 模块）与带口令的
`http://192.168.1.32:8813/?k=s3cr3t-token-0123456789`（29 模块）都能被 OpenCV 正确解出原文；
SVG 与字符画还原出的是同一张矩阵。`qrcode.js` 自己的 5 个样本（含 106 字节的 v5 上限）
也是同样的三步验证，另外对过 ISO/IEC 18004 附录 A 的生成多项式。

### 7.4 手机页面冒烟（`smoke-page.mjs`）

页面脚本本身也要能测：`node:vm` 里搭一个假 DOM（`getElementById` / `innerHTML` /
`document.addEventListener`）、假 `FileReader`（回一段 data URL）、假 `Image` + 假 canvas
（固定输出一段 base64），然后让它用**真的 `fetch`** 打到同进程里跑起来的插件实例上 ——
从「点一下会话」到「服务端到底收到了什么」整条链路都覆盖：

- 列表条目可点（`data-act="open"` + `data-sid`）；点一下只发**一次** `/api/session`，
  带 `credentials` / `cache` 约束；浮层、标题、状态行、时间线（user / assistant / tool / err 行、
  「bash pnpm install」、错误文案）、`/api/image` 缩略图都对得上。
- 空内容点发送不会发出去；打字后发送，服务端收到的 `content` 恰好是那段文字，
  `mode: 'queue'`、`requestId` 前缀 `lan-tasks-`、带手机时区；发完草稿清空并提示「已发送」。
- 选图走「FileReader → canvas → JPEG」链路，发出去的是压缩后的 base64 与文件名；
  非图片被拒、超过张数上限给提示且不丢图、`×` 能删图。
- Esc 关浮层；读会话返回 500 时把原因显示出来（不白屏）。
- 带 `token` 的实例：所有请求（含 `POST /api/send`）都带 `?k=`，并且真的能读能发。

```
node smoke-page.mjs 8879                          # 52 项断言  PASS
```

这三个冒烟测试一共 231 项断言（83+68+70+48+52，含降级路径的重复计数）。

## 8. 已知限制

- **改代码不会热重载。** DSH 的 `hmr` 服务不监听这个插件的源码文件（实测：改版本号后
  10 秒 `/healthz` 仍返回旧版本）。Node 的 ESM 模块缓存按 URL 缓存，所以
  「禁用/启用 bundle」只会重新执行 `apply()`，不会重新求值模块。
  **改完 `index.js` / `page.js` / `client.js` 必须重启 DSH 才生效。**
- **桌面面板要重启 DSH 才出现**：客户端插件只在启动时装载，宿主侧那三条路由也是
  `apply()` 里注册的。重启之前只有 8791 那个手机页面在跑。
- 二维码只支持到版本 5（106 字节）。带 `token` 的 URL 太长会超限，此时
  `/lan-tasks/qr.svg` 返回 500 并在正文里说明原因（面板上显示的是错误文案，不是空白）。
- **发消息 = 把 agent 的输入框放到局域网里**：`allowSend` 默认开，同网段谁能打开页面谁就能让
  agent 干活。公用网络请设 `token` 或 `allowSend: false`（详见第 4 节末尾）。
- 图片：单张 ≤ `maxImageBytes`（默认 6 MB，按解码后字节算）、一条消息 ≤ `maxImages`（默认 4 张），
  只收 png / jpeg / webp / gif（`gif` 不做压缩），且走 base64 传输 —— 请求体会比原始字节大约 1.37 倍。
- 时间线只给最近 `limit` 条（默认 80，最多 400）：更早的记录目前**没有**翻页入口
  （接口会回 `hasMore`，界面只提示一句）。
- 只能往**已经存在**的会话发消息（走 `sessionController.prompt`）；新建会话仍然要在桌面上做。
- 手机端目前只用 `mode: 'queue'`（排队）。接口支持 `'steer'`（立刻插队打断当前回合），但没做按钮。
- 不在内存里的老会话走 `sessionController.inspect()` 读历史，比活会话慢一点；
  图片字节要经 `/api/image` 代理，同样依赖会话服务在线。
- 端口冲突（`EADDRINUSE`）只打印错误日志，不抛异常、不重试。
- 活动流水是内存环形缓冲，插件重启即清空。
- 没做 HTTPS，局域网内明文传输。
- 会话标题依赖 `sessionTitle` 服务；拿不到时退化成短 id。
