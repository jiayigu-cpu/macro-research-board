/* ============================================================
   宏观量化看板 · 渲染逻辑 v5
   结构：顶端三结论卡 → 01 指标体系 → 02 周期定位
        → 03 政策互动 → 04 资产配置 → 05 行业择时
   铁律：默认只显示结论；点击卡片/读数才展开判定规则、公式、底层数值。
   ============================================================ */
(function () {
  const $ = function (s, r) { return (r || document).querySelector(s); };
  const $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  const CFG = window.MACRO_CFG || {};
  const el = function (t, cls, html) {
    const n = document.createElement(t);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  let DATA = null;
  let EV_ALL = false;
  let EV_Q = '';

  /* ---------------- 数字 ---------------- */
  function isNil(v) { return v === null || v === undefined || (typeof v === 'number' && isNaN(v)); }
  function smart(v) {
    if (isNil(v)) return '—';
    const parts = String(v).split('.');
    return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (parts[1] ? '.' + parts[1] : '');
  }
  function n(v, nd) {
    if (isNil(v)) return '—';
    const x = Number(v);
    if (nd == null) return smart(v);
    let s = x.toFixed(nd);
    if (nd > 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }
  function signed(v, nd, unit) {
    if (isNil(v)) return '—';
    const x = Number(v);
    return (x > 0 ? '+' : '') + n(x, nd) + (unit || '');
  }
  function pct(v) { return isNil(v) ? '—' : Math.round(Number(v) * 100) + '%'; }
  function uniq(a) { const o = Object.create(null), r = []; a.forEach(function (x) { if (x && !o[x]) { o[x] = 1; r.push(x); } }); return r; }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function MV() { return (DATA && DATA.macro_v2) || {}; }
  function pts(k) { if (!DATA) return null; const s = (DATA.series || {})[k]; return s && s.points ? s.points : null; }
  function freqOf(k) { if (!DATA) return 'D'; const s = (DATA.series || {})[k]; return s ? s.freq : 'D'; }
  function lines(k, name, idx) {
    const p = pts(k);
    if (!p) return null;
    // 不用红绿：多线一红一绿会被读成涨跌（A 股语义），这里用中性的青 / 紫
    const cols = [cssVar('--accent'), cssVar('--alt'), cssVar('--up')];
    return { name: name, points: p, color: cols[idx || 0] };
  }

  /* ---------------- 数据加载 ---------------- */
  let DATA_SRC = null;
  function loadJSON(url, opts) {
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  async function fetchData(bust) {
    const q = bust ? '?t=' + Date.now() : '';
    const opt = { cache: bust ? 'no-store' : 'no-cache' };
    if (DATA_SRC !== 'static') {
      try {
        const d = await loadJSON('api/dashboard' + q, opt);
        DATA_SRC = 'api';
        return d;
      } catch (e) { /* 静态托管时回退快照 */ }
    }
    const d = await loadJSON('data.json' + q, opt);
    DATA_SRC = 'static';
    return d;
  }
  function toast(msg) {
    let t = document.getElementById('toast');
    if (!t) { t = el('div', 'toast'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.classList.remove('on'); }, 6000);
  }

  /* ---------------- 抽屉 ---------------- */
  function openDrawer(o) {
    $('#d-title').textContent = o.title || '';
    $('#d-sub').textContent = o.sub || '';
    $('#d-body').innerHTML = o.html || '';
    $('#drawer').classList.add('on');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $('#scrim').classList.add('on');
    if (o.chart) {
      requestAnimationFrame(function () {
        const host = $('#d-chart');
        if (host && window.MC) MC.draw(host, o.chart);
      });
    }
  }
  function closeDrawer() {
    $('#drawer').classList.remove('on');
    $('#drawer').setAttribute('aria-hidden', 'true');
    $('#scrim').classList.remove('on');
  }
  function sec(t, html) { return '<div class="dsec"><div class="dsec-t">' + t + '</div>' + html + '</div>'; }
  function metricsHTML(ms) {
    return '<div class="dmetrics">' + (ms || []).map(function (m) {
      return '<div class="dm"><em>' + m.k + '</em><b>' + m.v + '</b><i>' + (m.n || '') + '</i></div>';
    }).join('') + '</div>';
  }
  function stepsHTML(list) {
    return '<ol class="dsteps">' + (list || []).map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol>';
  }
  function noteHTML(s) { return s ? '<div class="dsrc">' + s + '</div>' : ''; }

  /* 因子 z 分数统一保留两位小数（避免出现「2」与「1.11」并排） */
  function z2(v) { return isNil(v) ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2); }

  /* 抽屉统一带上数据时点，满足「点开能看到规则 / 数值 / 更新时间」 */
  function stampNote(s) {
    const t = String(DATA.updated_at || '').slice(5, 16);
    const a = (DATA.asof || {}).trade_date || '';
    return noteHTML(esc(s || '') + (s ? '　' : '') + '数据更新：' + esc(t) + (a ? '　行情截至：' + esc(a) : ''));
  }

  function bindCard(node, fn) {
    node.tabIndex = 0;
    node.addEventListener('click', fn);
    node.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
    });
  }

  /* ---------------- 顶栏 ---------------- */
  function renderTop() {
    const a = DATA.asof || {};
    $('#asof').textContent = a.trade_date || (DATA.updated_at || '').slice(0, 10);
    $('#upd').textContent = (DATA.updated_at || '').slice(5, 16);
  }

  /* ---------------- 行业分组与阶段 ---------------- */
  function groupOf(name) {
    const g = CFG.indGroups || {};
    for (const k in g) if (g[k].indexOf(name) > -1) return k;
    return '';
  }
  function stageNow() {
    const mv = MV();
    const oid = (mv.octant || {}).id;
    let sid = (CFG.octantStage || {})[oid] || 1;
    const inv = mv.inventory || {};
    // 库存阶段只做边界修正：主动补库且仍在宽松期 → 提前进入复苏初期；主动去库且已过热 → 退回宽松期
    if (inv.available && sid === 1 && inv.stage_id === 2) sid = 2;
    if (inv.available && sid >= 3 && inv.stage_id === 4) sid = 1;
    return sid;
  }
  function stageDef(sid) { return (CFG.stages || []).filter(function (s) { return s.id === sid; })[0] || { groups: [] }; }
  function recSet(sid) {
    const s = new Set();
    (stageDef(sid).groups || []).forEach(function (g) {
      ((CFG.indGroups || {})[g] || []).forEach(function (x) { s.add(x); });
    });
    return s;
  }
  function industryItems() { return (MV().industry || {}).items || []; }

  function industrySplit() {
    const items = industryItems();
    const sid = stageNow();
    const rec = recSet(sid);
    const dbl = items.filter(function (i) { return i.triggered && rec.has(i.name); });
    const evtOnly = items.filter(function (i) { return i.triggered && !rec.has(i.name); });
    const stageOnly = items.filter(function (i) { return !i.triggered && rec.has(i.name); });
    const hot = items.filter(function (i) { return (i.heat_pct || 0) > 0.9; });
    return { sid: sid, rec: rec, dbl: dbl, evtOnly: evtOnly, stageOnly: stageOnly, hot: hot, items: items };
  }

  /* ============================================================
     顶端三张结论卡
     ============================================================ */
  function renderTopCards() {
    const box = $('#topcards');
    const mv = MV();
    if (!mv.available) {
      box.innerHTML = '<article class="v3card mid"><div class="v3top"><span class="v3no">结论</span></div>' +
        '<div class="v3head">数据更新中</div><p class="v3text">' + esc(mv.note || '计算层尚未产出结果') + '</p></article>';
      return;
    }
    const oct = mv.octant || {}, inv = mv.inventory || {}, pos = mv.position || {};
    const ax = mv.axes || {};
    const sp = industrySplit();
    const tone = oct.tone || 'mid';

    // 卡 1 周期定位
    const c1 = el('article', 'v3card ' + tone);
    const trail = (oct.trail || []).map(function (t) {
      const o = (CFG.octants || []).filter(function (x) { return x.id === t.id; })[0] || {};
      return '<span class="trd ' + (o.tone || 'mid') + (t.id === oct.id ? ' on' : '') + '" title="' + t.m + ' ' + esc(o.name || '') + '">' +
        (o.name ? o.name.slice(0, 2) : '·') + '</span>';
    }).join('');
    c1.innerHTML =
      '<div class="v3top"><span class="v3no">01 周期定位</span><span class="badge ' + tone + '">' + esc(oct.name || '待定') + '</span></div>' +
      '<div class="v3head">' + esc(oct.meaning || '') + '</div>' +
      '<p class="v3text">' + (inv.available
        ? '库存周期：<b>' + esc(inv.stage) + '</b>（第 ' + inv.months_in + ' 个月）· 需求' + esc(inv.demand) + ' × 库存' + esc(inv.stock)
        : '库存周期：待判定') + '</p>' +
      '<div class="v3metrics">' +
        metric('增长', ax.growth && ax.growth.label, ax.growth && (n(ax.growth.value, 1) + '%')) +
        metric('通胀', ax.inflation && ax.inflation.label, ax.inflation && (n(ax.inflation.value, 1) + '%')) +
        metric('流动性', ax.liquidity && ax.liquidity.label, ax.liquidity && (n(ax.liquidity.value, 1) + 'pp')) +
      '</div>' +
      '<div class="v3trail">' + trail + '</div>' +
      '<div class="v3foot">进入 ' + esc(oct.since || '—') + '（第 ' + (oct.months_in || 1) + ' 月）· 点击看判定</div>';
    bindCard(c1, function () { octantDrawer(); });
    box.appendChild(c1);

    // 卡 2 仓位
    const pTone = pos.tier === 'full' ? 'pos' : pos.tier === 'empty' ? 'neg' : 'mid';
    const c2 = el('article', 'v3card ' + (pos.available ? pTone : 'mid'));
    c2.innerHTML = pos.available
      ? '<div class="v3top"><span class="v3no">02 仓位</span><span class="badge ' + pTone + '">' + esc(pos.label) + '</span></div>' +
        '<div class="v3head">' + esc(pos.reason) + '</div>' +
        '<p class="v3text">' + esc(pos.season_note || '') + '</p>' +
        '<div class="v3metrics">' +
          metric('基钦方向', pos.kitchin === 'up' ? '向上' : '向下', esc(pos.kitchin_label || '')) +
          metric('季节方向', pos.season === 'up' ? '向上' : '向下', '成交额 + 融资余额') +
        '</div>' +
        '<div class="v3foot">华鑫基钦 × 季节矩阵 · 点击看矩阵与依据</div>'
      : '<div class="v3top"><span class="v3no">02 仓位</span><span class="badge mid">待接入</span></div>' +
        '<div class="v3head">仓位建议暂不给出</div><p class="v3text">' + esc(pos.note || '') + '</p>';
    bindCard(c2, function () { positionDrawer(); });
    box.appendChild(c2);

    // 卡 3 行业配置
    const names = sp.dbl.slice(0, 3).map(function (i) { return i.name; });
    const c3 = el('article', 'v3card ' + (sp.dbl.length ? 'pos' : 'mid'));
    c3.innerHTML =
      '<div class="v3top"><span class="v3no">03 行业配置</span><span class="badge ' + (sp.dbl.length ? 'pos' : 'mid') + '">' +
        (sp.dbl.length ? '双确认 ' + sp.dbl.length + ' 个' : '无双确认') + '</span></div>' +
      '<div class="v3head">' + (names.length ? esc(names.join(' · ')) : '本月事件库与阶段映射没有同时命中') + '</div>' +
      '<p class="v3text">当前阶段：<b>' + esc(stageDef(sp.sid).name) + '</b>' +
        '　仅事件 ' + sp.evtOnly.length + ' 个 · 仅阶段 ' + sp.stageOnly.length + ' 个' +
        (sp.hot.length ? '　⚠ 高拥挤 ' + sp.hot.length + ' 个' : '') + '</p>' +
      '<div class="v3metrics">' +
        metric('双确认', sp.dbl.length + ' 个', '事件 × 阶段') +
        metric('单方信号', (sp.evtOnly.length + sp.stageOnly.length) + ' 个', '按来源标注') +
        metric('高拥挤', sp.hot.length + ' 个', '热度 > 90% 分位') +
      '</div>' +
      '<div class="v3foot">点击看每个行业的触发事件、IR、推导链与拥挤度</div>';
    bindCard(c3, function () { industryCardDrawer(); });
    box.appendChild(c3);
  }

  function metric(k, v, sub) {
    return '<div class="cm"><em>' + k + '</em><b>' + (v || '—') + '</b><i>' + (sub || '') + '</i></div>';
  }

  /* ---- 卡 1 抽屉 ---- */
  function octantDrawer() {
    const mv = MV(), oct = mv.octant || {}, ax = mv.axes || {};
    const rows = (CFG.axis || []).map(function (a) {
      const x = ax[a.k] || {};
      const tone = x.direction === 'up' ? 'up' : 'down';
      return '<tr><td>' + a.n + '</td><td class="' + tone + '">' + esc(x.label || '待定') + '</td>' +
        '<td>' + esc(x.note || '—') + '</td></tr>';
    }).join('');
    const table = '<div class="table-wrap"><table class="tbl"><thead><tr><th style="width:12%">轴</th><th style="width:22%">判定</th><th>依据</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    const trail = (oct.trail || []).map(function (t) {
      const o = (CFG.octants || []).filter(function (x) { return x.id === t.id; })[0] || {};
      return '<span class="trd ' + (o.tone || 'mid') + (t.id === oct.id ? ' on' : '') + '">' + t.m.slice(2) + '<b>' + esc(o.name || '') + '</b></span>';
    }).join('');
    const octs = (CFG.octants || []).map(function (o) {
      return '<tr' + (o.id === oct.id ? ' class="on"' : '') + '><td>' + o.name + '</td><td>' + o.bits + '</td><td>' + o.assets + '</td></tr>';
    }).join('');
    const octTable = '<div class="table-wrap"><table class="tbl"><thead><tr><th style="width:20%">卦限</th><th style="width:32%">三轴组合</th><th>资产倾向</th></tr></thead><tbody>' + octs + '</tbody></table></div>';
    openDrawer({
      title: '周期定位 · ' + (oct.name || '待定'),
      sub: '卦限判定 = 三轴方向合成，与模块 2.1 同源',
      html: sec('结论', '<div class="dheadline">' + esc(oct.meaning || '') + '</div>' +
        '<p class="dtext">' + esc(oct.assets || '') + '</p>') +
        sec('三轴当前值与判定', table) +
        sec('判定规则', stepsHTML((CFG.axis || []).map(function (a) { return a.n + '：' + a.dir; })
          .concat([oct.formula || 'octant_id = 4×增长上行 + 2×通胀上行 + 1×流动性宽松 + 1']))) +
        sec('近 12 个月轨迹', '<div class="trailrow">' + (trail || '轨迹待接入') + '</div>') +
        sec('八卦限定义', octTable) +
        stampNote('数据：国家统计局（PMI / 工业增加值 / CPI / PPI）、中国人民银行（M1 / M2）')
    });
  }

  /* ---- 卡 2 抽屉 ---- */
  function positionDrawer() {
    const pos = MV().position || {};
    const inv = MV().inventory || {};
    const mx = (CFG.position || {}).matrix || [];
    const tbl = mx.map(function (r) {
      const on = r.kitchin === pos.kitchin && r.season === pos.season;
      return '<tr' + (on ? ' class="on"' : '') + '><td>' + r.kitchinLabel + ' × ' + r.seasonLabel + '</td>' +
        '<td>' + r.label + '</td><td>' + r.reason + '</td></tr>';
    }).join('');
    openDrawer({
      title: '仓位 · ' + (pos.label || '待定'),
      sub: '基钦周期方向 × 季节周期方向',
      html: sec('结论', '<div class="dheadline">' + esc(pos.reason || pos.note || '') + '</div>' +
        '<p class="dtext">' + esc(pos.season_note || '') + '</p>') +
        sec('仓位矩阵（华鑫规则）',
          '<div class="table-wrap"><table class="tbl"><thead><tr><th style="width:40%">组合</th><th style="width:18%">档位</th><th>含义</th></tr></thead><tbody>' + tbl + '</tbody></table></div>') +
        sec('基钦方向依据', '<p class="dtext">库存周期阶段：<b>' + esc(inv.stage || '待定') + '</b>（进入第 ' + (inv.months_in || '—') + ' 个月）。' +
          '被动去库 / 主动补库＝向上，主动去库 / 被动补库＝向下。' + esc(inv.note || '') + '</p>') +
        sec('季节方向依据', stepsHTML(pos.detail || ['成交额与融资余额数据待接入'])) +
        sec('边界', '<div class="dact">' + esc((CFG.position || {}).boundary || '') + '</div>') +
        stampNote((pos.history || '') + '　数据：东方财富（成交额）、上交所（融资余额）')
    });
  }

  /* ---- 卡 3 抽屉 ---- */
  function industryCardDrawer() {
    const sp = industrySplit();
    const block = function (i) {
      const ev = (i.events || []).map(function (e) {
        return '<li>' + e.name + ' · IR ' + (e.ir == null ? '—' : e.ir) + ' · 历史 ' + e.n + ' 次 · 20 日均值 ' + (e.avg == null ? '—' : e.avg + '%') +
          (e.effective ? ' <span class="tag ok">有效</span>' : ' <span class="tag">未达阈值</span>') + '</li>';
      }).join('') || '<li>本月无触发事件</li>';
      return '<div class="indblk"><div class="indblk-h"><b>' + i.name + '</b>' +
        '<span class="tag ' + (i.label === '高拥挤筑顶' ? 'warn' : '') + '">' + i.label + '</span>' +
        '<span class="heat">热度 ' + pct(i.heat_pct) + '</span></div>' +
        '<ul class="rule">' + ev + '</ul>' +
        '<div class="indsrc">阶段推导：' + esc(stageDef(sp.sid).name) + ' → ' + esc(groupOf(i.name) || '未分组') + ' → ' + i.name +
        (i.best_ir ? '；最高 IR ' + i.best_ir : '') + '</div></div>';
    };
    let html = sec('双确认（事件库 × 阶段映射）',
      sp.dbl.length ? sp.dbl.map(block).join('') : '<p class="dtext">本月没有同时被两套引擎命中的行业。按框架，此时以「单方信号 + 交易性思路」处理，不追高。</p>');
    if (sp.evtOnly.length) html += sec('仅事件库命中', '<p class="dtext">' + sp.evtOnly.map(function (i) { return i.name + '（' + (i.events[0] ? i.events[0].name : '') + '）'; }).join('、') + '</p>');
    if (sp.stageOnly.length) html += sec('仅阶段映射命中', '<p class="dtext">' + sp.stageOnly.map(function (i) { return i.name; }).join('、') + '</p>');
    if (sp.hot.length) html += sec('高拥挤警示', '<p class="dtext">' + sp.hot.map(function (i) { return i.name + '（热度 ' + pct(i.heat_pct) + '）'; }).join('、') + '　即使双确认也应减仓或等回踩。</p>');
    html += sec('当前阶段', '<div class="dact">' + esc(stageDef(sp.sid).name) + '：' + esc(stageDef(sp.sid).note || '') + '</div>');
    html += stampNote('数据：申万一级行业指数（31 个）、东方财富');
    openDrawer({ title: '行业配置 · 双引擎', sub: '事件库（广发口径）× 阶段映射（东财口径）', html: html });
  }

  /* ============================================================
     模块 1 指标体系
     ============================================================ */
  const DIMS = [
    { k: 'growth', name: '增长', en: 'GROWTH' },
    { k: 'inflation', name: '通胀', en: 'INFLATION' },
    { k: 'liquidity', name: '流动性', en: 'LIQUIDITY' },
    { k: 'fiscal', name: '财政', en: 'FISCAL' },
    { k: 'external', name: '外部', en: 'EXTERNAL' },
    { k: 'policy', name: '政策', en: 'POLICY' }
  ];

  function metricVal(m) {
    if (!isNil(m.m1) || !isNil(m.m2)) return 'M1 <b>' + n(m.m1, 1) + '</b>% / M2 <b>' + n(m.m2, 1) + '</b>%';
    if (!isNil(m.lpr1y)) return '1Y <b>' + Number(m.lpr1y).toFixed(2) + '</b>% / 5Y <b>' + Number(m.lpr5y).toFixed(2) + '</b>%';
    if (!isNil(m.fx_yi_usd)) return '<b>' + smart(m.fx_yi_usd) + '</b> 亿美元' + (isNil(m.gold_wan_oz) ? '' : '<small>黄金 ' + smart(m.gold_wan_oz) + ' 万盎司</small>');
    if (!isNil(m.us10y)) return '<b>' + n(m.us10y, 2) + '</b>% <small>中美利差 ' + n(m.cnus10, 2) + 'pp</small>';
    if (String(m.name || '').indexOf('财政收入') === 0) return '<b>' + smart(m.value) + '</b> 亿元' + (isNil(m.cum_yoy) ? '' : '<small>累计同比 ' + n(m.cum_yoy, 1) + '%</small>');
    return '<b>' + smart(m.value) + '</b>' + (m.unit === '%' ? '%' : (m.unit ? ' ' + m.unit : ''));
  }

  function tagsOf(dimKey, name) {
    return (CFG.tags || {})[name] || (CFG.dimDefaultTag || {})[dimKey] || [];
  }

  function metricRow(dimKey, m) {
    if (!m) return '';
    if (m.pending) return '<div class="pend">' + m.note + '</div>';
    const nm = String(m.name || '');
    const hasVal = !isNil(m.value) || !isNil(m.m1) || !isNil(m.lpr1y) || !isNil(m.fx_yi_usd) || !isNil(m.us10y);
    const tg = tagsOf(dimKey, nm);
    const tagHTML = tg.length ? '<span class="itag">' + tg.join(' · ') + '</span>' : '';
    if (!hasVal) return '<div class="mrow"><span class="mn">' + nm + tagHTML + '</span><span class="mv">未取到</span></div>';
    const sub = [m.date, m.read].filter(Boolean).join(' · ');
    let bar = '';
    if (!isNil(m.pctile_1y)) {
      const p = Math.max(2, Math.round(m.pctile_1y * 100));
      bar = '<div class="bar"><i class="' + (p > 65 ? 'high' : p < 35 ? 'low' : '') + '" style="width:' + p + '%"></i></div>';
    }
    return '<button class="mrow mbtn" type="button" data-dim="' + dimKey + '" data-name="' + esc(nm) + '">' +
      '<span class="mn">' + nm + tagHTML + '</span>' +
      '<span class="mv">' + metricVal(m) + (sub ? '<small>' + sub + '</small>' : '') + '</span></button>' + bar;
  }

  function dimState(k) {
    const st = ((DATA.dims || {})[k] || {}).state || {};
    const ax = (MV().axes || {})[k];
    if (!ax) return st;
    const up = ax.direction === 'up';
    const short = k === 'liquidity' ? (up ? '宽松' : '收紧') : (up ? '上行' : '下行');
    const tone = k === 'inflation' ? (up ? 'neg' : 'pos') : (up ? 'pos' : 'neg');
    return { label: short, tone: tone, note: ax.note };
  }

  function renderDims() {
    const dims = DATA.dims || {};
    $('#dimstrip').innerHTML = DIMS.map(function (d) {
      const st = dimState(d.k);
      return '<div class="dchip ' + (st.tone || 'mid') + '"><em>' + d.name + '</em><b>' + (st.label || '待定') + '</b><span>' + (st.note || '—') + '</span></div>';
    }).join('');

    const box = $('#dims');
    box.innerHTML = '';
    DIMS.forEach(function (d) {
      const g = dims[d.k] || {};
      const st = dimState(d.k);
      const col = function (list, title, hint) {
        const items = (list || []).filter(Boolean);
        const body = items.length ? items.map(function (m) { return metricRow(d.k, m); }).join('') : '<div class="pend">本栏数据待接入</div>';
        return '<div class="dcol"><div class="dcol-t">' + title + '<span>' + hint + '</span></div>' + body + '</div>';
      };
      const card = el('div', 'dim');
      card.innerHTML = '<div class="dim-head"><b>' + d.name + '<em>' + d.en + '</em></b>' +
        '<span class="dim-state ' + (st.tone || 'mid') + '">' + (st.label || '待定') + '</span></div>' +
        '<div class="dim-cols">' + col(g.official, '正式数据', '低频 · 权威') + col(g.highfreq, '高频数据', '领先 · 可验证') + '</div>';
      box.appendChild(card);
    });

    $$('.mbtn').forEach(function (b) {
      b.addEventListener('click', function () {
        const dim = b.dataset.dim, name = b.dataset.name;
        const dd = (DATA.dims || {})[dim] || {};
        const all = (dd.official || []).concat(dd.highfreq || []);
        const m = all.filter(function (x) { return x && x.name === name; })[0] || {};
        const tg = tagsOf(dim, name);
        const keys = guessSeries(name);
        const lns = keys.map(function (k, i) { return lines(k, SERIES_LABEL[k] || k, i); })
          .filter(function (x) { return x && x.points && x.points.length; });
        const hasChart = lns.length > 0;
        // 两条以上才需要图例，单线时标题已经说明画的是什么
        const legend = lns.length > 1 ? '<div class="chart-legend">' + lns.map(function (l) {
          return '<span><i style="background:' + l.color + '"></i>' + esc(l.name) + '</span>';
        }).join('') + '</div>' : '';
        // 只有跨零的序列（剪刀差、利差）才以 0 为基准，否则收益率曲线的差异会被压平
        const crossZero = lns.some(function (l) {
          return l.points.some(function (q) { return q[1] < 0; });
        });
        const fr = hasChart ? freqOf(keys[0]) : '';
        const freqTxt = fr === 'M' ? '月频' : fr === 'Q' ? '季频' : fr ? '日频' : '—';
        openDrawer({
          title: name,
          sub: (m.date || '') + '　' + (tg.length ? tg.join(' · ') : ''),
          html: sec('当前读数', '<div class="dheadline">' + metricVal(m).replace(/<\/?small>/g, '') + '</div>' +
            (m.read ? '<p class="dtext">' + esc(m.read) + '</p>' : '')) +
            (hasChart ? sec('走势', '<div class="chart-body" id="d-chart"></div>' + legend) : '') +
            sec('标签', '<div class="dact">' + (tg[0] ? '领先性：' + tg[0] + '　' : '') + (tg[1] ? '传导链位置：' + tg[1] : '') +
              '<br><span class="dsrc">领先 / 同步 / 滞后按东财框架；政策目标 → 中间过程 → 经济结果按长江框架</span></div>') +
            sec('判定与口径', stepsHTML([
              (m.unit ? '单位：' + m.unit + '；' : '') + '频率：' + freqTxt,
              m.pctile_1y != null ? '近一年分位：' + pct(m.pctile_1y) : '分位数据待接入',
              m.src ? '来源：' + m.src : '来源见页脚'
            ])) +
            noteHTML(m.note || ''),
          chart: hasChart ? { lines: lns, unit: m.unit || '', nd: 2, height: 180, zero: crossZero } : null
        });
      });
    });
  }

  /* 指标名 → 序列 key。值统一为数组，双序列指标（M1/M2、LPR、美债曲线）画多条线。
     名字必须与 data.json 里 dims 的实际 name 完全一致，否则会退化为「没有走势图」。 */
  const SERIES_GUESS = {
    // 增长
    '官方制造业 PMI': ['pmi'],
    '制造业 PMI': ['pmi'],
    '非制造业 PMI': ['pmi_non'],
    '规模以上工业增加值同比': ['iav'],
    '规模以上工业增加值累计同比': ['iav_cum'],
    '工业增加值同比': ['iav'],
    '工业增加值累计同比': ['iav_cum'],
    // 通胀
    'CPI 同比': ['cpi'], 'CPI 环比': ['cpi_mom'], 'PPI 同比': ['ppi'],
    // 流动性
    'M1 / M2 同比': ['m1', 'm2'],
    'M1 同比': ['m1'], 'M2 同比': ['m2'],
    'M1 − M2 剪刀差': ['scissors'],
    'SHIBOR 隔夜': ['shibor_on'], 'SHIBOR 7天': ['shibor_7d'],
    '新增人民币贷款（社融主项）': ['credit_inc'],
    // 政策
    'LPR 1Y / 5Y 报价': ['lpr1y', 'lpr5y'],
    'LPR 1Y / 5Y': ['lpr1y', 'lpr5y'],
    // 财政
    '财政收入（当月 / 累计同比）': ['fiscal_rev'],
    '超长端利差 30Y − 10Y': ['us30y', 'us10y'],
    // 外部
    '外汇储备 / 黄金储备': ['fxres'],
    '美债 10Y / 中美利差': ['us10y', 'cnus10'],
    '美国 10Y 国债收益率': ['us10y'],
    '中美 10Y 利差': ['cnus10'],
    'USD/CNY 中间价': ['usdcny'],
    // 市场
    '国债收益率 10Y / 1Y': ['y10', 'y1'],
    '期限利差 10Y − 1Y': ['slope'],
    '沪深 300 与 60 日均线': ['hs300', 'hs300_ma60'],
    '两市成交额': ['amount'],
    '股权风险溢价 ERP': ['erp'],
    '螺纹钢主力连续': ['rb'], 'INE 原油主力': ['sc']
  };

  /* 图例用短名：序列 key 的全称太长，图上放不下 */
  const SERIES_LABEL = {
    pmi: 'PMI', pmi_non: '非制造业', iav: '工业增加值', iav_cum: '累计同比',
    cpi: 'CPI', cpi_mom: 'CPI 环比', ppi: 'PPI',
    m1: 'M1', m2: 'M2', scissors: '剪刀差',
    lpr1y: 'LPR 1Y', lpr5y: 'LPR 5Y',
    us10y: '美债 10Y', us30y: '美债 30Y', cnus10: '中美利差',
    y10: '国债 10Y', y1: '国债 1Y', slope: '期限利差',
    fxres: '外汇储备', hs300: '沪深 300', hs300_ma60: 'MA60',
    amount: '成交额', erp: 'ERP', rb: '螺纹钢', sc: '原油',
    shibor_on: 'SHIBOR 隔夜', shibor_7d: 'SHIBOR 7D', credit_inc: '新增贷款',
    fiscal_rev: '财政收入', usdcny: 'USD/CNY'
  };

  /* 返回序列 key 数组。先精确匹配；再按 key 长度降序做包含匹配，
     避免「工业增加值同比」抢先匹配到「规模以上工业增加值累计同比」。 */
  function guessSeries(name) {
    if (!name) return [];
    if (SERIES_GUESS[name]) return SERIES_GUESS[name];
    const keys = Object.keys(SERIES_GUESS).sort(function (a, b) { return b.length - a.length; });
    for (let i = 0; i < keys.length; i++) {
      if (name.indexOf(keys[i]) > -1) return SERIES_GUESS[keys[i]];
    }
    return [];
  }

  /* ============================================================
     模块 2 周期定位
     ============================================================ */
  const CUBE = { yaw: -0.66, pitch: 0.42, proj2d: false, drag: false, x: 0, y: 0 };

  function octantColor(tone) {
    if (tone === 'pos') return cssVar('--up');
    if (tone === 'neg') return cssVar('--down');
    return cssVar('--alt');
  }

  function renderCube() {
    const host = $('#oct-cube');
    if (!host) return;
    const mv = MV(), oct = mv.octant || {};
    if (!mv.available) { host.innerHTML = '<div class="chart-empty">卦限数据更新中</div>'; return; }
    if (CUBE.proj2d) { renderProj2D(host); return; }

    const W = Math.max(host.clientWidth || 460, 320), H = 372;
    const head = host.parentNode && host.parentNode.querySelector('.ptitle');
    if (head) head.innerHTML = '卦限立方体 · <b>' + esc(oct.name || '') + '</b>';
    const S = Math.min(W * 0.32, H * 0.56);
    const cx = W / 2, cy = H / 2 + 8;
    const yaw = CUBE.yaw, pitch = CUBE.pitch;
    const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);

    function project(p) {
      let x = p[0] - 0.5, y = p[1] - 0.5, z = p[2] - 0.5;
      const X = x * cyw + z * syw;
      const Z = -x * syw + z * cyw;
      const Y = y * cp - Z * sp;
      const D = y * sp + Z * cp;
      return { x: cx + X * S, y: cy - Y * S, d: D };
    }

    const NS = 'http://www.w3.org/2000/svg';
    host.innerHTML = '';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('class', 'cube-svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', H);
    host.appendChild(svg);
    const mk = function (tag, at) {
      const e = document.createElementNS(NS, tag);
      for (const k in at) e.setAttribute(k, at[k]);
      svg.appendChild(e);
      return e;
    };

    // 8 个卦限子立方体
    const subs = [];
    for (let gi = 0; gi < 2; gi++) for (let ii = 0; ii < 2; ii++) for (let li = 0; li < 2; li++) {
      subs.push({ g: gi, i: ii, l: li, id: 4 * gi + 2 * ii + li + 1 });
    }
    const facesOf = function (x0, y0, z0, s) {
      const x1 = x0 + s, y1 = y0 + s, z1 = z0 + s;
      return [
        { n: [0, 0, 1], p: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
        { n: [0, 0, -1], p: [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]] },
        { n: [1, 0, 0], p: [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]] },
        { n: [-1, 0, 0], p: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] },
        { n: [0, 1, 0], p: [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]] },
        { n: [0, -1, 0], p: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] }
      ];
    };

    const polys = [];
    subs.forEach(function (s) {
      const def = (CFG.octants || []).filter(function (o) { return o.id === s.id; })[0] || {};
      const x0 = s.g ? 0.5 : 0, y0 = s.i ? 0.5 : 0, z0 = s.l ? 0.5 : 0;
      const center = project([x0 + 0.25, y0 + 0.25, z0 + 0.25]);
      facesOf(x0, y0, z0, 0.5).forEach(function (f) {
        // 面法向旋转后朝观察者才画
        const nn = project([f.p[0][0] + f.n[0] * 0.001, f.p[0][1] + f.n[1] * 0.001, f.p[0][2] + f.n[2] * 0.001]);
        const base = project(f.p[0]);
        const toward = (nn.d - base.d) >= 0;
        if (!toward) return;
        const pts2 = f.p.map(project);
        const depth = pts2.reduce(function (a, p) { return a + p.d; }, 0) / 4;
        polys.push({ id: s.id, def: def, pts: pts2, depth: depth, center: center });
      });
    });
    polys.sort(function (a, b) { return a.depth - b.depth; });
    polys.forEach(function (f) {
      const cur = f.id === oct.id;
      const col = octantColor(f.def.tone);
      mk('polygon', {
        points: f.pts.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' '),
        fill: col, 'fill-opacity': cur ? 0.34 : 0.10,
        stroke: cur ? col : cssVar('--line-2'), 'stroke-width': cur ? 1.4 : 0.6,
        'stroke-opacity': cur ? 0.95 : 0.5,
        'data-id': f.id
      });
    });

    // 当前点 + 名称
    const cur = subs.filter(function (s) { return s.id === oct.id; })[0];
    if (cur) {
      const c = project([cur.g ? 0.75 : 0.25, cur.i ? 0.75 : 0.25, cur.l ? 0.75 : 0.25]);
      mk('circle', { cx: c.x, cy: c.y, r: 12, fill: octantColor(oct.tone), 'fill-opacity': 0.16 });
      mk('circle', { cx: c.x, cy: c.y, r: 3.4, fill: octantColor(oct.tone) });
      const tx = c.x + 9, ty = c.y + 3;
      const t2 = mk('text', { x: tx, y: ty, fill: cssVar('--muted'), 'font-size': 9 });
      t2.textContent = '第 ' + (oct.months_in || 1) + ' 月';
    }

    // 三轴
    const axis = [
      { a: [0, 0, 0], b: [1.18, 0, 0], t: '增长 →', off: [10, 4] },
      { a: [0, 0, 0], b: [0, 1.18, 0], t: '↑ 通胀', off: [-34, -6] },
      { a: [0, 0, 0], b: [0, 0, 1.18], t: '流动性 →', off: [-40, 12] }
    ];
    axis.forEach(function (ax) {
      const p1 = project(ax.a), p2 = project(ax.b);
      mk('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stroke: cssVar('--line-2'), 'stroke-width': 1, 'stroke-dasharray': '3 3' });
      const t = mk('text', { x: p2.x + ax.off[0], y: p2.y + ax.off[1], fill: cssVar('--muted'), 'font-size': 9.5 });
      t.textContent = ax.t;
    });

    // 图例
    const lg = [['pos', '权益友好'], ['neg', '防御'], ['mid', '结构性']];
    lg.forEach(function (x, i) {
      const gx = 12 + i * 76;
      mk('rect', { x: gx, y: H - 18, width: 8, height: 8, rx: 2, fill: octantColor(x[0]), 'fill-opacity': 0.8 });
      const t = mk('text', { x: gx + 13, y: H - 10, fill: cssVar('--muted'), 'font-size': 9 });
      t.textContent = x[1];
    });

    // 交互：拖动旋转 + 点击当前块
    svg.addEventListener('pointerdown', function (e) {
      CUBE.drag = true; CUBE.x = e.clientX; CUBE.y = e.clientY;
      svg.setPointerCapture && svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', function (e) {
      if (!CUBE.drag) return;
      CUBE.yaw += (e.clientX - CUBE.x) * 0.01;
      CUBE.pitch = Math.max(-1.1, Math.min(1.1, CUBE.pitch + (e.clientY - CUBE.y) * 0.006));
      CUBE.x = e.clientX; CUBE.y = e.clientY;
      renderCube();
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) {
      svg.addEventListener(ev, function () { CUBE.drag = false; });
    });
    $$('polygon', svg).forEach(function (p) {
      p.addEventListener('click', function () {
        const id = Number(p.getAttribute('data-id'));
        const o = (CFG.octants || []).filter(function (x) { return x.id === id; })[0];
        if (!o) return;
        openDrawer({
          title: '卦限 ' + o.name,
          sub: o.bits,
          html: sec('含义', '<div class="dheadline">' + o.meaning + '</div>') +
            sec('资产倾向', '<div class="dact">' + o.assets + '</div>') +
            sec('判定', '<p class="dtext">' + (id === oct.id ? '这是当前所处卦限。' : '不是当前卦限，当前为「' + oct.name + '」。') +
              '三轴方向合成：增长' + (o.bits.indexOf('增长↑') > -1 ? '上行' : '下行') + '、' +
              '通胀' + (o.bits.indexOf('通胀↑') > -1 ? '上行' : '下行') + '、' +
              '流动性' + (o.bits.indexOf('流动性松') > -1 ? '宽松' : '收紧') + '。</p>')
        });
      });
    });
  }

  function renderProj2D(host) {
    const mv = MV(), bits = (mv.octant || {}).bits || {};
    const pairs = [
      { a: 'growth', b: 'inflation', an: '增长', bn: '通胀' },
      { a: 'growth', b: 'liquidity', an: '增长', bn: '流动性' },
      { a: 'inflation', b: 'liquidity', an: '通胀', bn: '流动性' }
    ];
    const cell = function (on, txt) { return '<div class="pjcell' + (on ? ' on' : '') + '">' + txt + '</div>'; };
    host.innerHTML = '<div class="pjgrid">' + pairs.map(function (p) {
      const rows = [1, 0], cols = [0, 1];
      let g = '<div class="pj"><div class="pj-t">' + p.an + ' × ' + p.bn + '</div><div class="pj-m">';
      g += '<div class="pj-h"></div>' + cols.map(function (c) { return '<div class="pj-h">' + (c ? p.bn + '↑' : p.bn + '↓') + '</div>'; }).join('');
      rows.forEach(function (r) {
        g += '<div class="pj-h">' + (r ? p.an + '↑' : p.an + '↓') + '</div>';
        cols.forEach(function (c) {
          g += cell(bits[p.a] === r && bits[p.b] === c, '');
        });
        g += '</div>';
      });
      g += '</div>';
      return g;
    }).join('') + '</div><div class="pj-note">二分位投影，高亮格为当前组合；立体视图不可用时以此替代。</div>';
  }

  function renderOctRead() {
    const mv = MV(), ax = mv.axes || {}, oct = mv.octant || {};
    if (!mv.available) { $('#oct-read').innerHTML = '<div class="pend">卦限数据更新中</div>'; return; }
    const row = function (k, label, val, note) {
      return '<div class="axrow"><div class="axrow-t">' + label + '<span>' + val + '</span></div><p>' + note + '</p></div>';
    };
    $('#oct-read').innerHTML =
      '<div class="octname"><b>' + esc(oct.name) + '</b><span>' + esc(oct.meaning) + '</span></div>' +
      row('g', '增长轴', ax.growth ? ax.growth.label : '待定', esc((ax.growth || {}).note || '')) +
      row('i', '通胀轴', ax.inflation ? ax.inflation.label : '待定', esc((ax.inflation || {}).note || '')) +
      row('l', '流动性轴', ax.liquidity ? ax.liquidity.label : '待定', esc((ax.liquidity || {}).note || '')) +
      '<div class="octasset">资产倾向：' + esc(oct.assets || '—') + '</div>' +
      '<button class="btn ghost mt8" id="oct-more" type="button">看判定规则与近 12 个月轨迹</button>';
    const b = $('#oct-more');
    if (b) b.addEventListener('click', octantDrawer);
  }

  function renderKitchin() {
    const inv = MV().inventory || {};
    const box = $('#kitchin');
    if (!inv.available) { box.innerHTML = '<div class="pend">' + esc(inv.note || '库存周期数据更新中') + '</div>'; return; }
    const stages = CFG.kitchinStages || [];
    box.innerHTML =
      '<div class="kbar">' + stages.map(function (s) {
        const on = s.id === inv.stage_id;
        return '<button class="kstep ' + (s.tone || 'mid') + (on ? ' on' : '') + '" type="button" data-id="' + s.id + '">' +
          '<em>阶段 ' + s.id + '</em><b>' + s.name + '</b>' +
          (on ? '<span class="kmonths">第 ' + inv.months_in + ' 个月</span>' : '<span class="kmonths">需求' + (s.demand === 'up' ? '↑' : '↓') + ' × 库存' + (s.stock === 'up' ? '↑' : '↓') + '</span>') +
          '</button>';
      }).join('<i class="karrow">→</i>') + '</div>' +
      '<div class="kread">' + esc(inv.note || '') + '</div>' +
      '<div class="kfoot">判定：需求（工业增加值同比）× 库存（名义工业增长）两个方向；' +
      (inv.proxy ? '<span class="warn2">库存用名义增长代理，产成品存货同比接口不可得</span>' : '') +
      '　<span class="dsrc">点击阶段看规则</span></div>';

    $$('.kstep', box).forEach(function (b) {
      b.addEventListener('click', function () {
        const s = stages.filter(function (x) { return String(x.id) === b.dataset.id; })[0] || {};
        openDrawer({
          title: '库存周期 · ' + s.name,
          sub: s.id === inv.stage_id ? '当前阶段' : '非当前阶段',
          html: sec('含义', '<div class="dheadline">' + s.mean + '</div>') +
            sec('判定组合', '<div class="dact">需求' + (s.demand === 'up' ? '上行' : '下行') + ' × 库存' + (s.stock === 'up' ? '上行' : '下行') + ' → ' + s.name + '</div>') +
            sec('当前读数', metricsHTML([
              { k: '需求（工业增加值同比）', v: n(inv.value_demand, 1) + '%', n: inv.demand },
              { k: '库存（名义工业增长）', v: n(inv.value_stock, 1) + '%', n: inv.stock }
            ])) +
            noteHTML(esc(inv.rule || ''))
        });
      });
    });
  }

  function renderCycles() {
    const box = $('#cycles');
    const inv = MV().inventory || {};
    const rows = (CFG.cycles || []).map(function (c, i) {
      const pos = c.pos == null ? (inv.available ? (inv.stage_id - 0.5) / 4 : 0.5) : c.pos;
      return '<div class="cycrow"><div class="cyc-n">' + c.n + '<span>' + c.span + '</span></div>' +
        '<div class="cyc-track"><i style="left:' + Math.round(pos * 100) + '%"></i>' +
        ['谷', '升', '顶', '降'].map(function (t, j) { return '<b style="left:' + (j * 28 + 3) + '%">' + t + '</b>'; }).join('') + '</div>' +
        '<div class="cyc-now">' + esc(c.now) + '<span>' + esc(c.note) + '</span></div></div>';
    }).join('');
    box.innerHTML = rows + '<div class="cyc-note">康波 / 库兹涅茨 / 朱格拉为结构性背景，仅作参考，<b>不参与任何结论判定</b>；基钦周期见 2.2。人工复核：' +
      esc(CFG.cyclesUpdated || '—') + '</div>';
  }

  /* ============================================================
     模块 3 政策互动
     ============================================================ */
  function renderPolicy() {
    const p = MV().policy || {};
    const host = $('#pol-chart');
    if (!p.available) {
      host.innerHTML = '<div class="chart-empty">政策强度数据待接入</div>';
      $('#pol-read').innerHTML = '<div class="pend">' + esc(p.note || '') + '</div>';
      return;
    }
    const line = { name: '政策强度', points: (p.series || []).map(function (x) { return [x.m, x.v]; }), color: cssVar('--accent') };
    MC.draw(host, { lines: [line], nd: 2, zero: true, height: Math.max(host.clientHeight || 196, 170) });
    $('#pol-read').innerHTML =
      '<div class="polbig"><b>' + pct(p.percentile) + '</b><span>近 5 年分位</span>' +
      '<em>指数 ' + n(p.index, 2) + (p.asof ? '　·　数据截至 ' + esc(p.asof) : '') + '</em></div>' +
      '<ul class="rule">' + (p.parts || []).map(function (x) {
        return '<li>' + x.k + '：z = ' + x.z + '（权重 ' + x.w + '）　<span class="dsrc">' + esc(x.detail || '') + '</span></li>';
      }).join('') + '</ul>' +
      '<div class="kfoot">' + esc(p.missing || '') + '</div>' +
      '<button class="btn ghost mt8" id="pol-more" type="button">看公式与口径</button>';
    const b = $('#pol-more');
    if (b) b.addEventListener('click', function () {
      openDrawer({
        title: '政策强度指数',
        sub: '分位 ' + pct(p.percentile) + '　指数 ' + n(p.index, 2),
        html: sec('公式', '<div class="dact">' + esc(p.formula) + '</div>') +
          sec('可用成分', metricsHTML((p.parts || []).map(function (x) { return { k: x.k + '（w=' + x.w + '）', v: 'z ' + x.z, n: x.detail }; }))) +
          sec('缺口与处理', '<p class="dtext">' + esc(p.missing) + '</p>' + noteHTML(esc(p.note))) +
          sec('走势', '<div class="chart-body" id="d-chart"></div>'),
        chart: { lines: [line], nd: 2, zero: true, height: 190 }
      });
    });
  }

  function dynVal(kind) {
    const dims = DATA.dims || {};
    const find = function (list, kw) {
      return (list || []).filter(function (x) { return x && String(x.name || '').indexOf(kw) > -1; })[0];
    };
    /* 政策工具箱人工口径：fetch_data.py 把 manual.json 并入 data.manual.items */
    const man = (DATA.manual || {}).items || {};
    if (man[kind] && man[kind].v) return man[kind].v;
    if (kind === 'lpr') {
      const m = find((dims.policy || {}).official, 'LPR');
      return m && !isNil(m.lpr1y) ? Number(m.lpr1y).toFixed(2) + '% / ' + Number(m.lpr5y).toFixed(2) + '%' : null;
    }
    if (kind === 'shibor7') {
      const m = find((dims.liquidity || {}).highfreq, '7天');
      return m && !isNil(m.value) ? Number(m.value).toFixed(2) + '%' : null;
    }
    return null;
  }

  function renderToolbox() {
    const box = $('#toolbox');
    const tb = CFG.toolbox || [];
    const man = (DATA.manual || {}).items || {};
    $('#tool-note').textContent = '复核 ' + ((DATA.manual || {}).updated || CFG.toolboxUpdated || '—') +
      ' · 存准率自动抓取，其余按官方公告更新';
    box.innerHTML = tb.map(function (p) {
      return '<div class="tool ' + (p.tone || 'mid') + '"><div class="tool-h">' + p.pillar + '</div>' +
        p.items.map(function (it) {
          const m = it.dyn ? man[it.dyn] : null;
          const v = it.dyn ? (dynVal(it.dyn) || it.v) : it.v;
          const todo = v.indexOf('待人工更新') > -1;
          const note = (m && m.note) ? m.note : it.note;
          const tip = m ? String((m.src || '') + (m.asof ? ' · ' + m.asof : '')).replace(/"/g, '') : '';
          return '<div class="tool-row"><span class="tk">' + it.k + '</span>' +
            '<b class="' + (todo ? 'todo' : '') + '"' + (tip ? ' title="' + tip + '"' : '') + '>' + v + '</b>' +
            '<span class="tn">' + note + '</span></div>';
        }).join('') + '</div>';
    }).join('');
  }

  function renderCalendar() {
    const box = $('#calendar');
    const now = new Date();
    const list = (CFG.calendar || []).map(function (c) {
      const d = new Date(c.d + 'T00:00:00');
      return { c: c, d: d, days: Math.round((d - now) / 86400000), past: d < now };
    }).sort(function (a, b) { return a.d - b.d; });
    const next = list.filter(function (x) { return !x.past; })[0];
    $('#cal-note').textContent = '排期为惯例区间，以官方公告为准 · 复核 ' + (CFG.calendarUpdated || '—');
    box.innerHTML = (next ? '<div class="calnext"><em>最近事件</em><b>' + next.c.t + '</b><span>' + next.c.d + '（' + next.days + ' 天后）· ' + next.c.note + '</span></div>' : '') +
      '<div class="calgrid">' + list.map(function (x) {
        return '<div class="calrow' + (x.past ? ' past' : '') + '"><span class="cd">' + x.c.d.slice(5) + '</span>' +
          '<span class="ct">' + x.c.t + '</span><span class="cy">' + x.c.type + '</span></div>';
      }).join('') + '</div>';
  }

  function renderChain() {
    const mv = MV(), p = mv.policy || {};
    const last = function (k) { const a = pts(k); return a && a.length ? a[a.length - 1][1] : null; };
    const pmi = last('pmi'), iac = last('credit_cum_yoy');
    const status = [
      p.available ? '强度 ' + pct(p.percentile) + ' 分位' : '待接入',
      iac == null ? '待接入' : '贷款累计同比 ' + n(iac, 1) + '%',
      pmi == null ? '待接入' : 'PMI ' + n(pmi, 1) + '（' + (pmi >= 50 ? '扩张' : '收缩') + '）',
      (mv.erp || {}).available ? 'ERP ' + pct(mv.erp.pctile) + ' 分位' : '待接入'
    ];
    $('#chain').innerHTML = '<div class="chaingrid">' + (CFG.chain || []).map(function (c, i) {
      return '<div class="chainnode"><div class="ch-k">' + c.k + '</div><div class="ch-n">' + c.n + '</div>' +
        '<div class="ch-s">' + status[i] + '</div><div class="ch-d">时滞 ' + c.delay + '</div>' +
        '<p>' + c.read + '</p></div>' + (i < 3 ? '<i class="chainarrow">→</i>' : '');
    }).join('') + '</div><div class="cyc-note">四环节当前状态来自同一套数据；时滞为经验区间（3–6 个月），不是精确预测。</div>';
  }

  /* ============================================================
     模块 4 资产配置
     ============================================================ */
  function renderFactors() {
    const box = $('#factors');
    const fac = MV().factors || [];
    if (!fac.length) { box.innerHTML = '<div class="pend">因子数据待接入</div>'; return; }
    box.innerHTML = fac.map(function (f) {
      if (!f.available) return '<div class="facbox mid"><div class="t">' + f.name + '</div><div class="n">—</div><div class="p">' + f.note + '</div></div>';
      const tone = f.direction === 'up' ? 'up' : f.direction === 'down' ? 'down' : 'flat';
      const w = Math.max(4, Math.round(f.strength * 50));
      return '<button class="facbox ' + tone + '" type="button" data-id="' + f.id + '">' +
        '<div class="t">' + f.name + '<span>' + z2(f.score) + '</span></div>' +
        '<div class="fbar"><i class="' + (f.score > 0 ? 'pos' : 'neg') + '" style="width:' + w + '%"></i></div>' +
        '<div class="p">' + f.read + '</div></button>';
    }).join('');
    $$('.facbox', box).forEach(function (b) {
      if (!b.dataset.id) return;
      b.addEventListener('click', function () {
        const f = fac.filter(function (x) { return x.id === b.dataset.id; })[0];
        openDrawer({
          title: '因子 · ' + f.name,
          sub: '得分 ' + z2(f.score) + '（z 分数，截断 ±2）',
          html: sec('当前读数', '<div class="dheadline">' + f.read + '</div>' +
            '<p class="dtext">强度 ' + pct(f.strength) + '，方向' + (f.direction === 'up' ? '为正' : f.direction === 'down' ? '为负' : '中性') + '。</p>') +
            sec('构造方式', '<div class="dact">' + esc((CFG.factorNote || {})[f.id] || f.construct) + '</div>') +
            sec('口径', stepsHTML([f.construct, '得分＝该合成序列的 60 个月 z 分数，截断到 ±2', '强度＝|得分| / 2', '来源：' + f.src]))
        });
      });
    });
  }

  function renderBudget() {
    const box = $('#budget');
    const fac = {};
    (MV().factors || []).forEach(function (f) { if (f.available) fac[f.id] = f.score; });
    if (!Object.keys(fac).length) { box.innerHTML = '<div class="pend">因子数据待接入</div>'; return; }
    const rows = (CFG.assets || []).map(function (a) {
      const ex = (CFG.exposure || {})[a] || {};
      let num = 0, den = 0;
      for (const k in ex) { if (fac[k] != null) { num += ex[k] * fac[k]; den += Math.abs(ex[k]); } }
      const score = den ? num / den : 0;
      const base = CFG.assetBase[a];
      return { a: a, base: base, score: score, raw: base * Math.pow(2, score) };
    });
    const sum = rows.reduce(function (s, r) { return s + r.raw; }, 0);
    rows.forEach(function (r) { r.w = r.raw / sum * 100; });
    const max = Math.max.apply(null, rows.map(function (r) { return Math.max(r.base, r.w); }));
    box.innerHTML =
      '<div class="budhead"><span class="bk">资产</span><span class="bk">基准</span><span class="bk">调整后</span><span class="bk">偏离</span></div>' +
      rows.map(function (r) {
        const d = r.w - r.base;
        return '<div class="budrow"><span class="ba">' + r.a + '</span>' +
          '<span class="bbar"><i style="width:' + (r.base / max * 100) + '%"></i></span><em>' + r.base + '%</em>' +
          '<span class="bbar alt"><i style="width:' + (r.w / max * 100) + '%"></i></span><b>' + r.w.toFixed(1) + '%</b>' +
          '<span class="bd ' + (d > 0.3 ? 'up' : d < -0.3 ? 'down' : 'flat') + '">' + (d > 0 ? '▲' : d < 0 ? '▼' : '—') + ' ' + Math.abs(d).toFixed(1) + 'pp</span>' +
          '<span class="bs">得分 ' + r.score.toFixed(2) + '</span></div>';
      }).join('') +
      '<div class="kfoot">调整后权重 = 基准 × 2^资产得分，再归一化到 100%；得分 = 六因子得分按资产暴露加权平均。' +
      '<button class="linkbtn" id="bud-more" type="button">看暴露矩阵</button></div>';
    const b = $('#bud-more');
    if (b) b.addEventListener('click', function () {
      const head = '<tr><th style="width:14%">资产</th>' + (MV().factors || []).map(function (f) { return '<th>' + f.name + '</th>'; }).join('') + '<th>得分</th></tr>';
      const body = (CFG.assets || []).map(function (a) {
        const ex = (CFG.exposure || {})[a] || {}, r = rows.filter(function (x) { return x.a === a; })[0];
        return '<tr><td>' + a + '</td>' + (MV().factors || []).map(function (f) { return '<td>' + (ex[f.id] == null ? '—' : ex[f.id]) + '</td>'; }).join('') +
          '<td>' + r.score.toFixed(2) + '</td></tr>';
      }).join('');
      openDrawer({
        title: '风险预算 · 暴露矩阵',
        sub: '乘法规则：w = 基准 × 2^得分',
        html: sec('矩阵', '<div class="table-wrap"><table class="tbl"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>') +
          sec('步骤', stepsHTML([
            '资产得分 = Σ(因子得分 × 暴露权重) ÷ Σ|暴露权重|',
            '调整权重 = 基准权重 × 2^得分',
            '重新归一化到 100%，得到建议权重',
            '趋势保护层：任一资产趋势破位时，应下调该资产权重而非机械执行'
          ])) +
          sec('基准', '<div class="dact">A股 ' + CFG.assetBase['A股'] + '%　利率债 ' + CFG.assetBase['利率债'] + '%　商品 ' + CFG.assetBase['商品'] + '%　黄金 ' + CFG.assetBase['黄金'] + '%</div>') +
          noteHTML('暴露权重为静态配置（config.js），可按研究框架自行调整；本表仅为研究参考，不构成投资建议。')
      });
    });
  }

  function renderStyle() {
    const s = MV().style || {};
    const box = $('#style');
    if (!s.available) { box.innerHTML = '<div class="pend">' + esc(s.note || '风格信号待接入') + '</div>'; return; }
    const tone = (s.score || 0) > 0.2 ? 'up' : (s.score || 0) < -0.2 ? 'down' : 'flat';
    box.innerHTML =
      '<div class="stylehead"><b class="' + tone + '">' + s.label + '</b><em>总分 ' + n(s.score, 2) + '</em>' +
      '<span>' + s.n_available + '/' + s.n_total + ' 个信号可用</span></div>' +
      '<div class="sigrow">' + (s.signals || []).map(function (x) {
        const meta = (window.MACRO_STYLE_META || {})[x.id] || {};
        const cls = !x.available ? 'na' : x.v > 0 ? 'up' : 'down';
        return '<button class="sig ' + cls + '" type="button" data-id="' + x.id + '" title="' + esc(x.detail) + '">' +
          '<i></i>' + (meta.n || x.id) + '</button>';
      }).join('') + '</div>' +
      '<div class="kfoot">' + esc(s.note) + '　<span class="dsrc">点信号看口径</span></div>';
    $$('.sig', box).forEach(function (b) {
      b.addEventListener('click', function () {
        const x = (s.signals || []).filter(function (y) { return y.id === b.dataset.id; })[0];
        const meta = (window.MACRO_STYLE_META || {})[x.id] || {};
        openDrawer({
          title: '风格信号 · ' + (meta.n || x.id),
          sub: (meta.g || '') + '　' + (x.available ? (x.v > 0 ? '指向成长' : '指向价值') : '未接入'),
          html: sec('当前', '<div class="dheadline">' + esc(x.detail) + '</div>') +
            sec('规则', '<div class="dact">' + (meta.rule || '') + '</div>') +
            sec('说明', '<p class="dtext">' + esc(s.rule || '') + '。缺失信号不插补，直接不计入分母。</p>')
        });
      });
    });
  }

  function renderErp() {
    const e = MV().erp || {};
    const box = $('#erp');
    if (!e.available) { box.innerHTML = '<div class="pend">ERP 数据待接入</div>'; return; }
    box.innerHTML = '<div class="erpbig"><b>' + n(e.value, 2) + '%</b><span>近 5 年 ' + pct(e.pctile) + ' 分位</span></div>' +
      '<div class="chart-body" id="erp-chart"></div>' +
      '<div class="kfoot">盈利收益率 − 10 年国债收益率；分位越高，股票相对债券越便宜。</div>';
    const host = $('#erp-chart');
    const line = { name: 'ERP', points: (e.series || []).map(function (x) { return [x.m, x.v]; }), color: cssVar('--accent-2') };
    if (line.points.length) MC.draw(host, { lines: [line], unit: '%', nd: 1, height: 130 });
  }

  function renderTrend() {
    const t = MV().trend || {};
    const box = $('#trend');
    if (!t.available) { box.innerHTML = '<div class="pend">趋势数据待接入</div>'; return; }
    box.innerHTML = (t.rows || []).map(function (r) {
      if (!r.available) return '<div class="trow"><span class="ta">' + r.asset + '</span><span class="tpend">' + (r.note || '月线不足') + '</span></div>';
      const dot = function (k, label) {
        return '<span class="tdot ' + (r.signals[k] === 'up' ? 'ok' : 'bad') + '" title="' + label + '">' + label + '</span>';
      };
      return '<div class="trow"><span class="ta">' + r.asset + '</span>' +
        '<span class="tdots">' + dot('ma', '均线') + dot('macd', 'MACD') + dot('boll', '布林') + '</span>' +
        '<span class="tstate ' + (r.broken ? 'bad' : 'ok') + '">' + (r.broken ? '趋势破位' : '趋势完好') + '</span></div>';
    }).join('') + '<div class="kfoot">' + esc(t.note) + '</div>' +
      '<button class="btn ghost mt8" id="tr-more" type="button">看判定细节</button>';
    const b = $('#tr-more');
    if (b) b.addEventListener('click', function () {
      openDrawer({
        title: '趋势保护',
        sub: '月频三指标，任一破位即警示',
        html: sec('规则', '<div class="dact">' + esc(t.rule) + '</div>') +
          sec('明细', '<div class="table-wrap"><table class="tbl"><thead><tr><th>资产</th><th>收盘</th><th>MA10 / MA30</th><th>MACD</th><th>布林下轨</th><th>结论</th></tr></thead><tbody>' +
            (t.rows || []).map(function (r) {
              if (!r.available) return '<tr><td>' + r.asset + '</td><td colspan="5">' + (r.note || '') + '</td></tr>';
              return '<tr><td>' + r.asset + '</td><td>' + r.close + '</td><td>' + r.ma10 + ' / ' + r.ma30 + '</td>' +
                '<td>' + r.dif + ' / ' + r.dea + '</td><td>' + r.boll_lower + '</td><td>' + (r.broken ? '破位：' + r.broken_parts.join('、') : '完好') + '</td></tr>';
            }).join('') + '</tbody></table></div>') +
          noteHTML(esc(t.note))
      });
    });
  }

  /* ============================================================
     模块 5 行业择时
     ============================================================ */
  function renderEvents() {
    const ind = MV().industry || {};
    const box = $('#evtable');
    if (!ind.available) {
      box.innerHTML = '<tbody><tr><td>行业数据待接入</td></tr></tbody>';
      $('#ev-count').textContent = '';
      return;
    }
    const items = (ind.items || []).filter(function (i) {
      if (!EV_ALL && !(i.events || []).length) return false;
      if (!EV_Q) return true;
      const hay = (i.name + ' ' + (i.events || []).map(function (e) { return e.name; }).join(' ')).toLowerCase();
      return hay.indexOf(EV_Q.toLowerCase()) > -1;
    });
    $('#ev-count').textContent = '显示 ' + items.length + ' / ' + (ind.items || []).length + ' 个行业' +
      (EV_ALL ? '' : '（仅本月触发）') + '　灰底事件＝IR 未达 0.7 或次数 < 8';
    box.innerHTML =
      '<thead><tr><th style="width:12%">行业</th><th style="width:36%">触发事件</th><th style="width:8%">IR</th><th style="width:8%">次数</th><th style="width:18%">拥挤度</th><th>生命周期</th></tr></thead><tbody>' +
      (items.length ? items.map(function (i) {
        const ev = (i.events || []);
        const evTxt = ev.length ? ev.map(function (e) {
          return '<span class="evtag' + (e.effective ? ' ok' : '') + '">' + e.name + '</span>';
        }).join('') : '<span class="dsrc">本月无触发</span>';
        const best = ev.length ? ev.slice().sort(function (a, b) { return (b.ir || -9) - (a.ir || -9); })[0] : null;
        const heat = i.heat_pct;
        const hcls = heat > 0.9 ? 'high' : heat < 0.35 ? 'low' : '';
        return '<tr data-name="' + esc(i.name) + '"><td>' + i.name + '</td><td>' + evTxt + '</td>' +
          '<td class="' + (best && best.ir >= 0.7 ? 'up' : '') + '">' + (best && best.ir != null ? best.ir : '—') + '</td>' +
          '<td>' + (best ? best.n : '—') + '</td>' +
          '<td><div class="hbar"><i class="' + hcls + '" style="width:' + Math.max(3, Math.round((heat || 0) * 100)) + '%"></i></div>' +
          '<span class="hval">' + pct(heat) + '</span></td>' +
          '<td><span class="ltag ' + labCls(i.label) + '">' + i.label + '</span></td></tr>';
      }).join('') : '<tr><td colspan="6" class="chart-empty">没有匹配的行业</td></tr>') + '</tbody>';

    $$('tr[data-name]', box).forEach(function (tr) {
      tr.addEventListener('click', function () {
        const i = (ind.items || []).filter(function (x) { return x.name === tr.dataset.name; })[0];
        industryDrawer(i);
      });
    });
  }

  function labCls(l) {
    return { '高拥挤筑顶': 'hot', '困境反转': 'rev', '超跌反弹': 'reb', '趋势跟踪': 'trd', '弱势整理': 'weak' }[l] || 'weak';
  }

  function industryDrawer(i) {
    if (!i) return;
    const ev = (i.events || []).map(function (e) {
      return '<tr><td>' + e.name + '</td><td>' + (e.group || '') + '</td><td>' + (e.ir == null ? '—' : e.ir) + '</td>' +
        '<td>' + e.n + '</td><td>' + pct(e.win) + '</td><td>' + (e.avg == null ? '—' : e.avg + '%') + '</td>' +
        '<td>' + (e.effective ? '有效' : '未达阈值') + '</td></tr>';
    }).join('');
    openDrawer({
      title: i.name + ' · ' + i.label,
      sub: '申万一级 ' + i.code + '　收盘 ' + i.close,
      html: sec('结论', '<div class="dheadline">' + esc(i.label_why) + '</div>') +
        sec('读数', metricsHTML([
          { k: '20 日动量', v: signed(i.mom20, 1, '%'), n: '短期' },
          { k: '60 日动量', v: signed(i.mom60, 1, '%'), n: '中期' },
          { k: '成交热度', v: pct(i.heat_pct), n: 'MA20 近 3 年分位' },
          { k: '价格分位', v: pct(i.price_pctile), n: '近 3 年（估值代理）' },
          { k: 'PE(TTM)', v: n(i.pe, 1), n: '行业整体' },
          { k: 'PB', v: n(i.pb, 2), n: '行业整体' }
        ])) +
        (ev ? sec('本月触发事件', '<div class="table-wrap"><table class="tbl"><thead><tr><th>事件</th><th>类型</th><th>IR</th><th>次数</th><th>胜率</th><th>20 日均值</th><th>判定</th></tr></thead><tbody>' + ev + '</tbody></table></div>') : sec('本月触发事件', '<p class="dtext">无。该行业本周期的信号来自阶段映射，不来自事件库。</p>')) +
        sec('口径', stepsHTML([
          'IR = 事件后 20 日收益均值 / 标准差 × √(252/20)（年化口径），有效标准 IR ≥ 0.7 且次数 ≥ 8',
          '拥挤度 = 成交额 MA20 的近 3 年分位，> 90% 判高拥挤',
          '价格分位作估值分位代理（行业估值历史序列接口不可得）',
          '数据：申万指数（index_hist_sw）'
        ]))
    });
  }

  function renderStageMap() {
    const box = $('#stagemap');
    if (!industryItems().length) { box.innerHTML = '<div class="pend">行业数据待接入</div>'; return; }
    const sp = industrySplit();
    box.innerHTML = '<div class="stages">' + (CFG.stages || []).map(function (s) {
      const on = s.id === sp.sid;
      const names = [];
      (s.groups || []).forEach(function (g) { ((CFG.indGroups || {})[g] || []).forEach(function (x) { if (names.indexOf(x) < 0) names.push(x); }); });
      return '<div class="stagecell' + (on ? ' on' : '') + '"><div class="sc-h">阶段 ' + s.id + ' · ' + s.name + (on ? '<span class="now">当前</span>' : '') + '</div>' +
        '<div class="sc-note">' + s.note + '</div>' +
        '<div class="sc-chips">' + names.map(function (x) {
          const hit = industryItems().filter(function (i) { return i.name === x; })[0];
          return '<span class="scchip' + (hit && hit.triggered ? ' hit' : '') + '">' + x + '</span>';
        }).join('') + '</div></div>';
    }).join('') + '</div>' +
      '<div class="kfoot">映射：卦限 ' + (MV().octant || {}).id + ' → 阶段 ' + sp.sid + '；库存阶段做边界修正。' +
      '<span class="sclegend"><i></i>带点＝本月有有效事件</span></div>';
  }

  function renderLifecycle() {
    const box = $('#lifecycle');
    const items = industryItems();
    if (!items.length) { box.innerHTML = '<div class="pend">行业数据待接入</div>'; return; }
    const order = ['趋势跟踪', '困境反转', '超跌反弹', '高拥挤筑顶', '弱势整理'];
    const map = {};
    items.forEach(function (i) { (map[i.label] = map[i.label] || []).push(i); });
    box.innerHTML = '<div class="life">' + order.filter(function (k) { return map[k]; }).map(function (k) {
      return '<div class="lifecol ' + labCls(k) + '"><div class="lc-h">' + k + '<em>' + map[k].length + '</em></div>' +
        '<div class="lc-body">' + map[k].map(function (i) {
          return '<button class="lcchip" type="button" data-name="' + esc(i.name) + '">' + i.name + (i.triggered ? '<i class="dot"></i>' : '') + '</button>';
        }).join('') + '</div></div>';
    }).join('') + '</div>' +
      '<div class="kfoot">判定顺序：高拥挤筑顶（热度 > 90%）→ 超跌反弹（20 日 < −8%）→ 困境反转（价格分位 < 20% 且动量转正）→ 趋势跟踪（60 日 > 0）→ 弱势整理。点行业看明细。</div>';
    $$('.lcchip', box).forEach(function (b) {
      b.addEventListener('click', function () {
        industryDrawer(items.filter(function (i) { return i.name === b.dataset.name; })[0]);
      });
    });
  }

  function renderCrowd() {
    const C = (DATA.factors || {}).crowd || {};
    const item = function (k, v, sub) {
      const p = isNil(v) ? 0 : Math.max(2, Math.round(v * 100));
      const cls = p > 65 ? 'high' : p < 35 ? 'low' : '';
      return '<div class="gitem"><em>' + k + '</em><b>' + (isNil(v) ? '—' : p + '%') + '</b>' +
        '<div class="gbar"><i class="' + cls + '" style="width:' + p + '%"></i></div><span>' + sub + '</span></div>';
    };
    $('#crowd').innerHTML = '<div class="gauge">' +
      item('成交额分位（三年）', C.turnover_pctile_3y, 'MA20 成交额分位') +
      item('波动率分位（一年）', C.vol_pctile_1y, '沪深 300 60 日年化') +
      item('成交集中度分位', C.conc_pctile_3y, '沪深 300 占两市成交 ' + (isNil(C.conc_pct) ? '—' : C.conc_pct + '%')) +
      '</div><div class="crowd-read"><b>合成拥挤度 ' + (isNil(C.score) ? '—' : C.score) + '（' + (C.tier || '—') + '）</b>　' + (C.read || '') + '</div>';
  }

  function renderConflicts() {
    const box = $('#conflicts');
    const items = industryItems();
    if (!items.length) { box.innerHTML = '<div class="pend">行业数据待接入</div>'; return; }
    const sp = industrySplit();
    if (!sp.evtOnly.length && !sp.stageOnly.length) { box.innerHTML = '<div class="dtext">本月两套引擎没有分歧行业。</div>'; return; }
    box.innerHTML = '<div class="confgrid">' +
      '<div class="confcol"><div class="cc-h">仅事件库命中<em>' + sp.evtOnly.length + '</em></div>' +
      (sp.evtOnly.length ? sp.evtOnly.map(function (i) {
        return '<div class="confrow"><b>' + i.name + '</b><span>' + (i.events[0] ? i.events[0].name + '（IR ' + i.events[0].ir + '）' : '') + '</span>' +
          '<em>不在当前阶段推荐组</em></div>';
      }).join('') : '<div class="dsrc">无</div>') + '</div>' +
      '<div class="confcol"><div class="cc-h">仅阶段映射命中<em>' + sp.stageOnly.length + '</em></div>' +
      (sp.stageOnly.length ? sp.stageOnly.map(function (i) {
        return '<div class="confrow"><b>' + i.name + '</b><span>' + esc(groupOf(i.name)) + ' · 属「' + stageDef(sp.sid).name + '」推荐组</span>' +
          '<em>无有效事件触发</em></div>';
      }).join('') : '<div class="dsrc">无</div>') + '</div></div>' +
      '<div class="kfoot">分歧处理：按「博弈性行情」思路——基本面弱、叙事强时只做交易性机会，不当作趋势仓位。</div>';
  }

  /* ---------------- 页脚 ---------------- */
  function renderFoot() {
    const srcs = [];
    Object.keys(DATA.dims || {}).forEach(function (k) {
      ['official', 'highfreq'].forEach(function (s) {
        (((DATA.dims || {})[k] || {})[s] || []).forEach(function (x) { if (x && x.src) srcs.push(x.src); });
      });
    });
    const extra = ['申万指数', '东方财富', '上交所', '美国财政部'];
    $('#foot-src').textContent = uniq(srcs.concat(extra)).join('　·　');

    $('#foot-note').innerHTML =
      '序列窗口：日频 250 个交易日、月频 48–84 个月；涨跌颜色遵循 A 股习惯（红涨绿跌），因子与强度的正负不代表涨跌。' +
      '三轴：增长=工业增加值同比 3MA 或 PMI 连续 2 月 > 50；通胀=0.4CPI+0.6PPI 的 3MA；流动性=M1−M2 或 M1−PPI。' +
      '库存：需求=工业增加值方向，库存=名义工业增长方向（产成品存货接口不可得，以量价合成代理）。' +
      'IR 为自算年化口径；行业估值分位以价格分位代理。';

    const pend = [];
    ((MV().industry || {}).missed || []).forEach(function (x) { pend.push('行业未取到：' + x); });
    if ((MV().policy || {}).missing) pend.push('政策指数：' + MV().policy.missing);
    ((MV().style || {}).signals || []).forEach(function (s) {
      if (!s.available) pend.push('风格信号未接入：' + s.id + '（' + s.detail + '）');
    });
    (DATA.errors || []).forEach(function (e) {
      pend.push('<span class="warn">' + Object.keys(e).map(function (k) { return k + '：' + String(e[k]).slice(0, 46); }).join('') + '</span>');
    });
    $('#foot-pending').innerHTML = pend.length ? pend.slice(0, 6).map(function (x) { return '· ' + x; }).join('<br>') : '无';
  }

  /* ---------------- 左侧导航：滚动联动高亮 ---------------- */
  function initRail() {
    const rail = $('#rail');
    if (!rail) return;
    const links = $$('.rnav', rail);
    if (!links.length) return;
    const targets = links.map(function (a) {
      return document.getElementById(String(a.getAttribute('href') || '').slice(1));
    });
    let lock = 0;   // 点击后平滑滚动期间，不让滚动联动把高亮抢回去
    const setOn = function (i) { links.forEach(function (a, j) { a.classList.toggle('on', j === i); }); };
    links.forEach(function (a, i) {
      a.addEventListener('click', function () { setOn(i); lock = Date.now() + 800; });
    });
    const pick = function () {
      if (Date.now() < lock) return;
      if (window.scrollY <= 4) { setOn(0); return; }   // 停在顶部一律算「概览」
      const line = window.innerHeight * 0.34;
      let idx = 0;
      targets.forEach(function (t, i) {
        if (t && t.getBoundingClientRect().top <= line) idx = i;
      });
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 6) idx = links.length - 1;
      setOn(idx);
    };
    let raf = 0;
    window.addEventListener('scroll', function () {
      if (raf) return;
      raf = requestAnimationFrame(function () { raf = 0; pick(); });
    }, { passive: true });
    window.addEventListener('resize', pick);
    pick();
  }

  /* ---------------- 主题 ---------------- */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    $('#btn-theme').textContent = t === 'dark' ? '日间' : '夜间';
    localStorage.setItem('macro-theme', t);
    if (DATA) renderAll();
  }

  function renderAll() {
    if (!DATA) return;
    renderTop();
    renderTopCards();
    renderDims();
    renderCube();
    renderOctRead();
    renderKitchin();
    renderCycles();
    renderPolicy();
    renderToolbox();
    renderCalendar();
    renderChain();
    renderFactors();
    renderBudget();
    renderStyle();
    renderErp();
    renderTrend();
    renderEvents();
    renderStageMap();
    renderLifecycle();
    renderCrowd();
    renderConflicts();
    renderFoot();
  }

  /* ---------------- 轮询 ---------------- */
  const POLL_MS = (function () {
    const q = new URLSearchParams(location.search).get('poll');
    if (q !== null) return Math.max(0, Number(q) || 0) * 1000;
    return 60000;
  })();
  let FP = '';
  let pollTimer = null, pollCount = null, pollNext = 0, pollFails = 0, pollBusy = false;

  function fpOf(d) {
    const p = [d.updated_at || '', (d.asof || {}).trade_date || ''];
    const s = d.series || {};
    Object.keys(s).sort().forEach(function (k) {
      const a = (s[k] || {}).points;
      if (a && a.length) p.push(k + ':' + a.length + ':' + a[a.length - 1][0] + '=' + a[a.length - 1][1]);
    });
    p.push(JSON.stringify((d.macro_v2 || {}).octant || {}));
    p.push(JSON.stringify((d.factors || {}).crowd || {}));
    return p.join('|');
  }
  function changedKeys(a, b) {
    const out = [];
    const sa = a.series || {}, sb = b.series || {};
    Object.keys(sb).forEach(function (k) {
      const x = (sa[k] || {}).points, y = (sb[k] || {}).points;
      if (!y || !y.length) return;
      if (!x || !x.length || x.length !== y.length) { out.push(k); return; }
      const p = x[x.length - 1], q = y[y.length - 1];
      if (String(p[0]) !== String(q[0]) || Number(p[1]) !== Number(q[1])) out.push(k);
    });
    return out;
  }
  function setPollUI(state) {
    const box = $('#poll');
    if (!box) return;
    box.dataset.state = state;
    const b = box.querySelector('b'), em = box.querySelector('em');
    const map = { checking: '检查中', error: '重试中', paused: '已暂停', off: '手动刷新', wait: '自动刷新' };
    if (b) b.textContent = map[state] || '自动刷新';
    if (em && state !== 'wait') em.textContent = '';
  }
  function tickCount() {
    const box = $('#poll');
    if (!box || box.dataset.state !== 'wait' || !pollNext) return;
    const em = box.querySelector('em');
    if (em) em.textContent = Math.max(0, Math.round((pollNext - Date.now()) / 1000)) + 's';
  }
  function schedule() {
    clearTimeout(pollTimer); clearInterval(pollCount);
    if (!POLL_MS) { setPollUI('off'); return; }
    if (document.hidden) { setPollUI('paused'); return; }
    const wait = pollFails ? Math.min(POLL_MS * Math.pow(2, Math.min(pollFails, 3)), 300000) : POLL_MS;
    pollNext = Date.now() + wait;
    setPollUI('wait'); tickCount();
    pollCount = setInterval(tickCount, 1000);
    pollTimer = setTimeout(function () { poll(false); }, wait);
  }
  async function poll(manual) {
    if (pollBusy) return;
    pollBusy = true;
    clearInterval(pollCount);
    setPollUI('checking');
    try {
      const d = await fetchData(!!manual);
      const fp = fpOf(d);
      const first = !DATA;
      if (first || fp !== FP) {
        const changed = first ? [] : changedKeys(DATA, d);
        DATA = d; FP = fp;
        renderAll();
        if (!first) notify(changed);
      }
      pollFails = 0; setPollUI('wait');
    } catch (e) {
      pollFails++; setPollUI('error');
      if (pollFails === 1) toast('自动刷新失败，稍后重试：' + String((e && e.message) || e));
    }
    pollBusy = false;
    schedule();
  }
  function notify(keys) {
    document.body.classList.add('data-pulse');
    setTimeout(function () { document.body.classList.remove('data-pulse'); }, 1500);
    if (!keys.length) return;
    toast('数据已更新：' + keys.slice(0, 4).join('、') + (keys.length > 4 ? ' 等 ' + keys.length + ' 项' : '') +
      '　抓取时间 ' + String(DATA.updated_at || '').slice(5, 16));
  }

  /* ---------------- 手动刷新 ---------------- */
  function applyLive(live) {
    const changed = [];
    Object.keys(live.series || {}).forEach(function (k) {
      const tgt = DATA.series && DATA.series[k];
      const p = live.series[k];
      if (!tgt || !p || !p.length) return;
      const old = tgt.points && tgt.points.length ? tgt.points[tgt.points.length - 1][1] : null;
      tgt.points = p;
      tgt.first = p[0][0]; tgt.last = p[p.length - 1][0]; tgt.n = p.length;
      if (old === null || Math.abs(p[p.length - 1][1] - old) > 1e-9) changed.push(k);
    });
    if (live.date) { DATA.asof = DATA.asof || {}; DATA.asof.trade_date = live.date; }
    FP = fpOf(DATA);
    return Array.from(new Set(changed.map(function (k) {
      return (window.MCLive && window.MCLive.labels && window.MCLive.labels[k]) || k;
    })));
  }

  async function manualRefresh() {
    const b = $('#btn-refresh');
    if (b.disabled) return;
    b.disabled = true; b.textContent = '抓取中…';
    let done = false;
    try {
      let j = {};
      try { j = await (await fetch('api/refresh?force=1', { method: 'POST' })).json(); } catch (e) { j = { status: 'error' }; }
      if (j.status && j.status !== 'error') {
        if (j.status === 'started' || j.status === 'running') {
          toast('已启动抓取，约 2–4 分钟完成，完成后页面自动更新（含行业层）');
          b.textContent = '抓取中'; done = true;
        } else {
          await new Promise(function (r) { setTimeout(r, 900); });
          await poll(true);
          b.textContent = '已更新'; done = true;
        }
      }
    } catch (e) { /* 落到在线兜底 */ }
    if (!done) {
      if (!window.MCLive) { toast('当前环境不支持在线取数'); b.textContent = '静态快照'; }
      else {
        b.textContent = '取行情…';
        try {
          const live = await window.MCLive.fetchLive(DATA.series);
          const names = applyLive(live);
          renderAll();
          b.textContent = '已更新';
          toast(names.length ? '已更新 ' + names.join('、') + ' → ' + live.date.slice(5) : '行情已是最新（' + live.date.slice(5) + '）');
        } catch (e) { b.textContent = '刷新失败'; toast('在线取行情失败：' + String((e && e.message) || e)); }
      }
    }
    setTimeout(function () { b.disabled = false; b.textContent = '刷新数据'; }, 1600);
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    applyTheme(localStorage.getItem('macro-theme') || 'dark');
    $('#btn-theme').addEventListener('click', function () {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });
    $('#btn-refresh').addEventListener('click', manualRefresh);
    $('#scrim').addEventListener('click', closeDrawer);
    $('#d-close').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

    const search = $('#ev-search');
    if (search) search.addEventListener('input', function () { EV_Q = search.value.trim(); renderEvents(); });
    const tog = $('#ev-toggle');
    if (tog) tog.addEventListener('click', function () {
      EV_ALL = !EV_ALL;
      tog.setAttribute('aria-pressed', String(EV_ALL));
      tog.textContent = EV_ALL ? '只看本月触发' : '展开全部行业';
      renderEvents();
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { clearTimeout(pollTimer); clearInterval(pollCount); setPollUI('paused'); }
      else if (POLL_MS) poll(false);
    });

    let rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { if (DATA) { renderCube(); renderPolicy(); renderErp(); } }, 180);
    });

    initRail();
    poll(true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
