# Antigravity MiniMap (`antigravity-minimap`)

**Antigravity MiniMap（对话小地图）** 是一款专为 **Antigravity Desktop** 打造的轻量化历史对话导航插件。它在聊天视口右侧提供极简的无背景悬浮标尺与顶部轮次计数，悬停即可展开完整的提问目录，支持跨分页精准跳转、实时滚动同步与丝滑过渡动画。

---

## ✨ 核心特性 (Features)

- **极简无背景右侧标尺 (Minimalist Floating Ruler)**
  - 仅保留顶部总轮次数字与右侧标尺刻度，无背景遮挡，完美融入深色/浅色主题。
  - 根据对话轮数自动切换刻度密度（标准 / 紧凑 / 超密模式），长对话依然清爽。
- **实时滚动同步 (Real-Time Scroll Sync)**
  - 随聊天窗口滚动实时高亮当前屏幕最上方的提问刻度；滑动到底部时自动对齐最新一轮提问。
- **悬停展开提问目录 (Hover & Pin Directory Card)**
  - 鼠标悬停标尺即可滑出完整目录，展示每轮提问的序号（`#1`, `#2`...）、时间戳与提问摘要。
  - 支持固定面板（`固定` 按钮）、首轮/最新快捷跳转，以及关键字实时检索与 `#轮次` 回车直达。
- **跨分页完整上下文跳转与动画 (Full-Turn Context Jump & Smooth Animation)**
  - 点击任意刻度或目录项，自动将对应轮次的问题置于视口顶部并完整展示下方回答。
  - 若目标轮次位于尚未挂载的历史分页中，自动通过轨迹分页控制器加载完整问答区间后再执行 `Ease-Out-Quart` 丝滑滚动与聚光灯呼吸高亮。
- **严格的会话隔离与超长对话优化 (Conversation Isolation & Large-Chat Ready)**
  - 严格校验 URL 与轨迹控制器 `conversationId`，彻底杜绝切换会话时的缓存串台。
  - 支持本地 `transcript.jsonl` 快速回退解析与分批请求，轻松应对上百轮超长对话。
- **原生侧边栏面板支持 (Optional Auxiliary Sidecar Pane)**
  - 同时提供 Antigravity 原生右侧常驻面板入口（`SIDECAR_UI_ENTRYPOINT_AUX_PANE`）。

---

## 🚀 安装与使用 (Installation & Usage)

在仓库根目录下运行以下命令（需已安装 Python 3）：

```powershell
# 安装插件并立即在当前运行的 Antigravity Desktop 窗口中热生效
python manage.py install

# 查看插件安装状态与实时挂载状态
python manage.py status

# 在当前运行窗口中启用 / 重新注入小地图
python manage.py enable

# 从当前运行窗口中移除悬浮小地图
python manage.py disable

# 卸载插件
python manage.py uninstall
```

---

## 📂 目录结构 (Project Structure)

```text
antigravity-minimap/
├── plugin.json                  # Antigravity 插件清单
├── manage.py                    # 安装、卸载与 CDP 热注入管理工具
├── assets/
│   └── logo.svg                 # 插件图标
├── compat/
│   ├── minimap-widget.cjs       # 渲染进程 Shadow DOM 小地图核心组件
│   ├── runtime-ui.mjs           # CDP 连接与热重载注入器
│   └── platform.mjs             # 跨平台路径与 DevToolsActivePort 解析
└── sidecars/
    └── minimap/
        ├── sidecar.json         # Sidecar 声明配置
        ├── main.mjs             # Sidecar 后端进程与实时注入守护
        ├── sdk.mjs              # Sidecar 通信协议封装
        └── index.html           # 右侧原生常驻面板 UI
```

---

## 👥 创作者 (Creators & Authors)

- **浮士德 ([@www12354jkl](https://github.com/www12354jkl))** — 产品构思、交互设计与体验打磨 (Creator & Product Designer)
- **Antigravity ([@gemini-code-assist](https://github.com/gemini-code-assist))** — 架构设计与核心代码实现 (Co-Creator & Lead Developer)

---

## 📄 开源协议 (License)

本项目基于 [MIT License](./LICENSE) 开源。
