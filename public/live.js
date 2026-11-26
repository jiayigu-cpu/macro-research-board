/* ------------------------------------------------------------------
 * 在线行情刷新
 *
 * 线上部署没有 Python / akshare，服务端的「刷新数据」必然失败。
 * 这里绕过 Python，由浏览器直连公开行情接口（均带 CORS，无需代理与 key）。
 *
 * 数据源是两条，原因是稳定性不同：
 *   指数 —— 腾讯 fqkline，250 根完整日 K，与 fetch_data.py 同源
 *           （首根 2025-11-14 收 4628.14、末根与东财完全一致）
 *   期货 —— 东财 push2his 日 K；该域名实测会返回 ERR_EMPTY_RESPONSE，
 *           失败时降级为 push2 的实时报价，追加到快照序列末尾
 *
 * 只更新「高频行情」：沪深 300、螺纹钢、原油，以及由沪深 300 派生的
 * 60 日均线与 60 日年化波动率。派生口径已逐条与 fetch_data.py 对齐验证
 * （11-25 收盘 3898.24 / MA60 4262.97 / vol60 13.82 全部精确复现）。
 *
 * 成交额与集中度不纳入：它们用的是另一套数据源，量级对不上
 * （东财 13831 亿 vs 快照 10301 亿），替换会让图上出现无解释的台阶。
 * 宏观月度数据一个月才变一次，由快照承载已足够。
 *
 * 三个标的分别请求、互不牵连：任一失败只丢掉对应的图，不会整体报错。
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  var KEEP = 250;
  var MAX_TRY = 3;
  var TX = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=';
  var EM_K = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
  var EM_Q = 'https://push2.eastmoney.com/api/qt/ulist.np/get';

  function getJSON(url, attempt) {
    attempt = attempt || 1;
    return fetch(url, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .catch(function (e) {
        if (attempt >= MAX_TRY) throw e;
        return new Promise(function (res) { setTimeout(res, 280 * attempt); })
          .then(function () { return getJSON(url, attempt + 1); });
      });
  }

  /* 腾讯日 K：数组结构 [日期, 开, 收, 高, 低, 量]，收盘取索引 2 */
  function tencentKline(sym) {
    return getJSON(TX + sym + ',day,,,' + (KEEP + 90) + ',').then(function (j) {
      var d = j && j.data && j.data[sym];
      var arr = (d && (d.day || d.qfqday)) || [];
      if (!arr.length) throw new Error('腾讯接口未返回序列');
      return arr.map(function (r) { return { d: r[0], c: Number(r[2]) }; });
    });
  }

  /* 东财日 K：klines 为 "日期,收盘,量,额" 逗号串 */
  function emKline(secid) {
    var u = EM_K + '?secid=' + secid + '&klt=101&fqt=0&lmt=' + (KEEP + 90) +
      '&end=20500101&fields1=f1,f2,f3&fields2=f51,f53,f56,f57';
    return getJSON(u).then(function (j) {
      var ks = (j && j.data && j.data.klines) || [];
      if (!ks.length) throw new Error('东财接口未返回序列');
      return ks.map(function (s) { var p = s.split(','); return { d: p[0], c: Number(p[1]) }; });
    });
  }

  /* 东财实时报价：f1 为小数位，f2 为放大后的价格，f124 为行情时间戳
     返回键用「市场代码.代码」（如 113.rbm），与请求时的 secid 一致 */
  function emQuote(secids) {
    var u = EM_Q + '?fields=f1,f2,f12,f13,f124&secids=' + secids.join(',');
    return getJSON(u).then(function (j) {
      var out = {}, list = (j && j.data && j.data.diff) || [];
      list.forEach(function (x) {
        if (x.f2 == null || x.f2 === '-') return;
        var dec = typeof x.f1 === 'number' ? x.f1 : 2;
        var t = x.f124 ? new Date(x.f124 * 1000) : new Date();
        var pad = function (n) { return ('0' + n).slice(-2); };
        out[x.f13 + '.' + x.f12] = {
          price: x.f2 / Math.pow(10, dec),
          dec: dec,
          date: t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate())
        };
      });
      return out;
    });
  }

  /* 简单移动平均，前 n-1 个点补 null，与 pandas rolling(n).mean() 一致 */
  function ma(closes, n) {
    var out = [], sum = 0;
    for (var i = 0; i < closes.length; i++) {
      sum += closes[i];
      if (i >= n) sum -= closes[i - n];
      out.push(i >= n - 1 ? sum / n : null);
    }
    return out;
  }

  /* 与 fetch_data.py 完全一致：pct_change → rolling(60).std(ddof=1) × √252 × 100 */
  function volAnnual(closes, n) {
    var rets = [];
    for (var i = 0; i < closes.length; i++) rets.push(i ? closes[i] / closes[i - 1] - 1 : null);
    var out = [];
    for (var j = 0; j < rets.length; j++) {
      if (j < n) { out.push(null); continue; }
      var seg = rets.slice(j - n + 1, j + 1);
      var m = seg.reduce(function (a, b) { return a + b; }, 0) / seg.length;
      var v = seg.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / (seg.length - 1);
      out.push(Math.sqrt(v) * Math.sqrt(252) * 100);
    }
    return out;
  }

  /* 取末尾 KEEP 个点，按 nd 位小数取整，空值跳过 */
  function pack(rows, vals, nd) {
    var n = rows.length, from = Math.max(0, n - KEEP), pts = [];
    for (var i = from; i < n; i++) {
      if (vals[i] == null || !isFinite(vals[i])) continue;
      pts.push([rows[i].d, Number(vals[i].toFixed(nd))]);
    }
    return pts;
  }

  /* 把最新一根接在快照序列后面（日期相同则替换末点），用于期货降级路径 */
  function appendPoint(snap, date, price, nd) {
    var arr = (snap || []).slice();
    if (!arr.length) return [[date, Number(price.toFixed(nd))]];
    var last = arr[arr.length - 1];
    if (date === last[0]) arr[arr.length - 1] = [date, Number(price.toFixed(nd))];
    else if (date > last[0]) arr.push([date, Number(price.toFixed(nd))]);
    return arr.slice(-KEEP);
  }

  function build(rows, nd) {
    var c = rows.map(function (x) { return x.c; });
    return { base: pack(rows, c, nd), ma: pack(rows, ma(c, 60), nd) };
  }

  /**
   * @param {Object} snapshot 当前 data.series，用于期货降级时续接历史
   */
  function fetchLive(snapshot) {
    snapshot = snapshot || {};
    var failed = [];

    var jobIndex = tencentKline('sh000300')
      .then(function (rows) { return { key: 'hs300', rows: rows }; })
      .catch(function () { failed.push('沪深 300'); return null; });

    var jobRB = emKline('113.rbm')
      .then(function (rows) { return { key: 'rb', rows: rows }; })
      .catch(function () { return { key: 'rb', quote: true }; });

    var jobSC = emKline('142.scm')
      .then(function (rows) { return { key: 'sc', rows: rows }; })
      .catch(function () { return { key: 'sc', quote: true }; });

    return Promise.all([jobIndex, jobRB, jobSC, emQuote(['113.rbm', '142.scm', '1.000300']).catch(function () { return {}; })])
      .then(function (res) {
        var series = {}, date = '';
        var idx = res[0], rb = res[1], sc = res[2], q = res[3] || {};

        if (idx && idx.rows.length) {
          var hi = build(idx.rows, 2);
          series.hs300 = hi.base;
          series.hs300_ma60 = hi.ma;
          series.vol60 = pack(idx.rows, volAnnual(idx.rows.map(function (x) { return x.c; }), 60), 2);
          date = hi.base[hi.base.length - 1][0];
        }

        [['rb', rb, '113.rbm', 0], ['sc', sc, '142.scm', 1]].forEach(function (t) {
          var key = t[0], got = t[1], secid = t[2], nd = t[3];
          if (got && got.rows && got.rows.length) {
            var b = build(got.rows, nd);
            series[key] = b.base;
            series[key + '_ma60'] = b.ma;
            if (!date) date = b.base[b.base.length - 1][0];
            return;
          }
          // 降级：东财日 K 不通，用实时报价续接到快照末尾
          var snap = snapshot[key] && snapshot[key].points;
          var qt = q[secid];
          if (qt && snap && snap.length) {
            var pts = appendPoint(snap, qt.date, qt.price, nd);
            series[key] = pts;
            series[key + '_ma60'] = pack(pts.map(function (p) { return { d: p[0], c: p[1] }; }),
              ma(pts.map(function (p) { return p[1]; }), 60), nd);
            if (!date) date = qt.date;
          } else {
            failed.push(key === 'rb' ? '螺纹钢' : '原油');
          }
        });

        if (!Object.keys(series).length) throw new Error('行情接口暂时不可用');
        return { series: series, date: date, failed: failed };
      });
  }

  window.MCLive = {
    fetchLive: fetchLive,
    labels: {
      hs300: '沪深 300', hs300_ma60: '沪深 300', vol60: '沪深 300 波动率',
      rb: '螺纹钢', rb_ma60: '螺纹钢', sc: '原油'
    }
  };
})();
