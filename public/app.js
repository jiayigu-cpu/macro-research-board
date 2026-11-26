/* ============================================================
   宏观研究看板 · 渲染逻辑
   结构：结论（核心判断 + 结论卡）→ 01 六维指标体系
        → 02 宏观因子 → 03 时序走势
   ============================================================ */
(function () {
  const $ = function (s, r) { return (r || document).querySelector(s); };
  const el = function (t, cls, html) {
    const n = document.createElement(t);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  let DATA = null;
  let FILTER = '全部';

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
  function tone(v) { return isNil(v) ? 'flat' : v > 0 ? 'up' : v < 0 ? 'down' : 'flat'; }
  function uniq(a) { const o = Object.create(null), r = []; a.forEach(function (x) { if (x && !o[x]) { o[x] = 1; r.push(x); } }); return r; }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'; }

  /* ---------------- 序列 ---------------- */
  function pts(k) { const s = (DATA.series || {})[k]; return s && s.points ? s.points : null; }
  function freqOf(k) { const s = (DATA.series || {})[k]; return s ? s.freq : 'D'; }

  /* ---------------- 数据加载 ---------------- */
  // 首次加载破缓存；轮询走协商缓存（服务端带 ETag，命中即 304），避免反复拉整包
  let DATA_SRC = null;   // 'api' | 'static'，探测一次后固定
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
      } catch (e) { /* 静态托管时没有 api，回退到快照 */ }
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

  /* ---------------- 顶栏 ---------------- */
  function renderTop() {
    const a = DATA.asof || {};
    $('#asof').textContent = a.trade_date || (DATA.updated_at || '').slice(0, 10);
    $('#upd').textContent = (DATA.updated_at || '').slice(5, 16);
  }

  /* ---------------- 核心判断 ---------------- */
  function renderVerdict() {
    const v = DATA.verdict || {};
    const tn = v.tone || 'mid';
    const chips = (v.chips || []).map(function (c) {
      return '<span class="vchip ' + (c.tone || 'mid') + '"><em>' + c.k + '</em><b>' + c.v + '</b></span>';
    }).join('');
    $('#verdict').innerHTML =
      '<div class="verdict ' + tn + '">' +
      '<div class="vtag">核心判断 · 宏观 × 量化</div>' +
      '<h1>' + (v.headline || '数据加载中') + '</h1>' +
      '<p>' + (v.advice || '') + '</p>' +
      '<div class="vchips">' + chips + '</div>' +
      '<div class="hero-art fx" aria-hidden="true"><svg viewBox="0 0 640 170">' +
        '<path class="ln" d="M34 38 L104 16 L172 50 M104 16 L232 30"/>' +
        '<path class="ln2" d="M0 132 C40 128 70 104 110 108 C150 112 180 96 220 88 C270 78 300 98 340 74 C380 50 420 66 460 50 C510 32 560 44 620 22"/>' +
        '<circle class="ring" cx="104" cy="16" r="13"/>' +
        '<circle class="ring" cx="620" cy="22" r="10"/>' +
        '<circle class="nd" cx="34" cy="38" r="2"/>' +
        '<circle class="nd" cx="104" cy="16" r="2.6"/>' +
        '<circle class="nd" cx="172" cy="50" r="2"/>' +
        '<circle class="nd" cx="232" cy="30" r="1.8"/>' +
        '<circle class="nd" cx="620" cy="22" r="3"/>' +
        '<path class="ln" d="M524 118 h12 M530 112 v12"/>' +
        '</svg></div>' +
      '</div>';
  }

  /* ---------------- 结论卡 ---------------- */
  function renderCards() {
    const box = $('#cards');
    box.innerHTML = '';
    (DATA.cards || []).forEach(function (c, i) {
      const card = el('article', 'card');
      card.tabIndex = 0;
      const ms = (c.metrics || []).map(function (m) {
        return '<div class="cm"><em>' + m.k + '</em><b>' + m.v + '</b><i>' + (m.n || '') + '</i></div>';
      }).join('');
      card.innerHTML =
        '<div class="card-top"><h3>' + c.title + '</h3>' +
        '<span class="badge ' + (c.tone || 'mid') + '">' + c.badge + '</span></div>' +
        '<div class="card-head">' + (c.headline || '') + '</div>' +
        '<p class="card-text">' + (c.text || '') + '</p>' +
        '<div class="card-metrics">' + ms + '</div>' +
        '<div class="card-action">' + (c.action || '') + '</div>' +
        '<div class="card-more">详情 ↗</div>';
      card.addEventListener('click', function () { openDrawer(c); });
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(c); }
      });
      box.appendChild(card);
    });
  }

  /* ---------------- 抽屉 ---------------- */
  function openDrawer(c) {
    $('#d-title').textContent = c.title;
    $('#d-sub').textContent = '结论：' + c.badge;
    const ms = (c.metrics || []).map(function (m) {
      return '<div class="dm"><em>' + m.k + '</em><b>' + m.v + '</b><i>' + (m.n || '') + '</i></div>';
    }).join('');
    const steps = (c.steps || []).map(function (s) { return '<li>' + s + '</li>'; }).join('');
    $('#d-body').innerHTML =
      '<div class="dsec"><div class="dsec-t">判断</div>' +
      '<div class="dheadline">' + (c.headline || '') + '</div>' +
      '<p class="dtext">' + (c.text || '') + '</p></div>' +
      '<div class="dsec"><div class="dsec-t">关键取值</div><div class="dmetrics">' + ms + '</div></div>' +
      '<div class="dsec"><div class="dsec-t">计算逻辑</div><ol class="dsteps">' + steps + '</ol></div>' +
      '<div class="dsec"><div class="dsec-t">配置含义</div><div class="dact">' + (c.action || '') + '</div></div>' +
      '<div class="dsec"><div class="dsec-t">数据来源</div><div class="dsrc">' + (c.src || '') + '</div></div>';
    $('#drawer').classList.add('on');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $('#scrim').classList.add('on');
  }
  function closeDrawer() {
    $('#drawer').classList.remove('on');
    $('#drawer').setAttribute('aria-hidden', 'true');
    $('#scrim').classList.remove('on');
  }

  /* ---------------- 六维指标 ---------------- */
  const DIMS = [
    { k: 'growth', name: '增长', en: 'GROWTH' },
    { k: 'inflation', name: '通胀', en: 'INFLATION' },
    { k: 'liquidity', name: '流动性', en: 'LIQUIDITY' },
    { k: 'fiscal', name: '财政', en: 'FISCAL' },
    { k: 'external', name: '外部', en: 'EXTERNAL' },
    { k: 'policy', name: '政策', en: 'POLICY' }
  ];

  function metricVal(m) {
    const nm = String(m.name || '');
    if (!isNil(m.m1) || !isNil(m.m2)) {
      return 'M1 <b>' + n(m.m1, 1) + '</b> / <b>' + n(m.m2, 1) + '</b>%';
    }
    if (!isNil(m.lpr1y)) {
      return '<b>' + Number(m.lpr1y).toFixed(2) + '</b> / <b>' + Number(m.lpr5y).toFixed(2) + '</b>%';
    }
    if (!isNil(m.fx_yi_usd)) {
      return '<b>' + smart(m.fx_yi_usd) + '</b> 亿美元' +
        (isNil(m.gold_wan_oz) ? '' : '<small>黄金 ' + smart(m.gold_wan_oz) + '（央行口径）</small>');
    }
    if (!isNil(m.us10y)) {
      return '<b>' + n(m.us10y, 2) + '</b>% <small>中美利差 ' + n(m.cnus10, 2) + 'pp</small>';
    }
    if (nm.indexOf('财政收入') === 0) {
      return '<b>' + smart(m.value) + '</b> 亿元' +
        (isNil(m.cum_yoy) ? '' : '<small>累计同比 ' + n(m.cum_yoy, 1) + '%</small>');
    }
    return '<b>' + smart(m.value) + '</b>' + (m.unit === '%' ? '%' : (m.unit ? ' ' + m.unit : ''));
  }

  function metricRow(m) {
    if (!m) return '';
    if (m.pending) return '<div class="pend">' + m.note + '</div>';
    const nm = String(m.name || '');
    const hasVal = !isNil(m.value) || !isNil(m.m1) || !isNil(m.lpr1y) || !isNil(m.fx_yi_usd) || !isNil(m.us10y);
    if (!hasVal) {
      return '<div class="mrow"><span class="mn">' + nm + '</span>' +
        '<span class="mv" style="font-size:11px;font-weight:400;color:var(--muted)">未取到</span></div>';
    }
    const sub = [m.date, m.read].filter(Boolean).join(' · ');
    const stale = m.stale ? '<span class="stale-tag">陈旧</span>' : '';
    let bar = '';
    if (!isNil(m.pctile_1y)) {
      const p = Math.max(2, Math.round(m.pctile_1y * 100));
      bar = '<div class="bar"><i class="' + (p > 65 ? 'high' : p < 35 ? 'low' : '') + '" style="width:' + p + '%"></i></div>';
    }
    return '<div class="mrow"><span class="mn">' + nm + stale + '</span>' +
      '<span class="mv">' + metricVal(m) + (sub ? '<small>' + sub + '</small>' : '') + '</span></div>' + bar;
  }

  function renderDims() {
    const dims = DATA.dims || {};

    // 顶部总览条
    const strip = $('#dimstrip');
    strip.innerHTML = DIMS.map(function (d) {
      const g = dims[d.k] || {};
      const st = g.state || {};
      return '<div class="dchip ' + (st.tone || 'mid') + '">' +
        '<em>' + d.name + '</em><b>' + (st.label || '待定') + '</b>' +
        '<span>' + (st.note || '—') + '</span></div>';
    }).join('');

    // 六维明细（每维两栏：正式 / 高频）
    const box = $('#dims');
    box.innerHTML = '';
    DIMS.forEach(function (d) {
      const g = dims[d.k] || {};
      const st = g.state || {};
      const col = function (list, title, hint) {
        const items = (list || []).filter(Boolean);
        const body = items.length ? items.map(metricRow).join('') : '<div class="pend">本栏数据待接入</div>';
        return '<div class="dcol"><div class="dcol-t">' + title + '<span>' + hint + '</span></div>' + body + '</div>';
      };
      const card = el('div', 'dim');
      card.innerHTML =
        '<div class="dim-head"><b>' + d.name + '<em>' + d.en + '</em></b>' +
        '<span class="dim-state ' + (st.tone || 'mid') + '">' + (st.label || '待定') + '</span></div>' +
        '<div class="dim-cols">' +
        col(g.official, '正式数据', '低频 · 权威') +
        col(g.highfreq, '高频数据', '领先 · 可验证') +
        '</div>';
      box.appendChild(card);
    });
  }

  /* ---------------- 四象限 ---------------- */
  const QN = {
    'up|up': '过热', 'up|high': '过热', 'up|rec': '复苏', 'up|down': '复苏初期',
    'slow|up': '滞胀初期', 'slow|high': '滞胀', 'slow|rec': '复苏验证期', 'slow|down': '弱平衡',
    'rec|up': '复苏前夜', 'rec|high': '类滞胀', 'rec|rec': '磨底', 'rec|down': '衰退后期',
    'down|up': '滞胀', 'down|high': '滞胀', 'down|rec': '衰退', 'down|down': '衰退'
  };
  const GCOLS = [
    { k: 'up', n: '扩张加速' }, { k: 'slow', n: '扩张放缓' },
    { k: 'rec', n: '收缩改善' }, { k: 'down', n: '收缩加深' }
  ];
  const IROWS = [
    { k: 'up', n: '通胀上行' }, { k: 'high', n: '通胀高位' },
    { k: 'rec', n: '通胀修复' }, { k: 'down', n: '通胀低迷' }
  ];
  const QFAMILY = {
    '滞胀': '滞胀', '滞胀初期': '滞胀', '类滞胀': '滞胀',
    '衰退': '衰退', '衰退后期': '衰退',
    '复苏': '复苏', '复苏初期': '复苏', '复苏前夜': '复苏', '复苏验证期': '复苏',
    '过热': '过热'
  };
  const TIMING = [
    { q: '复苏', g: '增长上行', i: '通胀温和回升', f: '动量 / 周期 / 小盘', a: '股票 > 商品 > 债券', av: '长久期债券' },
    { q: '过热', g: '增长上行', i: '通胀上行', f: '价值 / 商品 Carry / 短久期', a: '商品、资源、银行', av: '成长、长久期' },
    { q: '滞胀', g: '增长下行', i: '通胀上行', f: 'Carry（商品）/ Defensive / 低波', a: '黄金、能源、现金', av: '成长、久期、动量' },
    { q: '衰退', g: '增长下行', i: '通胀低迷', f: '低波 / 质量 / 长久期债', a: '国债、红利、公用事业', av: '小盘、周期、高杠杆' }
  ];

  function renderQuad() {
    const q = (DATA.factors || {}).quadrant || {};
    let html = '<div class="qwrap"><div class="qmatrix"><div class="qh"></div>' +
      GCOLS.map(function (g) { return '<div class="qh">' + g.n + '</div>'; }).join('');
    IROWS.forEach(function (r) {
      html += '<div class="ql">' + r.n + '</div>';
      GCOLS.forEach(function (g) {
        const on = (g.k === q.growth_state && r.k === q.infl_state);
        html += '<div class="qcell' + (on ? ' on' : '') + '">' + (QN[g.k + '|' + r.k] || '—') + '</div>';
      });
    });
    html += '</div></div>';
    html += '<div class="qlegend">' +
      '<span>增长 <b>' + (q.growth_txt || '待定') + '</b></span>' +
      '<span>通胀 <b>' + (q.infl_txt || '待定') + '</b></span>' +
      '<span>当前 <b class="k-up">' + (q.quadrant || '待定') + '</b></span></div>' +
      '<p class="qadvice">' + (q.advice || '') + '</p>';
    $('#quad').innerHTML = html;

    // 象限 → 风格映射表
    const fam = QFAMILY[q.quadrant] || '';
    $('#timing').innerHTML =
      '<thead><tr><th style="width:9%">象限</th><th style="width:16%">宏观特征</th>' +
      '<th style="width:22%">占优风格因子</th><th style="width:26%">占优资产</th><th>规避</th></tr></thead><tbody>' +
      TIMING.map(function (r) {
        const on = r.q === fam ? ' class="on"' : '';
        return '<tr' + on + '><td>' + r.q + '</td><td>' + r.g + ' × ' + r.i + '</td>' +
          '<td>' + r.f + '</td><td>' + r.a + '</td><td>' + r.av + '</td></tr>';
      }).join('') + '</tbody>';

    drawQPath();
  }

  /* 象限迁移散点（增长 z 横轴，通胀 z 纵轴） */
  function drawQPath() {
    const host = $('#qpath');
    const g = pts('quad_g'), i = pts('quad_i');
    if (!g || !i || g.length < 4) {
      host.innerHTML = '<div class="chart-empty">轨迹数据待接入</div>';
      return;
    }
    const map = {};
    g.forEach(function (p) { map[p[0]] = map[p[0]] || {}; map[p[0]].g = Number(p[1]); });
    i.forEach(function (p) { map[p[0]] = map[p[0]] || {}; map[p[0]].i = Number(p[1]); });
    const list = Object.keys(map).filter(function (k) { return map[k].g != null && map[k].i != null; })
      .sort().map(function (k) { return { k: k, g: map[k].g, i: map[k].i }; });
    if (list.length < 4) { host.innerHTML = '<div class="chart-empty">轨迹数据待接入</div>'; return; }

    host.innerHTML = '';
    const W = Math.max(host.clientWidth || 420, 260);
    const H = Math.max(host.clientHeight || 224, 200);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('class', 'chart-svg');
    host.appendChild(svg);
    const mk = function (tag, at) {
      const e = document.createElementNS(NS, tag);
      for (const k in at) e.setAttribute(k, at[k]);
      svg.appendChild(e);
      return e;
    };

    const pad = { l: 30, r: 16, t: 14, b: 24 };
    let lo1 = Math.min.apply(null, list.map(function (p) { return p.g; }));
    let hi1 = Math.max.apply(null, list.map(function (p) { return p.g; }));
    let lo2 = Math.min.apply(null, list.map(function (p) { return p.i; }));
    let hi2 = Math.max.apply(null, list.map(function (p) { return p.i; }));
    const ext = function (a, b) { const s = Math.max(b - a, .8); return [a - s * .18, b + s * .18]; };
    const rx = ext(Math.min(lo1, -0.2), Math.max(hi1, 0.2));
    const ry = ext(Math.min(lo2, -0.2), Math.max(hi2, 0.2));
    const x = function (v) { return pad.l + (v - rx[0]) / (rx[1] - rx[0]) * (W - pad.l - pad.r); };
    const y = function (v) { return pad.t + (1 - (v - ry[0]) / (ry[1] - ry[0])) * (H - pad.t - pad.b); };

    // 象限底色（复苏/过热偏暖，滞胀/衰退偏冷）
    const x0 = x(0), y0 = y(0);
    const box = function (x1, y1, x2, y2, color, op) {
      mk('rect', { x: x1, y: y1, width: Math.max(x2 - x1, 0), height: Math.max(y2 - y1, 0), fill: color, opacity: op });
    };
    box(x0, y0, W - pad.r, H - pad.b, cssVar('--up'), .04);     // 右下 复苏
    box(x0, pad.t, W - pad.r, y0, cssVar('--alt'), .035);         // 右上 过热
    box(pad.l, pad.t, x0, y0, cssVar('--down'), .035);            // 左上 滞胀
    box(pad.l, y0, x0, H - pad.b, cssVar('--down'), .028);        // 左下 衰退

    // 零轴
    mk('line', { x1: pad.l, x2: W - pad.r, y1: y0, y2: y0, stroke: cssVar('--line-2'), 'stroke-width': 1, 'stroke-dasharray': '3 3' });
    mk('line', { x1: x0, x2: x0, y1: pad.t, y2: H - pad.b, stroke: cssVar('--line-2'), 'stroke-width': 1, 'stroke-dasharray': '3 3' });

    // 象限标签
    const lab = [
      { t: '过热', cx: W - pad.r, cy: pad.t + 12, a: 'end' },
      { t: '滞胀', cx: pad.l + 2, cy: pad.t + 12, a: 'start' },
      { t: '复苏', cx: W - pad.r, cy: H - pad.b - 4, a: 'end' },
      { t: '衰退', cx: pad.l + 2, cy: H - pad.b - 4, a: 'start' }
    ];
    lab.forEach(function (l) {
      const t = mk('text', { x: l.cx, y: l.cy, 'text-anchor': l.a, fill: cssVar('--muted'), 'font-size': 9.5 });
      t.textContent = l.t;
    });
    // 轴名
    const ax = mk('text', { x: W - pad.r, y: y0 - 6, 'text-anchor': 'end', fill: cssVar('--muted'), 'font-size': 9 });
    ax.textContent = '增长 z →';
    const ay = mk('text', { x: x0 + 4, y: pad.t + 2, fill: cssVar('--muted'), 'font-size': 9 });
    ay.textContent = '↑ 通胀 z';

    // 轨迹
    let d = '';
    list.forEach(function (p, k) { d += (k ? 'L' : 'M') + x(p.g).toFixed(1) + ' ' + y(p.i).toFixed(1) + ' '; });
    mk('path', { d: d, fill: 'none', stroke: cssVar('--alt'), 'stroke-width': 1.1, opacity: .45, 'stroke-dasharray': '3 3' });

    // 点（越近越亮）
    list.forEach(function (p, k) {
      const w = k / (list.length - 1);
      mk('circle', { cx: x(p.g), cy: y(p.i), r: 2.4 + w * 1.2, fill: cssVar('--alt'), opacity: .22 + w * .6 });
    });
    const last = list[list.length - 1];
    mk('circle', { cx: x(last.g), cy: y(last.i), r: 5.4, fill: cssVar('--up') });
    mk('circle', { cx: x(last.g), cy: y(last.i), r: 10, fill: cssVar('--up'), opacity: .16 });
    const lt = mk('text', {
      x: Math.min(x(last.g) + 12, W - pad.r - 2), y: Math.max(y(last.i) - 8, pad.t + 10),
      'text-anchor': 'end', fill: cssVar('--ink'), 'font-size': 10.5
    });
    lt.textContent = last.k + '  (' + last.g.toFixed(2) + ', ' + last.i.toFixed(2) + ')';
  }

  /* ---------------- 流动性映射 ---------------- */
  function renderLiq() {
    const L = (DATA.factors || {}).liq_map || {};
    const keys = [
      { k: 'M1 − M2 剪刀差', v: (isNil(L.scissors) ? '—' : L.scissors + 'pp'), s: 'M1 ' + n(L.m1, 1) + '% / M2 ' + n(L.m2, 1) + '%' },
      { k: '剩余流动性 ①', v: (isNil(L.surplus_m1_ppi) ? '—' : L.surplus_m1_ppi), s: 'M1 − PPI' },
      { k: '剩余流动性 ②', v: (isNil(L.surplus_m2_gdp) ? '—' : L.surplus_m2_gdp), s: 'M2 − 名义 GDP' },
      { k: '全 A 中位 PE', v: (isNil(L.all_a_pe_pctile_10y) ? '—' : Math.round(L.all_a_pe_pctile_10y * 100) + '% 分位'), s: '近 10 年' }
    ];
    $('#liq-read').innerHTML =
      '<div class="kv">' + keys.map(function (x) {
        const v = parseFloat(x.v);
        const tn = isNil(x.v) ? 'mid' : (v > 0 ? 'pos' : v < 0 ? 'neg' : 'mid');
        const cls = x.k.indexOf('PE') > -1 ? 'mid' : tn;
        return '<div class="kvbox ' + cls + '"><em>' + x.k + '</em><b>' + x.v + '</b><span>' + x.s + '</span></div>';
      }).join('') + '</div>' +
      '<ul class="rule">' + (L.logic || []).map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ul>';

    const host = $('#liq-chart');
    const lines = [];
    if (pts('scissors')) lines.push({ name: 'M1−M2 剪刀差', points: pts('scissors'), color: cssVar('--up'), area: false });
    if (pts('surplus_m1ppi')) lines.push({ name: '剩余流动性 M1−PPI', points: pts('surplus_m1ppi'), color: cssVar('--alt'), area: false });
    if (pts('surplus_m2gdp')) lines.push({ name: '剩余流动性 M2−GDP', points: pts('surplus_m2gdp'), color: cssVar('--down'), area: false });
    if (!lines.length) { host.innerHTML = '<div class="chart-empty">序列待接入</div>'; return; }
    MC.draw(host, { lines: lines, unit: 'pp', nd: 1, zero: true, height: Math.max(host.clientHeight || 196, 170) });
  }

  /* ---------------- 拥挤度 ---------------- */
  function renderCrowd() {
    const C = (DATA.factors || {}).crowd || {};
    const item = function (k, v, sub, hint) {
      const p = isNil(v) ? 0 : Math.max(2, Math.round(v * 100));
      const cls = p > 65 ? 'high' : p < 35 ? 'low' : '';
      return '<div class="gitem"><em>' + k + '</em><b>' + (isNil(v) ? '—' : p + '%') + '</b>' +
        '<div class="gbar"><i class="' + cls + '" style="width:' + p + '%"></i></div>' +
        '<span>' + sub + '</span></div>';
    };
    const score = C.score;
    $('#crowd').innerHTML =
      '<div class="gauge">' +
      item('成交额分位（三年）', C.turnover_pctile_3y, 'MA20 成交额分位') +
      item('波动率分位（一年）', C.vol_pctile_1y, '沪深 300 60 日年化') +
      item('成交集中度分位', C.conc_pctile_3y, '沪深 300 占两市成交 ' + (isNil(C.conc_pct) ? '—' : C.conc_pct + '%')) +
      '</div>' +
      '<div class="crowd-read"><b>合成拥挤度 ' + (isNil(score) ? '—' : score) + '（' + (C.tier || '—') + '）</b>　' +
      (C.read || '') + '</div>';
  }

  /* ---------------- AQR ---------------- */
  const AQRMAP = [
    { f: 'Carry', d: '套息 / 展期收益', p: '国债 10Y−1Y、商品近远月价差、股息率', up: '曲线陡、高息货币与商品', dn: '曲线平、负套息资产' },
    { f: 'Value', d: '估值偏离', p: 'ERP、股债性价比、PB 分位', up: '低估值的周期与金融', dn: '高估值成长、拥挤赛道' },
    { f: 'Momentum', d: '时序动量', p: '12−1 月收益、趋势强度', up: '延续趋势的资产', dn: '反转与破位资产' },
    { f: 'Defensive', d: '防御', p: '低波动、低 Beta、低拥挤', up: '低波红利、短久期', dn: '高 Beta、高拥挤' }
  ];

  function renderAqr() {
    const a = (DATA.factors || {}).aqr || {};
    const order = ['value', 'momentum', 'carry', 'defensive'];
    const box = $('#aqr');
    if (!order.some(function (k) { return a[k]; })) {
      box.innerHTML = '<div class="panel"><div class="pend">因子数据待接入</div></div>';
    } else {
      box.innerHTML = '<div class="aqrgrid">' + order.map(function (k) {
        const x = a[k];
        if (!x) return '';
        const isPct = x.unit === '%';
        const col = isPct ? (x.value > 0 ? 'var(--up)' : 'var(--down)')
          : (x.value >= 60 ? 'var(--up)' : x.value <= 40 ? 'var(--down)' : 'var(--alt)');
        return '<div class="aqr-box"><div class="t">' + x.name + '<span>' + x.full + '</span></div>' +
          '<div class="n" style="color:' + col + '">' + n(x.value, isPct ? 2 : 1) +
          '<small>' + (isPct ? '%' : '分位') + '</small></div>' +
          '<div class="p">' + x.proxy + '</div>' +
          '<span class="s">' + x.signal + '</span></div>';
      }).join('') + '</div>';
    }

    $('#aqr-table').innerHTML =
      '<thead><tr><th style="width:13%">因子</th><th style="width:16%">含义</th>' +
      '<th style="width:30%">代理构造</th><th style="width:20%">做多信号</th><th>做空信号</th></tr></thead><tbody>' +
      AQRMAP.map(function (r) {
        return '<tr><td>' + r.f + '</td><td>' + r.d + '</td><td>' + r.p + '</td><td>' + r.up + '</td><td>' + r.dn + '</td></tr>';
      }).join('') + '</tbody>';
  }

  /* ---------------- 因子总表 ---------------- */
  function renderTable() {
    const rows = (DATA.factors || {}).factor_table || [];
    $('#ftable').innerHTML =
      '<thead><tr><th style="width:11%">因子</th><th style="width:26%">构造方式</th>' +
      '<th style="width:17%">受益资产</th><th>当前读数</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td>' + r.factor + '</td><td>' + r.construct + '</td><td>' + r.assets + '</td><td>' + r.reading + '</td></tr>';
      }).join('') + '</tbody>';
  }

  /* ---------------- 走势图 ---------------- */
  const CHARTS = [
    { g: '增长', t: '制造业 / 非制造业 PMI', nd: 1, refs: [{ v: 50, n: '荣枯线' }],
      lines: [{ k: 'pmi', n: '制造业' }, { k: 'pmi_non', n: '非制造业', area: false }] },
    { g: '增长', t: '工业增加值同比', nd: 1, unit: '%',
      lines: [{ k: 'iav', n: '当月同比' }, { k: 'iav_cum', n: '累计同比', area: false }] },
    { g: '增长', t: '螺纹钢主力连续', nd: 0, unit: ' 元/吨', chg: 'pct',
      lines: [{ k: 'rb', n: '收盘' }, { k: 'rb_ma60', n: 'MA60', area: false, dash: '4 3' }] },
    { g: '增长', t: '增长 / 通胀 z 分数', nd: 2, zero: true,
      lines: [{ k: 'quad_g', n: '增长 z' }, { k: 'quad_i', n: '通胀 z', area: false }] },

    { g: '通胀', t: 'CPI / PPI 同比', nd: 1, unit: '%',
      lines: [{ k: 'cpi', n: 'CPI' }, { k: 'ppi', n: 'PPI', area: false }] },
    { g: '通胀', t: 'CPI 环比', nd: 1, unit: '%', zero: true, lines: [{ k: 'cpi_mom', n: '环比' }] },
    { g: '通胀', t: 'INE 原油主力', nd: 0, unit: ' 元/桶', chg: 'pct', lines: [{ k: 'sc', n: '收盘价' }] },

    { g: '流动性', t: 'M1 / M2 同比', nd: 1, unit: '%',
      lines: [{ k: 'm1', n: 'M1' }, { k: 'm2', n: 'M2', area: false }] },
    { g: '流动性', t: 'M1 − M2 剪刀差', nd: 1, unit: 'pp', zero: true, lines: [{ k: 'scissors', n: '剪刀差' }] },
    { g: '流动性', t: '剩余流动性 M1 − PPI', nd: 1, unit: 'pp', zero: true, lines: [{ k: 'surplus_m1ppi', n: 'M1−PPI' }] },
    { g: '流动性', t: '剩余流动性 M2 − 名义 GDP', nd: 1, unit: 'pp', zero: true, lines: [{ k: 'surplus_m2gdp', n: 'M2−GDP' }] },
    { g: '流动性', t: '新增人民币贷款', nd: 0, unit: ' 亿元', lines: [{ k: 'credit_inc', n: '当月新增' }] },
    { g: '流动性', t: 'SHIBOR 隔夜 / 7 天', nd: 2, unit: '%',
      lines: [{ k: 'shibor_on', n: '隔夜' }, { k: 'shibor_7d', n: '7 天', area: false }] },

    { g: '财政', t: '财政收入（当月）', nd: 0, unit: ' 亿元',
      lines: [{ k: 'fiscal_rev', n: '当月' }] },
    { g: '财政', t: '财政收入累计同比', nd: 1, unit: '%', zero: true,
      lines: [{ k: 'fiscal_cum_yoy', n: '累计同比' }] },

    { g: '外部', t: 'USD / CNY 中间价', nd: 4, chg: 'pct', lines: [{ k: 'usdcny', n: '中间价' }] },
    { g: '外部', t: '美国 10Y 国债收益率', nd: 2, unit: '%', lines: [{ k: 'us10y', n: '美债 10Y' }] },
    { g: '外部', t: '中美 10Y 利差', nd: 2, unit: 'pp', zero: true, lines: [{ k: 'cnus10', n: '中债 − 美债' }] },
    { g: '外部', t: '外汇储备', nd: 0, unit: ' 亿美元', chg: 'pct', lines: [{ k: 'fxres', n: '外储' }] },
    { g: '外部', t: '黄金储备（央行口径）', nd: 0, chg: 'pct', lines: [{ k: 'gold', n: '黄金' }] },

    { g: '政策', t: 'LPR 1Y / 5Y', nd: 2, unit: '%', step: true,
      lines: [{ k: 'lpr1y', n: '1Y', area: false }, { k: 'lpr5y', n: '5Y', area: false }] },
    { g: '政策', t: '国债收益率 10Y / 1Y', nd: 2, unit: '%',
      lines: [{ k: 'y10', n: '10Y' }, { k: 'y1', n: '1Y', area: false }] },
    { g: '政策', t: '期限利差 10Y − 1Y', nd: 2, unit: 'pp', zero: true, lines: [{ k: 'slope', n: '利差' }] },
    { g: '政策', t: '3Y 中短票 AAA − 国债利差', nd: 2, unit: 'pp', lines: [{ k: 'cspread', n: '信用利差' }] },

    { g: '市场', t: '沪深 300 与 60 日均线', nd: 0, chg: 'pct',
      lines: [{ k: 'hs300', n: '收盘' }, { k: 'hs300_ma60', n: 'MA60', area: false, dash: '4 3' }] },
    { g: '市场', t: '沪深 300 PE (TTM)', nd: 1, unit: ' 倍', chg: 'pct', lines: [{ k: 'pe300', n: 'PE' }] },
    { g: '市场', t: '股权风险溢价 ERP', nd: 2, unit: '%', lines: [{ k: 'erp', n: 'ERP' }] },
    { g: '市场', t: '两市成交额', nd: 0, unit: ' 亿元', chg: 'pct',
      lines: [{ k: 'amount', n: '成交额' }, { k: 'amount_ma20', n: 'MA20', area: false, dash: '4 3' }] },
    { g: '市场', t: '沪深 300 60 日年化波动率', nd: 1, unit: '%', lines: [{ k: 'vol60', n: '波动率' }] },
    { g: '市场', t: '沪深 300 成交额占比', nd: 1, unit: '%', lines: [{ k: 'concentration', n: '占比' }] }
  ];

  function renderChips() {
    const box = $('#chips');
    const groups = ['全部'].concat(uniq(CHARTS.map(function (c) { return c.g; })));
    // 已建过就只同步选中态，避免轮询刷新时按钮被重建而闪烁
    if (box.children.length === groups.length) {
      Array.prototype.forEach.call(box.children, function (c) {
        c.setAttribute('aria-pressed', String(c.textContent === FILTER));
      });
      return;
    }
    box.innerHTML = '';
    groups.forEach(function (g) {
      const b = el('button', 'chip', g);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(g === FILTER));
      b.addEventListener('click', function () {
        FILTER = g;
        Array.prototype.forEach.call(box.children, function (c) {
          c.setAttribute('aria-pressed', String(c.textContent === g));
        });
        applyFilter();
      });
      box.appendChild(b);
    });
  }

  function applyFilter() {
    Array.prototype.forEach.call(document.querySelectorAll('.chart-card'), function (c) {
      c.hidden = FILTER !== '全部' && c.dataset.group !== FILTER;
    });
    drawVisible();
  }

  function buildCharts() {
    const box = $('#charts');
    // 已有同一套卡片时只重画不重建，保住图表的旧图层，刷新才能做淡入淡出
    if (box.children.length === CHARTS.length) { drawVisible(); return; }
    box.innerHTML = '';
    CHARTS.forEach(function (def, i) {
      const have = def.lines.some(function (l) { return pts(l.k); });
      const card = el('div', 'chart-card');
      card.dataset.group = def.g;
      card.dataset.idx = i;
      card.innerHTML = '<div class="chart-head"><div class="chart-name">' + def.t +
        '<span>' + def.g + ' · ' + (freqOf(def.lines[0].k) === 'M' ? '月度' : freqOf(def.lines[0].k) === 'Q' ? '季度' : '日频') +
        '</span></div><div class="chart-chg flat"></div></div><div class="chart-body"></div>';
      if (!have) card.querySelector('.chart-body').innerHTML = '<div class="chart-empty">序列数据待接入</div>';
      box.appendChild(card);
    });
    drawVisible();
  }

  function chgText(def) {
    const p = pts(def.lines[0].k);
    if (!p || p.length < 2) return { t: '', c: 'flat' };
    const a = Number(p[0][1]), b = Number(p[p.length - 1][1]);
    const d = b - a;
    const c = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
    let t;
    if (def.chg === 'pct' && a) {
      t = (d > 0 ? '+' : '') + (d / Math.abs(a) * 100).toFixed(1) + '%';
    } else if (Math.abs(d) >= 10000) {
      t = (d > 0 ? '+' : '') + (d / 10000).toFixed(2) + ' 万亿';
    } else {
      t = signed(d, Math.abs(d) < 10 ? 2 : 0, def.unit ? def.unit.trim() : '');
    }
    return { t: t, c: c };
  }

  function drawOne(card) {
    const def = CHARTS[Number(card.dataset.idx)];
    const body = card.querySelector('.chart-body');
    if (!body || !body.clientWidth) return;
    const lines = [];
    def.lines.forEach(function (l, i) {
      const p = pts(l.k);
      if (!p) return;
      lines.push({
        name: l.n, points: p,
        color: i === 0 ? cssVar('--up') : (i === 1 ? cssVar('--down') : cssVar('--alt')),
        area: l.area !== false, dash: l.dash
      });
    });
    if (!lines.length) return;
    MC.draw(body, {
      lines: lines, unit: def.unit || '', nd: def.nd,
      zero: !!def.zero, step: !!def.step, refs: def.refs, height: 134
    });
    const ch = chgText(def);
    const node = card.querySelector('.chart-chg');
    node.textContent = ch.t;
    node.className = 'chart-chg ' + ch.c;
    let lg = card.querySelector('.chart-legend');
    if (!lg) { lg = el('div', 'chart-legend'); card.appendChild(lg); }
    let legend = lines.map(function (l) {
      return '<span><i style="background:' + l.color + (l.dash ? ';opacity:.7' : '') + '"></i>' + l.name + '</span>';
    }).join('');
    (def.refs || []).forEach(function (r) {
      legend += '<span><i class="ref"></i>' + r.n + ' ' + r.v + '</span>';
    });
    lg.innerHTML = legend;
  }

  function drawVisible() {
    Array.prototype.forEach.call(document.querySelectorAll('.chart-card'), function (c) {
      if (!c.hidden) drawOne(c);
    });
  }

  /* ---------------- 页脚 ---------------- */
  function renderFoot() {
    const srcs = [];
    Object.keys(DATA.dims || {}).forEach(function (k) {
      const g = DATA.dims[k];
      ['official', 'highfreq'].forEach(function (s) {
        (g[s] || []).forEach(function (x) { if (x && x.src) srcs.push(x.src); });
      });
    });
    $('#foot-src').textContent = uniq(srcs).join('　·　') || 'akshare 公开接口';

    $('#foot-note').innerHTML =
      '序列窗口：日频 250 个交易日、月频 48–60 个月、季频 16 个季度；涨跌颜色遵循 A 股习惯（红涨绿跌）。' +
      '增长 / 通胀 z 分数为 36 个月滚动标准化后取均值；剩余流动性①＝M1 同比−PPI 同比，②＝M2 同比−名义 GDP 同比；' +
      'ERP 以当前 10Y 国债平移近似历史序列，保留形态与分位；社融以「新增人民币贷款」代理；拥挤度＝成交额分位 60%＋波动率分位 40%，成交集中度作二阶确认。';

    const pend = [];
    Object.keys(DATA.dims || {}).forEach(function (k) {
      const g = DATA.dims[k];
      ['official', 'highfreq'].forEach(function (s) {
        (g[s] || []).forEach(function (x) {
          if (x && x.pending) pend.push(x.note.split('；')[0]);
        });
      });
    });
    const errs = (DATA.errors || []).map(function (e) {
      return '<span class="warn">' + Object.keys(e).map(function (k) { return k + '：' + String(e[k]).slice(0, 40); }).join('') + '</span>';
    });
    const list = uniq(pend).slice(0, 4).concat(errs);
    $('#foot-pending').innerHTML = list.length ? list.map(function (x) { return '· ' + x; }).join('<br>') : '无';
  }

  /* ---------------- 主题 ---------------- */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    $('#btn-theme').textContent = t === 'dark' ? '日间' : '夜间';
    localStorage.setItem('macro-theme', t);
    if (DATA) { renderVerdict(); renderCards(); renderDims(); renderQuad(); renderLiq(); renderCrowd(); renderAqr(); renderTable(); drawVisible(); renderFoot(); }
  }

  function renderAll() {
    renderTop();
    renderVerdict();
    renderCards();
    renderDims();
    renderQuad();
    renderLiq();
    renderCrowd();
    renderAqr();
    renderTable();
    renderChips();
    buildCharts();
    renderFoot();
  }

  /* ---------------- 轮询（Polling） ----------------
     用 setTimeout 串联而不是 setInterval：上一次请求结束后才开始计时，
     慢网络下不会堆积请求；页面隐藏时暂停，回到前台立即补一次。 */
  const POLL_MS = (function () {
    const q = new URLSearchParams(location.search).get('poll');
    if (q !== null) return Math.max(0, Number(q) || 0) * 1000;
    return 60000;
  })();

  let FP = '';
  let pollTimer = null, pollCount = null, pollNext = 0, pollFails = 0, pollBusy = false;

  // 数据指纹：抓取时间 + 每条序列的长度与末点，任一变化即视为有新数据
  function fpOf(d) {
    const p = [d.updated_at || '', (d.asof || {}).trade_date || ''];
    const s = d.series || {};
    Object.keys(s).sort().forEach(function (k) {
      const a = (s[k] || {}).points;
      if (a && a.length) p.push(k + ':' + a.length + ':' + a[a.length - 1][0] + '=' + a[a.length - 1][1]);
    });
    const f = d.factors || {};
    p.push(JSON.stringify(f.crowd || {}), JSON.stringify(f.aqr || {}), (d.verdict || {}).headline || '');
    return p.join('|');
  }

  function changedKeys(a, b) {
    const out = [];
    const sa = a.series || {}, sb = b.series || {};
    Object.keys(sb).forEach(function (k) {
      const x = (sa[k] || {}).points, y = (sb[k] || {}).points;
      if (!y || !y.length) return;
      if (!x || !x.length) { out.push(k); return; }
      if (x.length !== y.length) { out.push(k); return; }
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

  // 可观测计数：便于排查轮询是否在跑、命中几次更新（不参与渲染）
  function bump(name) {
    const box = $('#poll');
    if (box) box.dataset[name] = String((Number(box.dataset[name]) || 0) + 1);
  }

  function tickCount() {
    const box = $('#poll');
    if (!box || box.dataset.state !== 'wait' || !pollNext) return;
    const em = box.querySelector('em');
    if (em) em.textContent = Math.max(0, Math.round((pollNext - Date.now()) / 1000)) + 's';
  }

  function schedule() {
    clearTimeout(pollTimer);
    clearInterval(pollCount);
    if (!POLL_MS) { setPollUI('off'); return; }
    if (document.hidden) { setPollUI('paused'); return; }
    const wait = pollFails ? Math.min(POLL_MS * Math.pow(2, Math.min(pollFails, 3)), 300000) : POLL_MS;
    pollNext = Date.now() + wait;
    setPollUI('wait');
    tickCount();
    pollCount = setInterval(tickCount, 1000);
    pollTimer = setTimeout(function () { poll(false); }, wait);
  }

  async function poll(manual) {
    if (pollBusy) return;
    pollBusy = true;
    clearInterval(pollCount);
    bump('checks');
    setPollUI('checking');
    try {
      const d = await fetchData(!!manual);
      const fp = fpOf(d);
      const first = !DATA;
      if (first || fp !== FP) {
        const changed = first ? [] : changedKeys(DATA, d);
        DATA = d;
        FP = fp;
        renderAll();
        if (!first) { bump('updates'); notify(changed); }
      }
      pollFails = 0;
      setPollUI('wait');
    } catch (e) {
      pollFails++;
      setPollUI('error');
      if (pollFails === 1) toast('自动刷新失败，稍后重试：' + String((e && e.message) || e));
    }
    pollBusy = false;
    schedule();
  }

  // 有变化才提示：列出受影响的走势图，其余部分静默
  function notify(keys) {
    const map = Object.create(null);
    CHARTS.forEach(function (d) {
      d.lines.forEach(function (l) { (map[l.k] = map[l.k] || []).push(d.t); });
    });
    const names = [];
    keys.forEach(function (k) {
      (map[k] || []).forEach(function (t) { if (names.indexOf(t) < 0) names.push(t); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.chart-card'), function (c) {
      const def = CHARTS[Number(c.dataset.idx)];
      if (!def) return;
      if (def.lines.some(function (l) { return keys.indexOf(l.k) > -1; })) {
        c.classList.add('is-updated');
        setTimeout(function () { c.classList.remove('is-updated'); }, 2400);
      }
    });
    document.body.classList.add('data-pulse');
    setTimeout(function () { document.body.classList.remove('data-pulse'); }, 1500);
    toast('数据已更新：' + (names.slice(0, 3).join('、') || '结论与因子读数') +
      (names.length > 3 ? ' 等 ' + names.length + ' 项' : '') +
      '　抓取时间 ' + String(DATA.updated_at || '').slice(5, 16));
  }

  /* ---------------- 手动刷新 ---------------- */
  // 把在线行情合并进当前数据。只替换点位与首末日期，保留原 unit / freq / nd，
  // 因此图表格式不会因为数据来源变化而错乱。
  function applyLive(live) {
    const changed = [];
    Object.keys(live.series || {}).forEach(function (k) {
      const tgt = DATA.series && DATA.series[k];
      const pts = live.series[k];
      if (!tgt || !pts || !pts.length) return;
      const old = tgt.points && tgt.points.length ? tgt.points[tgt.points.length - 1][1] : null;
      const now = pts[pts.length - 1][1];
      tgt.points = pts;
      tgt.first = pts[0][0];
      tgt.last = pts[pts.length - 1][0];
      tgt.n = pts.length;
      if (old === null || Math.abs(now - old) > 1e-9) changed.push(k);
    });
    if (live.date) {
      DATA.asof = DATA.asof || {};
      DATA.asof.trade_date = live.date;
    }
    // 同步指纹，避免下一轮轮询把这次手动更新误判成「服务端来了新数据」
    FP = fpOf(DATA);
    return Array.from(new Set(changed.map(function (k) {
      return (window.MCLive && window.MCLive.labels && window.MCLive.labels[k]) || k;
    })));
  }

  async function manualRefresh() {
    const b = $('#btn-refresh');
    if (b.disabled) return;
    b.disabled = true;
    b.textContent = '抓取中…';
    let done = false;

    // 1) 先试服务端全量抓取：本机跑 Node 且装了 akshare 时走这条，能抓到全部 43 条
    try {
      let j = {};
      try {
        j = await (await fetch('api/refresh?force=1', { method: 'POST' })).json();
      } catch (e) { j = { status: 'error' }; }
      if (j.status && j.status !== 'error') {
        if (j.status === 'started') {
          // Python 抓全量要 1–2 分钟，不能只等 900ms 就去读；交给轮询接管
          toast('已启动抓取，约 1–2 分钟完成，完成后页面自动更新');
          b.textContent = '抓取中';
          done = true;
        } else if (j.status === 'running') {
          toast('已有抓取任务在执行，稍后自动更新');
          b.textContent = '抓取中';
          done = true;
        } else {
          await new Promise(function (r) { setTimeout(r, 900); });
          await poll(true);
          b.textContent = '已更新';
          done = true;
        }
      }
    } catch (e) { /* 静默落到在线兜底 */ }

    // 2) 服务端不可用（线上无 Python）时，改由浏览器直连公开行情接口
    if (!done) {
      if (!window.MCLive) {
        toast('当前环境不支持在线取数');
        b.textContent = '静态快照';
      } else {
        b.textContent = '取行情…';
        try {
          const prevAsOf = (DATA.asof || {}).trade_date || '';
          const live = await window.MCLive.fetchLive(DATA.series);
          const names = applyLive(live);
          renderAll();
          b.textContent = '已更新';
          const d = new Date();
          const hhmm = d.getHours() * 100 + d.getMinutes();
          const intraday = live.date === [d.getFullYear(), ('0' + (d.getMonth() + 1)).slice(-2), ('0' + d.getDate()).slice(-2)].join('-') && hhmm >= 930 && hhmm < 1500;
          const when = live.date.slice(5) + (intraday ? ' 盘中' : '');
          const miss = (live.failed && live.failed.length) ? '（' + live.failed.join('、') + ' 未取到）' : '';
          if (names.length) {
            toast('已更新 ' + names.join('、') + ' → ' + when + miss +
              '　宏观月度与利率仍为 ' + (prevAsOf ? prevAsOf.slice(5) : '快照') + ' 快照');
          } else {
            toast('行情已是最新（' + when + '），无变化' + miss);
          }
        } catch (e) {
          b.textContent = '刷新失败';
          toast('在线取行情失败：' + String((e && e.message) || e));
        }
      }
    }

    setTimeout(function () { b.disabled = false; b.textContent = '刷新数据'; }, 1600);
  }

  function init() {
    applyTheme(localStorage.getItem('macro-theme') || 'dark');

    $('#btn-theme').addEventListener('click', function () {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });

    $('#btn-refresh').addEventListener('click', manualRefresh);

    $('#scrim').addEventListener('click', closeDrawer);
    $('#d-close').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
    });

    // 切到后台就停掉计时器，回来立刻补一次，兼顾省电与新鲜度
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        clearTimeout(pollTimer);
        clearInterval(pollCount);
        setPollUI('paused');
      } else if (POLL_MS) {
        poll(false);
      }
    });

    let rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { drawVisible(); drawQPath(); renderLiq(); }, 160);
    });

    poll(true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
