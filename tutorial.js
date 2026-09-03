/**
 * tutorial.js — 首次进入分步引导（从 main.js 拆出）
 *
 * 自包含模块：步骤数据 + 迷你棋盘演示 + 渲染 + window 处理器。
 * 依赖：sfx（点击音效）、GRID_SIZE、全局 window.startGame。
 */

import { sfx } from "./audio.js";
import { GRID_SIZE } from "./state-mcp.js";

const TUTORIAL_KEY = "sf_tutorial_v1";
let tutorialIndex = 0;

const TUTORIAL_STEPS = [
  {
    icon: "🎯",
    title: "目标：打沉敌方舰队",
    text: "你和对战双方各在 5×5 海域里藏 <b>3 艘船</b>。轮流开火，<b>先把对方 7 个船格全部打中</b>，你就赢了！",
    demo: "goal",
  },
  {
    icon: "🚢",
    title: "第一步：藏好你的舰队",
    text: "开局先在自家棋盘点格子放船：<b>驱逐舰 3 格</b>、<b>护卫舰 2 格</b>、<b>潜艇 2 格</b>。点 🔄 旋转横 / 竖方向，放完 3 艘自动开战。",
    demo: "place",
  },
  {
    icon: "🔥",
    title: "第二步：开火对决",
    text: "轮到你时，点敌方海域的格子开火。<b>💥 命中</b> 或 <b>🌊 没中</b> 立刻显示。对手也会用策略还击，小心你的舰队被反打！",
    demo: "fire",
  },
  {
    icon: "🔒",
    title: "为什么你的船位很安全",
    text: "普通游戏里对手能偷看你的船在哪。这里你的船位被 <b>零知识加密</b> 锁住——游戏能验证每次开火结果对不对，<b>却看不到船的位置</b>。公平，且防作弊。",
    demo: "zk",
  },
  {
    icon: "🏆",
    title: "胜负与再来一局",
    text: "打光对方 7 个船格 → <b>🏆 胜利</b>；被对方打光 → 💀 失败。每局结束点「再来一局」即可重开。<br>祝你好运，司令员！",
    demo: "end",
  },
];

// 生成一个 5×5 迷你棋盘；occupied: [{r,c,cls,content}] 标记特殊格
function miniBoard(occupied = []) {
  let h = '<div class="mini-board">';
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const cell = occupied.find((x) => x.r === r && x.c === c);
      const cls = cell ? `mb-cell ${cell.cls}` : "mb-cell";
      h += `<div class="${cls}">${cell ? cell.content || "" : ""}</div>`;
    }
  }
  return h + "</div>";
}

function renderTutorialDemo(kind) {
  if (kind === "goal") {
    const mine = [
      // Destroyer (3 cells, row 0, horizontal) — steel gray
      { r: 0, c: 0, cls: "mb-ship mb-destroyer mb-bow-h" },
      { r: 0, c: 1, cls: "mb-ship mb-destroyer mb-mid-h" },
      { r: 0, c: 2, cls: "mb-ship mb-destroyer mb-stern-h" },
      // Frigate (2 cells, row 2, horizontal) — blue
      { r: 2, c: 3, cls: "mb-ship mb-frigate mb-bow-h" },
      { r: 2, c: 4, cls: "mb-ship mb-frigate mb-stern-h" },
      // Submarine (2 cells, row 4, horizontal) — green
      { r: 4, c: 1, cls: "mb-ship mb-submarine mb-bow-h" },
      { r: 4, c: 2, cls: "mb-ship mb-submarine mb-stern-h" },
    ];
    const enemy = [
      // Enemy ship partially hit
      { r: 1, c: 1, cls: "mb-ship mb-destroyer mb-bow-h" },
      { r: 1, c: 2, cls: "mb-ship mb-destroyer mb-stern-h" },
      { r: 3, c: 0, cls: "mb-hit", content: "💥" },
      { r: 3, c: 1, cls: "mb-miss", content: "🌊" },
    ];
    return `
      <div class="demo-goal">
        <div class="demo-side"><span class="demo-cap">你</span>${miniBoard(mine)}</div>
        <div class="demo-arrow">➜</div>
        <div class="demo-side"><span class="demo-cap">敌方</span>${miniBoard(enemy)}</div>
      </div>`;
  }
  if (kind === "place") {
    const ships = [
      // Destroyer — placed
      { r: 0, c: 0, cls: "mb-ship mb-destroyer mb-bow-h" }, { r: 0, c: 1, cls: "mb-ship mb-destroyer mb-mid-h" }, { r: 0, c: 2, cls: "mb-ship mb-destroyer mb-stern-h" },
      // Frigate — being placed (highlighted)
      { r: 2, c: 3, cls: "mb-ship mb-frigate mb-bow-h mb-placing" }, { r: 2, c: 4, cls: "mb-ship mb-frigate mb-stern-h mb-placing" },
      // Submarine — pending (ghost)
      { r: 4, c: 1, cls: "mb-ship mb-submarine mb-bow-h mb-ghost" }, { r: 4, c: 2, cls: "mb-ship mb-submarine mb-stern-h mb-ghost" },
    ];
    return `<div class="demo-place">${miniBoard(ships)}<div class="demo-hint">点格子放船 · 🔄 旋转方向</div></div>`;
  }
  if (kind === "fire") {
    const shots = [
      { r: 0, c: 0, cls: "mb-hit", content: "💥" },
      { r: 0, c: 2, cls: "mb-miss", content: "🌊" },
      { r: 1, c: 4, cls: "mb-hit", content: "💥" },
      { r: 3, c: 1, cls: "mb-miss", content: "🌊" },
      { r: 4, c: 3, cls: "mb-miss", content: "🌊" },
    ];
    return `<div class="demo-fire">${miniBoard(shots)}<div class="demo-hint">轮到你时 · 点敌方格开火</div></div>`;
  }
  if (kind === "zk") {
    const ships = [
      { r: 0, c: 0, cls: "mb-ship mb-destroyer mb-bow-h" }, { r: 0, c: 1, cls: "mb-ship mb-destroyer mb-mid-h" }, { r: 0, c: 2, cls: "mb-ship mb-destroyer mb-stern-h" },
      { r: 2, c: 3, cls: "mb-ship mb-frigate mb-bow-h" }, { r: 2, c: 4, cls: "mb-ship mb-frigate mb-stern-h" },
      { r: 4, c: 1, cls: "mb-ship mb-submarine mb-bow-h" }, { r: 4, c: 2, cls: "mb-ship mb-submarine mb-stern-h" },
    ];
    return `<div class="demo-zk">${miniBoard(ships)}<div class="demo-lock">🔒</div><div class="demo-hint">船位已加密 · 对手看不到</div></div>`;
  }
  // end
  return `
    <div class="demo-end">
      <div class="end-badge win">🏆<span>胜利</span></div>
      <div class="end-vs">VS</div>
      <div class="end-badge lose">💀<span>失败</span></div>
    </div>`;
}

function renderTutorial() {
  const root = document.getElementById("tutorial-overlay");
  if (!root) return;
  const step = TUTORIAL_STEPS[tutorialIndex];
  const total = TUTORIAL_STEPS.length;
  const dots = TUTORIAL_STEPS.map((_, i) =>
    `<span class="tut-dot ${i === tutorialIndex ? "is-active" : ""}"></span>`
  ).join("");
  const isLast = tutorialIndex === total - 1;
  root.hidden = false;
  root.innerHTML = `
    <div class="tut-card" role="dialog" aria-modal="true" aria-label="玩法教程">
      <button class="tut-close" onclick="window.closeTutorial()" aria-label="关闭教程">✕</button>
      <div class="tut-step-no">${tutorialIndex + 1} / ${total}</div>
      <div class="tut-icon">${step.icon}</div>
      <h2 class="tut-title">${step.title}</h2>
      <div class="tut-text">${step.text}</div>
      <div class="tut-demo">${renderTutorialDemo(step.demo)}</div>
      <div class="tut-dots">${dots}</div>
      <div class="tut-actions">
        <button class="tut-skip" onclick="window.closeTutorial()">跳过</button>
        <div class="tut-nav">
          ${tutorialIndex > 0 ? `<button class="tut-prev" onclick="window.tutorialPrev()">上一步</button>` : ""}
          <button class="tut-next" onclick="${isLast ? "window.closeTutorial(); window.startGame();" : "window.tutorialNext()"}">${isLast ? "开始游戏 🚀" : "下一步"}</button>
        </div>
      </div>
    </div>`;
}

window.openTutorial = () => {
  tutorialIndex = 0;
  renderTutorial();
  // 点遮罩空白处也能关掉教程，避免挡住下面的「开始游戏」按钮
  const root = document.getElementById("tutorial-overlay");
  if (root) root.onclick = (e) => { if (e.target === root) window.closeTutorial(); };
  sfx.click();
};
window.closeTutorial = () => {
  const r = document.getElementById("tutorial-overlay");
  if (r) { r.hidden = true; r.innerHTML = ""; }
  try { localStorage.setItem(TUTORIAL_KEY, "1"); } catch (e) {}
};
window.tutorialNext = () => {
  if (tutorialIndex < TUTORIAL_STEPS.length - 1) { tutorialIndex++; renderTutorial(); }
  else { window.closeTutorial(); }
};
window.tutorialPrev = () => {
  if (tutorialIndex > 0) { tutorialIndex--; renderTutorial(); }
};
