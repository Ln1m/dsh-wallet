# dsh-wallet

A DeepSeek Harness (DSH) wallet plugin — a persistent panel at the bottom of the left sidebar showing your **DeepSeek account balance**, **today's total cost**, **current-session cost**, and a **7-day usage trend**, with one-click links to the official recharge / API-key pages.

## ✨ Features

| Module | What it does |
| --- | --- |
| Balance | Official `GET api.deepseek.com/user/balance` (Bearer auth) for the CNY / USD pools; retries with exponential backoff on failure |
| Today's total | Official platform usage endpoint `platform.deepseek.com/api/v0/usage` (optional `userToken`) for your **real daily spend**; falls back to local session stats when unconfigured |
| Trend | A lightweight **7-day** daily-cost line chart (SVG, no third-party library); hover a point for date + amount |
| Session cost | token-meter projection × official price table — live estimate of the current session; hover for input / cache-hit / output breakdown |
| Peak/off-peak pricing | Built-in official peak pricing effective 2026-08-17, auto-switched by Beijing peak hours (9:00–12:00, 14:00–18:00) |
| Low-balance alert | Amber warning when CNY < ¥10 or USD < $2 |
| Alert threshold | Editable per-session threshold (default ¥5, **persisted** to `~/.dsh/dsh-wallet.json`); warns to start a new chat when exceeded |
| System notifications | Browser notification on low balance / over threshold (fires once per transition) |
| One-click links | "Recharge / API Key / Usage" open the official pages **inside the DSH window** |
| Model tool | Registers `query_deepseek_balance` — ask the AI your balance directly |

## 🖼 Screenshots

Dark theme:

![dark](https://cdn.jsdelivr.net/gh/Ln1m/dsh-wallet@main/assets/screenshot-panel.png)

Light theme:

![light](https://cdn.jsdelivr.net/gh/Ln1m/dsh-wallet@main/assets/screenshot-panel-light.png)

Line-chart hover (date + amount):

![hover](https://cdn.jsdelivr.net/gh/Ln1m/dsh-wallet@main/assets/screenshot-hover.png)

```
DeepSeek Wallet                     ↻
Balance              ¥30.39 CNY
Today                ¥70.30
This session ¥1.23 [peak]  ← hover for token/cost detail
▁▂▃▅▆▇                   ← 7-day trend
Alert threshold  ¥[5.00]
[Recharge] [API Key] [Usage]
```

## 🏗 Architecture

```
Host (Node process)
├─ Balance: native fetch → api.deepseek.com/user/balance (30s cache + backoff)
├─ Today/trend: official platform /api/v0/usage (userToken, 5-min cache) preferred, local session/event aggregation as fallback
├─ Session cost: sessionProjections.tokenUsage × price table (flash/pro, peak-aware)
├─ Threshold persistence: ~/.dsh/dsh-wallet.json (loaded on boot, saved on change)
├─ RPC: /wallet/api/balance · refresh · cost?session=<id> · usage · set-threshold
└─ Model tool: query_deepseek_balance

Client (browser)
├─ Entry: sidebar.footer.action (persistent bottom panel)
├─ Balance + today + session cost + 7-day line chart + threshold + links
├─ Current session id via useSyncExternalStore over sessions.list
└─ System notifications: low balance / over threshold (Notification API)
```

## 📦 Install

### One-click (recommended)

```bash
dsh plugin add dsh-wallet
```

`package.json` declares `dsh.bundle.patch`, so the plugin registers itself into your profile — no manual `cordis.patch.yml` edit. Restart `dsh web` and you're done.

### Manual

1. Place this directory at `~/.dsh/profiles/node_modules/dsh-wallet`
2. Append to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-wallet
      name: 'dsh-wallet'
```

3. Restart `dsh web`

> Note: opening the recharge / API-key pages inside the DSH window requires the dsh-desktop app to handle the `NewWindowRequested` event. See [`docs/DESKTOP-EMBED.md`](docs/DESKTOP-EMBED.md).

## 📊 Official usage (optional)

By default, "today / trend" uses **local session stats**. For accurate **official billing data**, configure the platform `userToken`:

1. Sign in at [platform.deepseek.com](https://platform.deepseek.com), open DevTools → Console, run `localStorage.getItem('userToken')`, and copy the `.value` field (NOT the `sk-` API key)
2. Write it to the `platformToken` field of `~/.dsh/dsh-wallet.json` (or set the DSH credential `DEEPSEEK_PLATFORM_TOKEN`)
3. Restart `dsh web`

> The `userToken` is session-scoped and expires. When it does, the plugin silently falls back to local stats and shows an "official data unavailable" hint — just re-fetch a new token.

## 💰 Price table (CNY per million tokens)

| Model | Input (cache hit) | Input (miss) | Output | Peak/off-peak |
| --- | --- | --- | --- | --- |
| deepseek-v4-flash | 0.02 | 1 | 2 | off-peak 0.05/1.5/4.5 · peak 0.10/3.0/9.0 |
| deepseek-v4-pro | 0.025 | 3 | 6 | off-peak 0.15/4.5/13.5 · peak 0.30/9.0/27.0 |

Peak pricing took effect at 2026-08-17 00:00 Beijing time; the plugin switches automatically by the current time.

## License

MIT. Session-cost pricing follows [dsh-balance-meter](https://github.com/Ghost011118/dsh-balance-meter) (MIT) and [dsh-balance-plugin](https://github.com/Francis-Xavier-code/dsh-balance-plugin) (MIT).
