// DeepSeek Boot Animation - Host Plugin Entry (Node.js Side)
//
// 专为 DeepSeek Harness (DSH) 设计的宿主端插件入口：
// 1. 声明 inject: ['webServer'] 获取 Cordis webServer 服务。
// 2. 拦截 webserver/index-inject 事件，在 HTML <head> 早期注入纯净全屏启动遮罩。
// 3. 注册 /plugins/dsh-boot-animation/clips.json 和 /plugins/dsh-boot-animation/clip/* 流式路由 (支持 Range 206)。

import { appendFileSync, createReadStream, readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, extname, resolve, sep } from 'node:path';

function logDebug(msg) {
  try {
    appendFileSync('C:/Users/Zhongxin.Wang/.dsh/boot-debug.log', `${new Date().toISOString()} ${msg}\n`);
  } catch (e) {}
}

logDebug('entry.js evaluated');

const BOOT_SCREEN_PATH = fileURLToPath(new URL('./src/boot-screen.js', import.meta.url));
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.m4v', '.mov']);
const ROUTE = '/plugins/dsh-boot-animation';

export const name = 'dsh-boot-animation';
export const inject = ['webServer'];

export const DEFAULT_CONFIG = {
  enabled: true,
  fadeMs: 1500,
  enterMode: 'end',
  maxDurationMs: 25000,
  sound: true,
  holdMs: 30000,
};

function parseRange(header, size) {
  if (typeof header !== 'string') return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return undefined;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return undefined;
  if (rawStart === '') {
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return undefined;
    return { start: Math.max(size - length, 0), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return { unsatisfiable: true };
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(end) || end < start) return { unsatisfiable: true };
  return { start, end };
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function contentType(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  return 'video/mp4';
}

export function apply(ctx, config = {}) {
  logDebug('apply() started');

  const assetDir = resolve(fileURLToPath(new URL('.', import.meta.url)), 'assets/videos');
  const server = ctx.webServer || ctx.webserver || ctx.server;

  function currentSettings() {
    return {
      enabled: config.enabled !== undefined ? config.enabled : DEFAULT_CONFIG.enabled,
      fadeMs: config.fadeMs || DEFAULT_CONFIG.fadeMs,
      enterMode: config.enterMode || DEFAULT_CONFIG.enterMode,
      maxDurationMs: config.maxDurationMs || DEFAULT_CONFIG.maxDurationMs,
      sound: config.sound !== undefined ? config.sound : DEFAULT_CONFIG.sound,
      holdMs: config.holdMs || DEFAULT_CONFIG.holdMs,
    };
  }

  // ① 核心：尽早注册 index-inject 监听器（桌面端 Electron 启动时一次性收集）
  ctx.on?.('webserver/index-inject', (table) => {
    logDebug('webserver/index-inject event received!');
    if (!Array.isArray(table)) return;

    const settings = currentSettings();
    if (!settings.enabled) return;

    table.push({
      kind: 'script',
      placement: 'head',
      text: `globalThis.__DSH_BOOT_ANIM_CFG__=${JSON.stringify({
        base: ROUTE,
        manifest: `${ROUTE}/clips.json`,
        fadeMs: settings.fadeMs,
        enterMode: settings.enterMode,
        maxDurationMs: settings.maxDurationMs,
        sound: settings.sound,
        holdMs: settings.holdMs
      })}`
    });

    try {
      const scriptCode = readFileSync(BOOT_SCREEN_PATH, 'utf8');
      table.push({
        kind: 'script',
        placement: 'head',
        text: scriptCode
      });
      logDebug('Successfully pushed boot-screen.js to index-inject table');
    } catch (e) {
      logDebug(`Error reading boot-screen.js: ${String(e)}`);
    }
  });

  async function listClips() {
    let entries;
    try {
      entries = await readdir(assetDir, { withFileTypes: true });
    } catch (e) {
      return [];
    }
    const files = entries
      .filter(e => e.isFile() && VIDEO_EXTENSIONS.has(extname(e.name).toLowerCase()))
      .map(e => ({
        name: e.name,
        src: `${ROUTE}/clip/${encodeURIComponent(e.name)}`
      }));
    return files;
  }

  function resolveClip(url) {
    const pathname = decodeURIComponent(url.split('?')[0]);
    if (!pathname.startsWith(`${ROUTE}/clip/`)) return undefined;
    const requested = basename(pathname.slice(`${ROUTE}/clip/`.length));
    if (!VIDEO_EXTENSIONS.has(extname(requested).toLowerCase())) return undefined;
    const absolute = resolve(assetDir, requested);
    if (!absolute.startsWith(assetDir + sep)) return undefined;
    return absolute;
  }

  async function serveClip(absolute, req, res) {
    const info = await stat(absolute);
    const type = contentType(absolute);
    const range = parseRange(req.headers.range, info.size);

    if (range?.unsatisfiable === true) {
      res.writeHead(416, { 'content-range': `bytes */${String(info.size)}` });
      res.end();
      return;
    }

    const headers = {
      'content-type': type,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    };

    if (range === undefined) {
      headers['content-length'] = String(info.size);
      res.writeHead(200, headers);
      createReadStream(absolute).pipe(res);
      return;
    }

    const chunkLength = range.end - range.start + 1;
    headers['content-range'] = `bytes ${range.start}-${range.end}/${info.size}`;
    headers['content-length'] = String(chunkLength);
    res.writeHead(206, headers);
    createReadStream(absolute, { start: range.start, end: range.end }).pipe(res);
  }

  // ② 注册 DSH Webserver 路由
  if (server?.register) {
    logDebug('Registering webServer routes');
    ctx.effect?.(() => server.register({
      kind: 'exact',
      path: `${ROUTE}/clips.json`,
      handler: (req, res) => {
        void (async () => {
          const clips = await listClips();
          sendJson(res, 200, { clips });
        })().catch(() => {
          if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
          else res.end();
        });
      }
    }), 'boot-animation: manifest route');

    ctx.effect?.(() => server.register({
      kind: 'prefix',
      path: `${ROUTE}/clip`,
      handler: (req, res) => {
        void (async () => {
          const absolute = resolveClip(req.url ?? '');
          if (!absolute) {
            sendJson(res, 404, { error: 'not found' });
            return;
          }
          await serveClip(absolute, req, res);
        })().catch(() => {
          if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
          else res.end();
        });
      }
    }), 'boot-animation: clip route');
  } else {
    logDebug('Warning: ctx.webServer.register was not available immediately in apply()');
  }
}

export default {
  name,
  inject,
  apply,
};
