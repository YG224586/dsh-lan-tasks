# dsh-lan-tasks · 局域网任务看板

在手机浏览器里实时看 DSH 当前在干什么：哪些会话在跑、跑到第几步、调用了什么工具、
团队任务板进展、后台作业、最近活动流水。

手机和电脑连同一个 Wi-Fi，打开 **http://<本机局域网IP>:8791** 即可。

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
| 改动只在文档里说明，不建 client 半边 | 手机页面就是全部 UI，DSH 界面里不需要面板 |

## 3. 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 插件本体：HTTP 服务、路由、数据投影、事件订阅 |
| `page.js` | `renderPage(meta)` 返回自包含的移动端 HTML；`ICON_SVG` 图标 |
| `cordis.patch.yml` | 声明 loader 条目 `dsh-lan-tasks` → `@local/dsh-lan-tasks` |
| `package.json` | 包名、`exports`、`dsh.bundle.patch` |
| `icon.svg` | 页面/清单用的图标 |
| `README.md` | 本文件：原理、接口、安装、限制 |
| `交付说明.md` | 交付记录：现状、怎么用、怎么验、怎么回滚 |
| `install-lan-tasks.mjs` | 一键接进 desktop profile（幂等，可重复跑） |
| `smoke-lan-tasks.mjs` | 离线冒烟测试：23 项断言 × 两条路径 |

## 4. HTTP 接口

| 路由 | 说明 |
| --- | --- |
| `GET /` | 手机页面（自包含 HTML） |
| `GET /api/state` | 完整 JSON 快照 |
| `GET /api/stream` | SSE，每 `intervalMs` 推一次；无变化发 `: ping` 心跳 |
| `GET /healthz` | 免鉴权自检：版本、监听地址、端口、可用 URL |
| `GET /icon.svg`、`/manifest.webmanifest` | 图标与 PWA 清单（免鉴权） |
| 其它 | 404；非 GET/HEAD → 405 |

`token` 非空时，除 `/healthz`、`/icon.svg`、`/manifest.webmanifest` 外都要求
`?k=<token>`、`x-dsh-token` 头或 `dsh_lan_token` cookie。

### 插件 config

```yaml
port: 8791          # 监听端口
host: '0.0.0.0'     # 绑定地址
token: ''           # 非空则开启鉴权
history: 60         # 活动流水保留条数
intervalMs: 2000    # SSE 推送间隔
```

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

离线冒烟测试 `smoke-lan-tasks.mjs` 就在工作区根目录，用假 ctx 把**真插件**跑起来，
覆盖 HTTP 层、快照组装、任务过滤/排序、SSE、鉴权、404/405。

```
node smoke-lan-tasks.mjs 8801                     # 权威路径   23/23 PASS
$env:SMOKE_NO_CONTROLLER='1'; node smoke-lan-tasks.mjs 8802   # 回退路径   23/23 PASS
```

两条路径都验证过：有 `sessionController` 时 `running` 以它为准（假数据故意让
`mate` 的日志推断与 controller 结论相反，确认快照听的是 controller），
没有时回退到日志推断并在 `notes` 里给出提示。

## 8. 已知限制

- **改代码不会热重载。** DSH 的 `hmr` 服务不监听这个插件的源码文件（实测：改版本号后
  10 秒 `/healthz` 仍返回旧版本）。Node 的 ESM 模块缓存按 URL 缓存，所以
  「禁用/启用 bundle」只会重新执行 `apply()`，不会重新求值模块。
  **改完 `index.js` / `page.js` 必须重启 DSH 才生效。**
- 端口冲突（`EADDRINUSE`）只打印错误日志，不抛异常、不重试。
- 活动流水是内存环形缓冲，插件重启即清空。
- 没做 HTTPS，局域网内明文传输。
- 会话标题依赖 `sessionTitle` 服务；拿不到时退化成短 id。
