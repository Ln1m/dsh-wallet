# dsh-wallet

DeepSeek Harness（DSH）钱包插件 —— 左栏底部常驻显示 **DeepSeek 账户余额**、**今日累计成本**、**当前会话消耗** 与 **近 7 天消耗趋势**，一键跳转官方平台充值 / 管理 API Key。

## ✨ 功能

| 模块 | 能力 |
| --- | --- |
| 余额查询 | 官方 `GET api.deepseek.com/user/balance`（Bearer 鉴权），CNY / USD 双余额池；失败自动指数退避重试 |
| 今日累计 | 调官方平台用量接口 `platform.deepseek.com/api/v0/usage`（可选配 userToken），显示**今天真实消耗**；未配置则回退本地会话统计 |
| 消耗趋势 | 近 **7 天**每日成本折线图，悬停显示日期与金额（轻量 SVG，无第三方图表库） |
| 会话成本 | token-meter 投影 × 官方价格表，实时估算当前会话消耗；悬停展开输入 / 缓存命中 / 输出明细 |
| 峰谷计价 | 内置 2026-08-17 生效的官方峰谷价，北京高峰时段（9:00–12:00、14:00–18:00）自动切换 |
| 低余额告警 | CNY < ¥10 或 USD < $2 时标黄提醒 |
| 提醒阈值 | 可编辑单会话阈值（默认 ¥5，**持久化**到 `~/.dsh/dsh-wallet.json`），超限提示新建对话 |
| 系统通知 | 低余额 / 超阈值时浏览器系统通知（状态转变时触发一次） |
| 一键跳转 | 「充值 / API Key / 明细」在 **DSH 窗口内**打开官方页（不弹系统浏览器） |
| 模型工具 | 注册 `query_deepseek_balance`，直接问 AI「余额还剩多少」也能答 |

## 🖼 界面

深色主题：

![深色](https://cdn.jsdelivr.net/gh/Ln1m/dsh-wallet@main/assets/screenshot-panel.png)

浅色主题：

![浅色](https://cdn.jsdelivr.net/gh/Ln1m/dsh-wallet@main/assets/screenshot-panel-light.png)

折线图悬停显示日期 + 金额：

![悬停](https://cdn.jsdelivr.net/gh/Ln1m/dsh-wallet@main/assets/screenshot-hover.png)

```
DeepSeek 钱包                     ↻
余额                   ¥30.39 CNY
今日累计               ¥70.30
本会话消耗 ¥1.23 [高峰价]   ← 悬停展开 token/金额明细
▁▂▃▅▆▇                    ← 近 7 天趋势
提醒阈值   ¥[5.00]
[充值] [API Key] [明细]
```

## 🏗 架构

```
Host（Node 进程）
├─ 余额查询：Node 原生 fetch → api.deepseek.com/user/balance（30s 缓存 + 指数退避）
├─ 今日/趋势：官方 platform /api/v0/usage（userToken，5 分钟缓存）优先，本地 session/event 聚合兜底
├─ 会话成本：sessionProjections.tokenUsage × 价格表（flash/pro，含峰谷）
├─ 阈值持久化：~/.dsh/dsh-wallet.json（启动加载，修改即存）
├─ RPC：/wallet/api/balance · refresh · cost?session=<id> · usage · set-threshold
└─ 模型工具：query_deepseek_balance

Client（浏览器）
├─ 入口：sidebar.footer.action（左栏底部常驻面板）
├─ 余额 + 今日累计 + 本会话消耗 + 7 天折线图 + 提醒阈值 + 充值/API Key 入口
├─ 当前会话 id 经 useSyncExternalStore 订阅 sessions.list，切换会话即时刷新
└─ 系统通知：低余额 / 超阈值（Notification API）
```

## 📦 安装

### 一键安装（推荐）

```bash
dsh plugin add dsh-wallet
```

`package.json` 已声明 `dsh.bundle.patch`，插件会自动注册到 profile，无需手动改 `cordis.patch.yml`。装完重启 `dsh web` 即可。

### 手动安装

1. 将本目录放到 `~/.dsh/profiles/node_modules/dsh-wallet`
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-wallet
      name: 'dsh-wallet'
```

3. 重启 `dsh web`

> 注：「充值 / API Key」在 DSH 窗口内打开官方页，需要桌面端 dsh-desktop 处理 `NewWindowRequested` 事件，见 [`docs/DESKTOP-EMBED.md`](docs/DESKTOP-EMBED.md)。

## 📊 官方用量（可选）

默认「今日累计 / 趋势」用**本地会话统计**。要更精确的**官方账单数据**，需配置平台 userToken：

1. 浏览器登录 [platform.deepseek.com](https://platform.deepseek.com)，F12 → Console 执行 `localStorage.getItem('userToken')`，复制返回 JSON 里的 `.value` 字段（不是 `sk-` 开头的 API Key）
2. 写入 `~/.dsh/dsh-wallet.json` 的 `platformToken` 字段（或设 DSH 凭据 `DEEPSEEK_PLATFORM_TOKEN`）
3. 重启 `dsh web`

> userToken 是**会话级**的，会过期。失效后插件自动回退本地统计，并在面板提示「官方数据不可用」，重新取一次即可。

## 💰 价格表（元 / 百万 token）

| 模型 | 输入(缓存命中) | 输入(未命中) | 输出 | 峰谷 |
| --- | --- | --- | --- | --- |
| deepseek-v4-flash | 0.02 | 1 | 2 | 空闲 0.05/1.5/4.5 · 高峰 0.10/3.0/9.0 |
| deepseek-v4-pro | 0.025 | 3 | 6 | 空闲 0.15/4.5/13.5 · 高峰 0.30/9.0/27.0 |

峰谷价于北京时间 2026-08-17 00:00 起生效，插件按当前时刻自动切换。

## 许可

MIT。会话成本计价思路参考 [dsh-balance-meter](https://github.com/Ghost011118/dsh-balance-meter)（MIT）、[dsh-balance-plugin](https://github.com/Francis-Xavier-code/dsh-balance-plugin)（MIT）。
