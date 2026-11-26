/* 宏观研究看板 · 本地服务（零依赖）
   GET  /                 静态页面
   GET  /api/dashboard    读取 data.json
   POST /api/refresh      重新抓取（?force=1 忽略缓存）
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = __dirname;
const PUB = path.join(BASE, 'public');
const DATA = path.join(BASE, 'data.json');
const py = process.env.PYTHON || '/usr/bin/python3';
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
let pyState = null; // null=未探测 true=可用 false=不可用
function pyAvailable() {
  if (pyState !== null) return pyState;
  if (!fs.existsSync(py)) { pyState = false; return false; }
  try {
    const r = require('child_process').spawnSync(py, ['-c', 'import akshare'], { timeout: 25000 });
    pyState = r.status === 0;
  } catch (e) {
    pyState = false;
  }
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

function refresh(force, res) {
  const now = Date.now();
  if (running) return json(res, { status: 'running', message: '已有抓取任务在执行' });
  if (!pyAvailable()) {
    return json(res, {
      status: 'error',
      message: '当前线上环境不提供数据抓取，展示的是最近一次抓取的快照。需要更新数据请在本机运行 python3 fetch_data.py 后重新发布。'
    });
  }
  if (!force && now - lastRun < 5 * 60 * 1000 && fs.existsSync(DATA)) {
    return json(res, { status: 'cached' });
  }
  lastError = '';
  const child = spawn(py, ['fetch_data.py'], { cwd: BASE });
  running = child;
  child.stderr.on('data', d => { lastError += d.toString(); });
  child.on('error', e => {
    lastError = String(e && e.message || e);
    running = null;
  });
  const killer = setTimeout(() => { if (running) running.kill('SIGKILL'); }, 300000);
  child.on('close', code => {
    clearTimeout(killer);
    running = null;
    lastRun = Date.now();
    if (code !== 0) console.log('fetch exit', code, lastError.slice(0, 400));
  });
  json(res, { status: 'started' });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  if (p === '/api/dashboard') {
    // 带 ETag：轮询时浏览器只做条件请求，数据没变就回 304，省掉整包传输
    fs.stat(DATA, (e, st) => {
      if (e || !st.isFile()) return json(res, { error: 'data.json 不存在，请先抓取数据' }, 500);
      const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
      const inm = req.headers['if-none-match'];
      if (inm && inm.split(',').map(s => s.trim()).indexOf(etag) > -1) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        ETag: etag,
        'Last-Modified': st.mtime.toUTCString()
      });
      fs.createReadStream(DATA).pipe(res);
    });
    return;
  }

  if (p === '/api/refresh') {
    return refresh(u.searchParams.get('force') === '1', res);
  }

  if (p === '/api/status') {
    return json(res, { running: !!running, lastRun, python: pyAvailable(), error: lastError.slice(0, 300) });
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

server.listen(PORT, HOST, () => {
  console.log('宏观研究看板: http://' + HOST + ':' + PORT);
  if (!fs.existsSync(DATA)) {
    if (pyAvailable()) {
      console.log('首次运行，开始抓取数据…');
      const c = spawn(py, ['fetch_data.py'], { cwd: BASE, stdio: 'inherit' });
      c.on('error', e => console.log('fetch error', e.message));
    } else {
      console.log('未找到 python3/akshare，使用仓库内 data.json 快照');
    }
  }
});
