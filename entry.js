// DeepSeek Boot Animation - Host Plugin Entry (Node.js Side)
//
// 专为 DeepSeek Harness (DSH) 设计的宿主端插件入口：
// 1. 导出 Config 配置元数据 (基于 @deepseek-ai/schemastery volatile 机制)，让 DSH 设置页面自动渲染左侧菜单栏插槽 ('settings.section')。
// 2. 声明 inject: ['webServer'] 获取 Cordis webServer 服务。
// 3. 拦截 webserver/index-inject 事件，在 HTML <head> 早期注入纯净全屏启动遮罩。
// 4. 注册 /plugins/dsh-boot-animation/clips.json 清单与 /plugins/dsh-boot-animation/clip/* 流式路由 (支持 Range 206)。
// 5. 注册 /plugins/dsh-boot-animation/optimize 路由，支持将视频 moov atom 前移以优化首帧解码性能。

import { readdir, stat, open } from 'node:fs/promises';
import { createReadStream, readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, extname, join, resolve, sep } from 'node:path';
import { optimizeInPlace } from './src/remux.js';
import z from '@deepseek-ai/schemastery';

function logDebug(msg) {
  try {
    appendFileSync('C:/Users/Zhongxin.Wang/.dsh/boot-debug.log', `${new Date().toISOString()} ${msg}\n`);
  } catch (e) {}
}

logDebug('entry.js evaluated');

const BOOT_SCREEN_PATH = fileURLToPath(new URL('./src/boot-screen.js', import.meta.url));
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.m4v', '.mov']);
const ROUTE = '/plugins/dsh-boot-animation';

const DEFAULT_SETTINGS = {
  enabled: true,
  fadeMs: 1500,
  enterMode: 'end',
  disabledClips: [],
  sound: true,
  clickToEnter: false,
  showHint: false,
  maxDurationMs: 25000,
};

const ENTER_MODES = ['tail', 'end', 'click'];

const LIVE_CAPABLE = typeof z.boolean().volatile === 'function';

function live(schema) {
  return LIVE_CAPABLE ? schema.volatile() : schema;
}

const VOLATILE_REF = Symbol.for('cosmokit.volatile.write');

function isLive(value) {
  return typeof value === 'object' && value !== null && VOLATILE_REF in value;
}

function readField(config, key) {
  const value = config?.[key];
  return isLive(value) && typeof value.get === 'function' ? value.get() : value;
}

export const Config = z.object({
  enabled: live(z.boolean().default(DEFAULT_SETTINGS.enabled)),
  fadeMs: live(z.number().min(300).max(5000).default(DEFAULT_SETTINGS.fadeMs)),
  enterMode: live(z.union([...ENTER_MODES]).default(DEFAULT_SETTINGS.enterMode)),
  disabledClips: live(z.array(z.string()).default([])),
  sound: live(z.boolean().default(DEFAULT_SETTINGS.sound)),
  clickToEnter: live(z.boolean().default(DEFAULT_SETTINGS.clickToEnter)),
  showHint: live(z.boolean().default(DEFAULT_SETTINGS.showHint)),
});

export const name = 'dsh-boot-animation';
export const inject = ['webServer'];

const assetDir = fileURLToPath(new URL('./assets/videos', import.meta.url));

function contentType(file) {
  switch (extname(file).toLowerCase()) {
    case '.webm': return 'video/webm';
    case '.mov': return 'video/quicktime';
    default: return 'video/mp4';
  }
}

async function readFaststart(absolute) {
  let handle;
  try {
    handle = await open(absolute, 'r');
    const head = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    let offset = 0;
    while (offset + 8 <= bytesRead) {
      const type = head.toString('latin1', offset + 4, offset + 8);
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      const size = head.readUInt32BE(offset);
      if (size < 8) break;
      offset += size;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function listClips() {
  let entries;
  try {
    entries = await readdir(assetDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = entries
    .filter(entry => entry.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map(entry => join(assetDir, entry.name));
  const stamped = await Promise.all(files.map(async (file) => {
    const info = await stat(file);
    return {
      file,
      mtime: info.mtimeMs,
      revision: Math.round(info.mtimeMs),
      bytes: info.size,
      faststart: await readFaststart(file),
    };
  }));
  return stamped.sort((left, right) => right.mtime - left.mtime);
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

  const from = range === undefined ? 0 : range.start;
  const to = range === undefined ? info.size - 1 : range.end;
  res.writeHead(range === undefined ? 200 : 206, {
    ...headers,
    'content-length': String(to - from + 1),
    ...(range === undefined ? {} : {
      'content-range': `bytes ${String(from)}-${String(to)}/${String(info.size)}`,
    }),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(absolute, { start: from, end: to });
  stream.on('error', () => { res.destroy(); });
  res.on('close', () => { stream.destroy(); });
  stream.pipe(res);
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

function bootScreenSource() {
  try {
    return readFileSync(BOOT_SCREEN_PATH, 'utf8');
  } catch (error) {
    return '';
  }
}

export function apply(ctx, config) {
  logDebug('apply() started');
  const server = ctx.webServer || ctx.webserver || ctx.server;

  function currentSettings() {
    try {
      const enabled = readField(config, 'enabled');
      const fadeMs = readField(config, 'fadeMs');
      const enterMode = readField(config, 'enterMode');
      const disabledClips = readField(config, 'disabledClips');
      const sound = readField(config, 'sound');
      const clickToEnter = readField(config, 'clickToEnter');
      const showHint = readField(config, 'showHint');
      return {
        enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_SETTINGS.enabled,
        fadeMs: typeof fadeMs === 'number' ? fadeMs : DEFAULT_SETTINGS.fadeMs,
        enterMode: ENTER_MODES.includes(enterMode) ? enterMode : DEFAULT_SETTINGS.enterMode,
        disabledClips: Array.isArray(disabledClips) ? disabledClips : [],
        sound: typeof sound === 'boolean' ? sound : DEFAULT_SETTINGS.sound,
        clickToEnter: typeof clickToEnter === 'boolean' ? clickToEnter : DEFAULT_SETTINGS.clickToEnter,
        showHint: typeof showHint === 'boolean' ? showHint : DEFAULT_SETTINGS.showHint,
        maxDurationMs: DEFAULT_SETTINGS.maxDurationMs,
      };
    } catch (error) {
      return DEFAULT_SETTINGS;
    }
  }

  // ① 核心：注册 index-inject 监听器
  ctx.on?.('webserver/index-inject', (table) => {
    logDebug('webserver/index-inject received');
    const settings = currentSettings();
    if (!settings.enabled) return;

    table.push({
      kind: 'script',
      placement: 'head',
      text: `globalThis.__DSH_BOOT_ANIM_CFG__=${JSON.stringify({
        base: ROUTE,
        manifest: `${ROUTE}/clips.json`,
        holdMs: 30000,
        fadeMs: settings.fadeMs,
        enterMode: settings.enterMode,
        sound: settings.sound,
        clickToEnter: settings.clickToEnter,
        showHint: settings.showHint,
        maxDurationMs: settings.maxDurationMs,
      })}`,
    });
    table.push({ kind: 'script', placement: 'head', text: bootScreenSource() });
    logDebug('injected boot-screen scripts into head');
  });

  // ② 注册 manifest 路由
  if (server?.register) {
    logDebug('Registering webServer routes');
    ctx.effect?.(() => server.register({
      kind: 'exact',
      path: `${ROUTE}/clips.json`,
      handler: (req, res) => {
        void (async () => {
          const clips = await listClips();
          const disabled = new Set(currentSettings().disabledClips);
          sendJson(res, 200, {
            clips: clips.map(clip => ({
              src: `${ROUTE}/clip/${encodeURIComponent(basename(clip.file))}`
                + `?v=${String(clip.revision)}-${String(clip.bytes)}`,
              name: basename(clip.file),
              enabled: !disabled.has(basename(clip.file)),
              bytes: clip.bytes,
              faststart: clip.faststart,
            })),
          });
        })().catch(() => {
          if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
          else res.end();
        });
      },
    }), 'boot-animation: manifest route');

    // ③ 注册视频流路由
    ctx.effect?.(() => server.register({
      kind: 'prefix',
      path: `${ROUTE}/clip`,
      handler: (req, res) => {
        void (async () => {
          const absolute = resolveClip(req.url ?? '');
          if (absolute === undefined) {
            sendJson(res, 404, { error: 'not found' });
            return;
          }
          await serveClip(absolute, req, res);
        })().catch(() => {
          if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
          else res.end();
        });
      },
    }), 'boot-animation: clip route');

    // ④ 注册 Faststart 优化路由
    const optimising = new Set();
    ctx.effect?.(() => server.register({
      kind: 'prefix',
      path: `${ROUTE}/optimize`,
      handler: (req, res) => {
        void (async () => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '只接受 POST 请求。' });
            return;
          }
          const requested = new URL(req.url ?? '/', 'http://localhost').searchParams.get('name') ?? '';
          const name = basename(requested);
          const absolute = resolve(assetDir, name);
          if (name === '' || name !== requested
            || !VIDEO_EXTENSIONS.has(extname(name).toLowerCase())
            || !absolute.startsWith(assetDir + sep)) {
            sendJson(res, 400, { ok: false, error: '素材名不合法。' });
            return;
          }
          if (optimising.has(name)) {
            sendJson(res, 409, { ok: false, error: '正在处理中，请稍候。' });
            return;
          }
          optimising.add(name);
          try {
            const result = await optimizeInPlace({
              file: absolute,
              backupDir: join(assetDir, 'originals'),
              scratchDir: join(assetDir, '.faststart-work'),
            });
            sendJson(res, 200, result);
          } finally {
            optimising.delete(name);
          }
        })().catch((error) => {
          if (res.headersSent) {
            res.end();
            return;
          }
          sendJson(res, 500, { ok: false, error: error?.message || 'internal error' });
        });
      },
    }), 'boot-animation: optimize route');
  }
}

export default {
  name,
  Config,
  inject,
  apply,
};
