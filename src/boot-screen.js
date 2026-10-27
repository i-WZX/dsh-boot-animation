// DeepSeek Boot Animation - Pre-boot Screen (Pure Cinematic Fullscreen & Preview Support)
// 
// 极致纯净全屏沉浸模式：
// 1. 无任何多余 UI（无进度条、无提示字、无控制按钮、全屏无边框纯黑底）。
// 2. 视频铺满整个视口 (100vw x 100vh, object-fit: cover)。
// 3. 严格执行 25 秒上限：
//    - 视频 <= 25 秒：完整播放至最后一帧后平滑淡出露出 DSH 界面。
//    - 视频 > 25 秒：在第 25 秒平滑截断淡出进入 DSH。
// 4. 交互：点击屏幕任意处可解锁原声音频，按 Esc 或空格键可提前跳过。
// 5. 播放完成后平滑淡入 DSH 主界面，并彻底销毁遮罩节点。
// 6. 支持全局 preview(options) 接口供 DSH 设置面板实时满屏预览。

;(function () {
  'use strict';

  var cfg = globalThis.__DSH_BOOT_ANIM_CFG__ || {};
  if (globalThis.__DSH_BOOT_ANIM__) return;

  var BASE_ROUTE = cfg.base || '/plugins/dsh-boot-animation';
  var MANIFEST_URL = cfg.manifest || (BASE_ROUTE + '/clips.json');
  var DEFAULT_ENTER_MODE = cfg.enterMode || 'end'; 
  var DEFAULT_FADE_MS = typeof cfg.fadeMs === 'number' && cfg.fadeMs >= 200 ? cfg.fadeMs : 1500;
  var DEFAULT_MAX_DURATION_MS = typeof cfg.maxDurationMs === 'number' && cfg.maxDurationMs > 0 ? cfg.maxDurationMs : 25000;
  var DEFAULT_SOUND = cfg.sound !== false;
  var DEFAULT_CLICK_TO_ENTER = cfg.clickToEnter === true;
  var HOLD_BUDGET_MS = 30000;

  var activePreview = null; // { name, onDone, timer }

  var namespace = {
    version: '2.0.0-pure-cinematic',
    maxDurationMs: DEFAULT_MAX_DURATION_MS,
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
      if (activeInstance) activeInstance.performExit(500);
    },
    preview: function (options) {
      if (!options || typeof options.name !== 'string') return false;
      if (activePreview !== null || (activeInstance && !activeInstance.isExited)) {
        return false;
      }
      var previewInstance = createOverlaySession({
        clipSrc: BASE_ROUTE + '/clip/' + encodeURIComponent(options.name),
        fadeMs: typeof options.fadeMs === 'number' ? options.fadeMs : DEFAULT_FADE_MS,
        enterMode: options.enterMode || DEFAULT_ENTER_MODE,
        sound: options.sound !== false,
        clickToEnter: options.clickToEnter === true,
        maxDurationMs: DEFAULT_MAX_DURATION_MS,
        isPreview: true,
        onDone: function () {
          activePreview = null;
          if (typeof options.onDone === 'function') options.onDone();
        }
      });
      activePreview = { name: options.name, instance: previewInstance };
      previewInstance.start();
      return true;
    }
  };
  globalThis.__DSH_BOOT_ANIM__ = namespace;

  var activeInstance = null;

  function ensureStyles(fadeMs) {
    var styleId = 'dsh-boot-pure-style';
    var style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement('style');
      style.id = styleId;
      (document.head || document.documentElement).appendChild(style);
    }
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
      '  transition: opacity ' + (fadeMs / 1000) + 's cubic-bezier(0.4, 0, 0.2, 1) !important;',
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
      '  transition: opacity 0.3s ease-in-out !important;',
      '}',
      '#dsh-boot-video.visible {',
      '  opacity: 1 !important;',
      '}'
    ].join('\n');
  }

  function createOverlaySession(opts) {
    var clipSrc = opts.clipSrc;
    var fadeMs = opts.fadeMs;
    var enterMode = opts.enterMode;
    var soundEnabled = opts.sound;
    var clickToEnter = opts.clickToEnter;
    var maxDurationMs = opts.maxDurationMs;
    var isPreview = opts.isPreview === true;
    var onDone = opts.onDone;

    var rootEl = null;
    var videoEl = null;
    var isLeaving = false;
    var isExited = false;
    var isVideoSettled = false;
    var isClipFinished = false;
    var hasDissolveStarted = false;
    var maxTimer = null;
    var audioFadeTimer = null;

    function build() {
      ensureStyles(fadeMs);
      var root = document.createElement('div');
      root.id = 'dsh-boot-overlay';
      root.setAttribute('data-state', 'booting');

      var video = document.createElement('video');
      video.id = 'dsh-boot-video';
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.preload = 'auto';

      if (enterMode === 'click') {
        video.loop = true;
      }

      root.appendChild(video);
      rootEl = root;
      videoEl = video;

      // 交互：点击屏幕
      root.addEventListener('click', function (e) {
        if (isLeaving) return;
        if (clickToEnter || enterMode === 'click') {
          performExit(fadeMs);
          return;
        }
        if (videoEl && soundEnabled) {
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

      // 键盘快捷键 Esc / 空格跳过
      var keyHandler = function (e) {
        if (isLeaving) return;
        if (e.key === 'Escape' || e.code === 'Space') {
          performExit(fadeMs / 2);
        }
      };
      window.addEventListener('keydown', keyHandler);

      session.destroyKeyHandler = function () {
        window.removeEventListener('keydown', keyHandler);
      };

      return root;
    }

    function fadeOutAudio(spanMs) {
      if (!videoEl || videoEl.muted) return;
      var startVol = videoEl.volume;
      var startTime = Date.now();
      audioFadeTimer = setInterval(function () {
        var elapsed = Date.now() - startTime;
        var factor = 1 - (elapsed / spanMs);
        if (factor <= 0) {
          clearInterval(audioFadeTimer);
          audioFadeTimer = null;
          if (videoEl) {
            videoEl.volume = 0;
            try { videoEl.pause(); } catch (e) {}
          }
        } else if (videoEl) {
          videoEl.volume = Math.max(0, startVol * factor);
        }
      }, 40);
    }

    function performExit(spanMs) {
      if (isLeaving) return;
      isLeaving = true;
      hasDissolveStarted = true;

      if (maxTimer) {
        clearTimeout(maxTimer);
        maxTimer = null;
      }

      var exitSpan = typeof spanMs === 'number' && spanMs > 0 ? spanMs : fadeMs;
      if (rootEl) {
        rootEl.style.transitionDuration = (exitSpan / 1000) + 's';
        rootEl.setAttribute('data-state', 'leaving');
      }

      fadeOutAudio(exitSpan);

      setTimeout(function () {
        isExited = true;
        if (session.destroyKeyHandler) session.destroyKeyHandler();
        if (rootEl && rootEl.parentNode) {
          rootEl.parentNode.removeChild(rootEl);
        }
        if (videoEl) {
          try { videoEl.pause(); } catch (e) {}
          videoEl.src = '';
        }
        if (typeof onDone === 'function') onDone();
      }, exitSpan + 100);
    }

    function checkHandOff() {
      if (isLeaving) return;
      if (isPreview) {
        // 预览模式播完即退
        if (isClipFinished) performExit(fadeMs);
        return;
      }
      if (isClipFinished && namespace.bootedAt !== null) {
        performExit(fadeMs);
      }
    }

    function start() {
      var root = build();
      if (document.body) {
        document.body.appendChild(root);
      } else {
        (document.documentElement || document).appendChild(root);
      }

      videoEl.addEventListener('timeupdate', function () {
        var curMs = videoEl.currentTime * 1000;
        // 模式判断与 25 秒上限截断
        if (enterMode === 'tail' && videoEl.duration && !hasDissolveStarted) {
          var remaining = (videoEl.duration * 1000) - curMs;
          if (remaining <= fadeMs) {
            hasDissolveStarted = true;
            isClipFinished = true;
            checkHandOff();
          }
        }
        if (curMs >= (maxDurationMs - fadeMs) && !hasDissolveStarted) {
          hasDissolveStarted = true;
          isClipFinished = true;
          performExit(fadeMs);
        }
      });

      videoEl.addEventListener('loadedmetadata', function () {
        maxTimer = setTimeout(function () {
          if (!hasDissolveStarted && !isLeaving) {
            hasDissolveStarted = true;
            isClipFinished = true;
            performExit(fadeMs);
          }
        }, maxDurationMs);
      }, { once: true });

      videoEl.addEventListener('canplay', function () {
        if (isVideoSettled) return;
        isVideoSettled = true;
        videoEl.classList.add('visible');
      }, { once: true });

      videoEl.addEventListener('ended', function () {
        isClipFinished = true;
        namespace.clipEndedAt = Date.now();
        checkHandOff();
      }, { once: true });

      videoEl.addEventListener('error', function () {
        setTimeout(function () { performExit(400); }, 300);
      }, { once: true });

      videoEl.src = clipSrc;

      if (soundEnabled) {
        videoEl.muted = false;
        var p = videoEl.play();
        if (p !== undefined) {
          p.then(function () {
            namespace.isAudioMuted = false;
          }).catch(function () {
            videoEl.muted = true;
            namespace.isAudioMuted = true;
            videoEl.play().catch(function () {});
          });
        }
      } else {
        videoEl.muted = true;
        namespace.isAudioMuted = true;
        videoEl.play().catch(function () {});
      }
    }

    var session = {
      start: start,
      performExit: performExit,
      checkHandOff: checkHandOff,
      get isLeaving() { return isLeaving; },
      get isExited() { return isExited; }
    };
    return session;
  }

  function onKernelOrClipReady() {
    if (activeInstance && !activeInstance.isLeaving) {
      activeInstance.checkHandOff();
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

  // 正常开机启动流程
  function runBootSequence() {
    fetch(MANIFEST_URL, { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : { clips: [] }; })
      .catch(function () { return { clips: [] }; })
      .then(function (data) {
        var allClips = data && Array.isArray(data.clips) ? data.clips : [];
        var enabledClips = allClips.filter(function (c) { return c.enabled !== false; });
        if (enabledClips.length === 0) {
          enabledClips = allClips;
        }
        if (enabledClips.length === 0) {
          // 无可用视频，快速退出
          setTimeout(function () {
            if (activeInstance) activeInstance.performExit(300);
          }, 400);
          return;
        }

        var chosen = enabledClips[Math.floor(Math.random() * enabledClips.length)];
        activeInstance = createOverlaySession({
          clipSrc: chosen.src,
          fadeMs: DEFAULT_FADE_MS,
          enterMode: DEFAULT_ENTER_MODE,
          sound: DEFAULT_SOUND,
          clickToEnter: DEFAULT_CLICK_TO_ENTER,
          maxDurationMs: DEFAULT_MAX_DURATION_MS,
          isPreview: false,
          onDone: function () {
            activeInstance = null;
          }
        });
        activeInstance.start();

        setTimeout(function () {
          if (namespace.bootedAt === null) {
            namespace.clientReady();
          }
        }, HOLD_BUDGET_MS);
      });

    monitorDshKernel();
  }

  if (document.body) {
    runBootSequence();
  } else {
    var observer = new MutationObserver(function () {
      if (document.body) {
        observer.disconnect();
        runBootSequence();
      }
    });
    observer.observe(document.documentElement, { childList: true });
    document.addEventListener('DOMContentLoaded', runBootSequence, { once: true });
  }

})();
