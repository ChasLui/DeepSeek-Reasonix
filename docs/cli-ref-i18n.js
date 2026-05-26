/* CLI-reference page translations + scrollspy. Layered on top of i18n.js. */

(() => {
  const R = window.Reasonix;
  if (!R) return;

  const en = {
    "cli.badge": "Shell · Slash Commands · Keyboard · Mouse",
    "cli.title.line1": "CLI Reference",
    "cli.title.line2": "every command, key, and flag",
    "cli.sub":
      "Every shell subcommand, every TUI slash command, every keybinding. The in-app <code>/help</code> and <code>/keys</code> panels are the live source of truth — this page is the printable companion.",

    "cli.toc.title": "On this page",
    "cli.toc.shell": "Shell subcommands",
    "cli.toc.slash": "Slash commands",
    "cli.toc.keyboard": "Keyboard",
    "cli.toc.mouse": "Mouse",
    "cli.toc.copypaste": "Copy / paste",

    "th.cmd": "Command",
    "th.what": "What it does",
    "th.key": "Key",
    "th.action": "Action",

    "sh.title": "Shell subcommands",
    "sh.body":
      "Run <code>reasonix --help</code> (or any subcommand with <code>--help</code>) for the full flag list. Headline subcommands:",
    "sh.flags.title": "Notable runtime flags (chat / code)",

    "sl.title": "Slash commands",
    "sl.body":
      "Type <code>/</code> mid-chat to open the picker. Aliases shown in parentheses. Code-mode-only commands marked <strong>(code)</strong>.",
    "sl.h.chatops": "Chat ops",
    "sl.h.setup": "Setup",
    "sl.h.info": "Info",
    "sl.h.extend": "Extend",
    "sl.h.session": "Session",
    "sl.h.code": "Code mode",
    "sl.h.jobs": "Jobs (code mode)",
    "sl.h.advanced": "Advanced",

    "kb.title": "Keyboard",
    "kb.h.editgate": "Edit-gate (code mode)",

    "ms.title": "Mouse",
    "ms.body":
      "Reasonix leaves SGR 1000/1006 mouse tracking off by default so plain drag-select and right-click stay owned by the terminal. If your terminal does not translate wheel input in the alternate screen, use <code>Alt+M</code>, <code>/mouse on</code>, or config <code>mouseTracking: true</code> to opt into app-level wheel routing. In that mode, plain drag may be captured by the app; use <code>Shift+Drag</code>, <code>Alt+M</code>, or <code>/mouse off</code> to return to terminal-native selection.",

    "cp.title": "Copy / paste",
    "cp.body":
      "The default path is <strong>terminal-native</strong>. Drag to select, then use your terminal's normal copy keys. When tracking is on, use <code>Shift+Drag</code> if your terminal captures plain drag, or run <code>/mouse off</code>.",
    "cp.h.drag": "When drag-select doesn't work",
    "cp.body.drag":
      "In SSH / mosh / tmux, the alt-screen buffer prevents the terminal from extending the selection past the visible viewport — there is no scrollback above the alt-screen to drag into. Two fixes:",
    "cp.fix1":
      "<strong><code>/copy</code></strong> — open copy mode in-app. Snapshots the current chat to a navigable buffer; mouse drag yanks a character span, double-click yanks a word/path segment, triple-click yanks the line, and <code>y</code> keeps the keyboard path. Clipboard writes go through OSC 52 with a temp-file fallback for terminals that don't support it.",
    "cp.fix2":
      "<strong><code>--no-alt-screen</code></strong> — render to shell scrollback instead. Drag-select then works terminal-natively (the chat content is real lines in the scrollback above your cursor). Trade-off: redraw can ghost on resize.",
    "cp.h.copymode": "<code>/copy</code> — copy mode keys",
    "cp.body.osc":
      "<code>y</code> with no active selection yanks just the current line. The yank goes through OSC 52 first (works through SSH, mosh, tmux with <code>set -g set-clipboard on</code>); content larger than 75 KB falls back to a temp file whose path is printed on exit.",
  };

  const zh = {
    "cli.badge": "Shell · 斜杠命令 · 快捷键 · 鼠标",
    "cli.title.line1": "CLI 参考",
    "cli.title.line2": "所有命令、快捷键和 flag",
    "cli.sub":
      "所有 shell 子命令、所有 TUI 斜杠命令、所有快捷键一览。应用内 <code>/help</code> 与 <code>/keys</code> 面板是权威来源——本页是可检索的离线副本。",

    "cli.toc.title": "本页目录",
    "cli.toc.shell": "Shell 子命令",
    "cli.toc.slash": "斜杠命令",
    "cli.toc.keyboard": "快捷键",
    "cli.toc.mouse": "鼠标",
    "cli.toc.copypaste": "复制 / 粘贴",

    "th.cmd": "命令",
    "th.what": "作用",
    "th.key": "按键",
    "th.action": "效果",

    "sh.title": "Shell 子命令",
    "sh.body": "任意子命令加 <code>--help</code> 可查完整 flag 列表。主要子命令：",
    "sh.flags.title": "常用运行时 flag（chat / code）",

    "sl.title": "斜杠命令",
    "sl.body":
      "输入 <code>/</code> 在聊天中打开选择器。括号内为别名。仅 code 模式可用的命令标注 <strong>（code）</strong>。",
    "sl.h.chatops": "聊天操作",
    "sl.h.setup": "设置",
    "sl.h.info": "信息",
    "sl.h.extend": "扩展",
    "sl.h.session": "会话",
    "sl.h.code": "Code 模式",
    "sl.h.jobs": "后台任务（code 模式）",
    "sl.h.advanced": "高级",

    "kb.title": "快捷键",
    "kb.h.editgate": "编辑门控（code 模式）",

    "ms.title": "鼠标",
    "ms.body":
      "Reasonix 默认关闭 SGR 1000/1006 mouse tracking，让普通拖选和右键继续归终端处理。如果你的终端在 alternate screen 中不会转换滚轮输入，可用 <code>Alt+M</code>、<code>/mouse on</code> 或配置 <code>mouseTracking: true</code> 开启应用级滚轮路由。该模式下普通拖动可能被应用捕获；用 <code>Shift+拖动</code>、<code>Alt+M</code> 或 <code>/mouse off</code> 可回到终端原生选择。",

    "cp.title": "复制 / 粘贴",
    "cp.body":
      "默认走<strong>终端原生</strong>路径。拖拽选中文本，再用终端本身的复制快捷键。tracking 开启时若普通拖动被捕获，用 <code>Shift+拖动</code> 或运行 <code>/mouse off</code>。",
    "cp.h.drag": "拖拽选择不生效时",
    "cp.body.drag":
      "SSH / mosh / tmux 下，alt-screen 缓冲区会阻止终端把选区延伸到可视视口以外——alt-screen 上方根本没有 scrollback 可拖入。两种解决方式：",
    "cp.fix1":
      "<strong><code>/copy</code></strong> — 在应用内打开复制模式，把当前聊天快照到可导航的缓冲区；鼠标拖选会复制字符级片段，双击复制词或路径片段，三击复制整行，<code>y</code> 仍保留键盘路径。复制先走 OSC 52，不支持的终端会退到临时文件。",
    "cp.fix2":
      "<strong><code>--no-alt-screen</code></strong> — 改为渲染到 shell scrollback。拖拽选择恢复终端原生（聊天内容就是光标上方的真实行）。代价：窗口大小改变时可能出现重绘残影。",
    "cp.h.copymode": "<code>/copy</code> — 复制模式快捷键",
    "cp.body.osc":
      "没有活动选区时按 <code>y</code> 只复制当前行。复制先走 OSC 52（通过 SSH、mosh、开了 <code>set -g set-clipboard on</code> 的 tmux 均可用）；超过 75 KB 的内容退到临时文件，路径在退出时打印。",
  };

  const DICT = { en: en, zh: zh };

  function applyCli(lang) {
    const dict = DICT[lang] || DICT.en;
    for (const el of document.querySelectorAll("[data-i18n]")) {
      const key = el.getAttribute("data-i18n");
      if (dict[key] !== undefined) el.innerHTML = dict[key];
    }
  }

  applyCli(R.lang());
  R.onLangChange(applyCli);

  const sections = Array.prototype.slice.call(document.querySelectorAll(".guide-body section[id]"));
  const tocLinks = Array.prototype.slice.call(document.querySelectorAll(".guide-toc a"));
  if (sections.length && tocLinks.length && "IntersectionObserver" in window) {
    const byId = {};
    for (const a of tocLinks) {
      const href = a.getAttribute("href") || "";
      const id = href.replace(/^#/, "");
      if (id) byId[id] = a;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const link = byId[e.target.id];
          if (!link) return;
          if (e.isIntersecting) {
            for (const l of tocLinks) {
              l.classList.remove("is-active");
            }
            link.classList.add("is-active");
          }
        }
      },
      { rootMargin: "-30% 0px -60% 0px", threshold: 0 },
    );
    for (const s of sections) {
      io.observe(s);
    }
  }
})();
