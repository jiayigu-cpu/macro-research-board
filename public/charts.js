/* ============================================================
   极简 SVG 走势图引擎（无依赖）
   - 多序列、面积渐变、零轴参考、阶梯线
   - 十字准星 + 悬浮提示
   ============================================================ */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  let uid = 0;

  function mk(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function css(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  function fmtNum(v, nd) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    const a = Math.abs(v);
    if (a >= 100000) return (v / 10000).toFixed(0) + '万';
    if (a >= 10000) return (v / 10000).toFixed(1) + '万';
    let s = Number(v).toFixed(nd == null ? 2 : nd);
    if (s.indexOf('.') > -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }

  function fmtAxis(v, nd) {
    const d = nd == null ? 2 : nd;
    let s = Number(v).toFixed(d);
    const parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  function tickLabel(label) {
    const s = String(label);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(5);
    if (/^\d{4}-\d{2}$/.test(s)) return s.slice(2).replace('-', '/');
    return s;
  }

  function pathFor(vals, x, y, step) {
    let d = '', started = false;
    vals.forEach(function (v, i) {
      if (v === null || v === undefined || isNaN(v)) { started = false; return; }
      const px = x(i).toFixed(2), py = y(v).toFixed(2);
      if (!started) { d += 'M' + px + ' ' + py + ' '; started = true; }
      else if (step) { d += 'H' + px + ' V' + py + ' '; }
      else { d += 'L' + px + ' ' + py + ' '; }
    });
    return d;
  }

  /* ---------------- 图层双缓冲 ----------------
     轮询刷新时不清空旧图，而是把新图叠在上层淡入、旧层淡出，
     避免 innerHTML 清空造成的一帧空白（等价于 ECharts setOption 的过渡）。 */
  function newLayer(host) {
    if (!host.classList.contains('mc-host')) host.classList.add('mc-host');
    let olds = Array.prototype.slice.call(host.querySelectorAll('.mc-layer'));
    // 防御：正常情况下最多只该有一层旧图。若出现堆积（例如页面处于
    // 后台、requestAnimationFrame 被浏览器暂停而未回收），先清掉多余层，
    // 否则反复刷新会让 DOM 里的图层无限增长。
    if (olds.length > 1) {
      olds.slice(0, olds.length - 1).forEach(function (o) {
        if (o.parentNode) o.parentNode.removeChild(o);
      });
      olds = olds.slice(-1);
    }
    const layer = document.createElement('div');
    layer.className = 'mc-layer';
    host.appendChild(layer);
    return { layer: layer, olds: olds };
  }

  function commitLayer(t) {
    if (!t.olds.length) { t.layer.style.opacity = '1'; return; }
    t.layer.style.opacity = '0';
    // 强制一次布局刷新，让 0 → 1 的过渡真正发生。
    // 不用 requestAnimationFrame：页面在后台时它会被暂停，
    // 旧层就永远回收不掉（刷几次后 DOM 里会堆满图层）。
    void t.layer.offsetWidth;
    t.layer.style.opacity = '1';
    t.olds.forEach(function (o) {
      o.style.opacity = '0';
      setTimeout(function () { if (o.parentNode) o.parentNode.removeChild(o); }, 320);
    });
  }

  /* ---------------- 主图 ---------------- */
  function draw(host, cfg) {
    const t = newLayer(host);
    const layer = t.layer;
    const W = Math.max(host.clientWidth || 320, 220);
    const H = cfg.height || 132;
    const pad = { l: 44, r: 10, t: 12, b: 20 };
    const svg = mk('svg', {
      width: W, height: H, viewBox: '0 0 ' + W + ' ' + H,
      class: 'chart-svg', preserveAspectRatio: 'none'
    }, layer);

    // ---- x 轴标签集合 ----
    const labels = [];
    const seen = Object.create(null);
    cfg.lines.forEach(function (l) {
      (l.points || []).forEach(function (p) {
        const k = String(p[0]);
        if (!seen[k]) { seen[k] = 1; labels.push(k); }
      });
    });
    labels.sort();
    const idx = Object.create(null);
    labels.forEach(function (l, i) { idx[l] = i; });

    const vals = [];
    const series = cfg.lines.map(function (l) {
      const arr = labels.map(function (lb) { return null; });
      (l.points || []).forEach(function (p) {
        const i = idx[String(p[0])];
        if (i !== undefined) arr[i] = Number(p[1]);
      });
      arr.forEach(function (v) { if (v !== null && !isNaN(v)) vals.push(v); });
      return { name: l.name, vals: arr, color: l.color, area: l.area !== false, dash: l.dash };
    });
    if (!vals.length) {
      if (layer.parentNode) layer.parentNode.removeChild(layer);
      if (!host.querySelector('.chart-empty')) {
        const e = document.createElement('div');
        e.className = 'chart-empty';
        e.textContent = '暂无序列数据';
        host.appendChild(e);
      }
      return;
    }

    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi === lo) { hi = lo + Math.abs(lo || 1) * 0.05; lo = lo - Math.abs(lo || 1) * 0.05; }
    const span = hi - lo;
    const rawLo = lo, rawHi = hi;
    lo -= span * 0.12; hi += span * 0.12;
    if (cfg.zero) {
      if (rawLo >= 0 && lo < 0) lo = 0;
      if (rawHi <= 0 && hi > 0) hi = 0;
    }
    const n = labels.length;
    const x = function (i) { return pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r)); };
    const y = function (v) { return pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b); };

    const gGrid = mk('g', null, svg);
    // ---- y 网格与刻度 ----
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = lo + (hi - lo) * (i / ticks);
      const py = y(v);
      mk('line', {
        x1: pad.l, x2: W - pad.r, y1: py, y2: py,
        stroke: css('--grid', 'rgba(255,255,255,.05)'), 'stroke-width': 1,
        'shape-rendering': 'crispEdges'
      }, gGrid);
      const t = mk('text', {
        x: pad.l - 8, y: py + 3.4, 'text-anchor': 'end',
        class: 'axis-y'
      }, gGrid);
      t.textContent = fmtAxis(v, cfg.nd != null ? cfg.nd : 2);
    }

    // ---- 零轴 ----
    if (cfg.zero && lo < 0 && hi > 0) {
      mk('line', {
        x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0),
        stroke: css('--line2', 'rgba(255,255,255,.2)'), 'stroke-width': 1,
        'stroke-dasharray': '3 3'
      }, svg);
    }

    // ---- 面积与折线 ----
    series.forEach(function (s, si) {
      if (s.area) {
        let baseV = lo;
        if (cfg.zero && rawLo < 0 && rawHi > 0) baseV = 0;
        const baseY = y(baseV);
        let d = '';
        let cur = null;
        s.vals.forEach(function (v, i) {
          if (v === null) { return; }
          const px = x(i).toFixed(2), py = y(v).toFixed(2);
          if (cur === null) { d += 'M' + px + ' ' + py + ' '; }
          else if (cfg.step) { d += 'H' + px + ' V' + py + ' '; }
          else { d += 'L' + px + ' ' + py + ' '; }
          cur = i;
        });
        if (cur !== null) {
          const firstX = x(0).toFixed(2), lastX = x(cur).toFixed(2);
          d += 'L' + lastX + ' ' + baseY.toFixed(2) + ' L' + firstX + ' ' + baseY.toFixed(2) + ' Z';
          const gid = 'grad' + (++uid);
          const defs = mk('defs', null, svg);
          const lg = mk('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
          mk('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': si === 0 ? 0.16 : 0.07 }, lg);
          mk('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': 0 }, lg);
          mk('path', { d: d, fill: 'url(#' + gid + ')', stroke: 'none' }, svg);
        }
      }
      const p = mk('path', {
        d: pathFor(s.vals, x, y, cfg.step), fill: 'none',
        stroke: s.color, 'stroke-width': si === 0 ? 1.8 : 1.3,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        'stroke-dasharray': s.dash || null,
        opacity: si === 0 ? 1 : 0.9
      }, svg);
      if (si === 0) p.setAttribute('class', 'line-main');
    });

    // ---- 参考线 ----
    if (cfg.refs && cfg.refs.length) {
      cfg.refs.forEach(function (r) {
        if (r.v < lo || r.v > hi) return;
        const py = y(r.v);
        mk('line', {
          x1: pad.l, x2: W - pad.r, y1: py, y2: py,
          stroke: css('--muted', '#7d8797'), 'stroke-width': 1,
          'stroke-dasharray': '5 4', opacity: 0.5
        }, svg);
      });
    }

    // ---- x 轴标签 ----
    const gx = mk('g', null, svg);
    const picks = n > 2 ? [0, Math.floor((n - 1) / 2), n - 1] : [0, n - 1];
    picks.forEach(function (i, k) {
      const t = mk('text', {
        x: x(i), y: H - 5,
        'text-anchor': k === 0 ? 'start' : (k === picks.length - 1 ? 'end' : 'middle'),
        class: 'axis-x'
      }, gx);
      t.textContent = tickLabel(labels[i]);
    });

    // ---- 末点标记 ----
    series.forEach(function (s, si) {
      if (si > 0) return;
      for (let i = s.vals.length - 1; i >= 0; i--) {
        if (s.vals[i] !== null) {
          mk('circle', { cx: x(i), cy: y(s.vals[i]), r: 3.2, fill: s.color, class: 'end-dot' }, svg);
          mk('circle', { cx: x(i), cy: y(s.vals[i]), r: 6.5, fill: s.color, opacity: 0.16 }, svg);
          break;
        }
      }
    });

    // ---- 悬浮交互 ----
    const hover = mk('g', { class: 'hover-layer', opacity: 0 }, svg);
    const vline = mk('line', {
      y1: pad.t, y2: H - pad.b, stroke: css('--ink2', '#999'),
      'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.55
    }, hover);
    const dots = series.map(function (s) {
      return mk('circle', { r: 3, fill: s.color, stroke: css('--panel', '#000'), 'stroke-width': 1.2 }, hover);
    });
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    layer.appendChild(tip);

    const rect = mk('rect', {
      x: pad.l, y: 0, width: Math.max(W - pad.l - pad.r, 1), height: H,
      fill: 'transparent', style: 'cursor:crosshair'
    }, svg);

    function show(evt) {
      const box = svg.getBoundingClientRect();
      const mx = evt.clientX - box.left;
      const i = Math.max(0, Math.min(n - 1, Math.round((mx - pad.l) / Math.max(W - pad.l - pad.r, 1) * (n - 1))));
      const px = x(i);
      vline.setAttribute('x1', px); vline.setAttribute('x2', px);
      hover.setAttribute('opacity', 1);
      let rows = '', any = false;
      series.forEach(function (s, si) {
        const v = s.vals[i];
        if (v === null) { dots[si].setAttribute('opacity', 0); return; }
        any = true;
        dots[si].setAttribute('opacity', 1);
        dots[si].setAttribute('cx', px);
        dots[si].setAttribute('cy', y(v));
        rows += '<div class="tip-row"><i style="background:' + s.color + '"></i><span>' + s.name +
          '</span><b>' + fmtNum(v, cfg.nd != null ? cfg.nd : 2) + (cfg.unit || '') + '</b></div>';
      });
      if (!any) { hover.setAttribute('opacity', 0); tip.style.opacity = 0; return; }
      tip.innerHTML = '<div class="tip-date">' + labels[i] + '</div>' + rows;
      tip.style.opacity = 1;
      const tw = tip.offsetWidth || 120;
      let left = px + 12;
      if (left + tw > W - 4) left = px - tw - 12;
      tip.style.left = Math.max(4, left) + 'px';
      tip.style.top = Math.max(6, (evt.clientY - box.top) - 10) + 'px';
    }

    rect.addEventListener('mousemove', show);
    rect.addEventListener('mouseleave', function () {
      hover.setAttribute('opacity', 0); tip.style.opacity = 0;
    });

    commitLayer(t);
  }

  /* ---------------- 迷你走势带 ---------------- */
  function spark(host, points, color, up) {
    host.innerHTML = '';
    if (!points || points.length < 3) return;
    const W = host.clientWidth || 90, H = host.clientHeight || 28;
    const svg = mk('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none' }, host);
    const vals = points.map(function (p) { return Number(p[1]); });
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi === lo) { hi += 1; lo -= 1; }
    const x = function (i) { return (i / (vals.length - 1)) * W; };
    const y = function (v) { return H - 3 - ((v - lo) / (hi - lo)) * (H - 6); };
    let d = '';
    vals.forEach(function (v, i) { d += (i ? 'L' : 'M') + x(i).toFixed(2) + ' ' + y(v).toFixed(2) + ' '; });
    const gid = 'sp' + (++uid);
    const defs = mk('defs', null, svg);
    const lg = mk('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    mk('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.18 }, lg);
    mk('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }, lg);
    mk('path', {
      d: d + 'L' + W.toFixed(2) + ' ' + H + ' L0 ' + H + ' Z', fill: 'url(#' + gid + ')', stroke: 'none'
    }, svg);
    mk('path', { d: d, fill: 'none', stroke: color, 'stroke-width': 1.4, 'stroke-linejoin': 'round' }, svg);
    mk('circle', { cx: x(vals.length - 1), cy: y(vals[vals.length - 1]), r: 2.2, fill: color }, svg);
  }

  window.MC = { draw: draw, spark: spark, fmtNum: fmtNum };
})();
