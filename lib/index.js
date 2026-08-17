// dsh-wallet —— Host 半端
// 学习 GitHub 项目（dsh-balance-meter / dsh-deepseek-quota / dsh-balance-plugin）的做法：
// 1) 查询官方 GET /user/balance（自动读 DSH 凭据 DEEPSEEK_API_KEY，失败指数退避重试）
// 2) 会话成本 = token-meter 的 tokenUsage 投影 × 官方价格表（flash/pro + 峰谷）
// 3) 今日消耗 / 历史趋势 = session/event 事件流聚合（历史经 sessionQuery 回扫）
// 4) 每个会话独立的消耗上限持久化到 ~/.dsh/dsh-wallet.json
// 浏览器只访问本机同源路由，Key 不出本机。

import { defineTool } from "@deepseek-ai/dsh-tools";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "dsh-wallet";
export const inject = ["webServer", "sessions", "credentials", "sessionProjections", "sessionQuery"];

// —— 官方价格表（元 / 百万 token）——基础价（2026-08-17 前）——
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

/** 由模型名判断计价档位（flash/pro）。 */
function pricingKeyOf(model) {
  if (typeof model !== "string") return "flash";
  const lower = model.toLowerCase();
  if (lower.includes("pro")) return "pro";
  return "flash";
}

function costOfTokens(count, perMillion) {
  if (!(count > 0) || !Number.isFinite(count)) return 0;
  return (count / 1000000) * perMillion;
}

/** 指定时刻生效的价格表：峰谷价生效后按北京时段取高峰/空闲，否则用基础价。 */
function effectiveCostAt(ts, pricingKey) {
  if (ts >= PEAK_PRICING_START_MS) {
    const band = isPeakHour(new Date(ts)) ? 'peak' : 'offPeak';
    return (pricingKey === 'pro' ? PRO_PEAK : FLASH_PEAK)[band];
  }
  return pricingKey === 'pro' ? PRO_COST : FLASH_COST;
}

/** 指定时刻所属计费档位：base（8-17 前）/ offPeak / peak。 */
function bandAt(ts) {
  return ts >= PEAK_PRICING_START_MS ? (isPeakHour(new Date(ts)) ? 'peak' : 'offPeak') : 'base';
}

export function apply(ctx) {
  const webServer = ctx.webServer;
  const sessions = ctx.get("sessions");
  const credentials = ctx.get("credentials");
  const projections = ctx.get("sessionProjections");
  const sessionQuery = ctx.get("sessionQuery");
  const tools = ctx.get("tools");

  const BALANCE_URL = "https://api.deepseek.com/user/balance";
  const BALANCE_TTL_MS = 30000;

  // —— 配置持久化（消耗上限）——
  const CONFIG_DIR = join(homedir(), ".dsh");
  const CONFIG_FILE = join(CONFIG_DIR, "dsh-wallet.json");

  const bootThresholds = Object.create(null); // 启动时从磁盘加载的值
  const costThresholds = Object.create(null); // 本进程内新设置的值（优先）
  let bootPlatformToken = ""; // 启动时从磁盘加载的官方平台 userToken

  async function loadConfig() {
    try {
      const text = (await readFile(CONFIG_FILE, "utf8")).replace(/^\uFEFF/, ""); // 容忍 UTF-8 BOM
      const obj = JSON.parse(text);
      const src = obj && obj.costThresholds;
      if (src && typeof src === "object") {
        for (const [sid, t] of Object.entries(src)) {
          const n = Number(t);
          if (sid && Number.isFinite(n) && n >= 0) bootThresholds[sid] = n;
        }
      }
      if (typeof obj.platformToken === "string" && obj.platformToken) bootPlatformToken = obj.platformToken;
    } catch { /* 首次运行无配置文件或损坏，忽略 */ }
  }

  let saveChain = Promise.resolve();
  function saveConfig() {
    saveChain = saveChain.then(async () => {
      try {
        await mkdir(CONFIG_DIR, { recursive: true });
        const merged = Object.assign({}, bootThresholds, costThresholds);
        await writeFile(CONFIG_FILE, JSON.stringify({ costThresholds: merged, platformToken: bootPlatformToken }, null, 2), "utf8");
      } catch { /* 写失败不影响功能 */ }
    });
    return saveChain;
  }

  function getThreshold(sid) {
    if (costThresholds[sid] !== undefined) return costThresholds[sid];
    if (bootThresholds[sid] !== undefined) return bootThresholds[sid];
    return 5;
  }

  loadConfig(); // 异步加载，不阻塞启动

  // —— 余额缓存 + 失败指数退避重试 ——
  let key = "";
  let balanceView = null;
  let balanceAt = 0;
  let inflight = null;
  let failCount = 0;
  let nextRetryAt = 0;
  const BACKOFF_BASE_MS = 5000;
  const BACKOFF_MAX_MS = 300000; // 最长 5 分钟

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
    // 退避窗口内：直接返回上次的失败结果，不再打网络
    if (!force && failCount > 0 && now < nextRetryAt && balanceView) return balanceView;
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
          failCount += 1;
          nextRetryAt = Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, failCount - 1));
          return { fetchedAt, available: false, balances: [], error: msg || ("HTTP " + res.status), retryInMs: nextRetryAt - Date.now() };
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
        failCount = 0; // 成功则重置退避
        nextRetryAt = 0;
        return {
          fetchedAt,
          available: body.is_available !== false,
          balances: buckets,
          ...(total !== undefined && !Number.isNaN(total) ? { total, currency: buckets[0].currency } : {}),
          ...(low.length ? { low } : {}),
        };
      } catch (error) {
        const aborted = error && (error.name === "AbortError" || error.name === "TimeoutError");
        failCount += 1;
        nextRetryAt = Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, failCount - 1));
        return {
          fetchedAt,
          available: false,
          balances: [],
          error: aborted ? "查询超时" : String(error && error.message || error).slice(0, 200),
          retryInMs: nextRetryAt - Date.now(),
        };
      }
    })().then((v) => { balanceView = v; balanceAt = Date.now(); return v; }).finally(() => { inflight = null; });
    return inflight;
  }

  // —— 会话成本 ——
  function sessionCost(session) {
    const id = session && session.id ? String(session.id) : "";
    const seg = perSession.get(id) || emptySessionAgg();
    let pricingKey = "flash";
    let model;
    try {
      const header = typeof session.requestHeader === "function" ? session.requestHeader() : undefined;
      model = header && header.config && header.config.model;
      pricingKey = pricingKeyOf(model);
    } catch { /* 读不到模型按 flash */ }
    // 分段计费：base / offPeak / peak 各按各自价格，不再全按当前时段
    const baseCfg = pricingKey === "pro" ? PRO_COST : FLASH_COST;
    const offCfg = (pricingKey === "pro" ? PRO_PEAK : FLASH_PEAK).offPeak;
    const peakCfg = (pricingKey === "pro" ? PRO_PEAK : FLASH_PEAK).peak;
    const bd = (b, c) => ({
      input: costOfTokens(b.uncachedInputTokens, c.inputPerMillion),
      cacheRead: costOfTokens(b.cacheReadTokens, c.cacheReadPerMillion),
      cacheWrite: costOfTokens(b.cacheWriteTokens, c.cacheWritePerMillion),
      output: costOfTokens(b.outputTokens, c.outputPerMillion),
    });
    const d0 = bd(seg.base, baseCfg);
    const d1 = bd(seg.offPeak, offCfg);
    const d2 = bd(seg.peak, peakCfg);
    const breakdown = {
      input: d0.input + d1.input + d2.input,
      cacheRead: d0.cacheRead + d1.cacheRead + d2.cacheRead,
      cacheWrite: d0.cacheWrite + d1.cacheWrite + d2.cacheWrite,
      output: d0.output + d1.output + d2.output,
    };
    const sum = (f) => seg.base[f] + seg.offPeak[f] + seg.peak[f];
    const peakActive = Date.now() >= PEAK_PRICING_START_MS;
    const band = peakActive ? (isPeakHour() ? "peak" : "offPeak") : "base";
    return {
      uncachedInputTokens: sum("uncachedInputTokens"),
      outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      cacheWriteTokens: sum("cacheWriteTokens"),
      cost: breakdown.input + breakdown.cacheRead + breakdown.cacheWrite + breakdown.output,
      currency: "CNY",
      pricingKey,
      band,
      ...(model ? { model } : {}),
      breakdown,
    };
  }

  function resolveSession(id) {
    if (!sessions || typeof id !== "string") return undefined;
    try { return sessions.get(id); } catch { return undefined; }
  }

  // —— 今日消耗 / 历史趋势（事件流聚合）——
  const USAGE_KEEP_MS = 90 * 86400000;
  const perDay = new Map(); // dayKey -> { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost, requests }
  const perSession = new Map(); // sessionId -> { base, offPeak, peak } 各计费档 token 桶（分段计费用）
  const scannedSessions = new Set(); // 已摄入过事件的会话 id
  const liveSeqs = new Map(); // sessionId -> 已实时摄入的最大 seq
  let usageReady = false;

  function dayKeyOf(time) {
    const d = new Date(time);
    const pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function emptyDayAgg() {
    return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, requests: 0 };
  }

  function emptyBuckets() {
    return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  }

  function emptySessionAgg() {
    return { base: emptyBuckets(), offPeak: emptyBuckets(), peak: emptyBuckets() };
  }

  function ingestEvent(sessionId, event) {
    if (!event || typeof event.time !== "number" || event.type !== "assistant/message") return;
    const data = event.data || {};
    const usage = data.usage;
    if (!usage || typeof usage !== "object") return;
    const input = Number(usage.inputTokens) || 0;
    const output = Number(usage.outputTokens) || 0;
    const cacheRead = Number(usage.cacheReadTokens) || 0;
    const cacheWrite = Number(usage.cacheWriteTokens) || 0;
    const model = data.message && data.message.source ? String(data.message.source.model || "") : "";
    const cfg = effectiveCostAt(event.time, pricingKeyOf(model));
    const cost = costOfTokens(input, cfg.inputPerMillion) + costOfTokens(cacheRead, cfg.cacheReadPerMillion)
      + costOfTokens(cacheWrite, cfg.cacheWritePerMillion) + costOfTokens(output, cfg.outputPerMillion);
    const day = dayKeyOf(event.time);
    const agg = perDay.get(day) || emptyDayAgg();
    agg.uncachedInputTokens += input;
    agg.outputTokens += output;
    agg.cacheReadTokens += cacheRead;
    agg.cacheWriteTokens += cacheWrite;
    agg.cost += cost;
    agg.requests += 1;
    perDay.set(day, agg);
    // 按计费档位分桶（供本会话分段计费）
    const band = bandAt(event.time);
    const sagg = perSession.get(sessionId) || emptySessionAgg();
    const b = sagg[band];
    b.uncachedInputTokens += input;
    b.outputTokens += output;
    b.cacheReadTokens += cacheRead;
    b.cacheWriteTokens += cacheWrite;
    perSession.set(sessionId, sagg);
  }

  ctx.on("session/event", (session, event) => {
    if (!session || !event || typeof event.time !== "number") return;
    const id = String(session.id || "");
    if (!id) return;
    scannedSessions.add(id);
    const prev = liveSeqs.get(id) || 0;
    if (typeof event.seq === "number" && event.seq > prev) liveSeqs.set(id, event.seq);
    if (event.time >= Date.now() - USAGE_KEEP_MS) ingestEvent(id, event);
  });

  async function scanHistory() {
    if (!sessionQuery) { usageReady = true; return; }
    try {
      const list = await sessionQuery.listSessions();
      const cut = Date.now() - USAGE_KEEP_MS;
      let scanned = 0;
      for (const record of list || []) {
        const header = record && record.header;
        const id = header && String(header.id || "");
        if (!id) continue;
        scannedSessions.add(id);
        try {
          const snap = await sessionQuery.readSession(id);
          const events = Array.isArray(snap && snap.events) ? snap.events : [];
          // 分叉子会话从父会话继承了前 seedLength 条事件（副本），跳过避免重复计数
          const seedLength = Number(header.seedLength) || 0;
          const liveMax = liveSeqs.get(id); // 已实时摄入的最大 seq（无则 undefined）
          for (const event of events) {
            if (!event || typeof event.time !== "number" || event.time < cut) continue;
            if (typeof event.seq === "number") {
              if (event.seq < seedLength) continue;
              if (liveMax !== undefined && event.seq <= liveMax) continue;
            }
            ingestEvent(id, event);
          }
          scanned += 1;
        } catch { /* 单会话读取失败则跳过 */ }
        if (scanned >= 100) break;
      }
    } catch { /* 扫描失败忽略 */ }
    usageReady = true;
  }
  scanHistory();

  // 会话成本按需回扫：切换到未扫过（>100 个）的旧会话时，补读其事件做分段计费
  async function ensureSessionIngested(session) {
    if (!sessionQuery) return;
    const id = session && session.id ? String(session.id) : "";
    if (!id || scannedSessions.has(id)) return;
    scannedSessions.add(id);
    try {
      const snap = await sessionQuery.readSession(id);
      const events = Array.isArray(snap && snap.events) ? snap.events : [];
      const seedLength = Number((session && session.header && session.header.seedLength)) || 0;
      const liveMax = liveSeqs.get(id);
      const cut = Date.now() - USAGE_KEEP_MS;
      for (const event of events) {
        if (!event || typeof event.time !== "number" || event.time < cut) continue;
        if (typeof event.seq === "number") {
          if (event.seq < seedLength) continue;
          if (liveMax !== undefined && event.seq <= liveMax) continue;
        }
        ingestEvent(id, event);
      }
    } catch { /* 读取失败忽略 */ }
  }

  function usagePayload() {
    const days = [...perDay.entries()]
      .map(([date, agg]) => ({ date, ...agg }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const todayKey = dayKeyOf(Date.now());
    const today = days.length && days[days.length - 1].date === todayKey ? days[days.length - 1] : { date: todayKey, ...emptyDayAgg() };
    const round = (d) => {
      const o = {};
      for (const [k, v] of Object.entries(d)) o[k] = (k === "cost" || k === "total") && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : v;
      return o;
    };
    return { ok: true, ready: usageReady, source: "local", today: round(today), days: days.slice(-7).map(round) };
  }

  // —— 官方用量（platform userToken，可选；未配置/失败则回退本地聚合）——
  const PLATFORM_BASE = "https://platform.deepseek.com/api/v0/usage";
  let platformToken = "";
  let officialCache = null;
  let officialAt = 0;
  const OFFICIAL_TTL_MS = 300000; // 5 分钟

  // userToken 在 localStorage 里是 {"value":"...","__version":"0"}，取 .value；也兼容直接存裸 token
  function extractToken(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    if (s.startsWith("{")) {
      try { const o = JSON.parse(s); if (o && typeof o.value === "string" && o.value) return o.value; } catch { /* 非 JSON，按原样 */ }
    }
    return s;
  }

  async function resolvePlatformToken() {
    if (credentials) {
      try {
        const r = await credentials.resolve("DEEPSEEK_PLATFORM_TOKEN");
        const v = extractToken(r && r.value);
        if (v) return v;
      } catch { /* 忽略 */ }
    }
    return extractToken(bootPlatformToken);
  }

  // 官方用量接口是平台私有端点（需登录后的 userToken，非 API Key），逐月拉取近 30 天成本
  async function fetchOfficialDays() {
    if (!platformToken) platformToken = await resolvePlatformToken();
    if (!platformToken) return null;
    const headers = {
      Authorization: "Bearer " + platformToken,
      "x-app-version": "1.0.0",
      Accept: "application/json",
      Referer: "https://platform.deepseek.com/usage",
      Origin: "https://platform.deepseek.com",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    };
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const months = [
      { m: prev.getMonth() + 1, y: prev.getFullYear() },
      { m: now.getMonth() + 1, y: now.getFullYear() },
    ];
    const costByDate = new Map();
    for (const { m, y } of months) {
      try {
        const res = await fetch(`${PLATFORM_BASE}/cost?month=${m}&year=${y}`, { headers, signal: AbortSignal.timeout(10000) });
        if (!res.ok) return null;
        const json = await res.json();
        if (!json || json.code !== 0) return null; // 平台始终返回 200，失败体现在 code
        const biz = Array.isArray(json && json.data && json.data.biz_data) ? json.data.biz_data[0] : (json && json.data && json.data.biz_data);
        const todayStr = dayKeyOf(Date.now());
        for (const day of (biz && biz.days) || []) {
          if (typeof day.date === "string" && day.date > todayStr) continue; // 过滤未来日期（平台返回整月）
          const cost = (day.data || []).reduce((s, mu) => s + (mu.usage || []).reduce((ss, e) => ss + (parseFloat(e.amount) || 0), 0), 0);
          costByDate.set(day.date, (costByDate.get(day.date) || 0) + cost);
        }
      } catch { return null; }
    }
    const days = [...costByDate.entries()]
      .map(([date, cost]) => ({ date, cost: Math.round(cost * 10000) / 10000 }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return days.length ? days.slice(-7) : null;
  }

  async function getOfficialDays() {
    const now = Date.now();
    if (officialCache && now - officialAt < OFFICIAL_TTL_MS) return officialCache;
    const v = await fetchOfficialDays();
    if (v && v.length) { officialCache = v; officialAt = now; return v; }
    return officialCache; // 失败回退上次成功缓存（首次失败则为 null）
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
    await ensureSessionIngested(session);
    return { ok: true, costThreshold: getThreshold(sid), ...sessionCost(session) };
  });
  registerRoute("GET", "/wallet/api/usage", async () => {
    const official = await getOfficialDays();
    if (official && official.length) {
      const todayKey = dayKeyOf(Date.now());
      const today = official.find((d) => d.date === todayKey) || { date: todayKey, cost: 0 };
      return { ok: true, ready: true, source: "official", today, days: official };
    }
    // 配了 token 却拉不到官方数据 → 标记降级（token 大概率已过期），前端提示
    const degraded = !!(platformToken || (await resolvePlatformToken()));
    return { ...usagePayload(), degraded };
  });
  registerRoute("POST", "/wallet/api/set-threshold", async (req) => {
    let body = "";
    try { for await (const chunk of req) body += chunk; } catch { /* ignore */ }
    let parsed = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
    const sid = typeof parsed.session === "string" ? parsed.session : "";
    const t = Number(parsed.threshold);
    if (sid && Number.isFinite(t) && t >= 0) {
      costThresholds[sid] = t;
      saveConfig();
    }
    return { ok: true, costThreshold: sid ? getThreshold(sid) : 5 };
  });

  // —— 峰谷价自动抓取（可选，尽力而为；失败静默回退硬编码官方价）——
  const PRICING_PAGE_URL = "https://api-docs.deepseek.com/quick_start/pricing/";
  let pricingFetched = false;

  // 极简容错解析：仅当能同时、无歧义地提取出 flash 与 pro 的「输入/缓存命中/输出」单价，
  // 且数值落在合理区间（0 < x < 100 元/百万 token）时才返回；否则返回 null 用硬编码兜底。
  function parsePricing(html) {
    try {
      const text = String(html || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;|&#160;/g, " ")
        .replace(/\s+/g, " ");
      const num = (s) => { const m = s.match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : NaN; };
      const valid = (v) => Number.isFinite(v) && v > 0 && v < 100;
      const extract = (marker) => {
        const idx = text.toLowerCase().indexOf(marker);
        if (idx < 0) return null;
        const tail = text.slice(idx, idx + 260);
        const nums = (tail.match(/\d+(?:\.\d+)?/g) || []).map(Number);
        return nums.length >= 3 ? nums.slice(0, 3) : null;
      };
      const flash = extract("flash");
      const pro = extract("pro");
      if (!flash || !pro || !flash.every(valid) || !pro.every(valid)) return null;
      return {
        flash: { inputPerMillion: flash[0], cacheReadPerMillion: flash[1], outputPerMillion: flash[2] },
        pro: { inputPerMillion: pro[0], cacheReadPerMillion: pro[1], outputPerMillion: pro[2] },
      };
    } catch {
      return null;
    }
  }

  async function tryRefreshPricing() {
    if (pricingFetched) return;
    pricingFetched = true;
    try {
      const res = await fetch(PRICING_PAGE_URL, { signal: AbortSignal.timeout(8000), headers: { Accept: "text/html" } });
      if (!res.ok) return;
      const parsed = parsePricing(await res.text());
      if (!parsed) return;
      const applyBase = (t, p) => { t.inputPerMillion = p.inputPerMillion; t.cacheReadPerMillion = p.cacheReadPerMillion; t.outputPerMillion = p.outputPerMillion; };
      applyBase(FLASH_COST, parsed.flash);
      applyBase(PRO_COST, parsed.pro);
      // 峰谷价无公开解析标准，保留硬编码（基础价按抓取覆盖）
    } catch { /* 网络/解析失败 → 保持硬编码 */ }
  }
  tryRefreshPricing();

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
