// ════════════════════════════════════════════════════════
//  src/actions/escape.js — 水中脫困（surface 動作的實作）
//
//  策略（由簡到難）：
//    A. 找岸：從現在的位置往四周廣度優先搜尋，只走水與空氣等非實心的格子，找到
//       「腳下是實心、頭上沒東西、上方一路開放到天空」的格子（也就是真正的岸），
//       算出最短路徑與座標，沿路游過去，最後爬上岸。避開岩漿與氣泡柱。
//       某一格走不過去就把它記成「走不通」，重新規劃別條路，不會一直重複同一條。
//    B. 找不到岸（封閉的地下水洞）：游到旁邊有實心牆的地方，再往上挖階梯（需要鎬子），一格一格爬到地面。
//    氧氣不足時，任何階段都會先去找氣室（頭能露出水面的格子）換氣。
//
//  所有判斷都用真實的方塊資料，結束時以實際位置為準回報，不留過時的訊息。
// ════════════════════════════════════════════════════════
'use strict';

const Vec3 = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { selectTool, equipFor } = require('./tools');

const MAX_NODES   = 9000;
const SEARCH_R    = 28;     // 水平搜尋半徑
const SKY_CHECK   = 40;     // 往上檢查幾格有沒有天空
const OVERALL_MS  = 100000;  // 整個脫困的時間上限
const LOW_AIR     = 5;      // 氧氣（0–20）降到這個值以下，優先去換氣
const WET_NAMES   = new Set(['water', 'bubble_column', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant']);
const K = (x, y, z) => `${x},${y},${z}`;

function makeWorld(bot) {
    const cache = new Map();
    const info = (x, y, z) => {
        const k = K(x, y, z);
        let v = cache.get(k);
        if (v) return v;
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b) v = { unknown: true, solid: true, wet: false, lava: false, bubble: false, leaves: false, name: 'unknown' };
        else v = {
            name: b.name, block: b,
            solid: b.boundingBox === 'block',
            wet: WET_NAMES.has(b.name),
            lava: b.name === 'lava',
            bubble: b.name === 'bubble_column',
            leaves: b.name.endsWith('_leaves'),
        };
        cache.set(k, v);
        return v;
    };
    return { info, forget: () => cache.clear() };
}

// 站得住：腳下實心（不是岩漿）、腳和頭那兩格都是空的（不是水、不是岩漿）
function standable(w, x, y, z) {
    const below = w.info(x, y - 1, z), feet = w.info(x, y, z), head = w.info(x, y + 1, z);
    return below.solid && !below.lava && !feet.solid && !feet.wet && !feet.lava && !head.solid && !head.wet && !head.lava;
}

// 上方一路開放到天空（樹葉算開放，因為岸邊常有樹）
function openSky(w, x, y, z) {
    for (let dy = 2; dy <= SKY_CHECK; dy++) {
        const c = w.info(x, y + dy, z);
        if (c.unknown) return false;
        if ((c.solid && !c.leaves) || c.wet) return false;
    }
    return true;
}

// 旁邊（四個方向）有沒有同高度、站得住的格子可以走出去。坑洞或豎井的底部四周都是牆，這裡會是 false。
function walkableNeighbor(w, x, y, z) {
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => standable(w, x + dx, y, z + dz));
}

// 真正上岸：站得住、上方開放到天空、而且能從這裡走出去（不是困在坑底）
function atSurface(w, x, y, z) {
    return standable(w, x, y, z) && openSky(w, x, y, z) && walkableNeighbor(w, x, y, z);
}

// 頭能露出水面換氣：頭那一格是空氣（不是水、不是實心）
function breathable(w, x, y, z) {
    const feet = w.info(x, y, z), head = w.info(x, y + 1, z);
    return !feet.solid && !feet.lava && !head.solid && !head.wet && !head.lava;
}

/**
 * 廣度優先搜尋。isGoal(cell) 為真就回傳 {exit, path, nodes}；blocked 裡的格子不走。
 * 只走非實心、非岩漿、非氣泡柱的格子（兩格高）；往上只能從濕的格子游上去，往下只往水裡沉。
 */
function search(w, start, isGoal, blocked) {
    const parent = new Map();
    const queue = [start];
    parent.set(K(start.x, start.y, start.z), null);
    let nodes = 0;
    const moves = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];

    while (queue.length > 0 && nodes < MAX_NODES) {
        const cur = queue.shift();
        nodes++;
        if (!(cur.x === start.x && cur.y === start.y && cur.z === start.z) && isGoal(cur)) {
            const path = [];
            for (let c = cur; c; c = parent.get(K(c.x, c.y, c.z))) path.unshift(c);
            return { exit: cur, path, nodes };
        }
        const here = w.info(cur.x, cur.y, cur.z);
        for (const [dx, dy, dz] of moves) {
            const nx = cur.x + dx, ny = cur.y + dy, nz = cur.z + dz;
            if (Math.abs(nx - start.x) > SEARCH_R || Math.abs(nz - start.z) > SEARCH_R) continue;
            const k = K(nx, ny, nz);
            if (parent.has(k) || (blocked && blocked.has(k))) continue;
            const n = w.info(nx, ny, nz);
            if (n.solid || n.lava || n.bubble) continue;
            const nHead = w.info(nx, ny + 1, nz);
            if (nHead.solid || nHead.lava) continue;
            if (dy > 0 && !here.wet) continue;
            if (dy < 0 && !n.wet) continue;
            parent.set(k, cur);
            queue.push({ x: nx, y: ny, z: nz });
        }
    }
    return null;
}

const feetCell = (bot) => {
    const p = bot.entity.position;
    return { x: Math.floor(p.x), y: Math.floor(p.y + 0.2), z: Math.floor(p.z) };
};

function isWetHere(bot) {
    const feet = bot.blockAt(bot.entity.position);
    const head = bot.blockAt(bot.entity.position.offset(0, 1, 0));
    return [feet, head].some(b => b && WET_NAMES.has(b.name));
}

const oxygenNow = (bot) => (typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : 20);

/**
 * 朝某一格移動。先把身體對準格子中線再前進（避免斜著撞到牆角），水裡按跳＝往上游。
 * 回傳是否到達。
 */
async function stepTo(bot, state, cell, timeoutMs = 5000) {
    const target = new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5);
    const t0 = Date.now();
    let best = Infinity, lastGain = Date.now();
    const samples = [];
    let lastSample = 0;
    while (Date.now() - t0 < timeoutMs && state.currentMovementMode === 'surface') {
        const p = bot.entity.position;
        const dx = target.x - p.x, dz = target.z - p.z;
        const horiz = Math.hypot(dx, dz), dy = target.y - p.y;
        if (horiz < 0.45 && dy < 0.6 && dy > -1.5) { bot.clearControlStates(); return true; }

        // 朝主要方向（x 或 z）移動，另一軸偏離超過 0.25 就先用左右移動修正
        const major = Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z';
        const lateral = major === 'x' ? dz : dx;
        const yaw = major === 'x' ? Math.atan2(-Math.sign(dx || 1), 0) : Math.atan2(0, -Math.sign(dz || 1));
        await bot.look(Math.abs(lateral) > 0.9 ? Math.atan2(-dx, -dz) : yaw, 0, true);

        const fwdVec = { x: -Math.sin(bot.entity.yaw), z: -Math.cos(bot.entity.yaw) };
        const rightVec = { x: -fwdVec.z, z: fwdVec.x };
        const lat = dx * rightVec.x + dz * rightVec.z;                  // 目標在我右邊（正）還是左邊（負）
        const fwdDist = dx * fwdVec.x + dz * fwdVec.z;
        // 窄洞裡身體要對準格子中線才能過：身體寬 0.6，偏差只要超過 0.2 左右，邊緣就會貼在方塊邊界上，
        // 浮點誤差會讓它被旁邊的方塊擋住。所以偏差 > 0.12 就先只用左右移動修正、不前進。
        // 離目標還很遠（> 0.9）時才斜著走。
        const needAlign = Math.abs(lat) > 0.12 && Math.abs(lateral) <= 0.9;
        bot.setControlState('forward', fwdDist > 0.25 && !needAlign);
        bot.setControlState('right', lat > 0.12 && Math.abs(lateral) <= 0.9);
        bot.setControlState('left', lat < -0.12 && Math.abs(lateral) <= 0.9);
        // 只有下一個路徑點比現在高才按跳（水裡按跳 = 往上游）。不為了「保持浮著」一直按：
        // 頭頂有天花板時持續按跳會把人頂在天花板下動彈不得；不按的話人會緩緩下沉，在洞底照樣可以水平移動。
        bot.setControlState('jump', dy > 0.3);
        await bot.waitForTicks(2);

        if (Date.now() - lastSample > 250) {
            lastSample = Date.now();
            const v = bot.entity.velocity;
            samples.push(`${Date.now() - t0}ms pos=(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) yaw=${bot.entity.yaw.toFixed(2)} ` +
                `vel=(${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}) ctl=${JSON.stringify(Object.entries(bot.controlState).filter(([, on]) => on).map(([k]) => k))} ` +
                `lat=${lat.toFixed(2)} fwdDist=${fwdDist.toFixed(2)} dy=${dy.toFixed(2)} target=(${cell.x},${cell.y},${cell.z}) major=${major} hCol=${bot.entity.isCollidedHorizontally} vCol=${bot.entity.isCollidedVertically} water=${bot.entity.isInWater} ` +
                `above2=${(bot.blockAt(p.offset(0, 2, 0)) || {}).name} above1=${(bot.blockAt(p.offset(0, 1, 0)) || {}).name} feet=${(bot.blockAt(p) || {}).name} below=${(bot.blockAt(p.offset(0, -1, 0)) || {}).name}`);
        }
        const d = horiz + Math.abs(dy);
        if (d < best - 0.05) { best = d; lastGain = Date.now(); }
        else if (Date.now() - lastGain > 1800) {
            console.log('🏊 [除錯] 沒有進展，最近的取樣：\n  ' + samples.slice(-6).join('\n  '));
            break;                                                      // 沒有進展
        }
    }
    bot.clearControlStates();
    const p = bot.entity.position;
    return Math.hypot(target.x - p.x, target.z - p.z) < 0.7 && target.y - p.y < 0.8;
}

// 用 mineflayer-pathfinder 走一小步（近距離，規劃很快）。它的移動邏輯（水中自動按跳、停下時重新置中）久經驗證，
// 當我自己的控制器在窄通道卡住時拿來當備援。
async function stepViaPathfinder(bot, state, cell) {
    const target = new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5);
    const goal = new goals.GoalBlock(cell.x, cell.y, cell.z);
    try {
        await Promise.race([
            bot.pathfinder.goto(goal),
            new Promise((_, reject) => setTimeout(() => reject(new Error('pathfinder 逾時')), 6000)),
        ]);
    } catch (e) { /* 到不了就看實際位置 */ }
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    const p = bot.entity.position;
    return Math.hypot(target.x - p.x, target.z - p.z) < 0.9 && Math.abs(target.y - p.y) < 1.2;
}

// 沿路徑走；失敗時回傳卡住的那一格（呼叫端把它記成走不通）
async function swimAlong(bot, state, path, onWaypoint) {
    for (let i = 1; i < path.length; i++) {
        if (state.currentMovementMode !== 'surface') return { ok: false, stuckAt: null };
        if (onWaypoint) await onWaypoint();
        let moved = await stepTo(bot, state, path[i]);
        if (!moved && state.currentMovementMode === 'surface') {
            console.log(`🏊 [脫困] 自己的控制器卡在第 ${i} 格 (${path[i].x},${path[i].y},${path[i].z})，改用 pathfinder 走這一步`);
            moved = await stepViaPathfinder(bot, state, path[i]);
        }
        if (!moved) {
            const p = bot.entity.position;
            console.log(`🏊 [脫困] 卡在路徑第 ${i}/${path.length - 1} 格：想去 (${path[i].x},${path[i].y},${path[i].z})，人在 (${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`);
            return { ok: false, stuckAt: path[i] };
        }
    }
    return { ok: true };
}

// 氧氣不足：游到最近的氣室（頭能露出水面的格子），待到氧氣回得差不多
async function breatheIfNeeded(bot, state, blocked) {
    if (oxygenNow(bot) > LOW_AIR) return false;
    const w = makeWorld(bot);
    const start = feetCell(bot);
    if (breathable(w, start.x, start.y, start.z) && !w.info(start.x, start.y + 1, start.z).wet) {
        // 已經頭在空氣裡了
    } else {
        const found = search(w, start, (c) => breathable(w, c.x, c.y, c.z), blocked);
        if (!found) { console.log('🏊 [脫困] 氧氣快沒了，但附近找不到氣室'); return false; }
        console.log(`🏊 [脫困] 氧氣只剩 ${oxygenNow(bot)}/20，先游到氣室 (${found.exit.x},${found.exit.y},${found.exit.z})`);
        await swimAlong(bot, state, found.path);
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 9000 && oxygenNow(bot) < 14 && state.currentMovementMode === 'surface') {
        bot.setControlState('jump', isWetHere(bot));                    // 待在水面換氣
        await bot.waitForTicks(4);
    }
    bot.clearControlStates();
    return true;
}

// 從 here 往某個水平方向往上挖階梯是否可行：旁邊那格腳高處是實心（有東西可以踩）、要挖的格子與周圍沒有岩漿
function pickDirection(w, here) {
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (const [dx, dz] of dirs) {
        const nx = here.x + dx, nz = here.z + dz;
        const floorB = w.info(nx, here.y, nz);
        if (!floorB.solid || floorB.lava) continue;
        const toDig = [[nx, here.y + 1, nz], [nx, here.y + 2, nz], [here.x, here.y + 2, here.z]];
        let danger = false;
        for (const [cx, cy, cz] of toDig) {
            for (const [ox, oy, oz] of [[0,0,0],[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
                if (w.info(cx + ox, cy + oy, cz + oz).lava) danger = true;
            }
        }
        if (danger) continue;
        return { dx, dz, nx, nz, toDig };
    }
    return null;
}

// ── B：往上挖階梯 ──
async function ascendByDigging(ctx, deadline, blocked) {
    const { bot, state, mcData } = ctx;
    let stalls = 0;
    let lastY = bot.entity.position.y;
    let lastRise = Date.now();

    if (!bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))) return { reached: false, why: '背包裡沒有鎬子，挖不出路' };

    for (let step = 0; step < 70 && Date.now() < deadline && state.currentMovementMode === 'surface'; step++) {
        await breatheIfNeeded(bot, state, blocked);
        const w = makeWorld(bot);
        const here = feetCell(bot);
        if (atSurface(w, here.x, here.y, here.z)) return { reached: true };

        let chosen = pickDirection(w, here);
        if (!chosen) {
            // 漂在開闊的水洞中間，旁邊沒有牆可以當立足點：先游到最近的、旁邊有牆的位置
            const found = search(w, here, (c) => !!pickDirection(w, c), blocked);
            if (!found) return { reached: false, why: '附近找不到可以往上挖的牆面（四周都是開闊的水或空洞，或有岩漿）' };
            console.log(`🏊 [脫困②] 先游到有牆的位置 (${found.exit.x},${found.exit.y},${found.exit.z}) 再往上挖`);
            const r = await swimAlong(bot, state, found.path);
            if (!r.ok) { if (r.stuckAt) blocked.add(K(r.stuckAt.x, r.stuckAt.y, r.stuckAt.z)); stalls++; if (stalls >= 4) return { reached: false, why: '游不到有牆的位置' }; continue; }
            w.forget();
            chosen = pickDirection(makeWorld(bot), feetCell(bot));
            if (!chosen) continue;
        }

        // 挖出這一步需要的三格（礫石、沙子會掉回來，最多重挖 3 次）
        for (let attempt = 0; attempt < 3; attempt++) {
            let dug = false;
            for (const [cx, cy, cz] of chosen.toDig) {
                const b = bot.blockAt(new Vec3(cx, cy, cz));
                if (!b || b.boundingBox !== 'block') continue;
                const choice = selectTool(bot, mcData, b);
                if (!choice.canHarvest) return { reached: false, why: `工具不夠：挖 ${b.name} 需要 ${choice.needed.slice(0, 2).join(' / ')} 以上` };
                try {
                    await equipFor(bot, choice.tool);
                    await bot.lookAt(b.position.offset(0.5, 0.5, 0.5), true);
                    await bot.dig(b);
                    dug = true;
                } catch (e) { /* 被水流或掉落的方塊打斷，下一輪再試 */ }
            }
            await bot.waitForTicks(6);
            const wCheck = makeWorld(bot);
            const leftover = chosen.toDig.some(([cx, cy, cz]) => wCheck.info(cx, cy, cz).solid);
            if (!leftover) break;
            if (!dug && attempt === 2) return { reached: false, why: '挖不動前方的方塊' };
        }

        // 走上去：先往前、再跳（水裡跳＝往上游）
        const ok = await stepTo(bot, state, { x: chosen.nx, y: here.y + 1, z: chosen.nz }, 6000);
        if (!ok) stalls++; else stalls = 0;
        if (bot.entity.position.y > lastY + 0.5) { lastY = bot.entity.position.y; lastRise = Date.now(); }
        if (stalls >= 3 || Date.now() - lastRise > 30000) return { reached: false, why: '往上挖了一陣子，高度沒有再增加（可能被水流、氣泡柱或掉落的方塊擋住）' };
    }
    const here = feetCell(bot);
    const w2 = makeWorld(bot);
    return { reached: atSurface(w2, here.x, here.y, here.z), why: '時間到或步數用完' };
}

module.exports = async function escapeWater(ctx) {
    const { bot, state } = ctx;
    const deadline = Date.now() + OVERALL_MS;
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    state.currentMovementMode = 'surface';
    state.isDiving = false;

    const startPos = bot.entity.position.clone();
    const notes = [];
    const blocked = new Set();      // 走不通的格子，重新規劃時不再走

    try {
        if (!isWetHere(bot)) {
            const w = makeWorld(bot);
            const f = feetCell(bot);
            if (standable(w, f.x, f.y, f.z)) {
                state.systemFeedback = '[身體信號：我已經在陸地上了，不在水裡]';
                return;
            }
        }

        console.log(`🏊 [脫困] 開始：位置 (${startPos.x.toFixed(1)},${startPos.y.toFixed(1)},${startPos.z.toFixed(1)})，氧氣 ${oxygenNow(bot)}/20`);

        // A：找岸（最多重新規劃 6 次；走不通的格子會被記下來，不會一直重複同一條路）
        for (let attempt = 1; attempt <= 6 && Date.now() < deadline && state.currentMovementMode === 'surface'; attempt++) {
            await breatheIfNeeded(bot, state, blocked);
            const w = makeWorld(bot);
            const found = search(w, feetCell(bot), (c) => atSurface(w, c.x, c.y, c.z), blocked);
            if (!found) { notes.push(attempt === 1 ? '附近沒有通往地面的水路或岸邊' : '重新規劃後找不到岸'); break; }
            console.log(`🏊 [脫困①] 找到岸 (${found.exit.x},${found.exit.y},${found.exit.z})，路徑 ${found.path.length - 1} 格（搜尋 ${found.nodes} 個格子，第 ${attempt} 次，已排除 ${blocked.size} 格）`);
            const r = await swimAlong(bot, state, found.path, () => breatheIfNeeded(bot, state, blocked));
            const p = feetCell(bot);
            const w2 = makeWorld(bot);
            if (!isWetHere(bot) && standable(w2, p.x, p.y, p.z)) { notes.push(`游到岸邊 (${found.exit.x},${found.exit.y},${found.exit.z}) 上岸`); break; }
            if (!r.ok && r.stuckAt) blocked.add(K(r.stuckAt.x, r.stuckAt.y, r.stuckAt.z));
        }

        // B：還在水裡或還在洞裡 → 往上挖
        {
            const w = makeWorld(bot);
            const f = feetCell(bot);
            const onShore = !isWetHere(bot) && atSurface(w, f.x, f.y, f.z);
            if (!onShore && Date.now() < deadline && state.currentMovementMode === 'surface') {
                console.log('🏊 [脫困②] 找不到岸，改往上挖階梯出去');
                const r = await ascendByDigging(ctx, deadline, blocked);
                notes.push(r.reached ? '往上挖階梯出來了' : `往上挖沒成功：${r.why}`);
            }
        }
    } catch (e) {
        console.log('⚠️ [脫困] 例外:', e.message);
        notes.push(`執行時出錯：${e.message}`);
    } finally {
        bot.clearControlStates();
        const wet = isWetHere(bot);
        const p = bot.entity.position;
        const under = bot.blockAt(p.offset(0, -1, 0));
        if (!wet) {
            const w = makeWorld(bot);
            const f = feetCell(bot);
            const sky = atSurface(w, f.x, f.y, f.z);
            state.systemFeedback = sky
                ? `[身體信號：已脫離水中並回到地面，位置 (${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})，腳下是 ${under ? under.name : '未知'}。${notes.join('；')}]`
                : `[身體信號：離開水了，但還沒回到地面（位置 Y=${Math.floor(p.y)}，頭上有岩層，或困在坑洞底部）。${notes.join('；')}]`;
        } else {
            state.systemFeedback = `[身體信號：還在水裡，位置 (${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})。${notes.join('；') || '沒有找到出路'}。` +
                `可以試試：dig direction=up（背包有鎬子時）、goto 到別處、或換個方向 staircase]`;
        }
        if (state.currentMovementMode === 'surface') state.currentMovementMode = 'idle';
    }
};
