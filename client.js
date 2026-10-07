// dsh-workbuddy-bridge — client half (browser module)
//
// Written in the same hand-authored `__ModuleLoader__` shape DSH uses for
// client modules, so this repo needs no bundler/build step. React comes from
// the host runtime; everything else is local.
//
// Data flow: the panel bootstraps the bridge's shared token from
// /workbuddy/bootstrap (which only answers same-origin browser pages) and
// then calls the rest of /workbuddy/* with it as a bearer token.

window.__ModuleLoader__.load({
  id: "dsh-workbuddy-bridge",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useState, useEffect, useCallback, useRef } = React;

    const BASE = "/workbuddy";
    const SECTION_ID = "workbuddy-bridge";
    const REFRESH_MS = 15000;

    const T = {
      bgLayer: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08))",
      border: "var(--dsw-alias-border-l2, rgba(127,127,127,0.18))",
      primary: "var(--dsw-alias-label-primary, currentColor)",
      secondary: "var(--dsw-alias-label-secondary, currentColor)",
      tertiary: "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-dimmed, currentColor))",
      accent: "var(--dsw-alias-brand-primary, #4d8dff)",
      success: "var(--dsw-alias-state-success-primary, #34a853)",
      warn: "var(--dsw-alias-state-warn-label, #e8a33d)",
      error: "var(--dsw-alias-state-error-primary, #d93025)",
      hover: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.10))",
    };

    const CSS = `
.wb{display:flex;flex-direction:column;gap:14px;color:${T.primary};font-size:13px;line-height:20px;padding-bottom:8px;min-width:300px}
.wb-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wb-title{font-size:16px;font-weight:600;line-height:24px;white-space:nowrap}
.wb-badge{font-size:11px;line-height:16px;padding:0 6px;border-radius:4px;background:${T.bgLayer};color:${T.tertiary};white-space:nowrap}
.wb-card{border:1px solid ${T.border};border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;min-width:0;container-type:inline-size}
.wb-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;min-width:0}
.wb-k{color:${T.secondary};flex:0 1 auto;min-width:0;white-space:nowrap}
.wb-v{font-variant-numeric:tabular-nums;text-align:right;flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.wb-btn{border:1px solid ${T.border};background:transparent;color:${T.primary};border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;flex:0 0 auto}
.wb-btn:hover{background:${T.hover}}
.wb-btn:disabled{opacity:.5;cursor:default}
.wb-btn.on{background:${T.accent};border-color:${T.accent};color:#fff}
.wb-btns{display:flex;gap:6px;flex-wrap:wrap;align-items:center;min-width:0}
.wb-ok{color:${T.success}} .wb-warn{color:${T.warn}} .b{font-weight:600}
.wb-list{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow-y:auto;min-width:0;padding-right:8px;scrollbar-gutter:stable}
.wb-price{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:4px 0;border-bottom:1px solid ${T.border};min-width:0}
.wb-price:last-child{border-bottom:0}
.wb-pn{color:${T.primary};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}
.wb-pm{color:${T.tertiary};font-size:11px;flex:0 1 auto;text-align:right}
.wb-msg{font-size:12px;color:${T.tertiary};min-height:16px;white-space:pre-wrap;overflow-wrap:anywhere}
.wb-link{width:100%;box-sizing:border-box;font-size:11px;padding:5px 8px;border-radius:6px;border:1px solid ${T.border};background:${T.bgLayer};color:${T.secondary};font-family:inherit}
/* DSH's settings modal keeps a fixed nav column, so on a narrow window the content
   column can drop below 120px (host sections clip there too). Below this width
   nothing stays legible, so take a horizontal scroll instead of shattering text. */
@container (max-width:260px){
  .wb-row{flex-direction:column;align-items:flex-start;gap:2px}
  .wb-v{text-align:left}
  .wb-btns{width:100%}
}
`;

    function fmtExpiry(ms) {
      if (!ms) return "—";
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    async function api(path, opts) {
      const token = await api.token();
      const r = await fetch(BASE + path, {
        ...opts,
        headers: { "content-type": "application/json", authorization: "Bearer " + token, ...(opts && opts.headers || {}) },
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error((j && j.error && j.error.message) || "HTTP " + r.status);
      return j;
    }
    let cachedToken = null;
    api.token = async () => {
      if (cachedToken) return cachedToken;
      const r = await fetch(BASE + "/bootstrap");
      if (!r.ok) throw new Error("bridge unreachable (HTTP " + r.status + ")");
      const j = await r.json();
      cachedToken = j.token;
      return cachedToken;
    };

    function Panel() {
      const [s, setS] = useState(null);
      const [err, setErr] = useState("");
      const [msg, setMsg] = useState("");
      const [busy, setBusy] = useState(false);
      const [bal, setBal] = useState(null);
      const [loginUrl, setLoginUrl] = useState("");
      const pollRef = useRef(null);

      const reload = useCallback(async () => {
        try { const d = await api("/summary"); setS(d); setErr(""); }
        catch (e) { setErr(String(e && e.message || e)); }
      }, []);

      useEffect(() => {
        reload();
        const t = setInterval(reload, REFRESH_MS);
        return () => clearInterval(t);
      }, [reload]);

      useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

      const setMode = async (mode) => {
        setBusy(true); setMsg("");
        try {
          const r = await api("/mode", { method: "POST", body: JSON.stringify({ mode }) });
          setMsg(r.warnings && r.warnings.length ? "已切换 " + r.mode + "：\n" + r.warnings.join("\n") : "已切换 " + r.mode);
          await reload();
        } catch (e) { setMsg("切换失败：" + (e && e.message || e)); }
        setBusy(false);
      };

      const switchAcct = async (uid) => {
        setBusy(true); setMsg("");
        try { const r = await api("/accounts/switch", { method: "POST", body: JSON.stringify({ uid }) }); setMsg("已切换到 " + (r.nickname || r.uid)); await reload(); }
        catch (e) { setMsg("切换失败：" + (e && e.message || e)); }
        setBusy(false);
      };

      const startLogin = async () => {
        setBusy(true); setMsg("正在申请授权链接…");
        try {
          const r = await api("/login", { method: "POST", body: "{}" });
          // The desktop shell denies window.open, so always keep the link copyable.
          setLoginUrl(r.authUrl);
          const w = window.open(r.authUrl, "_blank");
          setMsg(w ? "请在打开的页面用微信确认，完成后自动检测…" : "请复制链接到浏览器打开，用微信确认，完成后自动检测…");
          const deadline = Date.now() + 10 * 60 * 1000;
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = setInterval(async () => {
            if (Date.now() > deadline) { clearInterval(pollRef.current); pollRef.current = null; setMsg("登录超时，请重试"); setLoginUrl(""); setBusy(false); return; }
            try {
              const p = await api("/login/poll");
              if (p.status === "ok") {
                clearInterval(pollRef.current); pollRef.current = null;
                setMsg("登录成功：" + (p.nickname || p.uid));
                setBusy(false);
                reload();
              }
            } catch { /* keep polling */ }
          }, 3000);
        } catch (e) { setMsg("获取授权链接失败：" + (e && e.message || e)); setBusy(false); }
      };

      const getBalance = async () => {
        setBal("查询中…");
        try { const b = await api("/balance"); setBal(b.remain + " / " + b.total + "（" + b.packages + " 个套餐）"); }
        catch (e) { setBal("失败：" + (e && e.message || e)); }
      };

      if (err && !s) {
        return React.createElement("div", { className: "wb" },
          React.createElement("style", null, CSS),
          React.createElement("div", { className: "wb-card" },
            React.createElement("div", { className: "wb-warn b" }, "桥接不可达"),
            React.createElement("div", { className: "wb-msg" }, err),
            React.createElement("button", { className: "wb-btn", onClick: reload }, "重试"),
          ),
        );
      }
      if (!s) return React.createElement("div", { className: "wb" }, React.createElement("style", null, CSS), React.createElement("div", { className: "wb-msg" }, "加载中…"));

      const acct = s.account;
      const priceRows = (s.pricing || []).map((x) =>
        React.createElement("div", { className: "wb-price", key: x.id },
          React.createElement("span", { className: "wb-pn" }, x.name),
          x.free && !x.exhausted
            ? React.createElement("span", { className: "wb-ok b" }, "现在免费")
            : React.createElement("span", { className: "wb-v" },
                React.createElement("span", { className: x.effective < x.base ? "wb-ok b" : "" }, "x" + x.effective),
                (x.label || x.note) ? React.createElement("span", { className: "wb-pm" }, " " + [x.label, x.note].filter(Boolean).join(" · ")) : null,
              ),
        ),
      );

      const acctRows = (s.accounts || []).map((a) =>
        React.createElement("div", { className: "wb-row", key: a.uid },
          React.createElement("span", null,
            acct && acct.uid === a.uid ? React.createElement("span", { className: "wb-ok b" }, "● ") : null,
            a.nickname || String(a.uid).slice(0, 8),
          ),
          acct && acct.uid === a.uid
            ? React.createElement("span", { className: "wb-v wb-pm" }, fmtExpiry(acct.expiresAt))
            : React.createElement("button", { className: "wb-btn", disabled: busy, onClick: () => switchAcct(a.uid) }, "切到这个"),
        ),
      );

      return React.createElement("div", { className: "wb" },
        React.createElement("style", null, CSS),

        React.createElement("div", { className: "wb-h" },
          React.createElement("span", { className: "wb-title" }, "WorkBuddy 桥接"),
          React.createElement("span", { className: "wb-badge" }, "端口 " + s.port),
          React.createElement("span", { className: "wb-badge" }, s.realm === "global" ? "国际版" : "国内版"),
        ),

        // 账号
        React.createElement("div", { className: "wb-card" },
          React.createElement("div", { className: "wb-row" },
            React.createElement("span", { className: "wb-k" }, "当前账号"),
            React.createElement("span", { className: "wb-v b" }, acct ? (acct.nickname || String(acct.uid).slice(0, 8)) : "未登录"),
          ),
          React.createElement("div", { className: "wb-row" },
            React.createElement("span", { className: "wb-k" }, "凭证到期"),
            React.createElement("span", { className: "wb-v" }, acct ? fmtExpiry(acct.expiresAt) : "—"),
          ),
          React.createElement("div", { className: "wb-row" },
            React.createElement("span", { className: "wb-k" }, "余额"),
            React.createElement("span", { className: "wb-v" },
              React.createElement("span", null, typeof bal === "string" ? bal : bal),
              React.createElement("button", { className: "wb-btn", style: { marginLeft: 8 }, onClick: getBalance }, "查询"),
            ),
          ),
          React.createElement("div", { className: "wb-btns" },
            React.createElement("button", { className: "wb-btn", disabled: busy, onClick: startLogin }, "扫码登录 / 加新账号"),
            React.createElement("button", { className: "wb-btn", disabled: busy, onClick: reload }, "刷新"),
          ),
          loginUrl ? React.createElement("input", {
            className: "wb-link",
            readOnly: true,
            value: loginUrl,
            onClick: (e) => e.target.select(),
          }) : null,
        ),

        // 传输模式
        React.createElement("div", { className: "wb-card" },
          React.createElement("div", { className: "wb-row" },
            React.createElement("span", { className: "wb-k" }, "传输模式"),
            React.createElement("span", { className: "wb-btns" },
              React.createElement("button", { className: "wb-btn" + (s.mode === "wbipc" ? " on" : ""), disabled: busy, onClick: () => setMode("wbipc") }, "wbipc 代持"),
              React.createElement("button", { className: "wb-btn" + (s.mode === "direct" ? " on" : ""), disabled: busy, onClick: () => setMode("direct") }, "direct 直连"),
            ),
          ),
          React.createElement("div", { className: "wb-msg" },
            s.mode === "direct"
              ? "直连：真流式、无尺寸/时长上限、不依赖桌面端"
              : "wbipc：由桌面端代持鉴权，本地不落盘凭证；需桌面端运行，且有 768KB/640KB 上限"),
          React.createElement("div", { className: "wb-row" },
            React.createElement("span", { className: "wb-k" }, "桌面端在线"),
            React.createElement("span", { className: "wb-v" + (s.workbuddyIpc ? " wb-ok" : " wb-warn") }, s.workbuddyIpc ? "是" : "否"),
          ),
        ),

        // 预算
        React.createElement("div", { className: "wb-card" },
          React.createElement("div", { className: "wb-row" },
            React.createElement("span", { className: "wb-k" }, "今日已耗 / 每日预算"),
            React.createElement("span", { className: "wb-v b" }, s.spendToday + " / " + (s.dailyCreditBudget > 0 ? s.dailyCreditBudget : "∞")),
          ),
          React.createElement("div", { className: "wb-row" },
            React.createElement("span", { className: "wb-k" }, "单次预估上限"),
            React.createElement("span", { className: "wb-v" }, s.perRequestCreditBudget > 0 ? s.perRequestCreditBudget : "关"),
          ),
          React.createElement("div", { className: "wb-msg" }, "调整请改 config.json 后重启 DSH"),
        ),

        // 已保存账号
        React.createElement("div", { className: "wb-card" },
          React.createElement("div", { className: "wb-k b" }, "已保存账号"),
          acctRows.length ? React.createElement("div", { className: "wb-list" }, acctRows) : React.createElement("div", { className: "wb-msg" }, "（暂无）"),
        ),

        // 实时价格
        React.createElement("div", { className: "wb-card" },
          React.createElement("div", { className: "wb-row" },
            React.createElement("span", { className: "wb-k b" }, "实时价格（Asia/Shanghai）"),
            React.createElement("span", { className: "wb-pm" }, s.catalogFetchedAt ? String(s.catalogFetchedAt).slice(0, 16).replace("T", " ") : "—"),
          ),
          React.createElement("div", { className: "wb-list" }, priceRows.length ? priceRows : React.createElement("div", { className: "wb-msg" }, "（暂无，登录后自动拉取）")),
        ),

        msg ? React.createElement("div", { className: "wb-msg" }, msg) : null,
      );
    }

    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          { name: "settings.section", id: SECTION_ID, order: 110, label: "WorkBuddy 桥接" },
          Panel,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.Panel = Panel;
    return module.exports;
  },
});
