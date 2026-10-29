// ════════════════════════════════════════════════════════
//  tsbot.js — 機體主程式（Game Agent 的身體）
//
//  職責：
//    1. 建立 mineflayer bot 實例
//    2. 組裝 context 並初始化各模組
//    3. 啟動 Agent API（外部大腦透過 HTTP 觀察與下達動作）
//    4. 掛載事件監聽器（spawn, health, chat）並把反射層事件寫入事件緩衝區
//    5. 啟動週期性反射迴圈（威脅偵測、防溺水）
//
//  這裡不再主動呼叫任何大腦。反射（逃跑、進食、防溺水）在本地完成，
//  並以事件通知大腦；決策一律由大腦經 Agent API 下達。
//
//  所有動作邏輯在 src/actions/、感知在 src/perception.js、
//  狀態在 src/state.js、Agent API 在 src/agent/
// ════════════════════════════════════════════════════════
'use strict';

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const mcData = require('minecraft-data')('1.21.1');
const fs     = require('fs');
const path   = require('path');

require('dns').setDefaultResultOrder('ipv4first');

// ── 模組 ──
const config                = require('./src/config');
const state                 = require('./src/state');
const { createActionQueue } = require('./src/actions/index');
const startWatchdog         = require('./src/watchdog');
const { createExecutor }    = require('./src/agent/executor');
const startAgentServer      = require('./src/agent/server');
const { pushEvent }         = require('./src/agent/events');
const { buildFromPositional } = require('./src/agent/schema');
const { HOSTILE_MOBS, HIGH_DANGER_MOBS } = require('./src/agent/observation');

const MASTER_NAME = config.MASTER_NAME;
if (!MASTER_NAME) console.log('⚠️ [設定] MASTER_NAME 未設定，follow / drop / 逃跑 將找不到指揮官。請在 .env 設定。');

// ── Bot 建立 ──
const bot = mineflayer.createBot({
    host: config.MC_HOST,
    port: config.MC_PORT,
    username: config.MC_USERNAME,
    version: config.MC_VERSION,
    auth: config.MC_AUTH,
    family: 4,
    checkTimeoutInterval: 90000
});

bot.loadPlugin(pathfinder);

bot.pathfinderPlaced = 0;

// ── Context 組裝（exec 由 createActionQueue 後期注入）──
const ctx = {
    bot,
    state,
    mcData,
    goals,
    MASTER_NAME,
    exec: null,       // 由 createActionQueue 填入
    brainLoop: null,  // 由下方填入（後期綁定）
};

const executeActionQueue = createActionQueue(ctx);
const executor = createExecutor(ctx, config);

// 動作模組在背景動作結束時會呼叫 ctx.brainLoop()（例如擊殺完成）。
// 現在大腦在外部，所以改成發出事件，讓大腦知道可以做下一步。
ctx.brainLoop = () => pushEvent('wake', { reason: 'background_action_finished' });

let agentServer = null;

// ════════════════════════════════════════════════════════
//  事件監聽器
// ════════════════════════════════════════════════════════

bot.on('spawn', () => {
    // mineflayer 的 air_supply 處理沒有檢查是不是自己的實體：附近任何生物（魚、鱿魚、溺屍…）更新氧氣，
    // 都會覆蓋 bot.oxygenLevel，所以地表會出現「氧氣 3」這種假數字。這裡只認自己實體的 air_supply。
    if (!bot.oxygenFixed) {
        bot.oxygenFixed = true;
        let ownOxygen = 20;
        let airKey = -1;
        try {
            const keys = bot.registry.entitiesByName[bot.entity.name || 'player'].metadataKeys || [];
            airKey = keys.indexOf('air_supply');
        } catch (_) {}
        Object.defineProperty(bot, 'oxygenLevel', { get: () => ownOxygen, set: () => {}, configurable: true });
        bot._client.on('entity_metadata', (packet) => {
            if (airKey < 0 || !bot.entity || packet.entityId !== bot.entity.id) return;
            for (const m of packet.metadata) {
                if (m.key === airKey && typeof m.value === 'number') ownOxygen = Math.round(m.value / 15);
            }
        });
        console.log(`🫧 [氧氣] 只認自己實體的 air_supply（metadata key=${airKey}）`);
    }
    // pathfinder 會自己放方塊墊腳／搭橋（只關了 canDig，沒關 canPlace）。它放的時候 isBuilding() 為真，
    // 這裡只計數、不改行為，executor 會把數量寫進動作結果，讓大腦知道方塊為什麼變少。
    if (!bot.placeBlockWrapped && typeof bot.placeBlock === 'function') {
        bot.placeBlockWrapped = true;
        const rawPlaceBlock = bot.placeBlock.bind(bot);
        bot.pathfinderPlaceFailed = 0;
        bot.placeBlock = async (...args) => {
            const byPathfinder = !!(bot.pathfinder && bot.pathfinder.isBuilding && bot.pathfinder.isBuilding());
            const t0 = Date.now();
            const yBefore = bot.entity ? bot.entity.position.y : 0;
            try {
                // pathfinder 往腳下疊方塊時的時機差了一格：它只等「身體高過參考方塊頂面」，但新方塊佔據的是
                // 參考方塊上面那一格，腳必須升到那一格的頂面（參考方塊 y+2）以上才放得進去；放太早伺服器默默拒絕，
                // placeBlock 要白等 5 秒才逾時、再重跳一次（實測爬 4 格放置失敗 9 次、白等 45 秒）。
                // 所以這裡先等身體真的升到新方塊上方再放；跳已經過了最高點還沒到就立刻失敗，不白等。
                if (byPathfinder && args[1] && args[1].y === 1 && bot.entity) {
                    const ref = args[0].position;
                    const clearY = ref.y + 2;
                    const pp = bot.entity.position;
                    if (Math.abs(pp.x - (ref.x + 0.5)) < 0.8 && Math.abs(pp.z - (ref.z + 0.5)) < 0.8) {
                        for (let i = 0; i < 12 && bot.entity.position.y < clearY; i++) {
                            if (i > 2 && bot.entity.velocity.y < -0.05) break;      // 已經在下降，這一跳來不及了
                            await bot.waitForTicks(1);
                        }
                        if (bot.entity.position.y < clearY) throw new Error('身體還沒升到新方塊上方，這一跳先不放（不等伺服器逾時）');
                    }
                }
                const placed = await rawPlaceBlock(...args);
                if (byPathfinder) bot.pathfinderPlaced++;
                return placed;
            } catch (e) {
                if (byPathfinder) {
                    bot.pathfinderPlaceFailed++;
                    console.log(`🧱 [pathfinder放方塊] 失敗（${Date.now() - t0}ms）：${e.message}｜放置時 Y=${yBefore.toFixed(2)}→${bot.entity ? bot.entity.position.y.toFixed(2) : '?'}｜參考方塊 ${args[0] ? args[0].name + '@' + args[0].position : '?'}`);
                }
                throw e;
            }
        };
    }
    console.log(`【系統】機體已上線 ${config.MC_HOST}:${config.MC_PORT}`);
    const movements = new Movements(bot, mcData);
    movements.canDig = false;
    // pathfinder 只看碰撞箱類型：門（連打開的也一樣）都算實心，路徑永遠穿不過去（套件的 canOpenDoors 只處理柵欄門）。
    // 打開的門當成可以走過去；關著的門維持擋路，要走進去得先用 use_block 開門（goto 走不到時訊息會指出附近關著的門）。
    {
        const origGetBlock = movements.getBlock.bind(movements);
        movements.getBlock = function (pos, dx, dy, dz) {
            const b = origGetBlock(pos, dx, dy, dz);
            if (b && b.name && b.name.endsWith('_door')) {
                try { if (b.getProperties().open) { b.safe = true; b.physical = false; b.height = pos.y + dy; } } catch (_) { /* 讀不到狀態就當作關著 */ }
            }
            return b;
        };
    }
    bot.pathfinder.setMovements(movements);
    pushEvent('spawn', { position: bot.entity ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : null });
    if (!state.watchdogStarted) {
        state.watchdogStarted = true;
        startWatchdog(bot, state);
    }
    if (!agentServer) agentServer = startAgentServer(ctx, executor, config);
});

bot.on('death', () => {
    console.log('💀 [系統] 機體死亡');
    state.currentMovementMode = 'idle';
    state.bmRunning = false;
    pushEvent('death', {});
});

bot.on('kicked', (reason) => {
    console.log('🔌 [系統] 被伺服器踢出:', String(reason));
    pushEvent('disconnected', { reason: String(reason) });
});

bot.on('end', (reason) => {
    console.log('🔌 [系統] 連線結束:', String(reason));
    pushEvent('disconnected', { reason: String(reason) });
    // 區網伺服器偶爾把連線重置（write ECONNRESET，沒有踢人訊息），之後這支程式還活著卻不會重連，玩家整輪被卡死。
    // 斷線 3 秒後自己重新啟動（沿用同一份 stdout/stderr 檔案）；連續重啟太多次（真的被踢、伺服器關了）就放棄，不要無限循環。
    // 設 ECHO_AUTORESTART=0 可關閉。
    if (process.env.ECHO_AUTORESTART === '0') return;
    const n = parseInt(process.env.ECHO_RESTART_COUNT || '0', 10);
    if (n >= 6) { console.log('🔌 [系統] 已經自動重啟 6 次，放棄'); return; }
    setTimeout(() => {
        try {
            require('child_process').spawn(process.argv[0], process.argv.slice(1), {
                detached: true, stdio: 'inherit', cwd: process.cwd(),
                env: { ...process.env, ECHO_RESTART_COUNT: String(n + 1) },
            }).unref();
            console.log(`🔁 [系統] 斷線後自動重新啟動（第 ${n + 1} 次）`);
        } catch (e) { console.log('⚠️ [系統] 自動重啟失敗:', e.message); }
        process.exit(0);
    }, 3000);
});

// ── 自律神經系統：自動進食 & 殘血緊急撤退 ──
let lastHealthSeen = null;

bot.on('health', async () => {
    if (!bot.entity) return;

    let tookDamage = false;
    if (lastHealthSeen !== null && bot.health < lastHealthSeen) {
        tookDamage = true;
        const amount = lastHealthSeen - bot.health;
        pushEvent('damaged', { health: Math.round(bot.health * 10) / 10, delta: Math.round(-amount * 10) / 10 });
        recentDamage.push({ t: Date.now(), amount });
        lastDamageAt = Date.now();
    }
    lastHealthSeen = bot.health;
    {
        const cut = Date.now() - 4000;
        while (recentDamage.length && recentDamage[0].t < cut) recentDamage.shift();
        const burst = recentDamage.reduce((n, d) => n + d.amount, 0);
        const threats = nearbyHostiles(THREAT_RADIUS);
        // 血量見底，或 4 秒內連掉 6 滴以上而且身邊有怪物：中斷動作、遠離怪物（以前 ≤6 才反應、而且「逃向指揮官」，找不到指揮官就原地待命被打死）
        const fighting = state.currentMovementMode === 'attack';
        const trigger = fighting ? bot.health <= ATTACK_FLOOR_HP : (bot.health <= FLEE_HP || (burst >= 6 && threats.length > 0));
        // 只在「剛受傷」時評估：血量回復、飢餓這類 health 事件不能再觸發撤退（模型接手後會被反覆打斷）
        if (tookDamage && state.currentMovementMode !== 'flee' && trigger) {
            startFlee(fighting ? `打鬥中血量只剩 ${Math.round(bot.health)}/20，已到最後底線（${ATTACK_FLOOR_HP}）`
                : bot.health <= FLEE_HP ? `血量只剩 ${Math.round(bot.health)}/20` : `4 秒內連掉了 ${Math.round(burst)} 滴血`);
            return;
        }
    }

    if (bot.food < 15 && !state.isEating && state.currentMovementMode !== 'attack') {
        const foodItem = (() => {
            for (const fname of state.FOOD_PRIORITY) {
                const found = bot.inventory.items().find(i => i.name === fname);
                if (found) return found;
            }
            return null;
        })();
        if (!foodItem) return;

        state.isEating = true;
        console.log(`🍖 [自動進食] 飽食度 ${bot.food}/20，拿出 ${foodItem.name} 吃東西`);
        const prevItem = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
        try {
            await bot.equip(foodItem, 'hand');
            await bot.consume();
            console.log(`🍖 [自動進食] ✅ 進食完成，飽食度回升中`);
            pushEvent('ate', { item: foodItem.name, food: bot.food });
            try {
                fs.writeFileSync(
                    path.join(__dirname, '.eat_signal'),
                    `SUCCESS:${foodItem.name}:food=${bot.food}:${Date.now()}`
                );
            } catch(_) {}
        } catch (eatErr) {
            console.log(`⚠️ [自動進食] 進食失敗: ${eatErr.message}`);
            try {
                fs.writeFileSync(
                    path.join(__dirname, '.eat_signal'),
                    `FAIL:${eatErr.message}:${Date.now()}`
                );
            } catch(_) {}
        } finally {
            if (prevItem) { try { await bot.equip(prevItem, 'hand'); } catch(_) {} }
            else          { try { await bot.unequip('hand');          } catch(_) {} }
            state.isEating = false;
        }
    }
});

// ── 受怪物威脅時的反射：中斷動作、遠離怪物 ──
// 身體只負責「活下來」：中斷長動作（模型才有機會反應）、跑離怪物；要不要打、要不要蓋掩體由模型決定（attack、place_block 都在 core）。
const FLEE_HP = 8;
const ATTACK_FLOOR_HP = 5;     // 模型下令攻擊後，一般撤退（血量 ≤8、連續掉血）不再中斷戰鬥，只有血量掉到這個最後底線才強制撤退
// 骷髏的箭射程遠超 10 格（玩家被 10～12 格外的骷髏射死：反射判定「身邊沒怪物」就解除了撤退），所以威脅半徑要用 20 格
const THREAT_RADIUS = 20;
let lastDamageAt = 0;
let recentDamage = [];          // 最近幾秒的受傷紀錄 {t, amount}
let fleeQuietTicks = 0;         // 連續幾秒身邊沒有怪物

function nearbyHostiles(maxDist) {
    if (!bot.entity) return [];
    const out = [];
    for (const e of Object.values(bot.entities)) {
        if (!e || e === bot.entity || !e.position || !e.name) continue;
        const name = String(e.name).toLowerCase();
        if (!HOSTILE_MOBS.has(name)) continue;
        const dist = e.position.distanceTo(bot.entity.position);
        if (dist <= maxDist) out.push({ name, dist, entity: e });
    }
    return out.sort((a, b) => a.dist - b.dist);
}

function describeThreats(list) {
    if (!list.length) return '附近看不到怪物';
    const by = {};
    for (const t of list) { by[t.name] = by[t.name] || { n: 0, d: t.dist }; by[t.name].n++; by[t.name].d = Math.min(by[t.name].d, t.dist); }
    return Object.entries(by).map(([n, v]) => `${n}×${v.n}（最近 ${v.d.toFixed(1)} 格）`).join('、');
}

function startFlee(reason) {
    const threats = nearbyHostiles(16);
    console.log(`🚨 [緊急撤退] ${reason}，中斷所有任務，遠離怪物（${describeThreats(threats)}）`);
    state.currentMovementMode = 'flee';
    fleeQuietTicks = 0;
    if (state.attackInterval) { if (typeof state.endAttack === 'function') state.endAttack('interrupted'); else { clearInterval(state.attackInterval); state.attackInterval = null; } }
    state.currentMovementMode = 'flee';      // endAttack 會把模式改成 idle，這裡改回撤退
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    state.systemFeedback = `[身體信號：${reason}，已中斷動作並遠離怪物。附近：${describeThreats(threats)}。要不要回頭打、或先蓋掩體、先吃東西，由你決定]`;
    state.bmRunning = false;
    try { fs.writeFileSync(path.join(__dirname, '.flee_signal'), `SUCCESS:health=${Math.round(bot.health)}:${Date.now()}`); } catch(_) {}
    pushEvent('flee_started', { health: Math.round(bot.health * 10) / 10, reason, threats: threats.slice(0, 5).map(t => ({ name: t.name, distance: Math.round(t.dist * 10) / 10 })) });
}

// 每秒一次：撤退中就往「遠離最近怪物」的方向跑；身邊安靜 3 秒就結束撤退
setInterval(() => {
    if (!bot.entity || state.currentMovementMode !== 'flee') return;
    const threats = nearbyHostiles(THREAT_RADIUS);
    if (threats.length === 0 && Date.now() - lastDamageAt > 5000) {
        if (++fleeQuietTicks >= 4) {
            console.log(`💚 [撤退解除] 身邊已經沒有怪物（血量 ${Math.round(bot.health)}/20）`);
            state.currentMovementMode = 'idle';
            bot.pathfinder.setGoal(null);
            bot.clearControlStates();
            pushEvent('flee_ended', { health: Math.round(bot.health * 10) / 10 });
        }
        return;
    }
    if (threats.length === 0) return;      // 還在受傷（可能被看不見的遠處射手打），再等一下，不要解除
    fleeQuietTicks = 0;
    // 逃跑方向 = 遠離所有近處怪物的合力方向（越近權重越大）
    let vx = 0, vz = 0;
    for (const t of threats) {
        const dx = bot.entity.position.x - t.entity.position.x, dz = bot.entity.position.z - t.entity.position.z;
        const d = Math.max(0.5, Math.hypot(dx, dz)), w = 1 / d;
        vx += (dx / d) * w; vz += (dz / d) * w;
    }
    const len = Math.hypot(vx, vz) || 1;
    const tx = Math.floor(bot.entity.position.x + (vx / len) * 14), tz = Math.floor(bot.entity.position.z + (vz / len) * 14);
    try { bot.pathfinder.setGoal(new goals.GoalXZ(tx, tz), true); bot.setControlState('sprint', true); } catch (_) {}
}, 1000);

// ── 小腦極限反射：1 秒高頻掃描威脅（只發事件，不呼叫大腦）──
const hostileAlertCooldown = new Map();   // entity id → 上次通報時間
const HOSTILE_ALERT_COOLDOWN_MS = 8000;

setInterval(() => {
    if (!bot.entity) return;

    const now = Date.now();
    for (const [id, t] of hostileAlertCooldown) {
        if (now - t > HOSTILE_ALERT_COOLDOWN_MS * 4) hostileAlertCooldown.delete(id);
    }

    const enemy = bot.nearestEntity(e => {
        if (!e.name || !e.isValid) return false;
        const name = e.name.toLowerCase();
        if (!HOSTILE_MOBS.has(name)) return false;
        const dist = e.position.distanceTo(bot.entity.position);
        return HIGH_DANGER_MOBS.has(name) ? dist < 15 : dist < 6;
    });
    if (!enemy) return;
    if (now - (hostileAlertCooldown.get(enemy.id) || 0) < HOSTILE_ALERT_COOLDOWN_MS) return;

    // 苦力怕近距離一爆就是致命傷：不等受傷，靠近 5 格就先中斷動作遠離
    if (enemy.name.toLowerCase() === 'creeper' && enemy.position.distanceTo(bot.entity.position) < 5 && state.currentMovementMode !== 'flee' && state.currentMovementMode !== 'attack') {
        startFlee('苦力怕靠近到 5 格內');
    }
    hostileAlertCooldown.set(enemy.id, now);
    const highDanger = HIGH_DANGER_MOBS.has(enemy.name.toLowerCase());
    const distance = Math.round(enemy.position.distanceTo(bot.entity.position) * 10) / 10;
    console.log(`⚠️ [交感神經觸發] ${highDanger ? '☠️ 極度危險' : '🚨'} 發現 ${enemy.name} 靠近 (距${distance}格)`);
    pushEvent('hostile_nearby', { entityId: enemy.id, name: enemy.name, distance, highDanger });
}, 1000);

// ── 自動防溺水：200ms 高頻偵測 ──
// 只在「頭泡在水裡而且氧氣快用完」或「泡在岩漿裡」才強制上浮，其餘時候不干涉，
// 讓各個動作自己決定要游、要沉、要挖（以前只要碰到水就一直按住跳，人會被釘在水面下不去，
// 而且在 gather 模式離開水之後也不會放開，造成整個動作期間原地一直跳、挖掘被中斷）。
// mineflayer 的 bot.oxygenLevel 範圍是 0–20。
const LOW_OXYGEN = 6;          // 氧氣降到這個值以下開始上浮
const RECOVERED_OXYGEN = 15;   // 上浮後要回到這個值才放開，避免「剛露頭又沉下去」的來回循環
let reflexJumping = false;     // 這個反射自己是不是正在按著跳（只放開自己按的）
let surfacing = false;         // 正在為了換氣而上浮

setInterval(() => {
    if (!bot.entity) return;
    const blockFeet = bot.blockAt(bot.entity.position);
    const blockHead = bot.blockAt(bot.entity.position.offset(0, 1, 0));
    const inLava = (blockFeet && blockFeet.name === 'lava') || (blockHead && blockHead.name === 'lava');
    const headInWater = !!(blockHead && (blockHead.name === 'water' || blockHead.name === 'bubble_column'));
    const inWater = headInWater || !!(blockFeet && blockFeet.name === 'water');
    const oxygen = typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : 20;

    // 連續泡在水裡多久（刻意潛水時不算）
    if (inWater && !state.isDiving) { if (state.waterSince === null) state.waterSince = Date.now(); }
    else state.waterSince = null;

    if (!surfacing && headInWater && oxygen <= LOW_OXYGEN) {
        surfacing = true;
        state.isDiving = false;
        console.log(`🫧 [缺氧警報] 氧氣只剩 ${oxygen}/20，強制往上游換氣！`);
        // 反射的訊息走事件，不寫進 systemFeedback（那是動作模組回報結果的管道，會被誤認成動作的結果）
        pushEvent('low_oxygen', { oxygen });
    }
    if (surfacing && (oxygen >= RECOVERED_OXYGEN || !inWater)) {
        // 離開水面且氧氣補得差不多了才解除；還在水裡就繼續浮著
        if (oxygen >= RECOVERED_OXYGEN) surfacing = false;
    }

    if (inLava || surfacing) {
        if (!reflexJumping) { bot.setControlState('jump', true); reflexJumping = true; }
    } else if (reflexJumping) {
        bot.setControlState('jump', false);
        reflexJumping = false;
    }
}, 200);

// ── 水中自動脫困：泡在水裡太久還沒離開，就自己找岸（或往上挖）出去 ──
// 20 秒：大腦沒有在做別的動作 → 自動執行 surface；45 秒：大腦的動作還卡在水裡 → 中斷它再執行 surface。
// 兩次自動脫困之間至少隔 40 秒，避免脫不了還一直重試。
const WATER_ALERT_SEC = 10;
const WATER_AUTO_SEC  = 20;
const WATER_FORCE_SEC = 45;
let autoEscaping = false;
let lastAutoEscapeAt = 0;
let waterAlerted = false;

setInterval(async () => {
    if (!bot.entity || state.waterSince === null) { waterAlerted = false; return; }
    const sec = (Date.now() - state.waterSince) / 1000;
    if (sec >= WATER_ALERT_SEC && !waterAlerted) {
        waterAlerted = true;
        pushEvent('water_trapped', { seconds: Math.round(sec) });
    }
    // 氧氣快沒了就不能再等 20／45 秒：氧氣約 15 秒用完，之後每秒掉血（玩家：泡水 45 秒才中斷動作，早就在溺水，結果淹死）
    const lowAir = typeof bot.oxygenLevel === 'number' && bot.oxygenLevel <= 8;
    if (autoEscaping || Date.now() - lastAutoEscapeAt < (lowAir ? 12000 : 40000)) return;
    const st = executor.status();
    const idleCase  = !st.busy && (sec >= WATER_AUTO_SEC || (lowAir && sec >= 3));
    const forceCase = st.busy && st.current && st.current.type !== 'surface' && (sec >= WATER_FORCE_SEC || (lowAir && sec >= 5));
    if (!idleCase && !forceCase) return;

    autoEscaping = true;
    lastAutoEscapeAt = Date.now();
    console.log(`🏊 [自動脫困] 已泡在水裡 ${Math.round(sec)} 秒${forceCase ? '，中斷目前動作' : ''}，啟動 surface`);
    pushEvent('auto_escape_started', { seconds: Math.round(sec), interrupted: forceCase ? st.current.type : null });
    try {
        if (forceCase) {
            await executor.cancel();
            // cancel 回來時被中斷的動作還在收尾，executor 還當它是「進行中」，這時 run 會被當成 busy 拒絕：等它真的結束
            for (let i = 0; i < 40 && executor.status().busy; i++) await new Promise(res => setTimeout(res, 150));
        }
        let r = await executor.run({ type: 'surface' });
        for (let i = 0; i < 3 && !r.ok && r.status === 'rejected' && r.reason === 'busy'; i++) {
            await new Promise(res => setTimeout(res, 800));
            r = await executor.run({ type: 'surface' });
        }
        console.log(`🏊 [自動脫困] 結束：${r.ok ? '成功' : '未成功'} ${r.message || ''}`);
        pushEvent('auto_escape_done', { ok: r.ok, message: r.message });
    } catch (e) {
        console.log('⚠️ [自動脫困] 例外:', e.message);
    } finally {
        autoEscaping = false;
    }
}, 1000);

// ── 聊天：測試旁路 & 轉成事件給大腦 ──
// 測試旁路格式："TARS_TEST: <動作> [參數1] [參數2]"，位置參數的對應見 src/agent/schema.js
bot.on('chat', async (username, message) => {
    if (username === bot.username) return;

    if (config.TESTER_NAMES.includes(username)) {
        const testMatch = message.match(/^TARS_TEST:\s*(\w+)(?:\s+(\S+))?(?:\s+(\S+))?\s*$/i);
        if (testMatch) {
            const [, rawType, arg1, arg2] = testMatch;
            const type = rawType.toLowerCase();
            const actionObj = buildFromPositional(type, [arg1, arg2]);
            try {
                if (actionObj) {
                    console.log(`🧪 [測試旁路] 直接執行 ${JSON.stringify(actionObj)}（跳過大腦）`);
                    const result = await executor.run(actionObj, { profile: 'all' });
                    console.log(`🧪 [測試旁路] 結果: ${JSON.stringify(result)}`);
                } else {
                    // Agent API 不認得的動作直接走 Router
                    const rawObj = { type, target: arg1, name: arg2 || arg1, ...(arg2 ? { material: arg2 } : {}) };
                    console.log(`🧪 [測試旁路] 直接執行 ${JSON.stringify(rawObj)}（跳過大腦，不經驗證）`);
                    await executeActionQueue([rawObj]);
                }
            } catch (e) {
                console.log('⚠️ [測試旁路執行異常]:', e.message);
            }
            return;
        }
    }

    // 考官（測試用 bot）下指令產生的系統訊息（gamerule、傳送…）不是遊戲內容，混進事件只會讓玩家看不懂
    if (username === (process.env.EXAMINER_NAME || 'Examiner')) return;
    pushEvent('chat', { from: username, message, fromMaster: username === MASTER_NAME });
});

bot.on('error', (err) => console.log('🔥【Bot 錯誤】:', err.message));
