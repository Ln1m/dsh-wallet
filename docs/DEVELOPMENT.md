# dsh-wallet 开发复盘

> DeepSeek Harness 钱包插件（余额查询 + 会话成本 + 峰谷计价 + 一键充值/用量/API Key）从 0 到开源发布的完整记录。

## 一、需求与目标

在 DSH 软件**内部**查看 DeepSeek 账户余额与充值入口，UI 常驻左栏底部约 1/4 高度，参考 GitHub 同类项目与官方文档实现。

## 二、调研结论（关键事实）

| 事实 | 来源 |
| --- | --- |
| 余额接口 `GET api.deepseek.com/user/balance`（Bearer 鉴权），返回 `balance_infos[]`（currency/total_balance/granted_balance/topped_up_balance） | 官方 API 文档 |
| **充值无 API**，只能跳官方网页 `platform.deepseek.com/top_up`（支付宝/微信，需实名） | 官方 |
| 官方平台页面全部带 `CSP: frame-ancestors 'none'`，**禁止 iframe 内嵌** | 实测响应头 |
| 官方价格页：基础价（8-17 前）+ 峰谷价（8-17 起，高峰=空闲 2 倍，北京 9-12/14-18） | api-docs.deepseek.com |
| 会话成本 = token-meter 的 `tokenUsage` 投影 × 价格表（flash/pro） | 参考 dsh-balance-meter |

参考项目：`dsh-balance-meter`（composer dock chip 余额+会话成本）、`dsh-deepseek-quota`（右下角浮动卡片）、`dsh-usage-plugin`（完整用量统计）、`dsh-balance-plugin`（余额+用量+三方插件管理）。

## 三、架构

```
Host（Node）
├─ 余额：fetch /user/balance（30s 缓存），自动读 DSH 凭据 DEEPSEEK_API_KEY
├─ 会话成本：sessionProjections.snapshot(session).values.tokenUsage × 价格表
│   └─ 价格表：flash/pro 基础价 + 峰谷价（isPeakHour 判断北京时段 + 8-17 生效时间戳）
├─ 低余额告警：CNY<10 / USD<2
├─ RPC：/wallet/api/balance · refresh · cost?session=<id>
└─ 工具：query_deepseek_balance

Client（浏览器）
├─ 入口：sidebar.footer.action（左栏底部 24vh 面板，root scope）
├─ 余额 + 本会话成本 + 峰谷 band 标注（base/peak/offPeak）
├─ 当前会话 id：useSyncExternalStore 订阅 sessions.list（切换会话即时刷新）
└─ 充值/用量/API Key 按钮：window.open → 桌面端 WebView2 内开官方页
```

## 四、开发迭代时间线

1. **完整版**：余额 + 用量统计图表 + 手动 key 管理（左栏面板）→ 用户否掉。
2. **简化版**：余额摘要 + 三按钮跳官方页 → 用户反馈「学 GitHub 项目」。
3. **会话成本版**：移植 dsh-balance-meter（composer dock chip）→ 用户要「左栏 1/4」。
4. **最终版**：左栏面板 + 会话成本 + 峰谷标注 + 弹窗内化，多轮 UI 打磨。

## 五、遇到的问题与解法（踩坑清单）

### UI / 主题
1. **深色白块**：深色主题下 `--dsw-alias-brand-primary` = 白色，主按钮写 `color:#fff` 导致白底白字。→ 用 `color:var(--dsw-alias-label-primary-foreground)`（自动反色）。
2. **胶囊对齐**：line-height 造成文字顶部留白、字形上下不对称。→ 胶囊与文字统一 `font-size + line-height`，或用 `useLayoutEffect` 代码端量取文字 `offsetHeight` 同步胶囊高度。
3. **峰谷 band 三档疑问**：base=8-17 前基础价（过渡态），peak/offPeak=8-17 后两档。

### DSH 插件机制
4. **slot scope**：`sidebar.footer.action` 是 root scope（拿不到 sessionId）；`conversation.composer.dock` 是 session scope（自动注入 sessionId）。root scope 拿当前会话要用 `useSyncExternalStore` 订阅 `sessions.list.getSnapshot().current`。
5. **服务必须 inject**：`ctx.get("credentials")` 未在 `inject` 声明时懒加载返回 undefined → 余额查不到。需把 `credentials`/`sessionProjections` 显式加入 `inject`。
6. **client inject 声明 slot 声明者**：注入 `sidebar.footer.action` 时 `dsh.client.inject` 要含 `@deepseek-ai/dsh-client-ui-sidebar`。

### 桌面端（WebView2 内化）
7. **两栏→一栏闪烁**：CSS 在 `NavigationCompleted` 注入时，React SPA 已渲染侧边栏。→ 用 `AddScriptToExecuteOnDocumentCreatedAsync` + `DOMContentLoaded` 在 React 渲染前注入 CSS。
8. **弹窗失焦关闭 vs 流畅切换冲突**：点击主窗口按钮会先触发 Deactivate 关闭。→ Deactivate 延迟 250ms + `reused` 标志（NavigateTo 复用则取消关闭）。
9. **弹窗多开**：→ 单例 `openChild` 静态字段 + 复用 NavigateTo + Activate。
10. **`build.ps1` 编译 bug**：pwsh7 下 `$pk`（Get-ChildItem | Select-Object -First 1）展开成相对路径，csc 找不到 WebView2 DLL。→ 手动 csc.exe 编译（用 `$pk.FullName`）。
11. **C# Timer 歧义**：`using System.Threading` 下 `Timer` 解析为 threading.Timer。→ 写全 `System.Windows.Forms.Timer`。
12. **lambda 参数遮蔽**：`OnShown(object sender, ...)` 里 lambda 参数不能再用 `sender`。→ 改名 `wvSender/wvArgs`。

### 发布
13. **GitHub push 网络**：github.com:443 在 China 网络常超时（`curl 28 Could not connect`），但 api.github.com 可用。→ 用 GitHub API（contents/git database）上传；本地 git 与 API 上传会**历史分叉**，最终 `git push -f` 统一。
14. **README 图片**：npm 网站不解析相对路径图片；raw.githubusercontent.com 国内慢/超时（尤其 >100KB）。→ 压缩截图（转 JPEG + 缩小），README 用 **jsdelivr CDN 绝对 URL** `https://cdn.jsdelivr.net/gh/<user>/<repo>@<branch>/<path>`（国内有 CDN 节点）。
15. **npm publish**：用户 .npmrc registry 是 npmmirror（只读镜像），publish 须显式 `--registry=https://registry.npmjs.org`；token 在 `//registry.npmjs.org/:_authToken`。

## 六、发布结果

- GitHub：https://github.com/Ln1m/dsh-wallet（v1.0.1）
- npm：dsh-wallet@1.0.1
- 附带修复 dsh-lt-tasks 图片（0.2.3，README 改 jsdelivr）

## 七、复用建议

- 做「余额/用量」类插件：直接参考 dsh-balance-meter 的 `sessionCost`（sessionProjections + 价格表）模式。
- 做「在 DSH 内打开第三方网页」：桌面端 `NewWindowRequested` + 无边框 16:9 ChildForm + 失焦关闭 + 单例复用 + `DOMContentLoaded` 注入 CSS 隐藏第三方导航。
- UI 弹窗：优先 16:9、无边框、点击外部失焦关闭（已沉淀进 `ui-design` skill）。

## 八、v1.2.0 → v1.3.0 迭代复盘（2026-08-17）

本阶段新增：今日累计 + 7 天折线图 + 官方用量接口 + 阈值持久化 + 退避重试 + 折叠/通知 + 一键安装 + 中英 README + 桌面内化补丁 + 插图。

### 数据正确性
16. **今日累计严重虚高（分叉子会话重复计数）**：`scanHistory` 扫描所有会话求和时，分叉子会话（subagent）会把父会话历史作为 seed 事件复制进自己的日志，导致同一批事件在父 + 每个子会话里各算一遍。→ 回扫时跳过 `seq < header.seedLength` 的继承事件（seedLength 是 fork 边界，父会话正常、子会话跳过 seed）。
17. **官方用量接口：API Key 查不到，必须用平台 userToken**。`/user/balance` 只能用 API Key（`sk-` 开头）；用量明细 `platform.deepseek.com/api/v0/usage/cost?month=&year=` 只能用登录后的 userToken（localStorage `userToken`，值是 `{"value":"...","__version":"0"}`，取 `.value`）。鉴权失败也返回 HTTP 200，body `code:40003`（判 code 而非 status）。
18. **官方 cost 接口结构**：`data.biz_data[0].days[].data[].usage[]`，`amount` 是**成本金额（元）**，type 标签是 token 类型名（PROMPT_CACHE_HIT_TOKEN 等，误导性）。返回整月含未来日期（全 0），需过滤 `date > 今天`。
19. **配置文件 UTF-8 BOM 坑**：PowerShell `Set-Content -Encoding UTF8` 会带 BOM，`JSON.parse` 直接报错 → 读配置时 `.replace(/^\uFEFF/, '')` 容错；写配置用 node `writeFile`（无 BOM）。

### 交互/UI
20. **阈值回车不生效**：原实现等 POST 返回才更新 UI，中间 `setThresholdDraft(null)` 回退到旧值，看起来像没生效。→ 乐观更新：回车/失焦先 `setCost(c => c ? {...c, costThreshold: t} : c)` 立即反映，再异步 POST 持久化。
21. **折叠按钮「点了没用」**：hover 展开（peek）把点击态顶回去——点折叠后鼠标还悬停在面板上，`collapsed = !open && !peek` 因 peek=true 仍为展开。→ 要么纯点击切换（删 peek），要么点击时 `setPeek(false)` 立即收起。最终用户嫌逻辑复杂，**整个折叠删掉了**。
22. **折叠 + 悬浮 tooltip 被裁切**：`grid-template-rows: 1fr/0fr` 折叠要求内层 `overflow:hidden`，会裁掉绝对定位的悬浮明细。→ tooltip 用 `position:fixed`（React state 定位），渲染在 overflow 容器之外。

### 插图/发布
23. **README 截图（无真实截图时）**：用 Edge headless `msedge --headless --disable-gpu --hide-scrollbars --screenshot=out.png --window-size=W,H file:///...` 渲染自绘 HTML 面板 mockup。坑：`html` 没设背景时截图底部是透明的 → 设 `html{background:...}`；主题切换用 query 参数 + `documentElement.classList`。
24. **Ollama 卸载**：视觉识图早已迁到 llama-cpp-server（端口 8080），Ollama 成冗余且开机自启动（Startup 快捷方式 `Ollama.lnk`）。→ 移除 Startup 快捷方式 + 静默卸载（`unins000.exe /S`）。

### v1.3.1 修复（2026-08-17）
25. **本会话成本「全按当前时段计价」错误**：原实现用 `sessionProjections`（会话累计 token）直接 × `effectiveCostAt(当前时刻)`，导致高峰时段打开面板时，把整天（含空闲时段）的 token 全按高峰价算。→ **分段计费**：从事件流按 `bandAt(event.time)`（base/offPeak/peak）把每个会话的 token 分桶，成本 = Σ(各档 token × 各档单价)。会话成本改用 `perSession`（事件流分桶）而非 `sessionProjections`（无时间维度）。配套：`ensureSessionIngested` 在 cost 路由里对未扫过的旧会话按需回扫，避免切换到旧会话时成本归零。
26. **运行副本位置变了**：声明 `dsh.bundle.patch` 后，重启时 dsh loader 会从 npm 把插件解析到 `profiles\web\node_modules\dsh-wallet`（而非旧的 `profiles\node_modules\dsh-wallet` 手动副本）。→ 本地改完要么同步到新位置，要么直接发 npm 新版本；手动副本路径已废弃。

## 九、发布结果

- GitHub：https://github.com/Ln1m/dsh-wallet（v1.3.1）
- npm：dsh-wallet@1.3.1

