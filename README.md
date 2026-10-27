# dsh-boot-animation

DeepSeek Harness (DSH) 纯净全屏启动视频动画插件。

---

## 🌟 特性

* **极致纯净全屏**：无进度条、无提示文字、无多余 UI，纯黑底 `100vw × 100vh` 沉浸式电影级播放。
* **25 秒完播限制**：
  * $\le 25\text{s}$ 视频：完整播放至最后一帧后平滑淡出。
  * $> 25\text{s}$ 视频：第 25 秒自动触发平滑转场，绝不超时拖沓。
* **DSH 规范原生集成**：符合 DSH 插件规范，支持在客户端内直接通过仓库名一键安装。
* **现代浏览器自动播放降级**：优先尝试有声播放，受限时静音起播，点击屏幕任意位置可解锁声音。
* **键盘快捷支持**：按 `Esc` 或 `Space` 随时提前跳过动画。

---

## 📦 安装方式

### 方式 1：DSH 客户端内直接安装（推荐）

1. 打开 DeepSeek 客户端。
2. 进入 **「插件管理」** / **「社区插件市场」**。
3. 在安装输入框输入本仓库名：
   ```
   i-WZX/dsh-boot-animation
   ```
4. 点击安装并重启 DSH 客户端即可。

### 方式 2：DSH CLI 命令行安装

```bash
dsh plugin --profile desktop add github:i-WZX/dsh-boot-animation
```

---

## 🎬 自定义视频

将您的视频放置到插件目录下的 `assets/videos/` 中（支持 `.mp4`, `.webm` 格式，支持多片随机轮播）：
```
assets/videos/DeepSeek.mp4
```

---

## 📄 许可

MIT License
