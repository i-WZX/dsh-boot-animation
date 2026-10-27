// DeepSeek Boot Animation - Pre-boot Screen (Pure Cinematic Fullscreen)
// 
// 极致纯净全屏沉浸模式：
// 1. 无任何多余 UI（无进度条、无提示字、无控制按钮、全屏无边框纯黑底）。
// 2. 视频铺满整个视口 (100vw x 100vh, object-fit: cover)。
// 3. 严格执行 25 秒上限：
//    - 视频 <= 25 秒：完整播放至最后一帧后平滑淡出露出 DSH 界面。
//    - 视频 > 25 秒：在第 25 秒平滑截断淡出进入 DSH。
// 4. 交互：点击屏幕任意处可解锁原声音频，按 Esc 或空格键可提前跳过。
// 5. 播放完成后平滑淡入 DSH 主界面，并彻底销毁遮罩节点。

;(function () {
  'use strict';

  var cfg = globalThis.__DSH_BOOT_ANIM_CFG__ || {};
  if (globalThis.__DSH_BOOT_ANIM__) return;

  var BASE_ROUTE = cfg.base || '/plugins/dsh-boot-animation';
  var MANIFEST_URL = cfg.manifest || (BASE_ROUTE + '/clips.json');
  var ENTER_MODE = cfg.enterMode || 'end'; 
  var FADE_MS = typeof cfg.fadeMs === 'number' && cfg.fadeMs >= 200 ? cfg.fadeMs : 1500;
  var MAX_DURATION_MS = typeof cfg.maxDurationMs === 'number' && cfg.maxDurationMs > 0 ? cfg.maxDurationMs : 25000;
  var SOUND_ENABLED = cfg.sound !== false;
  var HOLD_BUDGET_MS = MAX_DURATION_MS + 5000;

  var namespace = {
    version: '1.2.0-pure-cinematic',
    maxDurationMs: MAX_DURATION_MS,
    bootedAt: null,
    clipEndedAt: null,
    isAudioMuted: true,
    isLeaving: false,
    clientReady: function () {
      if (namespace.bootedAt === null) {
        namespace.bootedAt = Date.now();
      }
      onKernelOrClipReady();
    },
    skip: function () {
      performExit(FADE_MS / 2);
    }
  };
  globalThis.__DSH_BOOT_ANIM__ = namespace;

  // 1. 并行拉取视频清单
  var earlyManifestPromise = null;
  try {
    earlyManifestPromise = fetch(MANIFEST_URL, { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : { clips: [] }; })
      .catch(function () { return { clips: [] }; });
  } catch (e) {
    earlyManifestPromise = Promise.resolve({ clips: [] });
  }

  var rootEl = null;
  var videoEl = null;
  var isVideoSettled = false;
  var isClipFinished = false;
  var hasDissolveStarted = false;
  var maxDurationTimer = null;

  // 纯净样式：无任何多余元素，只保留全屏视频与转场过渡
  function injectStyles() {
    var style = document.createElement('style');
    style.id = 'dsh-boot-pure-style';
    style.textContent = [
      '#dsh-boot-overlay {',
      '  position: fixed !important;',
      '  inset: 0 !important;',
      '  width: 100vw !important;',
      '  height: 100vh !important;',
      '  z-index: 2147483647 !important;',
      '  background: #000000 !important;',
      '  display: flex !important;',
      '  align-items: center !important;',
      '  justify-content: center !important;',
      '  overflow: hidden !important;',
      '  user-select: none !important;',
      '  cursor: default !important;',
      '  opacity: 1;',
      '  transition: opacity ' + (FADE_MS / 1000) + 's cubic-bezier(0.4, 0, 0.2, 1) !important;',
      '}',
      '#dsh-boot-overlay[data-state="leaving"] {',
      '  opacity: 0 !important;',
      '  pointer-events: none !important;',
      '}',
      '#dsh-boot-video {',
      '  position: absolute !important;',
      '  inset: 0 !important;',
      '  width: 100% !important;',
      '  height: 100% !important;',
      '  object-fit: cover !important;',
      '  opacity: 0;',
      '  transition: opacity 0.4s ease-in-out !important;',
      '}',
      '#dsh-boot-video.visible {',
      '  opacity: 1 !important;',
      '}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function buildOverlay() {
    var root = document.createElement('div');
    root.id = 'dsh-boot-overlay';
    root.setAttribute('data-state', 'booting');

    var video = document.createElement('video');
    video.id = 'dsh-boot-video';
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'auto';

    root.appendChild(video);
    rootEl = root;
    videoEl = video;

    // 点击屏幕切换声音
    root.addEventListener('click', function () {
      if (videoEl && SOUND_ENABLED) {
        if (videoEl.muted) {
          videoEl.muted = false;
          videoEl.volume = 1.0;
          namespace.isAudioMuted = false;
        } else {
          videoEl.muted = true;
          namespace.isAudioMuted = true;
        }
      }
    });

    // 键盘支持 Esc / 空格跳过
    window.addEventListener('keydown', function (e) {
      if (namespace.isLeaving) return;
      if (e.key === 'Escape' || e.code === 'Space') {
        performExit(FADE_MS / 2);
      }
    }, { once: false });

    return root;
  }

  // 声音淡出
  function fadeOutAudio(durationMs) {
    if (!videoEl || videoEl.muted) return;
    var startVolume = videoEl.volume;
    var startTime = Date.now();
    var timer = setInterval(function () {
      var elapsed = Date.now() - startTime;
      var factor = 1 - (elapsed / durationMs);
      if (factor <= 0) {
        clearInterval(timer);
        videoEl.volume = 0;
        try { videoEl.pause(); } catch (e) {}
      } else {
        videoEl.volume = Math.max(0, startVolume * factor);
      }
    }, 40);
  }

  // 平滑过渡退出并完全展示 DSH 页面
  function performExit(spanMs) {
    if (namespace.isLeaving) return;
    namespace.isLeaving = true;
    hasDissolveStarted = true;

    if (maxDurationTimer) {
      clearTimeout(maxDurationTimer);
      maxDurationTimer = null;
    }

    var exitSpan = typeof spanMs === 'number' && spanMs > 0 ? spanMs : FADE_MS;
    rootEl.style.transitionDuration = (exitSpan / 1000) + 's';
    rootEl.setAttribute('data-state', 'leaving');

    fadeOutAudio(exitSpan);

    setTimeout(function () {
      if (rootEl && rootEl.parentNode) {
        rootEl.parentNode.removeChild(rootEl);
      }
      if (videoEl) {
        try { videoEl.pause(); } catch (e) {}
        videoEl.src = '';
      }
    }, exitSpan + 100);
  }

  function onKernelOrClipReady() {
    if (namespace.isLeaving) return;
    if (isClipFinished && namespace.bootedAt !== null) {
      performExit(FADE_MS);
    }
  }

  // 开始播放
  function startPlayback(clips) {
    if (!clips || clips.length === 0) {
      setTimeout(function () { performExit(600); }, 500);
      return;
    }

    var chosen = clips[Math.floor(Math.random() * clips.length)];
    var video = videoEl;

    // 监听进度（执行 25 秒上限截断）
    video.addEventListener('timeupdate', function () {
      var curMs = video.currentTime * 1000;
      // 25 秒硬上限：在达到 (25s - fadeMs) 时启动淡出转场
      if (curMs >= (MAX_DURATION_MS - FADE_MS) && !hasDissolveStarted) {
        hasDissolveStarted = true;
        isClipFinished = true;
        performExit(FADE_MS);
      }
    });

    video.addEventListener('loadedmetadata', function () {
      maxDurationTimer = setTimeout(function () {
        if (!hasDissolveStarted && !namespace.isLeaving) {
          hasDissolveStarted = true;
          isClipFinished = true;
          performExit(FADE_MS);
        }
      }, MAX_DURATION_MS);
    }, { once: true });

    video.addEventListener('canplay', function () {
      if (isVideoSettled) return;
      isVideoSettled = true;
      video.classList.add('visible');
    }, { once: true });

    // 视频自然播完触发（<= 25 秒的视频在此处完播）
    video.addEventListener('ended', function () {
      isClipFinished = true;
      namespace.clipEndedAt = Date.now();
      onKernelOrClipReady();
    }, { once: true });

    video.addEventListener('error', function () {
      setTimeout(function () { performExit(400); }, 500);
    }, { once: true });

    video.src = chosen.src;

    // 自动播放处理
    if (SOUND_ENABLED) {
      video.muted = false;
      var playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise.then(function () {
          namespace.isAudioMuted = false;
        }).catch(function () {
          video.muted = true;
          namespace.isAudioMuted = true;
          video.play().catch(function () {});
        });
      }
    } else {
      video.muted = true;
      namespace.isAudioMuted = true;
      video.play().catch(function () {});
    }
  }

  // 监听 DSH 内核就绪
  function monitorDshKernel() {
    var checkReady = function () {
      if (namespace.bootedAt !== null) return;
      var bootNode = document.querySelector('[data-dsh-boot]');
      if (bootNode) {
        var computed = getComputedStyle(bootNode);
        var arcVal = computed.getPropertyValue('--dsh-boot-arc').trim();
        if (arcVal && parseFloat(arcVal) >= 288) {
          namespace.clientReady();
          return;
        }
      }
      // DSH 页面主体就绪判定
      if (document.querySelector('#root') && document.querySelector('#root').children.length > 0) {
        namespace.clientReady();
      }
    };

    var observer = new MutationObserver(checkReady);
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true
    });
    setInterval(checkReady, 300);
  }

  function mount() {
    if (rootEl && rootEl.isConnected) return;
    injectStyles();
    var root = buildOverlay();
    if (document.body) {
      document.body.appendChild(root);
    } else {
      (document.documentElement || document).appendChild(root);
    }

    setTimeout(function () {
      if (!namespace.isLeaving && namespace.bootedAt === null) {
        namespace.clientReady();
      }
    }, HOLD_BUDGET_MS);

    earlyManifestPromise.then(function (data) {
      var clips = data && Array.isArray(data.clips) ? data.clips : [];
      startPlayback(clips);
    });

    monitorDshKernel();
  }

  if (document.body) {
    mount();
  } else {
    var observer = new MutationObserver(function () {
      if (document.body) {
        observer.disconnect();
        mount();
      }
    });
    observer.observe(document.documentElement, { childList: true });
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  }

})();
