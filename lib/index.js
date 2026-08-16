// dsh-wallet —— Host 半端
// 学习 GitHub 项目（dsh-balance-meter / dsh-deepseek-quota）的做法：
// 1) 查询官方 GET /user/balance（自动读 DSH 凭据 DEEPSEEK_API_KEY）
// 2) 会话成本 = token-meter 的 tokenUsage 投影 × 官方价格表（flash/pro）
// 浏览器只访问本机同源路由，Key 不出本机。

import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "dsh-wallet";
export const inject = ["webServer", "sessions", "credentials", "sessionProjections"];

// 官方价格表（元 / 百万 token）——基础价（2026-08-17 前）
const FLASH_COST = { inputPerMillion: 1, cacheReadPerMillion: 0.02, cacheWritePerMillion: 0, outputPerMillion: 2 };
const PRO_COST = { inputPerMillion: 3, cacheReadPerMillion: 0.025, cacheWritePerMillion: 0, outputPerMillion: 6 };

// 峰谷价（2026-08-17 00:00 北京时间起生效）
const FLASH_PEAK = {
  offPeak: { inputPerMillion: 1.5, cacheReadPerMillion: 0.05, cacheWritePerMillion: 0, outputPerMillion: 4.5 },
  peak: { inputPerMillion: 3.0, cacheReadPerMillion: 0.10, cacheWritePerMillion: 0, outputPerMillion: 9.0 },
};
const PRO_PEAK = {
  offPeak: { inputPerMillion: 4.5, cacheReadPerMillion: 0.15, cacheWritePerMillion: 0, outputPerMillion: 13.5 },
  peak: { inputPerMillion: 9.0, cacheReadPerMillion: 0.30, cacheWritePerMillion: 0, outputPerMillion: 27.0 },
};

// 峰谷价生效时间：北京时间 2026-08-17 00:00 = UTC 2026-08-16 16:00
const PEAK_PRICING_START_MS = Date.UTC(2026, 7, 16, 16, 0, 0);

/** 是否高峰时段（北京时间 9:00-12:00、14:00-18:00）。 */
function isPeakHour(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    if (Number.isNaN(hour)) return false;
    return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
  } catch {
    return false;
  }
}

function costOfTokens(count, perMillion) {
  if (!(count > 0) || !Number.isFinite(count)) return 0;
  return (count / 1000000) * perMillion;
}

/** 当前生效的价格表：峰谷价生效后按北京时段取高峰/空闲，否则用基础价。 */
function effectiveCost(pricingKey) {
  if (Date.now() >= PEAK_PRICING_START_MS) {
    const band = isPeakHour() ? 'peak' : 'offPeak';
    return (pricingKey === 'pro' ? PRO_PEAK : FLASH_PEAK)[band];
  }
  return pricingKey === 'pro' ? PRO_COST : FLASH_COST;
}

export function apply(ctx) {
  const webServer = ctx.webServer;
  const sessions = ctx.get("sessions");
  const credentials = ctx.get("credentials");
  const projections = ctx.get("sessionProjections");
  const tools = ctx.get("tools");

  const BALANCE_URL = "https://api.deepseek.com/user/balance";
  const BALANCE_TTL_MS = 30000;

  // —— 余额缓存 ——
  let key = "";
  let balanceView = null;
  let balanceAt = 0;
  let inflight = null;

  async function resolveKey() {
    if (!credentials) return "";
    try {
      const r = await credentials.resolve("DEEPSEEK_API_KEY");
      return r && r.value ? r.value : "";
    } catch {
      return "";
    }
  }

  async function queryBalance(force) {
    const now = Date.now();
    if (!force && balanceView && !balanceView.error && now - balanceAt < BALANCE_TTL_MS) return balanceView;
    if (inflight) return inflight;
    inflight = (async () => {
      if (!key) key = await resolveKey();
      const fetchedAt = Date.now();
      if (!key) return { fetchedAt, available: false, balances: [], error: "未配置 API Key（DEEPSEEK_API_KEY）" };
      try {
        const res = await fetch(BALANCE_URL, {
          method: "GET",
          headers: { Authorization: "Bearer " + key, Accept: "application/json" },
          signal: AbortSignal.timeout(15000),
        });
        const text = await res.text();
        if (!res.ok) {
          let msg = null;
          try { const obj = JSON.parse(text); msg = obj && obj.error && obj.error.message; } catch { /* ignore */ }
          return { fetchedAt, available: false, balances: [], error: msg || ("HTTP " + res.status) };
        }
        const body = JSON.parse(text);
        const buckets = (Array.isArray(body.balance_infos) ? body.balance_infos : [])
          .map((b) => ({
            currency: String(b.currency || ""),
            total_balance: String(b.total_balance ?? "0"),
            granted_balance: String(b.granted_balance ?? "0"),
            topped_up_balance: String(b.topped_up_balance ?? "0"),
          }))
          .filter((b) => b.currency !== "");
        const total = buckets.length === 1 ? Number(buckets[0].total_balance) : undefined;
        // 低余额告警：CNY < 10 或 USD < 2 时标记
        const LOW_THRESHOLD = { CNY: 10, USD: 2 };
        const low = buckets
          .filter((b) => Number(b.total_balance) < (LOW_THRESHOLD[b.currency] ?? 10))
          .map((b) => ({ currency: b.currency, total: b.total_balance }));
        return {
          fetchedAt,
          available: body.is_available !== false,
          balances: buckets,
          ...(total !== undefined && !Number.isNaN(total) ? { total, currency: buckets[0].currency } : {}),
          ...(low.length ? { low } : {}),
        };
      } catch (error) {
        const aborted = error && (error.name === "AbortError" || error.name === "TimeoutError");
        return { fetchedAt, available: false, balances: [], error: aborted ? "查询超时" : String(error && error.message || error).slice(0, 200) };
      }
    })().then((v) => { balanceView = v; balanceAt = Date.now(); return v; }).finally(() => { inflight = null; });
    return inflight;
  }

  // —— 会话成本 ——
  function sessionCost(session) {
    const zero = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let usage = zero;
    if (projections) {
      try {
        const snap = projections.snapshot(session);
        const v = snap && snap.values && snap.values.tokenUsage;
        if (v && typeof v === "object") usage = { ...zero, ...v };
      } catch { /* 投影不可用则归零 */ }
    }
    let pricingKey = "flash";
    let model;
    try {
      const header = typeof session.requestHeader === "function" ? session.requestHeader() : undefined;
      model = header && header.config && header.config.model;
      if (typeof model === "string") {
        const lower = model.toLowerCase();
        if (lower.includes("pro")) pricingKey = "pro";
        else if (lower.includes("flash")) pricingKey = "flash";
      }
    } catch { /* 读不到模型按 flash */ }
    const cfg = effectiveCost(pricingKey);
    const input = costOfTokens(usage.uncachedInputTokens, cfg.inputPerMillion);
    const cacheRead = costOfTokens(usage.cacheReadTokens, cfg.cacheReadPerMillion);
    const cacheWrite = costOfTokens(usage.cacheWriteTokens, cfg.cacheWritePerMillion);
    const output = costOfTokens(usage.outputTokens, cfg.outputPerMillion);
    const peakActive = Date.now() >= PEAK_PRICING_START_MS;
    const band = peakActive ? (isPeakHour() ? "peak" : "offPeak") : "base";
    return {
      uncachedInputTokens: usage.uncachedInputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      cost: input + cacheRead + cacheWrite + output,
      currency: "CNY",
      pricingKey,
      band,
      ...(model ? { model } : {}),
      breakdown: { input, cacheRead, cacheWrite, output },
    };
  }

  function resolveSession(id) {
    if (!sessions || typeof id !== "string") return undefined;
    try { return sessions.get(id); } catch { return undefined; }
  }

  // —— 路由 ——
  function registerRoute(method, path, handler) {
    if (!webServer) return;
    webServer.register({
      kind: "exact",
      path,
      handler: async (req, res) => {
        let result;
        try {
          if (req.method !== method) result = { ok: false, error: "method-not-allowed" };
          else result = await handler(req);
        } catch (e) {
          result = { ok: false, error: String(e && e.message || e).slice(0, 300) };
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
      },
    });
  }

  registerRoute("GET", "/wallet/api/balance", async () => queryBalance(false));
  registerRoute("GET", "/wallet/api/refresh", async () => queryBalance(true));
  registerRoute("GET", "/wallet/api/cost", async (req) => {
    const url = new URL(req.url || "/", "http://x");
    const sid = url.searchParams.get("session");
    if (!sid) return { ok: false, error: "missing-session" };
    const session = resolveSession(sid);
    if (!session) return { ok: false, error: "unknown-session" };
    return { ok: true, ...sessionCost(session) };
  });

  // —— 模型工具 ——
  if (tools) {
    const renderText = (_args, value) => [{ type: "text", text: String(value && value.content || "") }];
    tools.register(defineTool({
      name: "query_deepseek_balance",
      description: "查询已配置的 DeepSeek API 账户余额（CNY/USD 双余额池），返回总余额与低余额提醒，并提示官方充值入口。",
      parameters: {},
      output: { schema: { type: "object", additionalProperties: true }, render: renderText },
      async execute() {
        const view = await queryBalance(false);
        if (view.error) return { content: "查询失败：" + view.error };
        if (!view.balances.length) return { content: "暂无余额数据" };
        const lines = ["## DeepSeek 余额"];
        for (const b of view.balances) {
          lines.push("- " + b.currency + " 总余额：" + b.total_balance + "（赠金 " + b.granted_balance + " / 充值 " + b.topped_up_balance + "）");
        }
        lines.push("- 建议前往官方平台充值：https://platform.deepseek.com/top_up");
        return { content: lines.join("\n") };
      },
    }));
  }
}
