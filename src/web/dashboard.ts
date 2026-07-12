// Interactive read/write dashboard served from the Worker. Market overview is
// public; portfolio & alerts are gated by an access key (sent as X-Access-Key,
// stored in localStorage). Inner JS avoids template literals to stay embeddable.

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>NEPSE Dashboard</title>
<style>
  :root {
    --bg:#f6f7f9; --card:#fff; --fg:#111827; --muted:#6b7280; --line:#e5e7eb;
    --up:#059669; --down:#dc2626; --accent:#2563eb; --field:#fff;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0b0e14; --card:#141a24; --fg:#e6e9ef; --muted:#9aa4b2; --line:#232b38;
            --up:#34d399; --down:#f87171; --accent:#60a5fa; --field:#0f1520; }
  }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--fg); }
  .wrap { max-width:980px; margin:0 auto; padding:24px 16px 60px; }
  header { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:20px; }
  h1 { font-size:20px; margin:0; letter-spacing:-.01em; }
  .row { display:flex; align-items:center; gap:8px; }
  .status { font-size:12px; font-weight:600; padding:4px 10px; border-radius:999px; border:1px solid var(--line); color:var(--muted); }
  .status.open { color:var(--up); } .status.close { color:var(--down); }
  .hero { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:22px; margin-bottom:16px; }
  .hero .label { color:var(--muted); font-size:13px; }
  .hero .val { font-size:40px; font-weight:700; letter-spacing:-.02em; margin:2px 0; }
  .chg { font-size:15px; font-weight:600; }
  .up { color:var(--up); } .down { color:var(--down); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; margin-bottom:24px; }
  .cell { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px; }
  .cell .name { font-size:12px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .cell .num { font-size:18px; font-weight:600; margin-top:2px; }
  .cell .sub { font-size:12px; font-weight:600; margin-top:1px; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:26px 0 12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; margin-bottom:14px; }
  label { display:block; font-size:12px; color:var(--muted); margin:0 0 4px; }
  input, button, select { font:inherit; }
  input[type=text], input[type=number] { width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:9px; background:var(--field); color:var(--fg); }
  input:focus { outline:2px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset:1px; }
  .fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; align-items:end; }
  button { padding:9px 16px; border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:9px; font-weight:600; cursor:pointer; white-space:nowrap; }
  button.ghost { background:transparent; color:var(--accent); }
  button.mini { padding:4px 9px; font-size:12px; border-color:var(--line); background:transparent; color:var(--down); }
  button:disabled { opacity:.5; cursor:default; }
  .combo { position:relative; }
  .combo-list { position:absolute; z-index:20; left:0; right:0; top:calc(100% + 4px); max-height:240px; overflow:auto;
                background:var(--card); border:1px solid var(--line); border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,.18); }
  .combo-list.hidden { display:none; }
  .opt { padding:8px 11px; cursor:pointer; display:flex; gap:8px; align-items:baseline; }
  .opt:hover, .opt.active { background:color-mix(in srgb, var(--accent) 14%, transparent); }
  .opt b { font-size:14px; } .opt span { color:var(--muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:right; padding:8px 6px; border-top:1px solid var(--line); white-space:nowrap; }
  th:first-child, td:first-child { text-align:left; }
  thead th { border-top:none; color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; }
  .news { list-style:none; padding:0; margin:0; }
  .news li { padding:12px 0; border-top:1px solid var(--line); display:flex; gap:10px; }
  .news li:first-child { border-top:none; }
  .news a { color:var(--fg); text-decoration:none; } .news a:hover { color:var(--accent); }
  .tag { font-size:11px; font-weight:700; text-transform:uppercase; color:var(--accent); flex:none; padding-top:2px; }
  .muted { color:var(--muted); } .err { color:var(--down); font-size:13px; }
  .locked { text-align:center; padding:22px; }
  .hidden { display:none; }
  footer { color:var(--muted); font-size:12px; margin-top:28px; text-align:center; }
  .toast { position:fixed; bottom:18px; left:50%; transform:translateX(-50%); background:var(--fg); color:var(--bg);
           padding:9px 16px; border-radius:10px; font-size:13px; opacity:0; transition:opacity .2s; pointer-events:none; }
  .toast.show { opacity:.95; }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>📊 NEPSE Dashboard</h1>
      <div class="row">
        <span id="status" class="status">…</span>
        <button id="lockBtn" class="ghost" title="Manage access">🔒</button>
      </div>
    </header>

    <div class="hero">
      <div class="label">NEPSE Index</div>
      <div class="val" id="idxVal">—</div>
      <div class="chg" id="idxChg"></div>
    </div>
    <div class="grid" id="subIdx"><div class="muted">Loading indices…</div></div>

    <!-- Personal panel -->
    <h2>My holdings &amp; alerts</h2>
    <div id="lockedView" class="card locked">
      <p class="muted">Enter your access key to manage your portfolio and alerts.</p>
      <div class="fields" style="max-width:420px;margin:0 auto;">
        <div><input id="keyInput" type="text" placeholder="Access key" autocomplete="off" /></div>
        <div><button id="unlockBtn">Unlock</button></div>
      </div>
      <p id="keyErr" class="err"></p>
    </div>

    <div id="personal" class="hidden">
      <div class="card">
        <label>Add a holding</label>
        <div class="fields">
          <div class="combo" data-combo="hold"><input type="text" placeholder="Search symbol or company…" autocomplete="off" /><div class="combo-list hidden"></div></div>
          <div><label>Quantity</label><input type="number" id="hQty" min="0" step="1" placeholder="10" /></div>
          <div><label>Buy price</label><input type="number" id="hPrice" min="0" step="0.01" placeholder="480" /></div>
          <div><button id="addHold">Add holding</button></div>
        </div>
      </div>

      <div class="card">
        <label>Set price alerts</label>
        <div class="fields">
          <div class="combo" data-combo="alert"><input type="text" placeholder="Search symbol or company…" autocomplete="off" /><div class="combo-list hidden"></div></div>
          <div><label>Buy alert — notify when price ≤</label><input type="number" id="aBuy" min="0" step="0.01" placeholder="e.g. 450" /></div>
          <div><label>Sell alert — notify when price ≥</label><input type="number" id="aSell" min="0" step="0.01" placeholder="e.g. 520" /></div>
          <div><button id="addAlert">Save alerts</button></div>
        </div>
        <p class="muted" style="margin:8px 0 0;font-size:12px;">Alerts are delivered to your Telegram. Set either or both.</p>
      </div>

      <div class="card">
        <label>Holdings</label>
        <div id="holdings"><p class="muted">No holdings yet.</p></div>
      </div>

      <div class="card">
        <label>Active alerts</label>
        <div id="alerts"><p class="muted">No alerts yet.</p></div>
      </div>
    </div>

    <h2>Latest news</h2>
    <ul class="news" id="news"><li class="muted">Loading…</li></ul>

    <footer>Market data via NEPSE &amp; ShareSansar · alerts on Telegram · auto-refresh 60s</footer>
  </div>
  <div id="toast" class="toast"></div>

<script>
(function(){
  var KEYNAME = "nepse_access_key";
  var securities = [];
  function key(){ return localStorage.getItem(KEYNAME) || ""; }
  function fmt(n){ return (n==null||isNaN(n)) ? "—" : Number(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }
  function cls(n){ return n>0?"up":n<0?"down":""; }
  function arrow(n){ return n>0?"▲":n<0?"▼":""; }
  function el(id){ return document.getElementById(id); }
  function toast(msg){ var t=el("toast"); t.textContent=msg; t.classList.add("show"); setTimeout(function(){t.classList.remove("show");},2200); }

  function api(path, opts){
    opts = opts || {};
    opts.headers = Object.assign({ "x-access-key": key() }, opts.headers||{});
    if (opts.body) opts.headers["content-type"] = "application/json";
    return fetch(path, opts);
  }

  // ---- market overview + news (public) ----
  function loadSummary(){
    fetch("/api/summary",{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){
      var open = ((d.marketStatus||{}).isOpen||"").toUpperCase()==="OPEN";
      var st = el("status"); st.textContent = open?"MARKET OPEN":"MARKET CLOSED"; st.className="status "+(open?"open":"close");
      var idx = (d.indices||[]);
      var nepse = idx.filter(function(i){return /NEPSE Index/i.test(i.index);})[0] || idx[0];
      if (nepse){ el("idxVal").textContent=fmt(nepse.currentValue);
        var c=el("idxChg"); c.textContent=arrow(nepse.change)+" "+fmt(nepse.change)+" ("+fmt(nepse.perChange)+"%)"; c.className="chg "+cls(nepse.change); }
      var sub = idx.filter(function(i){return !/NEPSE Index/i.test(i.index);});
      el("subIdx").innerHTML = sub.length ? sub.map(function(i){
        return '<div class="cell"><div class="name">'+i.index+'</div><div class="num">'+fmt(i.currentValue)+
          '</div><div class="sub '+cls(i.change)+'">'+arrow(i.change)+' '+fmt(i.perChange)+'%</div></div>';}).join("") : '<div class="muted">No index data.</div>';
      var news=d.news||[];
      el("news").innerHTML = news.length ? news.map(function(n){
        return '<li><span class="tag">'+(n.category==="news"?"":n.category)+'</span><a href="'+n.url+'" target="_blank" rel="noopener">'+n.title+'</a></li>';}).join("") : '<li class="muted">No news yet.</li>';
    }).catch(function(){ el("status").textContent="offline"; });
  }

  // ---- searchable combobox ----
  function attachCombo(root){
    var input = root.querySelector("input");
    var list = root.querySelector(".combo-list");
    var selected = "";
    function render(q){
      q = q.trim().toUpperCase();
      var items = securities;
      if (q) items = securities.filter(function(s){ return s.symbol.indexOf(q)>=0 || (s.name||"").toUpperCase().indexOf(q)>=0; });
      items = items.slice(0,40);
      list.innerHTML = items.map(function(s){ return '<div class="opt" data-sym="'+s.symbol+'"><b>'+s.symbol+'</b><span>'+(s.name||"")+'</span></div>'; }).join("");
      list.classList.toggle("hidden", items.length===0);
    }
    input.addEventListener("focus", function(){ render(input.value); });
    input.addEventListener("input", function(){ selected=""; render(input.value); });
    input.addEventListener("blur", function(){ setTimeout(function(){ list.classList.add("hidden"); },160); });
    list.addEventListener("mousedown", function(e){
      var opt = e.target.closest(".opt"); if(!opt) return;
      selected = opt.getAttribute("data-sym"); input.value = selected; list.classList.add("hidden");
    });
    return { get: function(){ return selected || input.value.trim().toUpperCase(); }, clear: function(){ selected=""; input.value=""; } };
  }
  var holdCombo, alertCombo;

  function loadSecurities(){
    return fetch("/api/securities").then(function(r){return r.json();}).then(function(list){ securities = Array.isArray(list)?list:[]; });
  }

  // ---- personal: portfolio + alerts ----
  function loadPortfolio(){
    return api("/api/portfolio").then(function(r){
      if(r.status===401){ throw new Error("unauthorized"); }
      return r.json();
    }).then(function(d){
      var h=d.holdings||[];
      if(!h.length){ el("holdings").innerHTML='<p class="muted">No holdings yet.</p>'; return; }
      var rows = h.map(function(x){
        return '<tr><td>'+x.symbol+'</td><td>'+fmt(x.quantity)+'</td><td>'+fmt(x.buyPrice)+'</td><td>'+fmt(x.ltp)+
          '</td><td>'+fmt(x.value)+'</td><td class="'+cls(x.pl)+'">'+(x.pl>=0?"+":"")+fmt(x.pl)+
          '</td><td><button class="mini" data-del-hold="'+x.id+'">✕</button></td></tr>';
      }).join("");
      var t=d.totals||{};
      el("holdings").innerHTML = '<table><thead><tr><th>Symbol</th><th>Qty</th><th>Buy</th><th>LTP</th><th>Value</th><th>P/L</th><th></th></tr></thead><tbody>'+rows+
        '</tbody><tfoot><tr><th>Total</th><td></td><td></td><td></td><td>'+fmt(t.value)+'</td><td class="'+cls(t.pl)+'">'+(t.pl>=0?"+":"")+fmt(t.pl)+' ('+fmt(t.plPct)+'%)</td><td></td></tr></tfoot></table>';
    });
  }

  var ATYPE = { price_below:"buy ≤", price_above:"sell ≥", pct_change:"move ≥ %", volume_spike:"vol ≥" };
  function loadAlerts(){
    return api("/api/alerts").then(function(r){ return r.json(); }).then(function(list){
      if(!Array.isArray(list) || !list.length){ el("alerts").innerHTML='<p class="muted">No alerts yet.</p>'; return; }
      el("alerts").innerHTML = '<table><tbody>'+list.map(function(a){
        return '<tr><td>'+a.symbol+'</td><td>'+(ATYPE[a.type]||a.type)+'</td><td>'+fmt(a.threshold)+
          '</td><td><button class="mini" data-del-alert="'+a.id+'">✕</button></td></tr>'; }).join("")+'</tbody></table>';
    });
  }

  function unlock(){
    return Promise.all([loadPortfolio(), loadAlerts()]).then(function(){
      el("lockedView").classList.add("hidden"); el("personal").classList.remove("hidden"); el("lockBtn").textContent="🔓";
    });
  }

  // ---- events ----
  el("unlockBtn").addEventListener("click", function(){
    var k = el("keyInput").value.trim(); if(!k) return;
    localStorage.setItem(KEYNAME, k); el("keyErr").textContent="";
    unlock().catch(function(){ localStorage.removeItem(KEYNAME); el("keyErr").textContent="Invalid access key."; });
  });
  el("lockBtn").addEventListener("click", function(){
    if(key()){ localStorage.removeItem(KEYNAME); el("personal").classList.add("hidden"); el("lockedView").classList.remove("hidden"); el("lockBtn").textContent="🔒"; el("keyInput").value=""; }
    else { el("keyInput").focus(); }
  });

  document.getElementById("addHold").addEventListener("click", function(){
    var sym=holdCombo.get(), qty=Number(el("hQty").value), price=Number(el("hPrice").value);
    if(!sym||!(qty>0)||!(price>0)){ toast("Enter symbol, quantity and buy price"); return; }
    api("/api/portfolio",{method:"POST",body:JSON.stringify({symbol:sym,quantity:qty,buyPrice:price})}).then(function(r){return r.json();}).then(function(d){
      if(d.ok){ toast("Holding added"); holdCombo.clear(); el("hQty").value=""; el("hPrice").value=""; loadPortfolio(); }
      else toast(d.error||"Failed"); });
  });

  document.getElementById("addAlert").addEventListener("click", function(){
    var sym=alertCombo.get(), buy=el("aBuy").value, sell=el("aSell").value;
    if(!sym){ toast("Pick a symbol"); return; }
    var jobs=[];
    if(buy!=="" && Number(buy)>0) jobs.push(api("/api/alerts",{method:"POST",body:JSON.stringify({symbol:sym,type:"price_below",threshold:Number(buy)})}));
    if(sell!=="" && Number(sell)>0) jobs.push(api("/api/alerts",{method:"POST",body:JSON.stringify({symbol:sym,type:"price_above",threshold:Number(sell)})}));
    if(!jobs.length){ toast("Enter a buy and/or sell price"); return; }
    Promise.all(jobs).then(function(){ toast("Alert(s) saved"); alertCombo.clear(); el("aBuy").value=""; el("aSell").value=""; loadAlerts(); });
  });

  document.getElementById("holdings").addEventListener("click", function(e){
    var b=e.target.closest("[data-del-hold]"); if(!b) return;
    api("/api/portfolio/"+b.getAttribute("data-del-hold"),{method:"DELETE"}).then(function(){ loadPortfolio(); });
  });
  document.getElementById("alerts").addEventListener("click", function(e){
    var b=e.target.closest("[data-del-alert]"); if(!b) return;
    api("/api/alerts/"+b.getAttribute("data-del-alert"),{method:"DELETE"}).then(function(){ loadAlerts(); });
  });

  // ---- init ----
  loadSummary(); setInterval(loadSummary, 60000);
  loadSecurities().then(function(){
    holdCombo = attachCombo(document.querySelector('[data-combo="hold"]'));
    alertCombo = attachCombo(document.querySelector('[data-combo="alert"]'));
  });
  if(key()){ unlock().catch(function(){ localStorage.removeItem(KEYNAME); }); }
})();
</script>
</body>
</html>`;
