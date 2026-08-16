// dsh-wallet —— Client 半端
// 入口：左栏下方 1/4 常驻面板（sidebar.footer.action slot）。
// 功能（学习 GitHub 项目 dsh-balance-meter / dsh-deepseek-quota）：
// 余额摘要 + 本会话消耗成本（token × 官方价格表）+ 充值/API Key 入口。

window.__ModuleLoader__.load({
  id: 'dsh-wallet',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');
    const h = React.createElement;

    function insertStyles(css) {
      try {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
        return () => { try { style.remove() } catch { /* ignore */ } };
      } catch {
        return () => {};
      }
    }

    async function apiGet(path) {
      const res = await fetch(path);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    }

    const POLL_MS = 30000;
    const COST_POLL_MS = 5000;
    const RECHARGE_URL = 'https://platform.deepseek.com/top_up';
    const API_KEYS_URL = 'https://platform.deepseek.com/api_keys';
    const USAGE_URL = 'https://platform.deepseek.com/usage';

    function fmt(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return '--';
      return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function fmtTokens(v) {
      const n = Number(v) || 0;
      if (n >= 1000000000) return (n / 1000000000).toFixed(2) + 'B';
      if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return String(Math.round(n));
    }

    const CSS = `
.dsw-dock{box-sizing:border-box;width:100%;height:24vh;min-height:150px;max-height:320px;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill);display:flex;flex-direction:column;gap:5px;overflow:visible;font-size:12px;color:var(--dsw-alias-label-primary);}
.dsw-dock-head{display:flex;align-items:center;gap:6px;flex:none;}
.dsw-dock-title{font-weight:600;font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsw-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);flex:none;}
.dsw-dot-ok{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none;}
.dsw-bal-row{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.dsw-bal-cur{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.4;display:inline-flex;align-items:flex-start;gap:5px;}
.dsw-band{display:inline-flex;align-items:center;justify-content:center;padding:0 6px;border-radius:999px;font-size:11px;line-height:1.4;font-weight:600;flex:none;white-space:nowrap;box-sizing:border-box;}
.dsw-band.base{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);}
.dsw-band.peak{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 22%,transparent);color:var(--dsw-alias-state-warn-primary);}
.dsw-band.offpeak{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 20%,transparent);color:var(--dsw-alias-state-success-primary);}
.dsw-bal-val{font-weight:600;font-size:14px;font-variant-numeric:tabular-nums;}
.dsw-cost-val{font-weight:600;font-size:13px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);cursor:default;}
.dsw-cost-wrap{position:relative;display:inline-flex;}
.dsw-tooltip{display:none;position:absolute;right:0;top:calc(100% + 6px);z-index:50;min-width:220px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 9px;flex-direction:column;gap:4px;box-shadow:var(--dsw-shadow-lv2);}
.dsw-cost-wrap:hover .dsw-tooltip{display:flex;}
.dsw-tooltip-row{display:flex;gap:10px;font-size:11px;align-items:baseline;}
.dsw-tooltip-name{color:var(--dsw-alias-label-secondary);width:48px;flex:none;}
.dsw-tooltip-tok{flex:1;text-align:right;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.dsw-tooltip-amt{width:58px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);font-weight:600;}
.dsw-hint{font-size:11px;color:var(--dsw-alias-label-secondary);}
.dsw-err{color:var(--dsw-alias-state-error-primary);font-size:11px;word-break:break-all;}
.dsw-btn{border:none;background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer;font-size:12px;padding:3px 8px;border-radius:6px;font-family:inherit;line-height:1.4;}
.dsw-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dsw-btn.dsw-primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);}
.dsw-btn.dsw-primary:hover{filter:brightness(1.08);}
.dsw-dock-btns{display:flex;gap:6px;flex-wrap:wrap;flex:none;margin-top:auto;}
.dsw-detail{display:flex;flex-direction:column;gap:3px;flex:none;}
.dsw-detail-row{display:flex;justify-content:space-between;gap:8px;align-items:baseline;}
.dsw-detail-label{color:var(--dsw-alias-label-secondary);font-size:11px;}
.dsw-detail-val{font-variant-numeric:tabular-nums;}
.dsw-rail{display:flex;align-items:center;justify-content:center;padding:4px 0;}
.dsw-ibar{width:28px;height:28px;border-radius:8px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex:none;padding:0;}
.dsw-ibar:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
`;

    function WalletIcon() {
      return h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, dangerouslySetInnerHTML: { __html: '<path d="M21 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M16 12a2 2 0 1 0 4 0 2 2 0 0 0-4 0z"/><path d="M3 9h18"/>' } });
    }

    function WalletDock(props) {
      const wide = props.wide;
      const sessions = props.sessions;
      // 响应式订阅当前会话 id：切换对话窗口立即触发重渲染
      const currentSessionId = React.useSyncExternalStore(
        sessions && sessions.list ? (cb) => sessions.list.subscribe(cb) : () => () => {},
        sessions && sessions.list ? () => sessions.list.getSnapshot().current : () => undefined,
        () => undefined
      );
      const [view, setView] = React.useState(null);
      const [cost, setCost] = React.useState(null);
      const labelRef = React.useRef(null);
      const bandRef = React.useRef(null);

      // 代码端量取「本会话消耗」文字高度，让峰谷胶囊与之精确同步
      React.useLayoutEffect(() => {
        if (labelRef.current && bandRef.current) {
          const h = labelRef.current.offsetHeight;
          if (h > 0) bandRef.current.style.height = h + 'px';
        }
      });

      React.useEffect(() => {
        let alive = true;
        const pollBalance = () => {
          apiGet('/wallet/api/balance').then((v) => { if (alive) setView(v); }, () => { if (alive) setView(null); });
        };
        pollBalance();
        const t1 = setInterval(pollBalance, POLL_MS);
        const onVis = () => { if (document.visibilityState === 'visible') pollBalance(); };
        document.addEventListener('visibilitychange', onVis);
        return () => { alive = false; clearInterval(t1); document.removeEventListener('visibilitychange', onVis); };
      }, []);

      React.useEffect(() => {
        let alive = true;
        const pollCost = () => {
          apiGet(currentSessionId ? '/wallet/api/cost?session=' + encodeURIComponent(currentSessionId) : '/wallet/api/cost')
            .then((c) => { if (alive) setCost(c); }, () => { /* ignore */ });
        };
        setCost(null);
        pollCost();
        const t2 = setInterval(pollCost, COST_POLL_MS);
        return () => { alive = false; clearInterval(t2); };
      }, [currentSessionId]);

      const refresh = () => { apiGet('/wallet/api/refresh').then((v) => setView(v), () => { /* ignore */ }); };
      const openUrl = (url) => { try { window.open(url, '_blank'); } catch { /* ignore */ } };

      if (!wide) {
        return h('div', { className: 'dsw-rail' },
          h('button', { type: 'button', className: 'dsw-ibar', title: 'DeepSeek 钱包', onClick: () => openUrl(RECHARGE_URL) }, h(WalletIcon, null)),
        );
      }

      const currency = view && (view.currency || (view.balances[0] && view.balances[0].currency)) || 'CNY';
      const total = view && view.total !== undefined ? view.total : undefined;
      const costTotal = cost && cost.ok === true && cost.cost !== undefined ? cost.cost : undefined;

      const statusLine = !view ? '连接中…'
        : (view.error ? '余额查询失败' : (view.available ? '正常' : '账户不可用'));

      return h('div', { className: 'dsw-dock' },
        h('div', { className: 'dsw-dock-head' },
          h('span', { className: view && !view.error && view.available ? 'dsw-dot-ok' : 'dsw-dot' }),
          h('span', { className: 'dsw-dock-title' }, 'DeepSeek 钱包'),
          h('button', { type: 'button', className: 'dsw-btn', title: '立即刷新', onClick: refresh }, '↻'),
        ),
        view && view.error ? h('div', { className: 'dsw-err' }, view.error) : null,
        h('div', { className: 'dsw-bal-row' },
          h('span', { className: 'dsw-bal-cur' }, '余额 ' + currency),
          h('span', { className: 'dsw-bal-val' }, total !== undefined ? fmt(total) : '--'),
        ),
        view && view.low && view.low.length ? h('div', { className: 'dsw-err' }, '⚠ 余额偏低，建议充值') : null,
        h('div', { className: 'dsw-bal-row' },
          h('span', { className: 'dsw-bal-cur' },
            h('span', { ref: labelRef }, '本会话消耗'),
            cost && cost.ok === true && cost.band ? h('span', { ref: bandRef, className: 'dsw-band ' + (cost.band === 'peak' ? 'peak' : cost.band === 'offPeak' ? 'offpeak' : 'base') }, cost.band === 'peak' ? '高峰价' : cost.band === 'offPeak' ? '空闲价' : '基础价') : null,
          ),
          cost && cost.ok === true && cost.breakdown ? h('div', { className: 'dsw-cost-wrap' },
            h('span', { className: 'dsw-cost-val' }, costTotal !== undefined ? ('¥' + fmt(costTotal)) : '--'),
            h('div', { className: 'dsw-tooltip' },
              h('div', { className: 'dsw-tooltip-row' },
                h('span', { className: 'dsw-tooltip-name' }, '输入'),
                h('span', { className: 'dsw-tooltip-tok' }, fmtTokens(cost.uncachedInputTokens) + ' tok'),
                h('span', { className: 'dsw-tooltip-amt' }, '¥' + fmt(cost.breakdown.input)),
              ),
              h('div', { className: 'dsw-tooltip-row' },
                h('span', { className: 'dsw-tooltip-name' }, '缓存命中'),
                h('span', { className: 'dsw-tooltip-tok' }, fmtTokens(cost.cacheReadTokens) + ' tok'),
                h('span', { className: 'dsw-tooltip-amt' }, '¥' + fmt(cost.breakdown.cacheRead)),
              ),
              h('div', { className: 'dsw-tooltip-row' },
                h('span', { className: 'dsw-tooltip-name' }, '输出'),
                h('span', { className: 'dsw-tooltip-tok' }, fmtTokens(cost.outputTokens) + ' tok'),
                h('span', { className: 'dsw-tooltip-amt' }, '¥' + fmt(cost.breakdown.output)),
              ),
            ),
          ) : h('span', { className: 'dsw-cost-val' }, costTotal !== undefined ? ('¥' + fmt(costTotal)) : '--'),
        ),
        h('div', { className: 'dsw-hint' }, statusLine),
        h('div', { className: 'dsw-dock-btns' },
          h('button', { type: 'button', className: 'dsw-btn dsw-primary', onClick: () => openUrl(RECHARGE_URL) }, '充值'),
          h('button', { type: 'button', className: 'dsw-btn', onClick: () => openUrl(API_KEYS_URL) }, 'API Key'),
          h('button', { type: 'button', className: 'dsw-btn', onClick: () => openUrl(USAGE_URL) }, '明细'),
        ),
      );
    }

    const inject = ['slots', 'sessions'];
    function apply(ctx) {
      insertStyles(CSS);
      const slots = ctx.get('slots');
      if (slots === undefined) return;
      const sessions = ctx.get('sessions');
      slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'dsw-wallet', order: 100, label: 'DeepSeek 钱包' },
        (props) => h(WalletDock, { ...props, sessions }),
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
