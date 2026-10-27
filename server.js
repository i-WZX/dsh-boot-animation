// DeepSeek Boot Animation - Standalone Local Test Server
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3888;
const ASSETS_DIR = path.join(__dirname, 'assets', 'videos');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SRC_DIR = path.join(__dirname, 'src');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.m4v', '.mov']);

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(urlObj.pathname);

  // 1. 素材清单路由
  if (pathname === '/plugins/dsh-boot-animation/clips.json') {
    try {
      if (!fs.existsSync(ASSETS_DIR)) {
        fs.mkdirSync(ASSETS_DIR, { recursive: true });
      }
      const files = fs.readdirSync(ASSETS_DIR);
      const clips = files
        .filter(f => VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase()))
        .map(f => ({
          name: f,
          src: `/plugins/dsh-boot-animation/clip/${encodeURIComponent(f)}`
        }));
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify({ clips }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, clips: [] }));
    }
    return;
  }

  // 2. 视频流分片传输 (HTTP 206 Range)
  if (pathname.startsWith('/plugins/dsh-boot-animation/clip/') || pathname.startsWith('/plugins/dsh-boot-animation/video/')) {
    const videoName = path.basename(pathname.replace('/plugins/dsh-boot-animation/clip/', '').replace('/plugins/dsh-boot-animation/video/', ''));
    const filePath = path.join(ASSETS_DIR, videoName);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Video not found');
      return;
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    const ext = path.extname(videoName).toLowerCase();
    const contentType = ext === '.webm' ? 'video/webm' : 'video/mp4';

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;

      const file = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
        'Cache-Control': 'no-store'
      });
      file.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(filePath).pipe(res);
    }
    return;
  }

  // 3. 静态脚本服务
  if (pathname === '/src/boot-screen.js') {
    const filePath = path.join(SRC_DIR, 'boot-screen.js');
    if (fs.existsSync(filePath)) {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  // 4. 根路径或静态页面服务
  let localPath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
    const ext = path.extname(localPath).toLowerCase();
    let type = 'text/plain';
    if (ext === '.html') type = 'text/html; charset=utf-8';
    else if (ext === '.js') type = 'application/javascript; charset=utf-8';
    else if (ext === '.css') type = 'text/css; charset=utf-8';
    
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(localPath).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 DeepSeek 纯净全屏启动视频演示服务已更新:`);
  console.log(`🔗 本地预览地址: http://localhost:${PORT}`);
  console.log(`📁 视频素材目录: ${ASSETS_DIR}`);
  console.log(`======================================================\n`);
});
