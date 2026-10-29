// ════════════════════════════════════════════════════════
//  src/actions/tunnel.js — 挖通道到指定座標（tunnel_to，也供 gather 在礦藏在岩石裡時使用）
//
//  像正常玩家一樣：朝目標一格一格挖出 1x2 的通道，需要上升或下降時挖成階梯，
//  遇到水、岩漿就停下來說明，礫石掉回來就重挖，最後把沿路的掉落物撿起來。
// ════════════════════════════════════════════════════════
'use strict';

const Vec3 = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { describeNearlyBroken, selectTool, equipFor, digBlockWithSight, settleOnGround, collectDrops, torchHabit } = require('./tools');
const { digShaft } = require('./shaft');

const MAX_STEPS   = 150;
const DEADLINE_MS = 95000;

const feetCell = (bot) => {
    const p = bot.entity.position;
    return { x: Math.floor(p.x), y: Math.floor(p.y + 0.2), z: Math.floor(p.z) };
};

function liquidAround(bot, x, y, z) {
    for (const [ox, oy, oz] of [[0,0,0],[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
        const b = bot.blockAt(new Vec3(x + ox, y + oy, z + oz));
        if (b && (b.name === 'water' || b.name === 'lava')) return b;
    }
    return null;
}

/**
 * 挖一條通道走到 (tx,ty,tz)。range=0 表示一路挖到站在那一格（目標是礦就會把它挖掉）；
 * range>0 表示走到距離 range 格以內就停（不挖目標本身）。
 * @returns {{arrived: boolean, steps: number, reason?: string, remaining: number}}
 */
async function tunnelToPosition(ctx, tx, ty, tz, opts = {}) {
    const { bot, state, mcData } = ctx;
    const range = typeof opts.range === 'number' ? Math.max(0, opts.range) : 0;
    const deadline = Date.now() + (opts.deadlineMs || DEADLINE_MS);
    const startMode = state.currentMovementMode;
    state.currentMovementMode = 'gather';
    bot.pathfinder.setGoal(null);

    let steps = 0, stalls = 0, bestRemain = Infinity, reason = '', dugAny = false;
    let stuckNext = { x: 0, y: 0, z: 0 }, stuckNames = ['?', '?'];
    const startCell = feetCell(bot);

    try {
        while (state.currentMovementMode === 'gather' && Date.now() < deadline && steps < MAX_STEPS) {
            const c = feetCell(bot);
            const dx = tx - c.x, dy = ty - c.y, dz = tz - c.z;
            const remain = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
            if (remain === 0 || (range > 0 && Math.hypot(dx, dy, dz) <= range)) { reason = ''; break; }

            if (remain < bestRemain) { bestRemain = remain; stalls = 0; } else if (++stalls >= 4) { reason = `連續 4 步都沒有更靠近目標：人卡在 (${c.x},${c.y},${c.z})，想走到 (${stuckNext.x},${stuckNext.y},${stuckNext.z})，那裡的方塊：腳高 ${stuckNames[0]}、頭上 ${stuckNames[1]}（可能被擋住、礫石補回通道，或 pathfinder 走不進去）`; break; }

            // 目標正下方（水平已對齊、只剩往下）：挖一格寬的垂直井，不要在兩欄之間左右來回挖
            if (dx === 0 && dz === 0 && dy < 0) {
                const sr = await digShaft(ctx, ty, { deadlineMs: Math.max(1000, deadline - Date.now()) });
                steps += sr.levels;
                state.currentMovementMode = 'gather';
                if (!sr.reached) { reason = sr.timedOut ? '' : (sr.reason || '垂直井被中斷'); break; }
                continue;
            }

            // 下一格：水平先走距離較大的軸；需要升降時一邊前進一邊升降（階梯）
            let sx = 0, sy = 0, sz = 0;
            if (dx !== 0 && (Math.abs(dx) >= Math.abs(dz) || dz === 0)) sx = Math.sign(dx);
            else if (dz !== 0) sz = Math.sign(dz);
            if (dy !== 0) sy = Math.sign(dy);
            if (sx === 0 && sz === 0) sx = 1;          // 只剩垂直方向：用一格階梯（之後水平會自己修正回來）

            // 升降一階時，新那一格的腳下必須有實心方塊可以站；在開闊地（腳下是空的）就先水平走，不要踏進半空中
            if (sy !== 0) {
                const floorB = bot.blockAt(new Vec3(c.x + sx, c.y + sy - 1, c.z + sz));
                if (!floorB || floorB.boundingBox !== 'block') sy = 0;
            }
            const next = { x: c.x + sx, y: c.y + sy, z: c.z + sz };
            stuckNext = next;
            stuckNames = [0, 1].map(dy => { const b = bot.blockAt(new Vec3(next.x, next.y + dy, next.z)); return b ? b.name : '未載入'; });
            console.log(`⛏️ [通道] 第 ${steps + 1} 步 (${c.x},${c.y},${c.z}) → (${next.x},${next.y},${next.z})｜距目標 ${remain}｜停滯 ${stalls}`);
            const tStep = Date.now();
            const toCarve = [[next.x, next.y, next.z], [next.x, next.y + 1, next.z]];
            if (sy > 0) toCarve.push([c.x, c.y + 2, c.z]);          // 往上時，原地頭頂要有空間可以跳
            // 往下時人是先水平走進去再落下一格，所以原本高度的那一格（腳高、頭上）也必須挖開，否則頭會撞到石頭
            if (sy < 0) toCarve.push([next.x, c.y, next.z], [next.x, c.y + 1, next.z]);

            {   // 往下時原高度那兩格和新那一格有重疊，去重（以前同一格被列兩次）
                const seen = new Set();
                for (let i = toCarve.length - 1; i >= 0; i--) { const k = toCarve[i].join(','); if (seen.has(k)) toCarve.splice(i, 1); else seen.add(k); }
            }
            // 安全：要挖的格子與四周不能有水或岩漿
            for (const [cx, cy, cz] of toCarve) {
                const liq = liquidAround(bot, cx, cy, cz);
                if (liq) { reason = `前方 (${liq.position.x},${liq.position.y},${liq.position.z}) 是${liq.name === 'water' ? '水' : '岩漿'}，繼續挖會${liq.name === 'water' ? '被淹' : '燒到'}`; break; }
            }
            if (reason) break;

            // 挖出這一步（礫石、沙子會掉回來，最多重挖 3 次）
            let carved = false;
            for (let attempt = 0; attempt < 3 && !carved; attempt++) {
                for (const [cx, cy, cz] of toCarve) {
                    const b = bot.blockAt(new Vec3(cx, cy, cz));
                    if (!b || b.boundingBox !== 'block') continue;
                    const choice = selectTool(bot, mcData, b);
                    if (!choice.canHarvest) { reason = `工具不夠：挖 ${b.name} 需要 ${choice.needed.slice(0, 2).join(' / ')} 以上`; break; }
                    if (choice.nearlyBroken) { reason = describeNearlyBroken(choice.nearlyBroken, b.name); break; }
                    const tDig = Date.now();
                    try {
                        const r = await digBlockWithSight(bot, mcData, b);
                        if (r.dug) dugAny = true;
                        else console.log(`⛏️ [通道]   沒挖成 ${b.name} (${cx},${cy},${cz})：${r.reason}${r.cleared ? `（清了 ${r.cleared} 個擋路的）` : ''}`);
                    } catch (e) { console.log(`⛏️ [通道]   挖 ${b.name} (${cx},${cy},${cz}) 出錯：${e.message}`); /* 被打斷，下一輪再試 */ }
                    if (Date.now() - tDig > 1500) console.log(`⛏️ [通道]   挖 ${b.name} (${cx},${cy},${cz}) 花了 ${Date.now() - tDig}ms（偏慢）`);
                }
                if (reason) break;
                await bot.waitForTicks(5);
                carved = !toCarve.some(([cx, cy, cz]) => { const b = bot.blockAt(new Vec3(cx, cy, cz)); return b && b.boundingBox === 'block'; });
            }
            if (reason) break;
            if (!carved) { reason = `挖不開 (${next.x},${next.y},${next.z}) 附近的方塊（基岩或一直有東西掉回來）`; break; }

            // 走進去
            const tCarved = Date.now();
            try {
                await Promise.race([
                    bot.pathfinder.goto(new goals.GoalBlock(next.x, next.y, next.z)),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('走進通道逾時')), 6000)),
                ]);
            } catch (_) {
                bot.pathfinder.setGoal(null);
                bot.setControlState('forward', true);
                bot.setControlState('jump', sy > 0);
                await bot.waitForTicks(12);
                bot.clearControlStates();
            }
            await settleOnGround(bot, 1200);     // 還在落下時讀到的高度會差一格，下一步會用錯的高度重算
            steps++;
            { const nc = feetCell(bot); console.log(`⛏️ [通道]   走進通道後位置 (${nc.x},${nc.y},${nc.z})，預期 (${next.x},${next.y},${next.z})｜這一步要挖 ${toCarve.length} 格：挖+等 ${tCarved - tStep}ms、走進去 ${Date.now() - tCarved}ms`); }

            await torchHabit(ctx, { dx: sx, dz: sz });
        }
    } finally {
        bot.clearControlStates();
        if (state.currentMovementMode === 'gather') state.currentMovementMode = startMode === 'gather' ? 'gather' : 'idle';
    }

    const c = feetCell(bot);
    const remaining = Math.abs(tx - c.x) + Math.abs(ty - c.y) + Math.abs(tz - c.z);
    if (dugAny) await collectDrops(bot, goals, new Vec3(c.x, c.y, c.z), 6, 12);
    const arrived = remaining === 0 || (range > 0 && Math.hypot(tx - c.x, ty - c.y, tz - c.z) <= range);
    let timedOut = false;
    if (!arrived && !reason) {
        timedOut = Date.now() >= deadline;
        reason = timedOut ? '時間到（單次最多約 95 秒），進度保留，用同樣的目標再呼叫一次就會從目前位置繼續' : '步數用完或被中斷';
    }
    return { arrived, steps, reason, remaining, from: startCell, timedOut };
}

// tunnel_to 動作
async function executeTunnel(action, ctx) {
    const { state } = ctx;
    const tx = Math.floor(action.x), ty = Math.floor(action.y), tz = Math.floor(action.z);
    // 目標在正上方：階梯會橫著繞來繞去而且卡住；直接用 pillar（邊挖頭頂邊往腳下墊方塊），需要背包有可以放的方塊
    {
        const c0 = feetCell(ctx.bot);
        if (tx === c0.x && tz === c0.z && ty > c0.y) {
            const executeBuilder = require('./builder');
            await executeBuilder({ type: 'pillar', height: ty - c0.y }, ctx);
            const c1 = feetCell(ctx.bot);
            if (!ctx.state.systemFeedback) ctx.state.systemFeedback = `[身體信號：目標在正上方，用墊高上去的：現在在 (${c1.x},${c1.y},${c1.z})]`;
            else ctx.state.systemFeedback = ctx.state.systemFeedback.replace(/^\[身體信號：/, '[身體信號：目標在正上方，改用墊高（pillar）：');
            return;
        }
    }
    const r = await tunnelToPosition(ctx, tx, ty, tz, { range: action.range });
    state.currentMovementMode = 'idle';
    if (!r.arrived && r.timedOut && r.steps > 0) ctx.bot.actionPartial = true;   // 時間到但已經挖了一段：回報「進行中」，不是失敗
    state.systemFeedback = r.arrived
        ? `[身體信號：挖了 ${r.steps} 格通道，已到達 (${tx},${ty},${tz}) 附近，沿路的掉落物已撿起]`
        : `[身體信號：挖了 ${r.steps} 格通道，還差 ${r.remaining} 格（曼哈頓距離）沒到 (${tx},${ty},${tz})：${r.reason}]`;
}

module.exports = { tunnelToPosition, executeTunnel };
