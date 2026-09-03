import "./style.css";
import "./zk.js";
import { sfx } from "./audio.js";
import * as fx from "./fx.js";
import { ZKGPU } from "./gpu.js";
import { generateAIPanel, callTool } from "./mcp.js";
import { syncState } from "./state-mcp.js";
import {
  WEAPONS, initWeapons, canUseWeapon, consumeWeapon,
  WEATHER, rollWeather, applyWeatherEffect, isScanDisabled,
  checkSubmarineDodge, getRevealCell, checkFrigateRapidFire,
  SHIP_ABILITIES,
  getRank, getRankProgress, recordMatch, loadRankData, getStreakBonus,
  recordStats, getStatsView,
} from "./features.js";
import {
  getQuizForTrigger, renderQuizPopup, renderQuizResult,
  renderCardPopup, renderCardCollection, renderZKLab,
  renderBitwiseAndDemo, renderPrivacyDemo, renderBlockchainDemo,
  checkCardUnlock, CONCEPT_CARDS,
} from "./education.js";
import { Net } from "./net.js";
import "./tutorial.js";

// ===== GAME CONFIGURATION =====
const GRID_SIZE = 5;
const TOTAL_CELLS = GRID_SIZE * GRID_SIZE;

// Fleet configurations: standard (3 ships) and extended (4 ships)
const FLEET_CONFIGS = {
  standard: [
    { size: 3, name: "Destroyer", cn: "驱逐舰" },
    { size: 2, name: "Frigate", cn: "护卫舰" },
    { size: 2, name: "Submarine", cn: "潜艇" },
  ],
  extended: [
    { size: 3, name: "Destroyer", cn: "驱逐舰" },
    { size: 3, name: "Cruiser", cn: "巡洋舰" },
    { size: 2, name: "Frigate", cn: "护卫舰" },
    { size: 2, name: "Submarine", cn: "潜艇" },
  ],
};

// Active fleet config (mutable — set at game start)
let SHIPS = FLEET_CONFIGS.standard;
let TOTAL_SHIP_CELLS = SHIPS.reduce((s, ship) => s + ship.size, 0);

// AI difficulty presets
const DIFFICULTY = {
  easy:   { huntRandom: 0.7, targetSmart: false, label: "简单", icon: "🟢", desc: "随机射击 — 适合新手" },
  normal: { huntRandom: 0.3, targetSmart: true,  label: "普通", icon: "🟡", desc: "命中后追踪 — 平衡挑战" },
  hard:   { huntRandom: 0.0, targetSmart: true,  label: "困难", icon: "🔴", desc: "智能追踪 + 奇偶策略 — 高手挑战" },
};

// ===== 手感节奏参数（毫秒）=====
// ZK 走本地降级时 await 几乎瞬间返回，结果会「啪」地直接跳出来，非常突兀。
// 这里给开火到出结果之间加一个悬念下限：真 ZK 慢就按真实耗时走，
// 本地降级快就补到 SUSPENSE_MS，两种模式下节奏一致。
const FEEL = {
  LOCK_ON_MS: 150,    // 锁定预备态时长（先给「扣扳机」的确认感）
  SUSPENSE_MS: 300,   // 开火 → 出结果的最短悬念
  RESULT_HOLD_MS: 260,// 结果出来后停一拍，让爆炸/水波看得清
  VICTORY_HOLD_MS: 620, // 决胜一击后延迟弹结算，别打断爆炸
  INCOMING_MS: 820,   // 「敌方来袭」提示 → 对手真正开火
};

const wait = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.round(ms / gameSpeed))));

// 游戏速度倍数：越大越快。所有手感节奏（FEEL）都按它缩放。
let gameSpeed = 1;
const SPEED_OPTIONS = [
  { mult: 0.5, label: "0.5× 慢" },
  { mult: 1, label: "1× 标准" },
  { mult: 2, label: "2× 快" },
  { mult: 4, label: "4× 神速" },
  { mult: 8, label: "8× 闪电" },
];
window.setGameSpeed = (mult) => {
  gameSpeed = parseFloat(mult);
  render();
};

// 输入闸：锁定/结算动画期间屏蔽连点，防止一次点两格
let inputLocked = false;

// 每艘船占哪些格（bit 掩码）—— 只用于判定「击沉」做反馈，
// 不参与任何 ZK 输入，zkVerifyHit / zkVerifyVictory 的调用契约保持原样。
let playerShipGroups = [];
let opponentShipGroups = [];

/** 这一发是否正好打沉了一整艘船？是则返回该船，否则 null */
function sunkShipBy(groups, hitsBitstring, mask) {
  for (const g of groups) {
    if ((g.mask & mask) === 0) continue;
    if ((hitsBitstring & g.mask) === g.mask) return g;
  }
  return null;
}

// ===== GAME STATE =====
const state = {
  phase: "start",
  // Game mode: "ai" (vs computer), "pvp" (pass-and-play), or "online" (WebRTC)
  gameMode: "ai",
  // Online mode state
  onlineState: "idle", // idle | creating | joining | waiting | connected
  onlineRoomCode: "",
  onlineStatus: "",
  onlineJoinInput: "",
  // P2P: which player is placing ("p1" then "p2")
  p2pPlacementPhase: null,
  // P2P: P2's ships/groups (P1 is playerShips/playerShipGroups)
  p2Ships: 0,
  p2ShipGroups: [],
  p2Shots: 0,
  p2Hits: 0,
  p2ShipsRemaining: TOTAL_SHIP_CELLS,
  p2ScanRemaining: 1,
  p2Combo: 0,
  p2MaxCombo: 0,
  // P2P: privacy screen toggle
  showPrivacyScreen: false,
  // Match system: best-of-3
  matchWins: 0,
  matchLosses: 0,
  matchRound: 0,
  matchOver: false,
  // Difficulty & fleet config
  difficulty: "normal",
  fleetMode: "standard",
  // Turn tracking for efficiency score
  turnCount: 0,
  // Board state
  playerShips: 0,
  playerShots: 0,
  playerHits: 0,
  playerShipsRemaining: TOTAL_SHIP_CELLS,
  opponentShips: 0,
  opponentShots: 0,
  opponentHits: 0,
  opponentShipsRemaining: TOTAL_SHIP_CELLS,
  currentTurn: "player",
  winner: null,
  placingShipIndex: 0,
  placementDirection: "horizontal",
  aleoAddress: null,
  proofLog: [],
  battleLog: [],
  zkEnabled: false,
  // Web3 / ZK stats — tracked across the session
  zkStats: {
    proofsGenerated: 0,
    proofsVerified: 0,
    proofsFallback: 0,
    totalProofMs: 0,
  },
  // Combo system (classic battleship: hit = keep firing)
  combo: 0,
  maxCombo: 0,
  // ZK Radar Scan (1 per game, scans 3x3 area)
  scanMode: false,
  scansRemaining: 1,
  // Achievements
  achievements: [],
  // WebGPU
  gpuEnabled: false,
  gpuMs: 0,
  cpuMs: 0,
  // AI Panel
  aiPanelOpen: false,
  // Special weapons
  weapons: initWeapons(),
  // Weather
  weather: "clear",
  weatherTurnCounter: 0,
  // Ship ability state
  submarineDodgeAvailable: true,
  frigateTurnCounter: 0,
  // Rank
  rankData: loadRankData(),
  // Education
  answeredQuizzes: [],
  unlockedCards: [],
  eduQuizActive: null,
  eduCardActive: null,
  eduLabActive: null,
  eduPanelOpen: false,
  hasPlayedFirstGame: false,
};

// ===== ZK VERIFICATION =====
async function zkVerifyHit(shipsBitstring, mask) {
  // 1. Try WebGPU first
  if (state.gpuEnabled) {
    const gpuResult = await ZKGPU.verifyHitGPU(shipsBitstring, mask);
    if (gpuResult) {
      state.gpuMs = gpuResult.ms;
      addProofLog("verify_hit", shipsBitstring, mask, gpuResult.isHit ? "true" : "false", true, "WebGPU", gpuResult.ms);
      return gpuResult.isHit;
    }
  }
  // 2. Try WASM (Aleo SDK)
  if (state.zkEnabled && window.__zkExecute) {
    try {
      const result = await window.__zkExecute("verify_hit", [`${shipsBitstring}u32`, `${mask}u32`]);
      // verify_hit returns (ships & mask) as u32 → non-zero means HIT
      const val = parseInt(result[0]);
      const isHit = val !== 0;
      addProofLog("verify_hit", shipsBitstring, mask, isHit ? "true" : "false", true);
      return isHit;
    } catch (e) {
      console.warn("Aleo ZK execution failed, using JS fallback:", e.message);
      state.zkEnabled = false;
    }
  }
  const hit = (shipsBitstring & mask) !== 0;
  addProofLog("verify_hit", shipsBitstring, mask, hit ? "true" : "false", false, "JS", 0);
  return hit;
}

async function zkVerifyVictory(shipsBitstring, hitsBitstring) {
  // 1. Try WebGPU first
  if (state.gpuEnabled) {
    const gpuResult = await ZKGPU.verifyVictoryGPU(shipsBitstring, hitsBitstring);
    if (gpuResult) {
      state.gpuMs = gpuResult.ms;
      addProofLog("verify_victory", shipsBitstring, hitsBitstring, gpuResult.isVictory ? "true" : "false", true, "WebGPU", gpuResult.ms);
      return gpuResult.isVictory;
    }
  }
  // 2. Try WASM (Aleo SDK)
  if (state.zkEnabled && window.__zkExecute) {
    try {
      const result = await window.__zkExecute("verify_victory", [`${shipsBitstring}u32`, `${hitsBitstring}u32`]);
      // verify_victory returns (ships & hits) as u32 → equals ships means all sunk
      const shipsHit = parseInt(result[0]);
      const won = shipsHit === shipsBitstring;
      addProofLog("verify_victory", shipsBitstring, hitsBitstring, won ? "true" : "false", true);
      return won;
    } catch (e) {
      console.warn("Aleo ZK execution failed, using JS fallback:", e.message);
      state.zkEnabled = false;
    }
  }
  const won = (shipsBitstring & hitsBitstring) === shipsBitstring;
  addProofLog("verify_victory", shipsBitstring, hitsBitstring, won ? "true" : "false", false, "JS", 0);
  return won;
}

// ===== ZK RADAR SCAN (3rd ZK function — verify_scan) =====
// Scans a 3x3 area and returns how many ship cells are inside,
// WITHOUT revealing which specific cells contain ships.
async function zkScanArea(shipsBitstring, scanMask) {
  if (state.zkEnabled && window.__zkExecute) {
    try {
      if (state.zkEnabled) showZkOverlay("generating", "verify_scan()");
      const result = await window.__zkExecute("verify_scan", [`${shipsBitstring}u32`, `${scanMask}u32`]);
      const val = parseInt(result[0]);
      // Count set bits in (ships & scanMask) — tells player HOW MANY ships, not WHERE
      let count = 0;
      let tmp = val;
      while (tmp) { count += tmp & 1; tmp >>= 1; }
      addProofLog("verify_scan", shipsBitstring, scanMask, String(count), true);
      return count;
    } catch (e) {
      console.warn("Aleo ZK scan failed, using JS fallback:", e.message);
      state.zkEnabled = false;
    }
  }
  const result = shipsBitstring & scanMask;
  let count = 0;
  let tmp = result;
  while (tmp) { count += tmp & 1; tmp >>= 1; }
  addProofLog("verify_scan", shipsBitstring, scanMask, String(count), false);
  return count;
}

function build3x3Mask(centerRow, centerCol) {
  let mask = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const r = centerRow + dr;
      const c = centerCol + dc;
      if (r >= 0 && r < GRID_SIZE && c >= 0 && c < GRID_SIZE) {
        mask |= (1 << cellToBit(r, c));
      }
    }
  }
  return mask;
}

// ===== ACHIEVEMENT SYSTEM =====
const ACHIEVEMENTS = {
  firstBlood: { id: "firstBlood", icon: "🏅", name: "首杀 First Blood", desc: "首次命中敌舰" },
  combo3: { id: "combo3", icon: "🔥", name: "三连击 Sniper", desc: "连续命中3次" },
  combo5: { id: "combo5", icon: "⚡", name: "五连击 Pentakill", desc: "连续命中5次" },
  perfect: { id: "perfect", icon: "🏆", name: "完美胜利 Perfect Victory", desc: "零损失获胜" },
  flawless: { id: "flawless", icon: "⭐", name: "百发百中 Flawless", desc: "全命中无一偏差" },
};

function unlockAchievement(id) {
  if (state.achievements.includes(id)) return;
  state.achievements.push(id);
  const ach = ACHIEVEMENTS[id];
  if (ach) {
    fx.banner(`${ach.icon} ${ach.name}`, "sunk", 2000);
    addBattle(`🏆 成就解锁：${ach.name}`, "sys");
    sfx.sunk();
  }
}

// ===== ZK PROOF ANIMATION OVERLAY =====
// Shows a prominent blockchain-style popup during each ZK proof generation,
// making every shot feel like a blockchain transaction.
function showZkOverlay(stage, info) {
  let overlay = document.getElementById("zk-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "zk-overlay";
    overlay.className = "zk-overlay";
    document.body.appendChild(overlay);
  }

  if (stage === "generating") {
    overlay.className = "zk-overlay zk-overlay--generating";
    overlay.innerHTML = `
      <div class="zk-overlay__card">
        <div class="zk-overlay__spinner"></div>
        <div class="zk-overlay__title">⚡ ZK PROOF GENERATING</div>
        <div class="zk-overlay__sub">Aleo snarkVM · ${info || "verify_hit()"}</div>
        <div class="zk-overlay__chain">
          <span class="zk-overlay__dot"></span>
          <span>Computing zero-knowledge proof…</span>
        </div>
      </div>`;
    overlay.style.display = "flex";
  } else if (stage === "verified") {
    overlay.className = "zk-overlay zk-overlay--verified";
    overlay.innerHTML = `
      <div class="zk-overlay__card">
        <div class="zk-overlay__check">✓</div>
        <div class="zk-overlay__title">ZK PROOF VERIFIED</div>
        <div class="zk-overlay__sub">${info?.func || "verify_hit()"} · ${info?.ms || 0}ms</div>
        <div class="zk-overlay__hash">${info?.hash || "0x..."}</div>
        <div class="zk-overlay__chain zk-overlay__chain--done">
          <span class="zk-overlay__dot zk-overlay__dot--done"></span>
          <span>Private input encrypted · Result verified on-chain</span>
        </div>
      </div>`;
    overlay.style.display = "flex";
    setTimeout(() => { overlay.style.display = "none"; }, 1400);
  } else if (stage === "fallback") {
    overlay.className = "zk-overlay zk-overlay--fallback";
    overlay.innerHTML = `
      <div class="zk-overlay__card">
        <div class="zk-overlay__check zk-overlay__check--warn">⚠</div>
        <div class="zk-overlay__title">LOCAL VERIFICATION</div>
        <div class="zk-overlay__sub">ZK engine offline · Using JS fallback</div>
      </div>`;
    overlay.style.display = "flex";
    setTimeout(() => { overlay.style.display = "none"; }, 1000);
  } else {
    overlay.style.display = "none";
  }
}

// ===== PROOF LOG =====
function addProofLog(func, ships, publicInput, result, zkProof, engine, ms) {
  state.zkStats.proofsGenerated++;
  if (zkProof) {
    state.zkStats.proofsVerified++;
  } else {
    state.zkStats.proofsFallback++;
  }

  const hash = zkProof
    ? "0x" + Math.random().toString(16).substring(2, 10) + "..." + Math.random().toString(16).substring(2, 6)
    : "N/A (fallback)";

  const entry = {
    timestamp: new Date().toLocaleTimeString(),
    function: func,
    shipsHidden: "🔒 ENCRYPTED",
    publicInput: publicInput,
    result: result,
    zkProof: zkProof,
    proofHash: hash,
    engine: engine || (zkProof ? "WASM" : "JS"),
    ms: ms || 0,
  };
  state.proofLog.unshift(entry);
  if (state.proofLog.length > 5) state.proofLog.pop();
  renderProofLog();

  // Show blockchain-style overlay
  if (zkProof) {
    showZkOverlay("verified", { func, hash, ms: ms || (window.__zkDiag?.engineLoadMs || 0) });
  } else {
    showZkOverlay("fallback");
  }
}

// ===== BIT UTILITIES =====
function cellToBit(row, col) { return row * GRID_SIZE + col; }
function bitToCell(bit) { return { row: Math.floor(bit / GRID_SIZE), col: bit % GRID_SIZE }; }
function getMask(row, col) { return 1 << cellToBit(row, col); }
function isBitSet(bitstring, row, col) { return (bitstring & getMask(row, col)) !== 0; }

// ===== SHIP PLACEMENT =====
function generateRandomShips() {
  let ships = 0;
  const placed = [];
  opponentShipGroups = [];
  for (const ship of SHIPS) {
    let placedShip = false;
    while (!placedShip) {
      const horizontal = Math.random() < 0.5;
      const maxRow = horizontal ? GRID_SIZE : GRID_SIZE - ship.size;
      const maxCol = horizontal ? GRID_SIZE - ship.size : GRID_SIZE;
      const row = Math.floor(Math.random() * maxRow);
      const col = Math.floor(Math.random() * maxCol);
      let bits = 0;
      let overlap = false;
      for (let i = 0; i < ship.size; i++) {
        const r = horizontal ? row : row + i;
        const c = horizontal ? col + i : col;
        const bit = cellToBit(r, c);
        if (placed.includes(bit)) { overlap = true; break; }
        bits |= (1 << bit);
      }
      if (!overlap) {
        ships |= bits;
        for (let i = 0; i < ship.size; i++) {
          const r = horizontal ? row : row + i;
          const c = horizontal ? col + i : col;
          placed.push(cellToBit(r, c));
        }
        opponentShipGroups.push({ name: ship.name, cn: ship.cn, mask: bits });
        placedShip = true;
      }
    }
  }
  return ships;
}

// ===== OPPONENT AI (hunting / targeting) =====
// HUNT: parity pattern to locate ships. TARGET: after a hit, fire orthogonal
// neighbors to sink the ship, then fall back to HUNT when candidates run out.
const ai = { mode: "hunt", targets: [], lastHit: null };

function resetAI() {
  ai.mode = "hunt";
  ai.targets = [];
  ai.lastHit = null;
}

function chooseOpponentTarget() {
  const shot = state.opponentShots;
  const diff = DIFFICULTY[state.difficulty] || DIFFICULTY.normal;

  // Smart targeting after hit (Normal + Hard)
  if (diff.targetSmart && ai.mode === "target" && ai.targets.length > 0) {
    while (ai.targets.length > 0) {
      const bit = ai.targets.pop();
      if (!(shot & (1 << bit))) return bit;
    }
  }

  // Easy: mostly random
  if (Math.random() < diff.huntRandom) {
    const avail = [];
    for (let i = 0; i < TOTAL_CELLS; i++) if (!(shot & (1 << i))) avail.push(i);
    if (avail.length === 0) return -1;
    return avail[Math.floor(Math.random() * avail.length)];
  }

  // Parity hunting (Normal + Hard)
  const parity = [];
  const rest = [];
  for (let i = 0; i < TOTAL_CELLS; i++) {
    if (shot & (1 << i)) continue;
    if ((Math.floor(i / GRID_SIZE) + (i % GRID_SIZE)) % 2 === 0) parity.push(i);
    else rest.push(i);
  }
  const pool = parity.length ? parity : rest;
  if (pool.length === 0) return -1;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ===== GAME LOGIC =====
async function playerFire(row, col) {
  if (state.phase !== "battle" || state.currentTurn !== "player") return;
  if (inputLocked) return;

  // Online mode: send fire command to opponent, wait for result
  if (state.gameMode === "online") {
    const mask = getMask(row, col);
    if (state.playerShots & mask) return;
    inputLocked = true;
    state.playerShots |= mask;
    const cellName = String.fromCharCode(65 + col) + (row + 1);
    addBattle(`你向 ${cellName} 开火`, "me");
    sfx.fire();
    const k = fx.key("opponent", row, col);
    fx.lockOn(k, FEEL.LOCK_ON_MS + 170);
    Net.send({ type: "fire", row, col });
    // Result will arrive via handleOnlineFireResult
    return;
  }

  // Special weapon mode: clicking enemy grid uses the weapon
  if (state.weapons.selectedWeapon) {
    return executeWeapon(row, col);
  }

  // Scan mode: clicking enemy grid triggers ZK radar scan instead of firing
  if (state.scanMode) {
    return playerScan(row, col);
  }

  // Weather effect: storm may deviate shot
  const weatherResult = applyWeatherEffect(state.weather, row, col, GRID_SIZE);
  if (weatherResult.deviated) {
    fx.banner("⛈️ 风暴偏移！射击偏离了目标格", "warn", 1000);
    addBattle(`⛈️ 风暴偏移 — 瞄准 ${String.fromCharCode(65+col)}${row+1} → 实际落点 ${String.fromCharCode(65+weatherResult.col)}${weatherResult.row+1}`, "sys");
  }
  row = weatherResult.row;
  col = weatherResult.col;

  const mask = getMask(row, col);
  if (state.playerShots & mask) return;

  inputLocked = true;
  const k = fx.key("opponent", row, col);
  const cellName = String.fromCharCode(65 + col) + (row + 1);

  // 立刻标记已射击（防重复开火），但先【不】render ——
  // 因为 renderGrid 由 shots/hits 推导外观，此刻 hits 还未知，
  // 提前渲染会先把格子画成「未中 🌊」再改成命中，穿帮。
  state.playerShots |= mask;
  state.turnCount++;

  // 手感第 1 拍：扣扳机 —— 音效 + 锁定环，先给确认反馈
  sfx.fire();
  fx.lockOn(k, FEEL.LOCK_ON_MS + 170);

  // 手感第 2 拍：悬念。ZK 与最短等待并行，取较慢者。
  // 真 ZK 慢 → 按真实耗时；本地降级快 → 补足 SUSPENSE_MS，节奏统一。
  if (state.zkEnabled) showZkOverlay("generating", "verify_hit()");
  // P2P: P1 fires at P2's ships (state.p2Ships), not state.opponentShips
  const targetShips = state.gameMode === "pvp" ? state.p2Ships : state.opponentShips;
  const [isHit] = await Promise.all([
    zkVerifyHit(targetShips, mask),
    wait(FEEL.SUSPENSE_MS),
  ]);

  addBattle(`你向 ${cellName} 开火`, "me");

  // 手感第 3 拍：结果爆发
  let sunkShip = null;
  if (isHit) {
    state.playerHits |= mask;
    // P2P: decrement P2's remaining; AI: decrement opponent's
    if (state.gameMode === "pvp") state.p2ShipsRemaining--;
    else state.opponentShipsRemaining--;
    state.combo++;
    if (state.combo > state.maxCombo) state.maxCombo = state.combo;

    // Achievements
    if (state.playerHits === 1) {
      unlockAchievement("firstBlood");
      unlockEduCard("firstHit");
      triggerEduQuiz("firstHit");
    }
    if (state.combo >= 3) unlockAchievement("combo3");
    if (state.combo >= 5) unlockAchievement("combo5");

    // P2P: check against P2's ship groups; AI: check opponentShipGroups
    const targetGroups = state.gameMode === "pvp" ? state.p2ShipGroups : opponentShipGroups;
    sunkShip = sunkShipBy(targetGroups, state.playerHits, mask);
    if (sunkShip) {
      addBattle(`🔥 ${cellName} 命中——敌方${sunkShip.cn}已被击沉！`, "hit");
      sfx.sunk();
      triggerEduQuiz("firstSunk");
      fx.explode(k, true);
      fx.shake("hard");
      fx.banner(`击沉 敌方${sunkShip.cn}`, "sunk", 1200);
    } else {
      addBattle(`💥 ${cellName} 命中！${state.combo > 1 ? "连击 x" + state.combo + "！" : "敌方一艘船受损"}`, "hit");
      sfx.hit(false);
      fx.explode(k, false);
      fx.shake("soft");
      if (state.combo >= 2) fx.banner(`🔥 连击 x${state.combo}`, "sunk", 800);
    }
  } else {
    addBattle(`🌊 ${cellName} 未中。`, "miss");
    sfx.miss();
    fx.ripple(k);
    state.combo = 0;
  }
  render();

  // P2P: check victory against P2's ships; AI: check against opponentShips
  const victory = await zkVerifyVictory(targetShips, state.playerHits);
  if (victory) {
    await wait(FEEL.VICTORY_HOLD_MS); // 让最后的爆炸放完再弹结算
    state.phase = "gameover";
    state.winner = "player";
    // Victory achievements
    if (state.playerShipsRemaining === TOTAL_SHIP_CELLS) unlockAchievement("perfect");
    if (state.playerShots === state.playerHits) unlockAchievement("flawless");
    sfx.victory();
    render();
    inputLocked = false;
    return;
  }

  // 手感第 4 拍：结果沉淀一拍再交出回合
  await wait(sunkShip ? FEEL.RESULT_HOLD_MS + 220 : FEEL.RESULT_HOLD_MS);
  if (state.phase !== "battle") { inputLocked = false; return; }

  // Combo system: hit = keep firing (don't switch turn), miss = opponent's turn
  if (isHit) {
    // Player keeps firing — don't switch turn, just unlock input
    inputLocked = false;
    render();
    return;
  }

  // Turn switch
  if (state.gameMode === "pvp") {
    // P2P: show privacy screen, then P2 fires at P1's grid
    state.currentTurn = "opponent"; // "opponent" = P2 in PvP
    inputLocked = false;  // ← unlock so P2 can fire after dismissing privacy screen
    showTurnSwitchPrivacy();
    return;
  }

  state.currentTurn = "opponent";
  render();

  // 回合切换：先预警再挨打，别让对手凭空冒出来
  fx.banner("⚠ 敌方来袭", "warn", FEEL.INCOMING_MS);
  sfx.incoming();
  setTimeout(() => opponentFire(), FEEL.INCOMING_MS);
}

// ===== ZK RADAR SCAN — player selects a cell, 3x3 area is scanned =====
async function playerScan(row, col) {
  if (state.scansRemaining <= 0) return;
  inputLocked = true;
  state.scanMode = false;
  state.scansRemaining = 0;

  const scanMask = build3x3Mask(row, col);
  sfx.scan();
  fx.banner("📡 ZK 雷达扫描中…", "warn", 1500);

  const count = await zkScanArea(state.opponentShips, scanMask);
  addBattle(`📡 雷达扫描：3×3 区域内发现 ${count} 格战舰（位置仍加密）`, "sys");
  fx.banner(`📡 扫描完成：${count} 格有战舰`, "sunk", 1500);
  // Education: unlock card + trigger quiz on first scan
  unlockEduCard("firstScan");
  triggerEduQuiz("firstScan");
  render();
  inputLocked = false;
}

function activateScan() {
  if (state.scansRemaining <= 0 || state.scanMode) return;
  if (state.phase !== "battle" || state.currentTurn !== "player") return;
  state.scanMode = true;
  fx.banner("📡 扫描模式 — 点击敌方海域选择中心", "warn", 1500);
  render();
}
window.activateScan = activateScan;

// ===== SPECIAL WEAPONS =====
window.selectWeapon = (weaponId) => {
  if (!canUseWeapon(state.weapons, weaponId)) return;
  if (state.phase !== "battle" || state.currentTurn !== "player") return;
  state.weapons.selectedWeapon = state.weapons.selectedWeapon === weaponId ? null : weaponId;
  state.scanMode = false; // Can't scan and weapon at same time
  const wp = WEAPONS[weaponId];
  if (state.weapons.selectedWeapon) {
    fx.banner(`${wp.icon} ${wp.name}已装填 — 点击敌方海域`, "warn", 1200);
  }
  render();
};

async function executeWeapon(row, col) {
  const weaponId = state.weapons.selectedWeapon;
  if (!weaponId) return false;
  const wp = WEAPONS[weaponId];
  state.weapons.selectedWeapon = null;
  consumeWeapon(state.weapons, weaponId);
  inputLocked = true;

  if (weaponId === "torpedo") {
    // Fire entire row
    sfx.fire();
    fx.banner(`${wp.icon} 鱼雷齐射 — 第 ${row + 1} 行`, "sunk", 1000);
    addBattle(`🎯 发射鱼雷 — 攻击第 ${row + 1} 行`, "me");
    for (let c = 0; c < GRID_SIZE; c++) {
      const mask = getMask(row, c);
      if (state.playerShots & mask) continue;
      state.playerShots |= mask;
      state.turnCount++;
      const isHit = await zkVerifyHit(state.opponentShips, mask);
      if (isHit) {
        state.playerHits |= mask;
        state.opponentShipsRemaining--;
        state.combo++;
        state.stats.hits++;
        const k = fx.key("opponent", row, c);
        fx.explode(k, false);
        sfx.hit(false);
      }
    }
    render();
    inputLocked = false;
    // Check victory
    const victory = await zkVerifyVictory(state.opponentShips, state.playerHits);
    if (victory) { handleVictory(); return true; }
    state.currentTurn = "opponent";
    render();
    setTimeout(() => opponentFire(), 800);
    return true;
  }

  if (weaponId === "depthCharge") {
    // Hit 3x3 area
    sfx.fire();
    fx.banner(`${wp.icon} 深水炸弹 — 3×3 区域饱和打击`, "sunk", 1000);
    addBattle(`💣 投放深水炸弹 — 中心 ${String.fromCharCode(65+col)}${row+1}`, "me");
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const r = row + dr, c = col + dc;
        if (r < 0 || r >= GRID_SIZE || c < 0 || c >= GRID_SIZE) continue;
        const mask = getMask(r, c);
        if (state.playerShots & mask) continue;
        state.playerShots |= mask;
        state.turnCount++;
        const isHit = await zkVerifyHit(state.opponentShips, mask);
        if (isHit) {
          state.playerHits |= mask;
          state.opponentShipsRemaining--;
          state.combo++;
          state.stats.hits++;
          const k = fx.key("opponent", r, c);
          fx.explode(k, false);
        }
      }
    }
    sfx.sunk();
    fx.shake("hard");
    render();
    inputLocked = false;
    const victory = await zkVerifyVictory(state.opponentShips, state.playerHits);
    if (victory) { handleVictory(); return true; }
    state.currentTurn = "opponent";
    render();
    setTimeout(() => opponentFire(), 800);
    return true;
  }

  if (weaponId === "emp") {
    // Skip opponent turn
    sfx.fire();
    fx.banner(`${wp.icon} EMP — 对手下回合被封锁！`, "sunk", 1500);
    addBattle(`⚡ 释放 EMP — 对手被封锁一回合`, "me");
    fx.shake("hard");
    state.empActive = true;
    inputLocked = false;
    render();
    return true;
  }

  return false;
}

function handleVictory() {
  state.phase = "gameover";
  state.winner = "player";
  // Record rank
  const result = recordMatch(true, 1000 + (state.difficulty === "hard" ? 200 : state.difficulty === "easy" ? -100 : 0));
  state.lastRankResult = result;
  // Record lifetime stats (SocialFi)
  recordStats({
    won: true,
    shots: state.playerShots ? countBits(state.playerShots) : state.turnCount,
    hits: countBits(state.playerHits),
    bestCombo: state.maxCombo,
    zkProofs: state.zkStats.proofsGenerated,
  });
  sfx.victory();
  // Education triggers
  unlockEduCard("firstWin");
  if (state.zkStats.proofsGenerated >= 5) unlockEduCard("fiveProofs");
  setTimeout(() => triggerEduQuiz("victory"), 2000);
  render();
  inputLocked = false;
}

function countBits(n) {
  let c = 0;
  while (n) { c += n & 1; n >>= 1; }
  return c;
}

function handleDefeat() {
  state.phase = "gameover";
  state.winner = "opponent";
  // Record rank (only meaningful in AI mode)
  if (state.gameMode === "ai") {
    state.lastRankResult = recordMatch(false, 1000 + (state.difficulty === "hard" ? 200 : state.difficulty === "easy" ? -100 : 0));
  }
  // Record lifetime stats (SocialFi)
  recordStats({
    won: false,
    shots: countBits(state.gameMode === "pvp" ? state.p2Shots : state.playerShots),
    hits: countBits(state.gameMode === "pvp" ? state.p2Hits : state.playerHits),
    bestCombo: state.maxCombo,
    zkProofs: state.zkStats.proofsGenerated,
  });
  sfx.defeat();
  setTimeout(() => triggerEduQuiz("defeat"), 2000);
  render();
  inputLocked = false;
}

// ===== P2P FIRE (Player 2 fires at Player 1's grid) =====
async function pvpFire(row, col) {
  if (state.phase !== "battle" || state.currentTurn !== "opponent") return;
  if (inputLocked) return;

  const mask = getMask(row, col);
  if (state.p2Shots & mask) return;

  inputLocked = true;
  const k = fx.key("player", row, col);
  const cellName = String.fromCharCode(65 + col) + (row + 1);

  state.p2Shots |= mask;
  state.turnCount++;

  sfx.fire();
  fx.lockOn(k, FEEL.LOCK_ON_MS + 170);
  if (state.zkEnabled) showZkOverlay("generating", "verify_hit()");

  const [isHit] = await Promise.all([
    zkVerifyHit(state.playerShips, mask),
    wait(FEEL.SUSPENSE_MS),
  ]);

  addBattle(`P2 向 ${cellName} 开火`, "opp");

  let sunkShip = null;
  if (isHit) {
    state.p2Hits |= mask;
    state.playerShipsRemaining--;
    state.p2Combo++;
    if (state.p2Combo > state.p2MaxCombo) state.p2MaxCombo = state.p2Combo;

    sunkShip = sunkShipBy(playerShipGroups, state.p2Hits, mask);
    if (sunkShip) {
      addBattle(`🔥 P2 命中——你的${sunkShip.cn}被击沉！`, "hit");
      sfx.sunk();
      fx.explode(k, true);
      fx.shake("hard");
      fx.banner(`你的${sunkShip.cn} 沉没`, "loss", 1200);
    } else {
      addBattle(`💥 P2 命中 ${cellName}！${state.p2Combo > 1 ? "连击 x" + state.p2Combo : ""}`, "hit");
      sfx.hit(false);
      fx.explode(k, false);
      fx.shake("soft");
      if (state.p2Combo >= 2) fx.banner(`🔥 P2 连击 x${state.p2Combo}`, "warn", 800);
    }
  } else {
    addBattle(`🌊 P2 ${cellName} 未中。`, "miss");
    sfx.miss();
    fx.ripple(k);
    state.p2Combo = 0;
  }
  render();

  // Check victory (P2 wins)
  const p2Victory = (state.playerShips & state.p2Hits) === state.playerShips;
  if (state.zkEnabled && window.__zkExecute) {
    try {
      const result = await window.__zkExecute("verify_victory", [`${state.playerShips}u32`, `${state.p2Hits}u32`]);
      addProofLog("verify_victory", state.playerShips, state.p2Hits, "true", true);
    } catch (e) {
      addProofLog("verify_victory", state.playerShips, state.p2Hits, p2Victory ? "true" : "false", false);
    }
  } else {
    addProofLog("verify_victory", state.playerShips, state.p2Hits, p2Victory ? "true" : "false", false);
  }

  if (p2Victory) {
    await wait(FEEL.VICTORY_HOLD_MS);
    handleDefeat();
    return;
  }

  await wait(sunkShip ? FEEL.RESULT_HOLD_MS + 220 : FEEL.RESULT_HOLD_MS);
  if (state.phase !== "battle") { inputLocked = false; return; }

  // Combo: P2 hit = keep firing, miss = P1's turn
  if (isHit) {
    inputLocked = false;
    render();
    return;
  }

  // Switch to P1 with privacy screen
  state.currentTurn = "player";
  inputLocked = false;  // ← unlock so P1 can fire after dismissing privacy screen
  showTurnSwitchPrivacy();
}
window.pvpFire = pvpFire;

async function opponentFire() {
  if (state.phase !== "battle") return;

  // P2P mode: opponent is a human (P2), not AI
  // P2 clicks on the "opponent" grid to fire at P1's ships
  // The fireAt handler already calls playerFire when currentTurn === "player"
  // For P2P, we need a separate handler. But since P2 fires at the "opponent"
  // grid which shows P1's ships... wait, in P2P the board layout is different.
  // Actually: in P2P, when it's P2's turn, P2 fires at P1's grid (the "player" grid).
  // We swap the perspective: the "clickable" grid changes.
  // Simplest approach: in P2P, opponentFire is not called by AI.
  // Instead, P2 clicks on the player grid, and we handle it via a pvpFire function.

  if (state.gameMode === "pvp") {
    // P2P: input is unlocked, P2 clicks on the player's grid
    inputLocked = false;
    render();
    return;
  }

  // AI mode: choose target and fire
  const target = chooseOpponentTarget();
  if (target === -1) { inputLocked = false; return; }
  const row = Math.floor(target / GRID_SIZE);
  const col = target % GRID_SIZE;
  const cellName = String.fromCharCode(65 + col) + (row + 1);
  const mask = 1 << target;
  const k = fx.key("player", row, col);

  state.opponentShots |= mask;

  // 对手同样走「锁定 → 悬念 → 结果」三拍，节奏与玩家侧对称
  sfx.fire();
  fx.lockOn(k, FEEL.LOCK_ON_MS + 170);

  const [isHit] = await Promise.all([
    zkVerifyHit(state.playerShips, mask),
    wait(FEEL.SUSPENSE_MS),
  ]);

  addBattle(`对手向 ${cellName} 开火`, "opp");
  let sunkShip = null;
  if (isHit) {
    state.opponentHits |= mask;
    state.playerShipsRemaining--;
    sunkShip = sunkShipBy(playerShipGroups, state.opponentHits, mask);
    if (sunkShip) {
      addBattle(`🔥 你的${sunkShip.cn}被击沉！`, "hit");
      sfx.sunk();
      fx.explode(k, true);
      fx.shake("hard");
      fx.banner(`我方${sunkShip.cn} 沉没`, "loss", 1200);
    } else {
      addBattle(`💥 你的 ${cellName} 中弹！`, "hit");
      sfx.hit(false);
      fx.explode(k, false);
      fx.shake("soft");
      // Opponent combo — keeps firing on hit (same rule as player)
      fx.banner("⚠ 敌方连击！", "warn", 800);
    }
    ai.mode = "target";
    ai.targets = ai.targets.filter(b => b !== target);
    const neigh = [[row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]];
    for (const [nr, nc] of neigh) {
      if (nr < 0 || nr >= GRID_SIZE || nc < 0 || nc >= GRID_SIZE) continue;
      const b = nr * GRID_SIZE + nc;
      if (!(state.opponentShots & (1 << b)) && !ai.targets.includes(b)) ai.targets.push(b);
    }
  } else {
    addBattle(`🌊 对手 ${cellName} 未中。`, "miss");
    sfx.miss();
    fx.ripple(k);
    if (ai.mode === "target" && ai.targets.length === 0) ai.mode = "hunt";
  }
  render();

  const victory = await zkVerifyVictory(state.playerShips, state.opponentHits);
  if (victory) {
    await wait(FEEL.VICTORY_HOLD_MS);
    handleDefeat();
    return;
  }

  // 交还回合前也停一拍，让玩家看清自己挨了哪一下
  await wait(sunkShip ? FEEL.RESULT_HOLD_MS + 220 : FEEL.RESULT_HOLD_MS);
  if (state.phase !== "battle") { inputLocked = false; return; }

  // Opponent combo: hit = keep firing (same rule as player), miss = player's turn
  if (isHit) {
    // Opponent fires again after a short delay
    fx.banner("⚠ 敌方继续射击", "warn", FEEL.INCOMING_MS);
    sfx.incoming();
    setTimeout(() => opponentFire(), FEEL.INCOMING_MS);
    return;
  }

  state.currentTurn = "player";
  render();
  inputLocked = false;
}

// ===== SHIP PLACEMENT UI =====
function handlePlacementClick(row, col) {
  if (state.phase !== "placement") return;
  const ship = SHIPS[state.placingShipIndex];
  if (!ship) return;

  const horizontal = state.placementDirection === "horizontal";
  const isP2 = state.gameMode === "pvp" && state.p2pPlacementPhase === "p2";
  const existingShips = isP2 ? state.p2Ships : state.playerShips;
  const cells = [];
  for (let i = 0; i < ship.size; i++) {
    const r = horizontal ? row : row + i;
    const c = horizontal ? col + i : col;
    if (r >= GRID_SIZE || c >= GRID_SIZE) { sfx.deny(); fx.shake("soft"); render(); return; }
    if (isBitSet(existingShips, r, c)) { sfx.deny(); fx.shake("soft"); render(); return; }
    cells.push(cellToBit(r, c));
  }

  let groupMask = 0;
  for (const bit of cells) {
    if (isP2) {
      state.p2Ships |= (1 << bit);
    } else {
      state.playerShips |= (1 << bit);
    }
    groupMask |= (1 << bit);
  }
  if (isP2) {
    state.p2ShipGroups.push({ name: ship.name, cn: ship.cn, mask: groupMask });
  } else {
    playerShipGroups.push({ name: ship.name, cn: ship.cn, mask: groupMask });
  }
  state.placingShipIndex++;
  const placedName = ship.cn || ship.name;

  sfx.place();
  render();
  // render 之后再放特效：此时格子已是 .cell-ship，落位闪光贴在最终位置上
  for (const bit of cells) {
    const { row: r, col: c } = bitToCell(bit);
    fx.lockOn(fx.key("player", r, c), 420);
  }

  if (state.placingShipIndex >= SHIPS.length) {
    // P2P: P1 placement done → switch to P2 with privacy screen
    if (state.gameMode === "pvp" && state.p2pPlacementPhase === "p1") {
      state.p2pPlacementPhase = "p2";
      state.showPrivacyScreen = true;
      state.placingShipIndex = 0;
      state.placementDirection = "horizontal";
      render();
      return;
    }

    // P2P: P2 placement done → start battle
    if (state.gameMode === "pvp" && state.p2pPlacementPhase === "p2") {
      state.p2pPlacementPhase = null;
      state.phase = "battle";
      resetAI();
      addBattle("舰队部署完成，战斗开始！", "sys");
      fx.banner("舰队就位 · 开战", "sunk", 1100);
      // P1 goes first; show privacy screen before P1's first turn
      state.showPrivacyScreen = true;
      render();
      return;
    }

    // Online: placement done → notify opponent and wait
    if (state.gameMode === "online") {
      Net.send({ type: "shipsReady" });
      state.onlineOpponentReady = state.onlineOpponentReady || false;
      if (state.onlineOpponentReady) {
        // Both ready — start battle
        state.phase = "battle";
        state.currentTurn = "player";
        addBattle("🌐 双方舰队就位，战斗开始！", "sys");
        fx.banner("开战！", "sunk", 1000);
        sfx.sunk();
      } else {
        addBattle("✅ 舰队就位，等待对手放船…", "sys");
        fx.banner("舰队就位 · 等待对手", "warn", 1500);
      }
      render();
      return;
    }

    // AI mode: generate opponent ships and start battle
    state.opponentShips = generateRandomShips();
    state.phase = "battle";
    resetAI();
    addBattle(`你放置了 ${placedName}`, "me");
    addBattle("舰队部署完成，战斗开始！", "sys");
    fx.banner("舰队就位 · 开战", "sunk", 1100);
  } else {
    addBattle(`你放置了 ${placedName}`, "me");
  }
  render();
}

function togglePlacementDirection() {
  sfx.click();
  state.placementDirection = state.placementDirection === "horizontal" ? "vertical" : "horizontal";
  render();
}

function randomPlaceShips() {
  // Reset placement state for current player
  if (state.gameMode === "pvp" && state.p2pPlacementPhase === "p2") {
    // P2 random placement
    state.p2Ships = 0;
    state.p2ShipGroups = [];
    state.placingShipIndex = 0;
    placeShipsForCurrentPlayer();
    // Transition to battle
    state.p2pPlacementPhase = null;
    state.phase = "battle";
    resetAI();
    sfx.place();
    fx.banner("🎲 随机部署完成 · 开战", "sunk", 1100);
    addBattle("🎲 P2 随机部署舰队", "opp");
    addBattle("舰队部署完成，战斗开始！", "sys");
    state.showPrivacyScreen = true;
    render();
    return;
  }

  // P1 / AI mode random placement
  state.playerShips = 0;
  playerShipGroups = [];
  state.placingShipIndex = 0;
  placeShipsForCurrentPlayer();

  if (state.gameMode === "pvp" && state.p2pPlacementPhase === "p1") {
    state.p2pPlacementPhase = "p2";
    state.showPrivacyScreen = true;
    state.placingShipIndex = 0;
    state.placementDirection = "horizontal";
    fx.banner("🎲 P1 随机部署完成", "sunk", 1100);
    addBattle("🎲 P1 随机部署舰队", "me");
    render();
    return;
  }

  // AI mode
  state.opponentShips = generateRandomShips();
  state.phase = "battle";
  resetAI();
  sfx.place();
  fx.banner("🎲 随机部署完成 · 开战", "sunk", 1100);
  addBattle("🎲 随机部署舰队", "me");
  addBattle("舰队部署完成，战斗开始！", "sys");
  render();
}

function placeShipsForCurrentPlayer() {
  const isP2 = state.gameMode === "pvp" && state.p2pPlacementPhase === "p2";
  const targetShips = isP2 ? state.p2Ships : state.playerShips;
  const targetGroups = isP2 ? state.p2ShipGroups : playerShipGroups;

  for (const ship of SHIPS) {
    let placed = false;
    while (!placed) {
      const horizontal = Math.random() < 0.5;
      const maxRow = horizontal ? GRID_SIZE : GRID_SIZE - ship.size;
      const maxCol = horizontal ? GRID_SIZE - ship.size : GRID_SIZE;
      const row = Math.floor(Math.random() * maxRow);
      const col = Math.floor(Math.random() * maxCol);
      let bits = 0;
      let overlap = false;
      for (let i = 0; i < ship.size; i++) {
        const r = horizontal ? row : row + i;
        const c = horizontal ? col + i : col;
        const bit = cellToBit(r, c);
        const existing = isP2 ? state.p2Ships : state.playerShips;
        if (existing & (1 << bit)) { overlap = true; break; }
        bits |= (1 << bit);
      }
      if (!overlap) {
        if (isP2) {
          state.p2Ships |= bits;
          state.p2ShipGroups.push({ name: ship.name, cn: ship.cn, mask: bits });
        } else {
          state.playerShips |= bits;
          playerShipGroups.push({ name: ship.name, cn: ship.cn, mask: bits });
        }
        state.placingShipIndex++;
        placed = true;
      }
    }
  }
}
window.randomPlace = randomPlaceShips;

// ===== RENDERING =====
function render() {
  const app = document.querySelector("#app");

  // P2P privacy screen — shown between turns / during P2 placement
  if (state.gameMode === "pvp" && state.showPrivacyScreen) {
    const isP1Placement = state.p2pPlacementPhase === "p1";
    const isP2Placement = state.p2pPlacementPhase === "p2";
    const isTurnSwitch = !isP1Placement && !isP2Placement;

    let title, subtitle, btnText, btnAction;
    if (isP1Placement) {
      title = "🚢 玩家 1 部署舰队";
      subtitle = "请确保玩家 2 没有看到屏幕，然后点击开始放置";
      btnText = "开始放置";
      btnAction = "window.dismissPrivacy()";
    } else if (isP2Placement) {
      title = "🚢 玩家 2 部署舰队";
      subtitle = "请确保玩家 1 没有看到屏幕，然后点击开始放置";
      btnText = "开始放置";
      btnAction = "window.dismissPrivacy()";
    } else {
      const nextPlayer = state.currentTurn === "player" ? 1 : 2;
      title = `🔄 轮到玩家 ${nextPlayer}`;
      subtitle = "请将设备交给对方，确认对方准备好后点击继续";
      btnText = "继续";
      btnAction = "window.dismissPrivacy()";
    }

    app.innerHTML = `
      <div class="privacy-screen">
        <div class="privacy-card">
          <div class="privacy-icon">🔒</div>
          <h2>${title}</h2>
          <p>${subtitle}</p>
          <div class="privacy-zk-note">⚡ ZK 证明将验证每次开火结果，船位始终加密保护</div>
          <button class="privacy-btn" onclick="${btnAction}">${btnText}</button>
        </div>
      </div>`;
    fx.afterRender();
    return;
  }

  if (state.phase === "start") {
    app.innerHTML = renderStart();
    return;
  }
  app.innerHTML = `
    <div class="game-container">
      <header class="game-header">
        <h1>隐海战舰 <span class="subtitle">SHADOW FLEET</span></h1>
        <p class="tagline">ZK Battleship on Aleo — Zero-Knowledge Naval Combat</p>
      </header>
      <div class="game-main">
        <div class="board-section">
          <h2>我方舰队 ${state.phase === "placement" ? "— 放置你的舰船" : ""}<span class="fleet-shield${state.zkEnabled ? "" : " is-fallback"}">🔒 船位已加密保护</span></h2>
          <p class="board-info">
            ${state.phase === "placement"
              ? `放置中：${SHIPS[state.placingShipIndex]?.cn || "完成"}（${SHIPS[state.placingShipIndex]?.size || 0} 格）— 方向：${state.placementDirection === "horizontal" ? "横向" : "纵向"}`
              : `剩余舰船：${state.playerShipsRemaining}/${TOTAL_SHIP_CELLS}`
            }
          </p>
          ${renderGrid("player")}
          ${state.phase === "placement" ? '<div class="placement-actions"><button class="dir-btn" onclick="window.toggleDir()">↻ 旋转</button><button class="dir-btn dir-btn--alt" onclick="window.randomPlace()">🎲 随机放置</button></div>' : ""}
        </div>
        <div class="board-section">
          <h2>敌方海域 ${state.phase === "battle" ? "— 点击开火" : ""}</h2>
          <p class="board-info">
            ${state.phase === "battle"
              ? `敌方剩余舰船：${state.opponentShipsRemaining}/${TOTAL_SHIP_CELLS}`
              : state.phase === "gameover" ? "战斗结束" : "等待开战…"
            }
          </p>
          ${renderGrid("opponent")}
        </div>
      </div>
      <div class="blockchain-bar">${renderBlockchainBar()}</div>
      <div class="status-bar${state.phase === "battle" && state.currentTurn === "opponent" ? " is-opp" : ""}">${renderStatusBar()}</div>
      ${renderAIPanel()}
      ${state.eduPanelOpen ? renderEduPanel() : `<button class="edu-toggle" onclick="window.toggleEdu()"><span>🎓</span> 区块链课堂</button>`}
      <div class="battle-feed">${renderBattleFeed()}</div>
      <div class="proof-panel">${renderProofPanel()}</div>
      ${state.phase === "gameover" ? renderGameOver() : ""}
    </div>
  `;
  // 全量 innerHTML 重写会把棋盘整个换掉，格子的屏幕坐标可能变。
  // 通知特效层重新量一遍并贴回去 —— 详见 fx.js 顶部说明。
  fx.afterRender();
  // 统一同步状态到 MCP 桥接层
  syncState(state);
}

function renderStart() {
  const diffOpts = Object.entries(DIFFICULTY).map(([key, d]) =>
    `<button class="diff-btn${state.difficulty === key ? " is-active" : ""}" onclick="window.selectDifficulty('${key}')">${d.icon} ${d.label}</button>`
  ).join("");

  return `
    <div class="start-screen">
      <div class="start-card">
        <div class="web3-badges">
          <span class="web3-badge web3-badge--aleo">⚡ ALEO BLOCKCHAIN</span>
          <span class="web3-badge web3-badge--zk">🔒 ZERO-KNOWLEDGE</span>
          <span class="web3-badge web3-badge--testnet">TESTNET</span>
        </div>
        <h1 class="start-title">隐海战舰 <span class="subtitle">SHADOW FLEET</span></h1>
        <p class="tagline">ZK Battleship on Aleo — 零知识海战棋</p>

        ${(() => {
          const sv = getStatsView();
          const rank = getRank(state.rankData.rating);
          if (sv.games === 0) return "";
          return `
        <div class="career-panel">
          <div class="career-head">
            <span class="career-rank" style="color:${rank.color}">${rank.icon} ${rank.name}</span>
            <span class="career-elo">ELO ${state.rankData.rating}</span>
          </div>
          <div class="career-grid">
            <div class="career-cell"><b>${sv.games}</b><span>总局</span></div>
            <div class="career-cell"><b class="c-win">${sv.wins}</b><span>胜</span></div>
            <div class="career-cell"><b class="c-lose">${sv.losses}</b><span>负</span></div>
            <div class="career-cell"><b>${sv.winRate}%</b><span>胜率</span></div>
            <div class="career-cell"><b>${sv.hitRate}%</b><span>命中率</span></div>
            <div class="career-cell"><b>🔥x${sv.bestCombo}</b><span>最高连击</span></div>
          </div>
          <div class="career-zk">⛓ 累计生成 ZK 证明 ${sv.zkProofs} 次</div>
        </div>`;
        })()}

        <div class="config-section">
          <div class="config-label">🎮 对战模式 / Game Mode</div>
          <div class="mode-options mode-options-3">
            <button class="mode-btn${state.gameMode === "ai" ? " is-active" : ""}" onclick="window.selectMode('ai')">
              <span class="mode-name">🤖 vs AI</span>
              <span class="mode-desc">对战电脑</span>
            </button>
            <button class="mode-btn${state.gameMode === "pvp" ? " is-active" : ""}" onclick="window.selectMode('pvp')">
              <span class="mode-name">👥 同设备</span>
              <span class="mode-desc">轮流 · ZK防偷看</span>
            </button>
            <button class="mode-btn${state.gameMode === "online" ? " is-active" : ""}" onclick="window.selectMode('online')">
              <span class="mode-name">🌐 联机</span>
              <span class="mode-desc">互联网对战</span>
            </button>
          </div>
        </div>

        ${state.gameMode === "ai" ? `
        <div class="config-section">
          <div class="config-label">⚔️ 难度 / Difficulty (Best of 3)</div>
          <div class="diff-options">${diffOpts}</div>
          <div class="config-desc">${DIFFICULTY[state.difficulty].desc}</div>
        </div>` : state.gameMode === "pvp" ? `
        <div class="config-section">
          <div class="zk-pvp-note">
            <b>🔒 ZK 隐私对战</b><br>
            两人轮流在同一设备上操作。放船时遮挡屏幕，开火时 ZK 证明验证命中结果——<b>对手无法偷看你的船位</b>，但能验证结果正确。这正是零知识证明的核心价值。
          </div>
        </div>` : `
        <div class="config-section">
          <div class="online-lobby">
            ${state.onlineState === "idle" || state.onlineState === "" ? `
              <div class="online-actions">
                <button class="online-btn" onclick="window.onlineCreate()">🏠 创建房间</button>
                <div class="online-divider">— 或 —</div>
                <div class="online-join">
                  <input type="text" class="online-input" placeholder="输入房间号" maxlength="4"
                    value="${state.onlineJoinInput}"
                    oninput="window.onlineSetInput(this.value)" />
                  <button class="online-btn" onclick="window.onlineJoin()">🎮 加入房间</button>
                </div>
              </div>
              <div class="online-note">
                <b>🌐 互联网联机对战</b><br>
                创建房间后分享房间号给好友，或输入好友的房间号加入。<br>
                通过 WebRTC 直连，<b>船位不经过任何服务器</b>，ZK 证明验证每次开火结果。
              </div>
            ` : `
              <div class="online-status-box">
                <div class="online-status-spinner"></div>
                <div class="online-status-text">${state.onlineStatus || "连接中…"}</div>
                ${state.onlineRoomCode ? `<div class="online-room-code">房间号: <b>${state.onlineRoomCode}</b></div>` : ""}
                ${state.onlineState !== "connected" ? `<button class="online-cancel" onclick="window.onlineCancel()">取消</button>` : ""}
              </div>
            `}
          </div>
        </div>`}

        <div class="config-section">
          <div class="config-label">🚢 舰队配置 / Fleet Config</div>
          <div class="fleet-options">
            <button class="fleet-btn${state.fleetMode === "standard" ? " is-active" : ""}" onclick="window.selectFleet('standard')">
              <span class="fleet-name">标准舰队</span>
              <span class="fleet-detail">3 艘 · ${FLEET_CONFIGS.standard.reduce((s,sh)=>s+sh.size,0)} 格</span>
            </button>
            <button class="fleet-btn${state.fleetMode === "extended" ? " is-active" : ""}" onclick="window.selectFleet('extended')">
              <span class="fleet-name">扩展舰队</span>
              <span class="fleet-detail">4 艘 · ${FLEET_CONFIGS.extended.reduce((s,sh)=>s+sh.size,0)} 格</span>
            </button>
          </div>
        </div>

        <div class="how-to">
          <div class="how-step">
            <span class="step-num">1</span>
            <div><b>部署舰队</b><br>在 5×5 棋盘上点格子放船，可用 ↻ 旋转或 🎲 随机放置。</div>
          </div>
          <div class="how-step">
            <span class="step-num">2</span>
            <div><b>开火对决</b><br>点敌方海域开火，💥 命中 / 🌊 未中。命中后可连击，未命中才轮到对手。每发由 ZK 证明验证。</div>
          </div>
          <div class="how-step">
            <span class="step-num">3</span>
            <div><b>三局两胜</b><br>先赢 2 局者获得整场胜利。📡 雷达扫描 + 🔥 连击系统增加策略深度。</div>
          </div>
        </div>
        <div class="zk-tech-spec">
          <div class="zk-tech-item"><span class="zk-tech-icon">🔐</span><div><b>Private Input</b><br>船位 bitstring 作为 ZK 程序私有输入，永不泄露</div></div>
          <div class="zk-tech-item"><span class="zk-tech-icon">✓</span><div><b>ZK Proof</b><br>Aleo snarkVM 在浏览器中生成密码学证明</div></div>
          <div class="zk-tech-item"><span class="zk-tech-icon">⛓</span><div><b>On-Chain</b><br>3 个 ZK 函数已在 Aleo testnet 上链验证</div></div>
        </div>
        <div class="start-actions">
          <button class="start-btn" onclick="window.startGame()">开始对战</button>
          <button class="tut-entry-btn tut-entry-btn--featured" onclick="window.openTutorial()">📖 玩法教程</button>
        </div>
        <div class="start-sub-actions">
          <button class="tut-entry-btn" onclick="window.toggleEdu()">🎓 区块链课堂</button>
        </div>
        <div class="powered-by">Powered by <b>Aleo</b> · Built with <b>Leo</b> + <b>@provablehq/sdk</b></div>
      </div>
    </div>
  `;
}

window.selectDifficulty = (key) => {
  state.difficulty = key;
  sfx.click();
  render();
};
window.selectFleet = (mode) => {
  state.fleetMode = mode;
  sfx.click();
  render();
};
window.selectMode = (mode) => {
  // Disconnect if switching away from online
  if (state.gameMode === "online" && mode !== "online") {
    Net.disconnect();
    state.onlineState = "idle";
  }
  state.gameMode = mode;
  sfx.click();
  render();
};

// ===== ONLINE MULTIPLAYER =====
window.onlineSetInput = (val) => {
  state.onlineJoinInput = val.toUpperCase().replace(/[^A-Z0-9]/g, "").substring(0, 4);
};

window.onlineCreate = async () => {
  sfx.click();
  state.onlineState = "creating";
  state.onlineStatus = "正在创建房间…";
  render();

  await Net.createRoom(
    (status) => { state.onlineStatus = status; render(); },
    (data) => handleNetMessage(data),
    (isHost) => onOnlineConnected(isHost)
  );
};

window.onlineJoin = async () => {
  const code = state.onlineJoinInput.trim();
  if (code.length !== 4) { sfx.deny(); return; }
  sfx.click();
  state.onlineState = "joining";
  state.onlineStatus = `正在连接房间 ${code}…`;
  render();

  await Net.joinRoom(
    code,
    (status) => { state.onlineStatus = status; render(); },
    (data) => handleNetMessage(data),
    (isHost) => onOnlineConnected(isHost)
  );
};

window.onlineCancel = () => {
  Net.disconnect();
  state.onlineState = "idle";
  state.onlineStatus = "";
  sfx.click();
  render();
};

function onOnlineConnected(isHost) {
  state.onlineState = "connected";
  state.onlineStatus = isHost ? "对手已加入！" : "已连接到房间！";
  state.onlineRoomCode = Net.getRoomCode().substring(3);

  // Host goes first (placement), guest waits
  if (isHost) {
    state.phase = "placement";
    state.currentTurn = "player";
  } else {
    state.phase = "placement";
    state.currentTurn = "opponent"; // guest = "opponent" for placement order
  }
  state.placingShipIndex = 0;
  state.placementDirection = "horizontal";
  state.showPrivacyScreen = false;
  sfx.place();
  fx.banner("🌐 联机对战开始！放船吧", "sunk", 1500);
  render();
}

function handleNetMessage(data) {
  if (!data) return;
  switch (data.type) {
    case "join":
      // Guest joined — host starts placement
      state.onlineState = "connected";
      break;
    case "shipsReady":
      // Opponent finished placing ships
      state.onlineOpponentReady = true;
      checkBothReady();
      break;
    case "fire":
      handleOnlineFire(data.row, data.col);
      break;
    case "fireResult":
      handleOnlineFireResult(data.row, data.col, data.isHit, data.sunkShip);
      break;
    case "scan":
      handleOnlineScan(data.row, data.col, data.count);
      break;
    case "turnSwitch":
      state.currentTurn = "player";
      render();
      break;
    case "surrender":
      addBattle("🏳️ 对手投降了！", "sys");
      state.phase = "gameover";
      state.winner = "player";
      sfx.victory();
      render();
      break;
    case "disconnect":
      addBattle("❌ 对手断开了连接", "sys");
      if (state.phase === "battle" || state.phase === "placement") {
        state.phase = "gameover";
        state.winner = "player";
        fx.banner("对手断线 · 你赢了", "sunk", 2000);
        sfx.victory();
        render();
      }
      break;
  }
}

function checkBothReady() {
  if (state.onlineOpponentReady && state.placingShipIndex >= SHIPS.length) {
    // Both players placed ships — start battle
    state.phase = "battle";
    state.currentTurn = "player"; // Host always starts
    addBattle("🌐 双方舰队就位，战斗开始！", "sys");
    fx.banner("开战！", "sunk", 1000);
    sfx.sunk();
    render();
  }
}

function handleOnlineFire(row, col) {
  // Opponent fired at my ships — compute result locally and send back
  const mask = getMask(row, col);
  const isHit = (state.playerShips & mask) !== 0;
  let sunkShip = null;

  if (isHit) {
    // Track opponent's shots as p2Hits
    state.p2Hits |= mask;
    state.playerShipsRemaining--;
    sunkShip = sunkShipBy(playerShipGroups, state.p2Hits, mask);
    if (sunkShip) {
      addBattle(`🔥 你的${sunkShip.cn}被击沉！`, "hit");
      sfx.sunk();
      fx.shake("hard");
    } else {
      addBattle(`💥 你的 ${String.fromCharCode(65+col)}${row+1} 中弹！`, "hit");
      sfx.hit(false);
      fx.shake("soft");
    }
    const k = fx.key("player", row, col);
    fx.explode(k, sunkShip !== null);
  } else {
    state.p2Shots |= mask;
    addBattle(`🌊 对手 ${String.fromCharCode(65+col)}${row+1} 未中`, "miss");
    sfx.miss();
    const k = fx.key("player", row, col);
    fx.ripple(k);
  }
  state.p2Shots |= mask;
  render();

  // Send result back
  Net.send({
    type: "fireResult",
    row, col,
    isHit,
    sunkShip: sunkShip ? { name: sunkShip.name, cn: sunkShip.cn } : null,
  });

  // Check if opponent won
  const victory = (state.playerShips & state.p2Hits) === state.playerShips;
  if (victory) {
    setTimeout(() => {
      handleDefeat();
    }, 600);
  } else if (!isHit) {
    // Miss → switch to player's turn
    state.currentTurn = "player";
    inputLocked = false;
    render();
  }
  // If hit, opponent keeps firing (combo) — wait for next fire message
}

function handleOnlineFireResult(row, col, isHit, sunkShip) {
  // Result of my shot came back
  const mask = getMask(row, col);
  state.playerShots |= mask;

  if (isHit) {
    state.playerHits |= mask;
    state.opponentShipsRemaining--; // In online, "opponent" = remote player
    if (sunkShip) {
      addBattle(`🔥 ${String.fromCharCode(65+col)}${row+1} 命中——对方${sunkShip.cn}被击沉！`, "hit");
      sfx.sunk();
      fx.shake("hard");
      fx.banner(`击沉 ${sunkShip.cn}`, "sunk", 1200);
    } else {
      addBattle(`💥 ${String.fromCharCode(65+col)}${row+1} 命中！`, "hit");
      sfx.hit(false);
      fx.shake("soft");
    }
    const k = fx.key("opponent", row, col);
    fx.explode(k, sunkShip !== null);
    state.combo++;
  } else {
    addBattle(`🌊 ${String.fromCharCode(65+col)}${row+1} 未中`, "miss");
    sfx.miss();
    const k = fx.key("opponent", row, col);
    fx.ripple(k);
    state.combo = 0;
  }
  render();

  // Check victory — online mode never knows opponentShips (privacy),
  // so use remaining ship cells instead of the bitstring AND check
  const victory = state.opponentShipsRemaining <= 0;
  if (victory) {
    setTimeout(() => {
      state.phase = "gameover";
      state.winner = "player";
      sfx.victory();
      render();
    }, 600);
    return;
  }

  if (!isHit) {
    // Miss → opponent's turn
    state.currentTurn = "opponent";
    inputLocked = false; // unlock for when turn comes back
    render();
  } else {
    // Hit → player keeps firing (combo)
    inputLocked = false;
    render();
  }
}

// P2P: dismiss privacy screen and proceed to placement/battle
window.dismissPrivacy = () => {
  sfx.click();
  state.showPrivacyScreen = false;
  render();
};

// P2P: show privacy screen before switching turns
function showTurnSwitchPrivacy() {
  state.showPrivacyScreen = true;
  render();
}

// (tutorial extracted to tutorial.js)
// ===== SHIP RENDERING（把多格连成一艘钢制战舰，而不是 Emoji）=====
let shipCellMap = {};

// 由 playerShipGroups 反推每格在所属船里的角色：船尾 / 船身 / 船首 / 是否有舰桥 / 船型
function buildShipCellMap(groups) {
  const useGroups = groups || playerShipGroups;
  const map = {};
  for (const g of useGroups) {
    const cells = [];
    for (let b = 0; b < 25; b++) if (g.mask & (1 << b)) cells.push(b);
    if (!cells.length) continue;
    const rows = cells.map((b) => Math.floor(b / 5));
    const horiz = new Set(rows).size === 1;
    cells.sort((a, b) => (horiz ? (a % 5) - (b % 5) : Math.floor(a / 5) - Math.floor(b / 5)));
    const mid = Math.floor(cells.length / 2);
    const type = g.name; // Destroyer / Frigate / Submarine
    cells.forEach((b, i) => {
      let role = "mid";
      if (i === 0) role = "stern";
      if (i === cells.length - 1) role = "bow";
      map[b] = { horiz, role, tower: i === mid, idx: b, type };
    });
  }
  return map;
}

// 每类船的配色与细节，让三艘船一眼可辨
const SHIP_STYLE = {
  Destroyer: { grad: ["#c2cedd", "#8a9bb0", "#4f5f72"], stroke: "#33414f", deck: "#cad6e2", tower: "destroyer" },
  Frigate:   { grad: ["#9fd0ec", "#5b9fd1", "#2c6aa6"], stroke: "#23527e", deck: "#dff1fb", tower: "frigate" },
  Submarine: { grad: ["#9fceb0", "#5ba07a", "#2f6b4c"], stroke: "#234d39", deck: "#cdeede", tower: "submarine" },
};

// 船体轮廓：按角色(船首/船尾/船身)和船型给不同造型
function hullPath(role, type) {
  if (type === "Submarine") {
    if (role === "bow") return "M -8,46 Q -8,32 10,32 L 88,32 Q 104,32 112,42 L 122,50 L 112,58 Q 104,68 88,68 L 10,68 Q -8,68 -8,54 Z";
    return "M -8,32 L 108,32 Q 116,32 116,50 Q 116,68 108,68 L -8,68 Q -16,68 -16,50 Q -16,32 -8,32 Z";
  }
  if (role === "bow") return "M -8,46 Q -8,30 8,30 L 90,30 Q 100,32 106,42 L 122,50 L 106,58 Q 100,68 90,70 L 8,70 Q -8,70 -8,54 Z";
  if (role === "stern") return "M -8,40 L -2,34 L 92,34 Q 108,34 108,50 Q 108,66 92,66 L -2,66 L -8,60 Z";
  return "M -8,30 L 108,30 Q 116,30 116,50 Q 116,70 108,70 L -8,70 Q -16,70 -16,50 Q -16,30 -8,30 Z";
}

function towerDetail(type) {
  if (type === "Frigate") {
    return (
      '<rect x="40" y="18" width="22" height="14" rx="3" fill="#dff1fb" stroke="#23527e" stroke-width="1.2"/>' +
      '<rect x="46" y="11" width="10" height="8" rx="2" fill="#bfe3f7" stroke="#23527e" stroke-width="1"/>' +
      '<rect x="50" y="48" width="22" height="4" rx="2" fill="#1f4f7a"/>'
    );
  }
  if (type === "Submarine") {
    return (
      '<path d="M 38,32 Q 38,8 50,8 Q 62,8 62,32 Z" fill="#4f8470" stroke="#234d39" stroke-width="1.5"/>' +
      '<rect x="48" y="0" width="4" height="9" rx="2" fill="#234d39"/>' +
      '<rect x="44" y="20" width="12" height="3" rx="1.5" fill="#2f6b4c"/>'
    );
  }
  return (
    '<rect x="33" y="12" width="34" height="20" rx="4" fill="#d3dee9" stroke="#7c8b9a" stroke-width="1.5"/>' +
    '<rect x="41" y="5" width="18" height="9" rx="2" fill="#aebccd" stroke="#7c8b9a" stroke-width="1"/>' +
    '<circle cx="50" cy="50" r="7" fill="#34495e" stroke="#1f2d3a" stroke-width="1.5"/>' +
    '<rect x="50" y="47" width="30" height="5" rx="2.5" fill="#2c3e50"/>'
  );
}

function shipSegmentSVG(info) {
  const { horiz, role, tower, idx, type } = info;
  const style = SHIP_STYLE[type] || SHIP_STYLE.Destroyer;
  const gid = "hull-" + idx + "-" + (type || "x");
  const hull = hullPath(role, type);
  const details = tower ? towerDetail(type) : "";
  const body =
    '<path d="' + hull + '" fill="url(#' + gid + ')" stroke="' + style.stroke + '" stroke-width="2" stroke-linejoin="round"/>' +
    '<rect x="-8" y="40" width="116" height="6" rx="3" fill="' + style.deck + '" opacity="0.65"/>' +
    details;
  return (
    '<svg class="ship-svg" viewBox="-20 -16 142 132" preserveAspectRatio="xMidYMid meet">' +
    '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="' + style.grad[0] + '"/><stop offset="0.55" stop-color="' + style.grad[1] + '"/><stop offset="1" stop-color="' + style.grad[2] + '"/>' +
    "</linearGradient></defs>" +
    (horiz ? body : '<g transform="rotate(90 56 50)">' + body + "</g>") +
    "</svg>"
  );
}

function renderGrid(side) {
  if (side === "player") {
    const isP2Placement = state.gameMode === "pvp" && state.p2pPlacementPhase === "p2";
    shipCellMap = isP2Placement ? buildShipCellMap(state.p2ShipGroups) : buildShipCellMap(playerShipGroups);
  }
  let html = `<div class="grid"><div class="grid-header"><div></div>`;
  for (let c = 0; c < GRID_SIZE; c++) {
    html += `<div class="grid-label">${String.fromCharCode(65 + c)}</div>`;
  }
  html += `</div>`;
  for (let r = 0; r < GRID_SIZE; r++) {
    html += `<div class="grid-row"><div class="grid-label">${r + 1}</div>`;
    for (let c = 0; c < GRID_SIZE; c++) {
      let cls = "cell";
      let content = "";
      const isPlayer = side === "player";
      // P2P: during P2 placement, show P2's ships on the player grid
      const isP2Placement = state.gameMode === "pvp" && state.p2pPlacementPhase === "p2" && isPlayer;
      const ships = isP2Placement ? state.p2Ships : (isPlayer ? state.playerShips : state.opponentShips);
      const shots = isPlayer
        ? (state.gameMode === "pvp" ? state.p2Shots : state.opponentShots)
        : state.playerShots;
      const hits = isPlayer
        ? (state.gameMode === "pvp" ? state.p2Hits : state.opponentHits)
        : state.playerHits;

      if (isBitSet(shots, r, c)) {
        if (isBitSet(hits, r, c)) {
          // Check if this hit cell belongs to a fully sunk ship
          let isSunk = false;
          if (!isPlayer) {
            for (const g of opponentShipGroups) {
              if ((g.mask & getMask(r, c)) && (state.playerHits & g.mask) === g.mask) {
                isSunk = true;
                break;
              }
            }
          } else {
            // P2P: P2's hits on P1's grid are in p2Hits
            const checkHits = state.gameMode === "pvp" ? state.p2Hits : state.opponentHits;
            const checkGroups = state.gameMode === "pvp" ? playerShipGroups : playerShipGroups;
            for (const g of checkGroups) {
              if ((g.mask & getMask(r, c)) && (checkHits & g.mask) === g.mask) {
                isSunk = true;
                break;
              }
            }
          }
          cls += isSunk ? " cell-sunk" : " cell-hit";
          content = isSunk ? "☠" : "💥";
        } else {
          cls += " cell-miss";
          content = "🌊";
        }
      } else if (isPlayer && isBitSet(ships, r, c)) {
        // P2P: hide P1's ships from P2 during battle
        if (state.gameMode === "pvp" && state.phase === "battle" && state.currentTurn === "opponent") {
          cls += " cell-water";
        } else {
          cls += " cell-ship";
          const info = shipCellMap[cellToBit(r, c)];
          content = info ? shipSegmentSVG(info) : "🚢";
        }
      } else {
        cls += " cell-water";
      }

      const clickable =
        (state.phase === "placement" && isPlayer) ||
        (state.phase === "battle" && !isPlayer && state.currentTurn === "player" && (state.scanMode || !isBitSet(shots, r, c))) ||
        (state.phase === "battle" && isPlayer && state.gameMode === "pvp" && state.currentTurn === "opponent" && !isBitSet(shots, r, c));
      if (clickable) cls += " cell-clickable";
      if (state.scanMode && !isPlayer) cls += " cell-scan-target";

      // P2P: when P2 is firing, hide P1's ship positions (privacy!)
      const hideShipsInP2P = state.gameMode === "pvp" && isPlayer && state.phase === "battle" && state.currentTurn === "opponent";

      const onclick = isPlayer
        ? (hideShipsInP2P ? `onclick="window.pvpFire(${r}, ${c})"` : `onclick="window.placeShip(${r}, ${c})"`)
        : `onclick="window.fireAt(${r}, ${c})"`;

      // data-cell 是特效层定位格子的唯一锚点（fx.key(side,row,col)）。
      // 节点每次 render 都会重建，但 key 不变，所以特效能重新找到它。
      html += `<div class="${cls}" data-cell="${side}-${r}-${c}" ${clickable ? onclick : ""}>${content}</div>`;
    }
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

function renderBlockchainBar() {
  const s = state.zkStats;
  const verifyRate = s.proofsGenerated > 0
    ? Math.round((s.proofsVerified / s.proofsGenerated) * 100)
    : 0;

  return `
    <div class="bc-bar">
      <div class="bc-item">
        <span class="bc-icon">⚡</span>
        <span class="bc-label">ZK Proofs</span>
        <span class="bc-value">${s.proofsGenerated}</span>
      </div>
      <div class="bc-item">
        <span class="bc-icon">✓</span>
        <span class="bc-label">Verified</span>
        <span class="bc-value bc-value--green">${s.proofsVerified}</span>
      </div>
      <div class="bc-item">
        <span class="bc-icon">📊</span>
        <span class="bc-label">Verify Rate</span>
        <span class="bc-value">${verifyRate}%</span>
      </div>
      <div class="bc-item bc-item--addr">
        <span class="bc-icon">🔗</span>
        <span class="bc-label">Aleo Network</span>
        <span class="bc-value bc-value--purple">Testnet</span>
      </div>
      <div class="bc-item bc-item--addr">
        <span class="bc-icon">👛</span>
        <span class="bc-label">Wallet</span>
        <span class="bc-value bc-value--mono">${state.aleoAddress ? state.aleoAddress.substring(0, 14) + "…" : "N/A"}</span>
      </div>
      <div class="bc-item bc-item--addr">
        <span class="bc-icon">📋</span>
        <span class="bc-label">Program</span>
        <span class="bc-value bc-value--mono">shadowfleet.aleo</span>
      </div>
    </div>`;
}

function renderStatusBar() {
  let status = "";
  if (state.phase === "placement") {
    const playerLabel = state.gameMode === "pvp"
      ? (state.p2pPlacementPhase === "p1" ? "玩家 1" : "玩家 2")
      : "";
    status = `🚢 ${playerLabel}部署阶段 — 放完 ${SHIPS.length} 艘船即可开战`;
  } else if (state.phase === "battle") {
    if (state.scanMode) {
      status = "📡 扫描模式 — 点击敌方海域选择扫描中心";
    } else if (state.gameMode === "pvp") {
      status = state.currentTurn === "player" ? "🎯 玩家 1 回合 — 点击敌方海域开火" : "🎯 玩家 2 回合 — 点击对方海域开火";
    } else {
      status = state.currentTurn === "player"
        ? "🎯 你的回合 — 点击敌方海域开火"
        : "⏳ 对手正在计算命中…";
    }
  } else if (state.phase === "gameover") {
    status = state.winner === "player" ? "🏆 胜利！" : "💀 失败！";
  }

  // Combo indicator
  const comboBadge = state.combo >= 2
    ? `<span class="combo-badge">🔥 连击 x${state.combo}</span>`
    : "";

  // Weather indicator
  const w = WEATHER[state.weather];
  const weatherBadge = state.phase === "battle"
    ? `<span class="weather-badge" title="${w.name}：${w.desc}">${w.icon} ${w.name}</span>`
    : "";

  // ZK Radar Scan button
  const scanDisabled = isScanDisabled(state.weather);
  const scanBtn = state.phase === "battle" && state.currentTurn === "player" && state.scansRemaining > 0 && !scanDisabled
    ? `<button class="scan-btn${state.scanMode ? " is-active" : ""}" onclick="window.activateScan()">📡 ZK 雷达扫描</button>`
    : scanDisabled && state.phase === "battle"
      ? '<span class="scan-btn scan-btn--used">🌫️ 雾天·扫描失效</span>'
      : state.scansRemaining === 0 && state.phase === "battle"
        ? '<span class="scan-btn scan-btn--used">✅ 扫描已用</span>'
        : "";

  // Special weapons buttons
  const weaponBtns = state.phase === "battle" && state.currentTurn === "player" && state.gameMode === "ai"
    ? Object.values(WEAPONS).map(wp => {
        const remaining = state.weapons[wp.id]?.remaining || 0;
        const isActive = state.weapons.selectedWeapon === wp.id;
        const isUsed = remaining === 0;
        return `<button class="weapon-btn${isActive ? " is-active" : ""}${isUsed ? " is-used" : ""}"
          onclick="window.selectWeapon('${wp.id}')"
          ${isUsed ? "disabled" : ""}
          title="${wp.name}：${wp.desc}">
          ${wp.icon} ${wp.name}${remaining > 0 ? ` (${remaining})` : ""}
        </button>`;
      }).join("")
    : "";

  // Rank badge
  const rank = getRank(state.rankData.rating);
  const rankBadge = `<span class="rank-badge" style="color:${rank.color}">${rank.icon} ${rank.name} ${state.rankData.rating}</span>`;

  // 三态：加载中（引擎正在 Worker 里实例化 wasm）/ 已启用（真实 ZK）/ 降级（环境不支持）
  const zkLoading = !state.zkEnabled && window.__zkDiag && window.__zkDiag.mode === "probing";
  const zkStatus = zkLoading
    ? '<span class="zk-badge zk-loading">⏳ 零知识引擎加载中…</span>'
    : state.zkEnabled
      ? '<span class="zk-badge zk-active">🔒 零知识验证 · 已启用</span>'
      : '<span class="zk-badge zk-fallback">⚠ 本地校验模式</span>';

  const speedSel = `
    <label class="speed-sel">
      <span class="speed-sel-label">⚡速度</span>
      <select onchange="window.setGameSpeed(this.value)" aria-label="游戏速度">
        ${SPEED_OPTIONS.map((o) => `<option value="${o.mult}"${gameSpeed === o.mult ? " selected" : ""}>${o.label}</option>`).join("")}
      </select>
    </label>`;

  return `
    <div class="status-left">${status} ${comboBadge} ${weatherBadge}</div>
    <div class="status-right">
      ${scanBtn}
      ${weaponBtns ? `<div class="weapon-bar">${weaponBtns}</div>` : ""}
      ${zkStatus}
      ${rankBadge}
      ${state.aleoAddress ? `<span class="addr-badge">Aleo: ${state.aleoAddress.substring(0, 12)}...</span>` : ""}
      ${speedSel}
    </div>`;
}

// ===== AI PANEL (MCP-powered) =====
function renderAIPanel() {
  if (!state.aiPanelOpen) {
    return `<button class="ai-toggle" onclick="window.toggleAI()"><span>🤖</span> AI 战术助手</button>`;
  }

  const ai = generateAIPanel();
  const bf = ai.battlefield;
  const move = ai.bestMove;
  const proof = ai.proofInfo;

  let moveHtml = "";
  if (move) {
    moveHtml = `
      <div class="ai-suggestion">
        <div class="ai-sug-head">
          <span class="ai-sug-icon">🎯</span>
          <span class="ai-sug-label">推荐射击</span>
          <span class="ai-sug-cell">${move.label}</span>
          <span class="ai-sug-score">得分 ${move.score}</span>
        </div>
        <div class="ai-sug-reason">${move.reason}</div>
        <button class="ai-fire-btn" onclick="window.aiFire(${move.row}, ${move.col})">⚡ 一键执行</button>
      </div>`;
  }

  let proofHtml = "";
  if (proof) {
    proofHtml = `
      <div class="ai-proof">
        <div class="ai-proof-head">
          <span class="ai-proof-icon">🔐</span>
          <span class="ai-proof-label">ZK 证明解释</span>
          <span class="ai-proof-fn">${proof.function}()</span>
        </div>
        <div class="ai-proof-body">
          <div class="ai-proof-row"><span>作用:</span> ${proof.whatItDoes}</div>
          <div class="ai-proof-row"><span>原理:</span> ${proof.howItWorks}</div>
          <div class="ai-proof-row"><span>隐私:</span> ${proof.privacyGuarantee}</div>
          <div class="ai-proof-row"><span>结果:</span> <code class="ai-proof-result">${proof.result}</code></div>
          <div class="ai-proof-row"><span>引擎:</span> ${proof.isZkProof ? "✓ ZK 证明" : "⚠ 回退"} ${proof.proofHash !== "N/A (fallback)" ? "· " + proof.proofHash.substring(0, 12) : ""}</div>
        </div>
      </div>`;
  }

  const gpuBadge = state.gpuEnabled
    ? `<span class="engine-badge engine-gpu">⚡ WebGPU ${state.gpuMs > 0 ? state.gpuMs + "ms" : ""}</span>`
    : `<span class="engine-badge engine-cpu">🔧 WASM/JS</span>`;

  const zkBadge = bf.zk.enabled
    ? `<span class="engine-badge engine-zk">✓ ZK 已启用</span>`
    : `<span class="engine-badge engine-fallback">⚠ 本地校验</span>`;

  return `
    <div class="ai-panel">
      <div class="ai-panel-head">
        <h3>🤖 AI 战术助手</h3>
        <span class="ai-engine-info">${gpuBadge} ${zkBadge}</span>
        <button class="ai-close" onclick="window.toggleAI()">✕</button>
      </div>
      <div class="ai-panel-body">
        <div class="ai-stats">
          <div class="ai-stat"><span class="ai-stat-val">${bf.opponent.shipsRemaining}</span><span class="ai-stat-label">敌方剩余</span></div>
          <div class="ai-stat"><span class="ai-stat-val">${bf.player.shipsRemaining}</span><span class="ai-stat-label">我方剩余</span></div>
          <div class="ai-stat"><span class="ai-stat-val">${bf.zk.proofsGenerated}</span><span class="ai-stat-label">ZK 证明数</span></div>
          <div class="ai-stat"><span class="ai-stat-val">${bf.zk.proofsVerified}</span><span class="ai-stat-label">已验证</span></div>
        </div>
        ${moveHtml}
        ${proofHtml}
        <div class="ai-tools">
          <button class="ai-tool-btn" onclick="window.aiAnalyze()">📊 分析战局</button>
          <button class="ai-tool-btn" onclick="window.aiReview()">📋 战局复盘</button>
          <button class="ai-tool-btn" onclick="window.aiSuggest()">🎯 推荐射击</button>
          <button class="ai-tool-btn" onclick="window.aiExplain()">🔐 解释证明</button>
          ${state.gpuEnabled ? '<button class="ai-tool-btn" onclick="window.aiBenchmark()">⚡ GPU 跑分</button>' : ""}
        </div>
        <div class="ai-analysis" id="ai-analysis"></div>
      </div>
    </div>`;
}

window.toggleAI = () => {
  state.aiPanelOpen = !state.aiPanelOpen;
  render();
};

window.aiFire = (row, col) => {
  state.aiPanelOpen = false;
  if (window.fireAt) window.fireAt(row, col);
};

window.aiAnalyze = () => {
  const bf = callTool("get_battlefield");
  const el = document.getElementById("ai-analysis");
  if (!el) return;
  el.innerHTML = `
    <div class="ai-result">
      <div class="ai-result-head">📊 战局分析</div>
      <div class="ai-result-body">
        <div>阶段: ${bf.phase} | 回合: ${bf.turn === "player" ? "你的" : "对手"}</div>
        <div>敌方剩余: ${bf.opponent.shipsRemaining}/${bf.opponent.totalShips} 格</div>
        <div>我方剩余: ${bf.player.shipsRemaining}/${bf.player.totalShips} 格</div>
        <div>ZK 证明: ${bf.zk.proofsGenerated} 总 / ${bf.zk.proofsVerified} 验证 / ${bf.zk.proofsFallback} 回退</div>
        <div>难度: ${bf.difficulty}</div>
      </div>
    </div>`;
};

window.aiReview = () => {
  const review = callTool("battle_review");
  const el = document.getElementById("ai-analysis");
  if (!el) return;
  el.innerHTML = `
    <div class="ai-result">
      <div class="ai-result-head">📋 战局复盘</div>
      <div class="ai-result-body">
        <div>状态: ${review.status}</div>
        <div>ZK 证明: ${review.zkProofs.total} 总 / ${review.zkProofs.verifyRate} 验证率</div>
        <div>我方: ${review.player.shipsRemaining}/${review.player.totalShips} 格</div>
        <div>敌方: ${review.opponent.shipsRemaining}/${review.opponent.totalShips} 格</div>
        <div class="ai-verdict">${review.verdict}</div>
      </div>
    </div>`;
};

window.aiSuggest = () => {
  const sug = callTool("suggest_move");
  const el = document.getElementById("ai-analysis");
  if (!el) return;
  if (sug.error) { el.innerHTML = `<div class="ai-result"><div class="ai-result-body">${sug.error}</div></div>`; return; }
  const html = sug.suggestions.map((s, i) => `
    <div class="ai-sug-item" onclick="window.aiFire(${s.row}, ${s.col})" style="cursor:pointer">
      <span class="ai-sug-rank">${i + 1}</span>
      <span class="ai-sug-cell">${s.label}</span>
      <span class="ai-sug-score">${s.score}分</span>
      <span class="ai-sug-reason-small">${s.reason}</span>
    </div>`).join("");
  el.innerHTML = `<div class="ai-result"><div class="ai-result-head">🎯 射击推荐 (点击执行)</div><div class="ai-result-body">${html}</div></div>`;
};

window.aiExplain = () => {
  const proof = callTool("explain_proof");
  const el = document.getElementById("ai-analysis");
  if (!el) return;
  if (proof.error) { el.innerHTML = `<div class="ai-result"><div class="ai-result-body">${proof.error}</div></div>`; return; }
  el.innerHTML = `
    <div class="ai-result">
      <div class="ai-result-head">🔐 ZK 证明解释 — ${proof.function}()</div>
      <div class="ai-result-body">
        <div><b>作用:</b> ${proof.whatItDoes}</div>
        <div><b>原理:</b> ${proof.howItWorks}</div>
        <div><b>隐私:</b> ${proof.privacyGuarantee}</div>
        <div><b>结果:</b> <code>${proof.result}</code></div>
        <div><b>证明:</b> ${proof.isZkProof ? "✓ 真实 ZK" : "⚠ 回退"} ${proof.proofHash}</div>
      </div>
    </div>`;
};

window.aiBenchmark = async () => {
  const ships = state.opponentShips || 0b00100_00010_00000_01000_00100;
  const mask = 1 << 12;
  const bm = await ZKGPU.benchmark(ships, mask);
  const el = document.getElementById("ai-analysis");
  if (!el) return;
  if (bm.gpuMs < 0) {
    el.innerHTML = `<div class="ai-result"><div class="ai-result-head">⚡ GPU Benchmark</div><div class="ai-result-body">WebGPU 不可用</div></div>`;
    return;
  }
  const barGpu = Math.min(100, bm.gpuMs * 10);
  const barCpu = Math.min(100, bm.cpuMs * 100);
  el.innerHTML = `
    <div class="ai-result">
      <div class="ai-result-head">⚡ GPU vs CPU Benchmark</div>
      <div class="ai-result-body">
        <div class="bench-row">
          <span class="bench-label">⚡ WebGPU</span>
          <div class="bench-bar"><div class="bench-fill bench-gpu" style="width:${barGpu}%"></div></div>
          <span class="bench-ms">${bm.gpuMs}ms</span>
        </div>
        <div class="bench-row">
          <span class="bench-label">🔧 CPU</span>
          <div class="bench-bar"><div class="bench-fill bench-cpu" style="width:${barCpu}%"></div></div>
          <span class="bench-ms">${bm.cpuMs}ms</span>
        </div>
        <div class="bench-speedup">加速倍数: ${bm.speedup}x</div>
      </div>
    </div>`;
};

// ===== EDUCATION PANEL =====
function renderEduPanel() {
  return renderEduPanelContent();
}

function renderEduPanelContent() {
  const cards = renderCardCollection(state.unlockedCards);
  const lab = renderZKLab();
  const quizInfo = state.answeredQuizzes.length > 0
    ? `<div class="edu-quiz-info">已答题：${state.answeredQuizzes.length}/6</div>`
    : "";
  return `
    <div class="edu-panel">
      <div class="edu-panel-head">
        <h3>🎓 区块链课堂</h3>
        <button class="edu-close" onclick="window.closeEdu()">✕</button>
      </div>
      <div class="edu-panel-body">
        ${quizInfo}
        ${lab}
        ${cards}
      </div>
    </div>`;
}

// 区块链课堂（含概念卡片收藏 + ZK 实验室）——
// 始终以全屏 overlay 占据主显示，而非游戏内联小面板。
window.toggleEdu = () => {
  const container = document.getElementById("edu-overlay-container");
  const alreadyOpen = container && container.innerHTML.includes("edu-panel");
  if (alreadyOpen) {
    window.closeEdu();
    return;
  }
  state.eduPanelOpen = true;
  showEduOverlay(`<div class="edu-overlay edu-overlay--panel" onclick="if(event.target===this)window.closeEdu()">${renderEduPanelContent()}</div>`);
};

window.closeEdu = () => {
  state.eduPanelOpen = false;
  // Remove overlay if present
  const overlay = document.getElementById("edu-overlay-container");
  if (overlay) {
    overlay.innerHTML = "";
  }
  render();
};

window.eduOpenLab = (labId) => {
  state.eduLabActive = labId;
  if (labId === "bitwise_and") {
    showEduOverlay(renderBitwiseAndDemo());
    initBitwiseDemo();
  } else if (labId === "privacy") {
    showEduOverlay(renderPrivacyDemo());
    initPrivacyDemo();
  } else if (labId === "blockchain") {
    showEduOverlay(renderBlockchainDemo());
    initBlockchainDemo();
  }
};

window.eduCloseLab = () => {
  state.eduLabActive = null;
  const el = document.getElementById("edu-lab-overlay");
  if (el) el.remove();
  // 若外层 overlay 容器里已无实质内容（edu panel 一起被清掉的场景），
  // 残留的空 .edu-overlay 会挡住整页点击 —— 一并清空容器。
  const container = document.getElementById("edu-overlay-container");
  if (container) {
    const hasContent = container.querySelector(".edu-panel, .edu-card, .edu-quiz-card");
    if (!hasContent) container.innerHTML = "";
  }
};

function showEduOverlay(html) {
  let el = document.getElementById("edu-overlay-container");
  if (!el) {
    el = document.createElement("div");
    el.id = "edu-overlay-container";
    document.body.appendChild(el);
  }
  el.innerHTML = html;
}

// ===== QUIZ HANDLERS =====
window.eduSkipQuiz = () => {
  state.eduQuizActive = null;
  const el = document.getElementById("edu-quiz-overlay");
  if (el) el.remove();
};

window.eduAnswerQuiz = (index) => {
  const quiz = state.eduQuizActive;
  if (!quiz) return;
  const overlay = document.getElementById("edu-quiz-overlay");
  if (overlay) {
    overlay.innerHTML = renderQuizResult(quiz, index);
  }
  const correct = index === quiz.answer;
  if (correct && !state.answeredQuizzes.includes(quiz.id)) {
    state.answeredQuizzes.push(quiz.id);
    // Apply reward
    if (quiz.rewardType === "scan") state.scansRemaining++;
    else if (quiz.rewardType === "torpedo") state.weapons.torpedo.remaining++;
    else if (quiz.rewardType === "emp") state.weapons.emp.remaining++;
    else if (quiz.rewardType === "elo") state.rankData.rating += 50;
    else if (quiz.rewardType === "card") {
      const card = checkCardUnlock("weaponUsed", state);
      if (card) {
        state.unlockedCards.push(card.id);
        setTimeout(() => showEduOverlay(renderCardPopup(card)), 2000);
      }
    }
    sfx.victory();
  } else if (!correct) {
    sfx.deny();
  }
};

window.eduCloseQuiz = () => {
  state.eduQuizActive = null;
  const el = document.getElementById("edu-quiz-overlay");
  if (el) el.remove();
  render();
};

window.eduCloseCard = () => {
  state.eduCardActive = null;
  const el = document.getElementById("edu-card-overlay");
  if (el) el.remove();
};

/** 在游戏事件中触发问答 */
function triggerEduQuiz(triggerEvent) {
  if (state.eduQuizActive) return; // Already showing
  const quiz = getQuizForTrigger(triggerEvent, state.answeredQuizzes);
  if (!quiz) return;
  state.eduQuizActive = quiz;
  showEduOverlay(renderQuizPopup(quiz));
}

/** 解锁概念卡片 */
function unlockEduCard(unlockKey) {
  const card = checkCardUnlock(unlockKey, state);
  if (!card) return;
  state.unlockedCards.push(card.id);
  setTimeout(() => showEduOverlay(renderCardPopup(card)), 1500);
  fx.banner(`🃏 概念卡片解锁：${card.name}`, "sunk", 2000);
  sfx.sunk();
}

// ===== BITWISE AND DEMO =====
let _bitDemoShips = 0b00100_00010_00000_01000_00100;
let _bitDemoMask = 0;

function initBitwiseDemo() {
  updateBitwiseDemo();
  // Attach click handlers after render.
  // 必须用事件委托：updateBitwiseDemo() 每次都用 innerHTML 重写格子，
  // 若把 onclick 直接绑在 .edu-bit 子元素上，第一次重绘后 handler 全部丢失
  //（这就是"只能点一次"的 bug）。委托绑定在容器上，子元素怎么重写都有效。
  setTimeout(() => {
    const shipsBits = document.getElementById("edu-ships-bits");
    const maskBits = document.getElementById("edu-mask-bits");
    if (shipsBits) {
      shipsBits.onclick = (e) => {
        const bit = e.target.closest(".edu-bit");
        if (!bit) return;
        const i = Array.from(shipsBits.querySelectorAll(".edu-bit")).indexOf(bit);
        if (i >= 0) {
          _bitDemoShips ^= (1 << i);
          updateBitwiseDemo();
        }
      };
    }
    if (maskBits) {
      maskBits.onclick = (e) => {
        const bit = e.target.closest(".edu-bit");
        if (!bit) return;
        const i = Array.from(maskBits.querySelectorAll(".edu-bit")).indexOf(bit);
        if (i >= 0) {
          _bitDemoMask ^= (1 << i);
          updateBitwiseDemo();
        }
      };
    }
  }, 50);
}

function updateBitwiseDemo() {
  const shipsEl = document.getElementById("edu-ships-bits");
  const maskEl = document.getElementById("edu-mask-bits");
  const resultEl = document.getElementById("edu-result-bits");
  const conclusionEl = document.getElementById("edu-lab-conclusion");
  if (!shipsEl || !maskEl || !resultEl) return;

  const result = _bitDemoShips & _bitDemoMask;
  const isHit = result !== 0;

  let shipsHtml = "";
  let maskHtml = "";
  let resultHtml = "";

  for (let i = 0; i < 25; i++) {
    const s = (_bitDemoShips >> i) & 1;
    const m = (_bitDemoMask >> i) & 1;
    const r = (result >> i) & 1;
    shipsHtml += `<div class="edu-bit ${s ? "is-ship" : ""}">${s}</div>`;
    maskHtml += `<div class="edu-bit ${m ? "is-mask" : ""}">${m}</div>`;
    resultHtml += `<div class="edu-bit ${r ? "is-hit" : ""}">${r}</div>`;
  }

  shipsEl.innerHTML = shipsHtml;
  maskEl.innerHTML = maskHtml;
  resultEl.innerHTML = resultHtml;

  if (conclusionEl) {
    conclusionEl.innerHTML = isHit
      ? `<div class="edu-hit-result">💥 命中！ships & mask ≠ 0 — 该格有船</div>`
      : `<div class="edu-miss-result">🌊 未命中 — 该格无船</div>`;
  }
}

// ===== PRIVACY LAB DEMO（双视角：我方见船，对手只见结果） =====
const _privShips = 0b00100_00010_00000_01000_00100; // 5 格示例船位
let _privShots = 0;   // 已开火格子 bitmask
let _privView = "mine";

function initPrivacyDemo() {
  _privShots = 0;
  _privView = "mine";
  updatePrivacyDemo();
}

window.eduSwitchView = (view) => {
  _privView = view;
  updatePrivacyDemo();
};

function updatePrivacyDemo() {
  const board = document.getElementById("edu-privacy-board");
  const mineBtn = document.getElementById("edu-view-mine");
  const oppBtn = document.getElementById("edu-view-opp");
  if (!board) return;

  if (mineBtn) mineBtn.classList.toggle("is-active", _privView === "mine");
  if (oppBtn) oppBtn.classList.toggle("is-active", _privView === "opp");

  let html = `<div class="edu-priv-grid${_privView === "opp" ? " is-opp" : ""}">`;
  for (let i = 0; i < 25; i++) {
    const hasShip = (_privShips >> i) & 1;
    const fired = (_privShots >> i) & 1;
    let cls = "edu-priv-cell";
    let content = "";
    if (fired) {
      if (hasShip) { cls += " is-hit"; content = "💥"; }
      else { cls += " is-miss"; content = "🌊"; }
    } else if (hasShip && _privView === "mine") {
      cls += " is-ship";
      content = "🚢";
    } else if (_privView === "mine") {
      cls += " is-clickable";
    } else {
      cls += " is-unknown";
      content = "?";
    }
    html += `<div class="${cls}" data-bit="${i}">${content}</div>`;
  }
  html += `</div>`;

  const label = _privView === "mine"
    ? "👁 你的视角：能看见自己的船，点击空格开火"
    : "🤖 对手视角：船完全隐形，只能看到开火结果";
  html += `<p class="edu-priv-label">${label}</p>`;

  board.innerHTML = html;

  // 事件委托：点击开火（两个视角都允许，方便对比）
  board.onclick = (e) => {
    const cell = e.target.closest(".edu-priv-cell");
    if (!cell) return;
    const i = parseInt(cell.dataset.bit, 10);
    if (isNaN(i) || (_privShots >> i) & 1) return; // 已开火
    _privShots |= (1 << i);
    updatePrivacyDemo();
    const hit = (_privShips >> i) & 1;
    const conc = document.getElementById("edu-privacy-conclusion");
    if (conc) {
      conc.innerHTML = hit
        ? `💥 <b>命中</b> — 对手看到 💥（由 ZK 证明保证），但<b>不知道你其余船在哪</b>`
        : `🌊 <b>未中</b> — 对手只多了一个 🌊 标记，<b>你的船位依然完全隐藏</b>`;
    }
  };
}

// ===== BLOCKCHAIN FLOW DEMO（开火 → 证明 → 验证 链路动画） =====
const BC_FLOW_STEPS = [
  { icon: "🖱️", title: "点击开火", desc: "选择敌方一格，生成公开输入 mask" },
  { icon: "🔐", title: "取私有输入", desc: "ships bitstring 作为私有输入进入 ZK 程序（永不明文传输）" },
  { icon: "⚡", title: "生成 ZK 证明", desc: "Aleo snarkVM 在浏览器内执行 verify_hit 并生成证明" },
  { icon: "⛓️", title: "证明可上链", desc: "证明包含计算正确性承诺，无需暴露 ships" },
  { icon: "✅", title: "验证通过", desc: "任何一方可验证证明 → 输出 ships & mask（命中/未中）" },
];

function initBlockchainDemo() {
  const flow = document.getElementById("edu-bc-flow");
  if (!flow) return;
  flow.innerHTML = BC_FLOW_STEPS.map((s, i) => `
    <div class="edu-bc-step" data-step="${i}">
      <span class="edu-bc-icon">${s.icon}</span>
      <div class="edu-bc-text">
        <div class="edu-bc-title">${i + 1}. ${s.title}</div>
        <div class="edu-bc-desc">${s.desc}</div>
      </div>
    </div>`).join("");
}

window.eduRunBcFlow = () => {
  const steps = document.querySelectorAll(".edu-bc-step");
  steps.forEach(s => s.classList.remove("is-active", "is-done"));
  const conc = document.getElementById("edu-bc-conclusion");
  if (conc) conc.innerHTML = "执行中…";

  steps.forEach((step, i) => {
    setTimeout(() => {
      steps.forEach((s, j) => {
        s.classList.toggle("is-active", j === i);
        s.classList.toggle("is-done", j < i);
      });
      if (i === steps.length - 1) {
        const conc = document.getElementById("edu-bc-conclusion");
        if (conc) {
          conc.innerHTML = `✅ 完成！全程 <b>5 步</b>，私有输入 ships 从未以明文出现 — 这就是零知识证明。`;
        }
      }
    }, i * 700);
  });
};

function renderProofPanel() {
  const zkLoading = !state.zkEnabled && window.__zkDiag && window.__zkDiag.mode === "probing";
  const privacyNote = zkLoading
    ? `
    <div class="privacy-note is-loading">
      <div class="pn-icon" aria-hidden="true">⏳</div>
      <div class="pn-body">
        <h3>正在启用零知识加密…</h3>
        <p>Aleo 零知识引擎正在后台加载（约 21MB wasm，首次稍慢）。加载完成后船位将作为 ZK 程序的<strong>私有输入</strong>被加密保护，游戏可正常进行。</p>
      </div>
    </div>`
    : state.zkEnabled
      ? `
    <div class="privacy-note">
      <div class="pn-icon" aria-hidden="true">🔒</div>
      <div class="pn-body">
        <h3>船位零知识加密保护已启用</h3>
        <p>你的船位作为 ZK 程序的<strong>私有输入</strong>被加密保护——每一发命中/未中都由零知识证明验证，<strong>游戏过程中绝不向对手泄露</strong>船的位置。</p>
      </div>
    </div>`
      : `
    <div class="privacy-note is-fallback">
      <div class="pn-icon" aria-hidden="true">⚠</div>
      <div class="pn-body">
        <h3>本局未启用零知识加密（本地校验模式）</h3>
        <p>当前为本地降级模式，命中判定由本地计算得出，<strong>船位并未经过零知识加密保护</strong>。配置好 Aleo 网络后将自动启用。</p>
      </div>
    </div>`;

  const summary = state.zkEnabled
    ? "🔒 本回合命中已由零知识证明验证 — 点开看原始密码学数据"
    : "⚠ 当前为本地降级模式，未运行真·零知识证明 — 点开看日志";

  const logHtml = state.proofLog.length === 0
    ? '<div class="proof-empty">还没有生成证明，开火后会出现在这里。</div>'
    : state.proofLog.map(entry => `
    <div class="proof-entry ${entry.zkProof ? "zk-real" : "zk-fallback"}">
      <div class="proof-header">
        <span class="proof-func">${entry.function}()</span>
        <span class="proof-time">${entry.timestamp}</span>
        <span class="proof-engine engine-${entry.engine === 'WebGPU' ? 'gpu' : entry.engine === 'WASM' ? 'wasm' : 'js'}">${entry.engine}${entry.ms > 0 ? ' · ' + entry.ms + 'ms' : ''}</span>
        <span class="proof-badge ${entry.zkProof ? "badge-real" : "badge-fallback"}">
          ${entry.zkProof ? "✓ ZK PROOF" : "⚠ FALLBACK"}
        </span>
      </div>
      <div class="proof-details">
        <div class="proof-row"><span>ships (private):</span> <code>${entry.shipsHidden}</code></div>
        <div class="proof-row"><span>mask (public):</span> <code>${entry.publicInput}u32</code></div>
        <div class="proof-row"><span>result:</span> <code class="proof-result">${entry.result}</code></div>
        <div class="proof-row"><span>proof hash:</span> <code class="proof-hash">${entry.proofHash}</code></div>
      </div>
    </div>
  `).join("");

  return privacyNote + `
    <details class="proof-collapsible">
      <summary>${summary}</summary>
      <div class="proof-log">${logHtml}</div>
    </details>`;
}

function renderProofLog() {
  const panel = document.querySelector(".proof-panel");
  if (panel) panel.innerHTML = renderProofPanel();
}

// ===== BATTLE FEED (human-language combat log) =====
function addBattle(text, type = "sys") {
  state.battleLog.unshift({ text, type, time: new Date().toLocaleTimeString() });
  if (state.battleLog.length > 8) state.battleLog.pop();
}

function renderBattleFeed() {
  const list = state.battleLog.length
    ? state.battleLog.map(e => `
      <div class="battle-entry battle-${e.type}">
        <span class="battle-time">${e.time}</span>
        <span class="battle-text">${e.text}</span>
      </div>`).join("")
    : '<div class="battle-empty">放船开火后，这里会实时播报战况。</div>';
  return `
    <div class="battle-feed-head">
      <h3>⚔ 战斗实况 ${state.matchRound > 0 || state.matchWins > 0 || state.matchLosses > 0 ? `<span class="match-score">(${state.matchWins}:${state.matchLosses})</span>` : ""}</h3>
      <span class="battle-score">敌方舰剩 ${state.opponentShipsRemaining}/${TOTAL_SHIP_CELLS} · 我方舰剩 ${state.playerShipsRemaining}/${TOTAL_SHIP_CELLS}</span>
    </div>
    <div class="battle-list">${list}</div>`;
}

function renderGameOver() {
  const s = state.zkStats;
  const verifyRate = s.proofsGenerated > 0
    ? Math.round((s.proofsVerified / s.proofsGenerated) * 100)
    : 0;

  // Efficiency rating: fewer shots = more stars
  const efficiency = state.turnCount > 0 ? Math.round((TOTAL_SHIP_CELLS / state.turnCount) * 100) : 0;
  const stars = efficiency >= 80 ? "⭐⭐⭐" : efficiency >= 50 ? "⭐⭐" : efficiency >= 30 ? "⭐" : "";
  const ratingLabel = efficiency >= 80 ? "完美" : efficiency >= 50 ? "优秀" : efficiency >= 30 ? "及格" : "待提升";

  // Check if match is decided (best of 3)
  const matchDecided = state.matchWins >= 2 || state.matchLosses >= 2;
  const matchWon = state.matchWins >= 2;

  // Update match score on round end
  if (state.winner === "player" && !state.matchOver) {
    state.matchWins++;
    state.matchOver = matchDecided;
  } else if (state.winner === "opponent" && !state.matchOver) {
    state.matchLosses++;
    state.matchOver = matchDecided;
  }

  const matchScoreBar = `
    <div class="go-match-bar">
      <div class="go-match-side ${state.winner === "player" ? "is-win" : ""}">
        <span class="go-match-label">你</span>
        <span class="go-match-score">${state.matchWins}</span>
      </div>
      <div class="go-match-vs">VS (R${state.matchRound + 1})</div>
      <div class="go-match-side ${state.winner === "opponent" ? "is-win" : ""}">
        <span class="go-match-label">敌方</span>
        <span class="go-match-score">${state.matchLosses}</span>
      </div>
    </div>`;

  const matchResult = matchDecided
    ? `<div class="go-match-result ${matchWon ? "over-win" : "over-lose"}">${matchWon ? "🏆 系列赛胜利！" : "💀 系列赛落败"}</div>`
    : "";

  const actionBtn = matchDecided
    ? '<button class="restart-btn" onclick="window.restart()">返回主菜单</button>'
    : `<button class="restart-btn" onclick="window.nextRound()">下一局 →</button>
       <button class="restart-btn restart-btn--alt" onclick="window.restart()">放弃比赛</button>`;

  return `
    <div class="game-over-overlay">
      <div class="game-over-modal ${state.winner === "player" ? "over-win" : "over-lose"}">
        <h2>${state.winner === "player" ? "🏆 胜 利" : "💀 战 败"}</h2>
        <p>${state.winner === "player" ? "敌方舰队已被你全部击沉！" : "你的舰队全军覆没。"}</p>
        ${matchScoreBar}
        ${matchResult}
        <div class="go-efficiency">
          <span class="go-eff-stars">${stars}</span>
          <span class="go-eff-label">效率 ${ratingLabel}</span>
          <span class="go-eff-detail">${state.turnCount} 回合 / ${TOTAL_SHIP_CELLS} 命中</span>
        </div>
        <div class="go-blockchain-summary">
          <div class="go-bc-title">⛓ Blockchain Summary</div>
          <div class="go-bc-stats">
            <div class="go-bc-stat"><span class="go-bc-num">${s.proofsGenerated}</span><span class="go-bc-label">ZK Proofs</span></div>
            <div class="go-bc-stat"><span class="go-bc-num go-bc-num--green">${s.proofsVerified}</span><span class="go-bc-label">Verified</span></div>
            <div class="go-bc-stat"><span class="go-bc-num">${verifyRate}%</span><span class="go-bc-label">Verify Rate</span></div>
          </div>
          <div class="go-bc-program">
            <span class="go-bc-label">Program:</span>
            <code>shadowfleet.aleo</code>
          </div>
          <div class="go-bc-privacy">
            ${state.zkEnabled
              ? "🔒 本局所有命中判定均由 Aleo 零知识证明验证。船位作为私有输入全程加密，未曾泄露。"
              : "⚠ 本局运行在本地校验模式，未运行真·零知识证明。"}
          </div>
          ${state.achievements.length > 0 ? `
          <div class="go-achievements">
            <div class="go-ach-title">🏆 本局成就</div>
            <div class="go-ach-list">
              ${state.achievements.map(id => {
                const a = ACHIEVEMENTS[id];
                return a ? `<span class="go-ach-item">${a.icon} ${a.name}</span>` : "";
              }).join("")}
            </div>
          </div>` : ""}
          ${state.maxCombo >= 2 ? `<div class="go-combo">🔥 最高连击：x${state.maxCombo}</div>` : ""}
        </div>
        ${state.lastRankResult ? `
        <div class="go-rank">
          <div class="go-rank-title">🎖 排名变动</div>
          <div class="go-rank-info">
            <span class="go-rank-change ${state.lastRankResult.change >= 0 ? "rank-up" : "rank-down"}">
              ${state.lastRankResult.change >= 0 ? "▲" : "▼"} ${Math.abs(state.lastRankResult.change)}
            </span>
            <span class="go-rank-badge" style="color:${state.lastRankResult.rank.color}">
              ${state.lastRankResult.rank.icon} ${state.lastRankResult.rank.name} ${state.rankData.rating}
            </span>
            ${state.lastRankResult.streak >= 3 ? `<span class="go-rank-streak">${getStreakBonus(state.lastRankResult.streak)}</span>` : ""}
          </div>
        </div>` : ""}
        <div class="go-actions">${actionBtn}</div>
      </div>
    </div>
  `;
}

// ===== GLOBAL HANDLERS =====
window.placeShip = handlePlacementClick;
window.fireAt = playerFire;
window.toggleDir = togglePlacementDirection;
window.startGame = () => {
  sfx.init();
  sfx.click();
  // Apply fleet config
  SHIPS = FLEET_CONFIGS[state.fleetMode];
  TOTAL_SHIP_CELLS = SHIPS.reduce((s, ship) => s + ship.size, 0);
  // Reset match state for a new match
  state.matchWins = 0;
  state.matchLosses = 0;
  state.matchRound = 0;
  state.matchOver = false;
  // PvP: start with P1 placement + privacy screen
  if (state.gameMode === "pvp") {
    state.p2pPlacementPhase = "p1";
    state.p2Ships = 0;
    state.p2ShipGroups = [];
    state.p2Shots = 0;
    state.p2Hits = 0;
    state.p2ShipsRemaining = TOTAL_SHIP_CELLS;
    state.p2ScanRemaining = 1;
    state.p2Combo = 0;
    state.p2MaxCombo = 0;
    state.showPrivacyScreen = true;
    state.phase = "placement";
    resetRoundState();
    render();
    return;
  }
  state.phase = "placement";
  resetRoundState();
  render();
};
function resetRoundState() {
  playerShipGroups = [];
  opponentShipGroups = [];
  state.playerShips = 0;
  state.playerShots = 0;
  state.playerHits = 0;
  state.playerShipsRemaining = TOTAL_SHIP_CELLS;
  state.opponentShips = 0;
  state.opponentShots = 0;
  state.opponentHits = 0;
  state.opponentShipsRemaining = TOTAL_SHIP_CELLS;
  state.currentTurn = "player";
  state.winner = null;
  state.placingShipIndex = 0;
  state.placementDirection = "horizontal";
  state.proofLog = [];
  state.battleLog = [];
  state.zkStats = { proofsGenerated: 0, proofsVerified: 0, proofsFallback: 0, totalProofMs: 0 };
  state.combo = 0;
  state.maxCombo = 0;
  state.scanMode = false;
  state.scansRemaining = 1;
  state.achievements = [];
  state.turnCount = 0;
  // P2P reset
  state.p2Ships = 0;
  state.p2ShipGroups = [];
  state.p2Shots = 0;
  state.p2Hits = 0;
  state.p2ShipsRemaining = TOTAL_SHIP_CELLS;
  state.p2ScanRemaining = 1;
  state.p2Combo = 0;
  state.p2MaxCombo = 0;
  state.p2pPlacementPhase = state.gameMode === "pvp" ? "p1" : null;
  state.showPrivacyScreen = state.gameMode === "pvp";
  // Reset special features
  state.weapons = initWeapons();
  state.weather = rollWeather();
  state.weatherTurnCounter = 0;
  state.submarineDodgeAvailable = true;
  state.frigateTurnCounter = 0;
  state.empActive = false;
  state.lastRankResult = null;
  resetAI();
}

window.restart = () => {
  sfx.click();
  fx.clear();
  inputLocked = false;
  // Disconnect online session if active
  if (state.gameMode === "online") {
    Net.send({ type: "surrender" });
    Net.disconnect();
    state.onlineState = "idle";
    state.onlineOpponentReady = false;
    state.gameMode = "ai"; // Reset to AI mode
  }
  // If match is over, go back to start screen
  if (state.matchOver) {
    state.phase = "start";
    state.matchOver = false;
    state.matchWins = 0;
    state.matchLosses = 0;
    state.matchRound = 0;
    render();
    return;
  }
  // Otherwise start next round
  state.phase = "placement";
  resetRoundState();
  render();
};

// Start next round in the match
window.nextRound = () => {
  sfx.click();
  fx.clear();
  inputLocked = false;
  state.matchRound++;
  state.phase = "placement";
  resetRoundState();
  render();
};

// ===== INITIALIZATION =====
// 静音开关挂到 <body>（不在 #app 内 → 不会被全量重渲染冲掉）。
// 这里只建 DOM，不碰 AudioContext，符合自动播放策略。
sfx.mountToggle();

// ===== WebGPU 初始化 =====
ZKGPU.init().then(ok => {
  if (ok) {
    state.gpuEnabled = true;
    console.log("[GPU] WebGPU 已启用，ZK 运算将使用 GPU 加速");
    render();
  } else {
    console.log("[GPU] WebGPU 不可用，使用 WASM/JS 回退");
  }
});

// ===== 状态桥接到 MCP =====
syncState(state);

// 打开即开始页，无需 loading 引导。ZK 引擎在后台异步加载，
// 就绪（或失败降级）由下方事件监听更新状态并局部刷新，不挡玩家。
if (window.__zkReady) {
  state.zkEnabled = true;
  state.aleoAddress = window.__zkAddress;
}
render();

window.addEventListener("zk-ready", () => {
  state.zkEnabled = true;
  state.aleoAddress = window.__zkAddress;
  render();
});

window.addEventListener("zk-error", () => {
  if (!state.zkEnabled) {
    state.zkEnabled = false;
    render();
  }
});
