/* 宏观研究看板 · 本地服务（零依赖）
   GET  /                 静态页面
   GET  /api/dashboard    读取 data.json
   POST /api/refresh      重新抓取（?force=1 忽略缓存）
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const BASE = __dirname;
const PUB = path.join(BASE, 'public');
const DATA = path.join(BASE, 'data.json');
const MANUAL = path.join(BASE, 'manual.json');
const PORT = Number(process.env.PORT ||
  (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1]) || 7101;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png'
};

let running = null;
let lastRun = 0;
let lastError = '';

// Python 抓取只在本地可用；线上沙箱没有 akshare，探测一次并缓存结果
let pyPath = null;
let pyState = null; // null=未探测 true=可用 false=不可用
// 找一个装了 akshare 的解释器：PATH 里默认的 python3 常常不带这个包
function resolvePython() {
  if (pyPath) return pyPath;
  const cands = [process.env.PYTHON, '/usr/local/bin/python3', '/opt/homebrew/bin/python3', '/usr/bin/python3']
    .filter(Boolean);
  for (const c of cands) {
    if (!fs.existsSync(c)) continue;
    try {
      if (spawnSync(c, ['-c', 'import akshare'], { timeout: 25000 }).status === 0) {
        pyPath = c; pyState = true; return c;
      }
    } catch (e) { /* 试下一个 */ }
  }
  pyPath = cands.find(c => fs.existsSync(c)) || 'python3';
  pyState = false;
  return pyPath;
}

function pyAvailable() {
  if (pyState === null) resolvePython();
  return pyState;
}

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function startFetch(force) {
  const now = Date.now();
  if (running) return { status: 'running', message: '已有抓取任务在执行' };
  if (!pyAvailable()) {
    return {
      status: 'error',
      message: '当前线上环境不提供数据抓取，展示的是最近一次抓取的快照。需要更新数据请在本机运行 python3 fetch_data.py 后重新发布。'
    };
  }
  if (!force && now - lastRun < 5 * 60 * 1000 && fs.existsSync(DATA)) {
    return { status: 'cached' };
  }
  lastError = '';
  const child = spawn(resolvePython(), ['fetch_data.py'], { cwd: BASE });
  running = child;
  // stderr 里大多是 tqdm 进度条，只有退出码非 0 时才当错误保留
  let errBuf = '';
  child.stderr.on('data', d => {
    errBuf = (errBuf + d.toString()).slice(-4000);
  });
  child.on('error', e => {
    lastError = String(e && e.message || e);
    running = null;
  });
  const killer = setTimeout(() => { if (running) running.kill('SIGKILL'); }, 300000);
  child.on('close', code => {
    clearTimeout(killer);
    running = null;
    lastRun = Date.now();
    console.log('[fetch] 结束 code=' + code + ' 用时 ' + ((Date.now() - now) / 1000).toFixed(0) + 's');
    if (code === 0) {
      lastError = '';
    } else {
      lastError = errBuf.trim() || ('退出码 ' + code);
      console.log('fetch exit', code, lastError.slice(0, 400));
    }
  });
  return { status: 'started' };
}

function refresh(force, res) {
  json(res, startFetch(force));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  if (p === '/api/dashboard') {
    // 带 ETag：轮询时浏览器只做条件请求，数据没变就回 304，省掉整包传输
    fs.stat(DATA, (e, st) => {
      if (e || !st.isFile()) return json(res, { error: 'data.json 不存在，请先抓取数据' }, 500);
      // manual.json 的 mtime 参与 ETag：口径改了即使 data.json 没重跑也能立即看到
      let mm = 0, mr = null;
      try { mm = fs.statSync(MANUAL).mtimeMs; mr = JSON.parse(fs.readFileSync(MANUAL, 'utf8')); } catch (e2) { /* 没有人工口径文件就走原样 */ }
      const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) +
        (mm ? '-' + Math.floor(mm).toString(16) : '') + '"';
      const inm = req.headers['if-none-match'];
      if (inm && inm.split(',').map(s => s.trim()).indexOf(etag) > -1) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
        return res.end();
      }
      const head = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        ETag: etag,
        'Last-Modified': st.mtime.toUTCString()
      };
      if (!mr || !mr.items) {
        res.writeHead(200, head);
        return fs.createReadStream(DATA).pipe(res);
      }
      // 用 manual.json 覆盖 data.json 里的人工口径（保留抓数写入的自动项，如存准率）
      let d;
      try { d = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
      catch (e3) { res.writeHead(200, head); return fs.createReadStream(DATA).pipe(res); }
      const man = d.manual || {};
      const items = man.items || {};
      Object.keys(mr.items).forEach(k => {
        const v = mr.items[k];
        if (v && v.v) items[k] = { v: v.v, note: v.note || '', asof: v.asof || null, src: v.src || '人工', auto: false };
      });
      d.manual = Object.assign({}, man, {
        available: true, items: items,
        updated: mr.updated || man.updated, source: mr.source || man.source
      });
      res.writeHead(200, head);
      res.end(JSON.stringify(d));
    });
    return;
  }

  if (p === '/api/refresh') {
    return refresh(u.searchParams.get('force') === '1', res);
  }

  if (p === '/api/status') {
    let meta = {};
    try {
      const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
      meta = { sources: d.sources || {}, checks: d.checks || {}, asof: d.asof || null };
    } catch (e) { /* data.json 还没生成 */ }
    return json(res, Object.assign({
      running: !!running,
      lastRun,
      python: pyAvailable(),
      autoFetch: AUTO_FETCH,
      dataAgeHours: Number.isFinite(dataAgeHours()) ? Number(dataAgeHours().toFixed(2)) : null,
      error: lastError.slice(0, 300)
    }, meta));
  }

  // 环境诊断：用来判断当前托管节点能否直连国内数据源、是否具备 Python 抓数能力
  if (p === '/api/probe') {
    const https = require('https');
    const targets = [
      ['百度基准', 'https://www.baidu.com/'],
      ['新浪行情', 'https://hq.sinajs.cn/list=sh000300'],
      ['腾讯快照', 'https://qt.gtimg.cn/q=sh000300'],
      ['腾讯K线', 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000300,day,,,5,'],
      ['东财行情', 'https://push2.eastmoney.com/api/qt/stock/get?secid=1.000300&fields=f43,f58'],
      ['东财宏观', 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_ECONOMY_PMI&columns=ALL&pageSize=1&sortColumns=REPORT_DATE&sortTypes=-1']
    ];
    const results = [];
    let left = targets.length;
    const done = () => {
      if (--left > 0) return;
      json(res, {
        node: process.version,
        python: pyAvailable(),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        now: new Date().toISOString(),
        net: results
      });
    };
    targets.forEach(([name, url]) => {
      const t0 = Date.now();
      const r = { name, url, ok: false };
      const req = https.get(url, {
        timeout: 9000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept': '*/*',
          'Referer': 'https://finance.sina.com.cn/'
        }
      }, rs => {
        let body = '';
        rs.setEncoding('utf8');
        rs.on('data', c => { if (body.length < 400) body += c; if (body.length > 80000) rs.destroy(); });
        rs.on('end', () => { r.ok = rs.statusCode < 400; r.status = rs.statusCode; r.ms = Date.now() - t0; r.head = body.slice(0, 180).replace(/\s+/g, ' '); results.push(r); done(); });
        rs.on('error', e => { r.err = String(e.message); r.ms = Date.now() - t0; results.push(r); done(); });
      });
      req.on('timeout', () => { r.err = 'timeout'; r.ms = Date.now() - t0; req.destroy(); });
      req.on('error', e => { r.err = String(e.code || e.message); r.ms = Date.now() - t0; results.push(r); done(); });
    });
    return;
  }

  let file = path.join(PUB, p === '/' ? 'index.html' : decodeURIComponent(p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(file).pipe(res);
  });
});

/* ---------------- 自动抓数（容器/云托管形态） ----------------
   AUTO_FETCH=1 时启用：服务启动先返回现有快照（毫秒级），
   后台按需补抓；常驻期间每小时检查一次，数据过旧就抓。
   抓取耗时 1-3 分钟，不阻塞任何请求。                                   */
const AUTO_FETCH = process.env.AUTO_FETCH === '1';
const STALE_HOURS = Number(process.env.STALE_HOURS || 6);

function dataAgeHours() {
  try {
    const st = fs.statSync(DATA);
    return (Date.now() - st.mtimeMs) / 3600000;
  } catch (e) {
    return Infinity;
  }
}

function autoFetch(reason, force) {
  if (running || !pyAvailable()) return;
  console.log('[auto] 触发抓数：' + reason + '（当前数据 ' + dataAgeHours().toFixed(1) + 'h 前）');
  startFetch(!!force);
}

function tick() {
  const age = dataAgeHours();
  const now = new Date();
  const wd = now.getDay();
  const hm = now.getHours() * 100 + now.getMinutes();
  const weekday = wd >= 1 && wd <= 5;
  // 交易时段（工作日 09:00-15:00）要求更勤
  const inSession = weekday && hm >= 900 && hm <= 1500;
  // 收盘后 15:00-16:30 是「取当日收盘」的窗口，必须尽快抓一次
  const justClosed = weekday && hm > 1500 && hm <= 1630;
  let limit = inSession ? 2 : STALE_HOURS;
  if (justClosed) limit = 0.5;
  if (age > limit) autoFetch('数据已过期 ' + age.toFixed(1) + 'h' + (justClosed ? '（收盘补抓）' : ''));
}

server.listen(PORT, HOST, () => {
  console.log('宏观研究看板: http://' + HOST + ':' + PORT + '  autoFetch=' + AUTO_FETCH);
  if (!fs.existsSync(DATA)) {
    if (pyAvailable()) {
      console.log('首次运行，开始抓取数据…');
      const c = spawn(resolvePython(), ['fetch_data.py'], { cwd: BASE, stdio: 'inherit' });
      c.on('error', e => console.log('fetch error', e.message));
    } else {
      console.log('未找到 python3/akshare，使用仓库内 data.json 快照');
    }
  } else if (AUTO_FETCH) {
    console.log('现有快照 ' + dataAgeHours().toFixed(1) + 'h 前，先提供服务，后台按需补抓');
    setTimeout(tick, 3000);
    setInterval(tick, 10 * 60 * 1000);
  }
});
