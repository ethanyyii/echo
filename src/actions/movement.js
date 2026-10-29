// ════════════════════════════════════════════════════════
//  src/actions/movement.js — 移動類動作
//  涵蓋: dive, surface, stop, wait, look, face, goto, follow, wander, approach, jump
// ════════════════════════════════════════════════════════
'use strict';
const { goals } = require('mineflayer-pathfinder');
const vec3 = require('vec3');
const { yawFor } = require('./tools');
const escapeWater = require('./escape');
const fs   = require('fs');
const path = require('path');
const ROOT_DIR = path.join(__dirname, '..', '..');

// 目標附近關著的木門：pathfinder 不會自己開門（套件只處理柵欄門），走不到時要告訴玩家門在哪、用 use_block 打開
function closedDoorsHint(bot, gx, gy, gz) {
    const found = [];
    for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) for (let dy = -2; dy <= 3; dy++) {
        const b = bot.blockAt(new vec3(gx + dx, gy + dy, gz + dz));
        if (!b || !b.name.endsWith('_door') || b.name.startsWith('iron_')) continue;
        let open = null;
        try { open = b.getProperties().open; } catch (_) {}
        if (open === false || open === 'false') found.push(b);
    }
    // 一扇門有上下兩格，只報下半（half=lower）
    const lowers = found.filter(b => { try { return b.getProperties().half === 'lower'; } catch (_) { return true; } });
    if (lowers.length === 0) return '';
    lowers.sort((a, b) => a.position.distanceTo(new vec3(gx, gy, gz)) - b.position.distanceTo(new vec3(gx, gy, gz)));
    const list = lowers.slice(0, 3).map(b => `${b.name}(${b.position.x},${b.position.y},${b.position.z})`).join('、');
    return `；目標附近有關著的門：${list}。門會擋住路，先用 use_block 把它打開再 goto`;
}

// ── 穿過開著的門 ──
// 開著的門有一片薄板（約 0.19 格）貼在門格的一側，身體寬 0.6，只剩很窄的一段可以過；pathfinder 只負責走到格子附近，
// 最後那個精準對正它做不到，會卡在門口。真人會對準門洞再走過去：這裡先算出門洞最寬那一段的中心線，蹲走（每刻 0.065 格，不會衝過頭）對準後穿過去。
function nearestOpenDoor(bot, radius) {
    const here = bot.entity.position.floored();
    let best = null, bestD = Infinity;
    for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let dy = -1; dy <= 2; dy++) {
        const b = bot.blockAt(new vec3(here.x + dx, here.y + dy, here.z + dz));
        if (!b || !b.name.endsWith('_door')) continue;
        let pr = null;
        try { pr = b.getProperties(); } catch (_) { continue; }
        if (!(pr.open === true || pr.open === 'true') || pr.half === 'upper') continue;
        const d = b.position.offset(0.5, 0, 0.5).distanceTo(bot.entity.position);
        if (d < bestD) { bestD = d; best = b; }
    }
    return best;
}

async function stepToXZ(bot, x, z, tol, maxTicks) {
    bot.setControlState('sneak', true);
    try {
        for (let i = 0; i < maxTicks; i++) {
            const p = bot.entity.position;
            if (Math.hypot(x - p.x, z - p.z) < tol) break;
            await bot.lookAt(new vec3(x, p.y + 1.62, z), true);
            bot.setControlState('forward', true);
            await bot.waitForTicks(1);
        }
    } finally { bot.setControlState('forward', false); bot.setControlState('sneak', false); }
}

async function walkThroughDoor(bot, door) {
    const pr = door.getProperties();
    const passZ = pr.facing === 'north' || pr.facing === 'south';       // 門板所在的牆是東西向 → 沿南北方向穿過
    // 門洞在「橫向」（和穿過方向垂直）上最寬那一段的中心：門格 [0,1] 扣掉門板佔的範圍，再留出身體半寬 0.3
    const lo = passZ ? 0 : 2, hi = passZ ? 3 : 5;
    let slabMin = 1, slabMax = 0;
    for (const sh of (door.shapes || [])) { slabMin = Math.min(slabMin, sh[lo]); slabMax = Math.max(slabMax, sh[hi]); }
    let freeLo = 0, freeHi = 1;
    if (slabMax > slabMin) { if ((slabMin + slabMax) / 2 < 0.5) freeLo = slabMax; else freeHi = slabMin; }
    const aim = (freeHi - freeLo) >= 0.6 ? (freeLo + 0.3 + freeHi - 0.3) / 2 : 0.5;
    const base = passZ ? door.position.x : door.position.z;
    const lateral = base + aim;
    const here = bot.entity.position;
    const side = passZ ? Math.sign(here.z - (door.position.z + 0.5)) || 1 : Math.sign(here.x - (door.position.x + 0.5)) || 1;
    const c = passZ ? door.position.z + 0.5 : door.position.x + 0.5;
    const pt = (along) => passZ ? { x: lateral, z: along } : { x: along, z: lateral };
    const near = pt(c + side * 1.3), far = pt(c - side * 1.6);
    await stepToXZ(bot, near.x, near.z, 0.08, 120);        // 先在門前對準中心線
    await stepToXZ(bot, far.x, far.z, 0.15, 140);          // 再直直穿過去
}

// pathfinder 走到一半在開著的門旁邊停住：停掉它，自己對準門洞穿過去，再讓 pathfinder 繼續
async function gotoWithDoorAssist(bot, goal) {
    let doorStall = null, lastPos = bot.entity.position.clone(), lastMove = Date.now();
    const mon = setInterval(() => {
        const p = bot.entity.position;
        if (p.distanceTo(lastPos) > 0.3) { lastPos = p.clone(); lastMove = Date.now(); return; }
        if (Date.now() - lastMove > 2500 && !doorStall) {
            const d = nearestOpenDoor(bot, 3);
            if (d) { doorStall = d; bot.pathfinder.stop(); }
        }
    }, 500);
    try { await bot.pathfinder.goto(goal); }
    catch (e) { if (!doorStall) throw e; }
    finally { clearInterval(mon); }
    if (doorStall) {
        console.log(`🚪 [goto] 卡在開著的門 (${doorStall.position.x},${doorStall.position.y},${doorStall.position.z}) 旁邊，對準門洞穿過去`);
        await walkThroughDoor(bot, doorStall);
        await bot.pathfinder.goto(goal);
    }
}

module.exports = async function executeMovement(action, ctx) {
    const { bot, state, MASTER_NAME } = ctx;

    switch (action.type) {

        // ── dive ──
        case 'dive':
            state.isDiving = true;
            bot.pathfinder.setGoal(null);
            bot.setControlState('jump', false);
            state.systemFeedback = "[身體信號：已開啟潛水模式，我會跟著哥哥潛入水中探險。]";
            break;

        // ── surface ──
        case 'surface': {
            // 水中脫困：找岸游過去，找不到就往上挖階梯出去（實作在 escape.js）
            await escapeWater(ctx);
            break;
        }

        // ── stop ──
        case 'stop':
            bot.pathfinder.setGoal(null);
            bot.clearControlStates();
            state.currentMovementMode = 'idle';
            if (state.attackInterval) { if (typeof state.endAttack === 'function') state.endAttack('stopped'); else clearInterval(state.attackInterval); }
            break;

        // ── wait ──
        case 'wait':
            await bot.waitForTicks((action.ms || 1000) / 50);
            break;

        // ── look ──
        case 'look': {
            const lookTarget = bot.players[MASTER_NAME]?.entity;
            if (lookTarget) {
                await bot.lookAt(lookTarget.position.offset(0, 1.6, 0), false);
            }
            break;
        }

        // ── follow ──
        case 'follow': {
            // 支援可選 target：有指定就跟那個玩家，沒指定就跟 MASTER_NAME
            const followName = action.target || MASTER_NAME;
            const followTarget = bot.players[followName]?.entity;
            if (followTarget) {
                bot.pathfinder.setGoal(new goals.GoalFollow(followTarget, 2), true);
                state.currentMovementMode = 'follow';
                console.log(`🚶 [跟隨] 開始跟隨 ${followName}`);
            } else {
                state.systemFeedback = `[身體信號：找不到 ${followName} 的實體，無法跟隨！]`;
            }
            break;
        }

        // ── wander ──
        case 'wander': {
            bot.pathfinder.setGoal(null);
            state.currentMovementMode = 'wander';
            const angle = Math.random() * Math.PI * 2;
            const distance = 10 + Math.random() * 10;
            const randomX = Math.floor(bot.entity.position.x + Math.cos(angle) * distance);
            const randomZ = Math.floor(bot.entity.position.z + Math.sin(angle) * distance);
            bot.pathfinder.setGoal(new goals.GoalNearXZ(randomX, randomZ, 2), true);
            state.systemFeedback = `[身體信號：已開始朝新的方向隨機探索]`;
            break;
        }

        // ── approach ──
        case 'approach': {
            if (!action.target) break;
            const approachTarget = action.target.toLowerCase();
            console.log(`[approach] target=${approachTarget}`);

            const approachAlias = {
                '\u5bf6\u7bb1': 'chest', '\u7bb1\u5b50': 'chest', 'chest': 'chest',
                '\u9418': 'bell',
                '\u6a39': 'log', '\u6a39\u6728': 'log',
                '\u77f3\u982d': 'stone', '\u6c99': 'sand',
                '\u6ce5\u571f': 'dirt', '\u8349\u5730': 'grass_block',
                '\u6751\u6c11': 'villager', '\u7f8a': 'sheep',
                '\u725b': 'cow', '\u7c73\u6876': 'barrel',
                '\u5de5\u4f5c\u53f0': 'crafting_table',
                '\u71d0\u7210': 'furnace', '\u9580': 'door'
            };
            const approachVerticalLimit = 16;
            const resolvedTarget = approachAlias[approachTarget] || approachTarget;
            console.log(`[approach] resolved=${resolvedTarget}`);

            // 玩家實體的 e.name 是 'player'，要用玩家名稱（bot.players）才找得到
            const playerEntry = Object.values(bot.players).find(p =>
                p.username && p.username.toLowerCase() === resolvedTarget && p.entity && p.entity !== bot.entity);
            const targetEntity = playerEntry ? playerEntry.entity : bot.nearestEntity(e => {
                if (!e.name || !e.isValid) return false;
                const eName = e.name.toLowerCase();
                if (resolvedTarget === 'chest' && eName.includes('minecart')) return false;
                return eName === resolvedTarget || eName === resolvedTarget + '_horse';
            });

            if (targetEntity) {
                state.currentMovementMode = 'approach';
                console.log(`[approach] found entity: ${targetEntity.name}`);
                const approachDist = targetEntity.type === 'object' ? 0 : 1.5;
                try {
                    await bot.pathfinder.goto(new goals.GoalNear(
                        targetEntity.position.x, targetEntity.position.y, targetEntity.position.z, approachDist
                    ));
                    await bot.lookAt(targetEntity.position);
                    const distToEntity = bot.entity.position.distanceTo(targetEntity.position);
                    state.systemFeedback = `[身體信號：已靠近 ${action.target}]`;
                    try {
                        fs.writeFileSync(
                            path.join(ROOT_DIR, '.approach_signal'),
                            distToEntity <= 3
                                ? `SUCCESS:entity:${action.target}:dist=${Math.round(distToEntity * 10) / 10}:${Date.now()}`
                                : `FAIL:到達了但距離太遠:dist=${Math.round(distToEntity * 10) / 10}:${Date.now()}`
                        );
                    } catch(_) {}
                } catch(e) {
                    console.log('[approach entity failed]:', e.message);
                    state.failedApproachCooldowns[resolvedTarget] = Date.now() + 30000;
                    state.systemFeedback = `[身體信號：找到了 ${action.target} 但路被擋住，無法靠近，請不要繼續嘗試這個目標]`;
                    try {
                        fs.writeFileSync(
                            path.join(ROOT_DIR, '.approach_signal'),
                            `FAIL:entity路徑被擋:${action.target}:${Date.now()}`
                        );
                    } catch(_) {}
                }
                state.currentMovementMode = 'idle';
            } else {
                if (!bot.entity) { state.systemFeedback = '[身體信號：尚未生成，無法搜索]'; break; }
                const botY = bot.entity.position.y;
                const targetBlock = bot.findBlock({
                    matching: b => {
                        if (!b || !b.name) return false;
                        if (!b.name.toLowerCase().includes(resolvedTarget)) return false;
                        if (!b.position) return false;
                        if (Math.abs(b.position.y - botY) > approachVerticalLimit) return false;
                        return true;
                    },
                    maxDistance: 64,
                    useExtraInfo: true
                });
                console.log(`[approach] block search: ${targetBlock ? targetBlock.name + ' at ' + JSON.stringify(targetBlock.position) : 'NOT FOUND'}`);
                if (targetBlock) {
                    state.currentMovementMode = 'approach';
                    try {
                        await bot.pathfinder.goto(new goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2));
                        await bot.lookAt(targetBlock.position);
                        const distToBlock = bot.entity.position.distanceTo(targetBlock.position);
                        state.systemFeedback = `[身體信號：已到達 ${action.target}]`;
                        try {
                            fs.writeFileSync(
                                path.join(ROOT_DIR, '.approach_signal'),
                                distToBlock <= 3
                                    ? `SUCCESS:block:${action.target}:dist=${Math.round(distToBlock * 10) / 10}:${Date.now()}`
                                    : `FAIL:到達了但距離太遠:dist=${Math.round(distToBlock * 10) / 10}:${Date.now()}`
                            );
                        } catch(_) {}
                    } catch(e) {
                        console.log('[approach block failed]:', e.message);
                        state.failedApproachCooldowns[resolvedTarget] = Date.now() + 30000;
                        state.systemFeedback = `[身體信號：找到了 ${action.target} 但路被擋住，無法靠近，請不要繼續嘗試這個目標]`;
                        try {
                            fs.writeFileSync(
                                path.join(ROOT_DIR, '.approach_signal'),
                                `FAIL:block路徑被擋:${action.target}:${Date.now()}`
                            );
                        } catch(_) {}
                    }
                    state.currentMovementMode = 'idle';
                } else {
                    state.failedApproachCooldowns[resolvedTarget] = Date.now() + 30000;
                    state.systemFeedback = `[身體信號：附近找不到 ${action.target}，我已經確認過了，請不要繼續嘗試這個目標，改做其他事情]`;
                    try {
                        fs.writeFileSync(
                            path.join(ROOT_DIR, '.approach_signal'),
                            `FAIL:找不到目標:${action.target}:${Date.now()}`
                        );
                    } catch(_) {}
                }
            }
            break;
        }

        // ── jump ──
        // ── face：轉向指定方位（north/south/east/west/up/down）──
        case 'face': {
            const d = String(action.direction || '').toLowerCase();
            if (d === 'up' || d === 'down') await bot.look(bot.entity.yaw, d === 'up' ? -Math.PI / 2 + 0.01 : Math.PI / 2 - 0.01, true);
            else await bot.look(yawFor(d), 0, true);
            await bot.waitForTicks(3);
            state.systemFeedback = `[身體信號：已轉向 ${d}]`;
            break;
        }

        // ── goto：走到指定座標（range=0 表示要站在那一格，否則走到距離 range 格以內）──
        case 'goto': {
            const gx = Math.floor(action.x), gy = Math.floor(action.y), gz = Math.floor(action.z);
            const range = typeof action.range === 'number' ? Math.max(0, action.range) : 1;
            const goal = range > 0 ? new goals.GoalNear(gx, gy, gz, range) : new goals.GoalBlock(gx, gy, gz);
            bot.pathfinder.setGoal(null);
            state.currentMovementMode = 'goto';
            console.log(`🧭 [goto] 前往 (${gx},${gy},${gz}) range=${range}`);
            try {
                await gotoWithDoorAssist(bot, goal);
                const d = bot.entity.position.distanceTo(new vec3(gx + 0.5, gy, gz + 0.5));
                // 以實際距離為準：pathfinder 有時不拋錯卻沒走到（被水流推開、目標在水裡等）
                const pp = bot.entity.position;
                const inCell = Math.floor(pp.x) === gx && Math.floor(pp.z) === gz && Math.abs(Math.floor(pp.y + 0.2) - gy) <= 1;
                const arrived = range > 0 ? d <= range + 1.5 : inCell;
                // 目標格頭頂是實心方塊（只有 1 格高的凹洞），人站不進去
                const roof = bot.blockAt(new vec3(gx, gy + 1, gz));
                const lowCeiling = range === 0 && roof && roof.boundingBox === 'block';
                state.systemFeedback = arrived
                    ? `[身體信號：已到達 (${gx},${gy},${gz}) 附近，距離 ${Math.round(d * 10) / 10} 格]`
                    : `[身體信號：沒有走到 (${gx},${gy},${gz})${range === 0 ? '（range=0 要站在那一格）' : ''}：尋路結束時距離目標還有 ${Math.round(d * 10) / 10} 格${lowCeiling ? `；那一格頭頂是 ${roof.name}，只有 1 格高，人站不進去，要先把它挖掉（dig up 或 tunnel_to）` : '（目標在水裡、被水流推開，或路被擋住）'}${closedDoorsHint(bot, gx, gy, gz)}。如果目標在地下或水中，請改用 surface 脫困、staircase 或 tunnel_to]`;
            } catch (e) {
                const d = bot.entity.position.distanceTo(new vec3(gx + 0.5, gy, gz + 0.5));
                const why = /No path/i.test(e.message) ? '找不到可以走過去的路（被地形擋住，或目標在封閉空間裡；pathfinder 不會自己挖路）'
                    : /timed? ?out/i.test(e.message) ? '路太遠或太複雜，尋路逾時'
                    : /goal was changed/i.test(e.message) ? '途中被別的動作或反射打斷'
                    : e.message;
                state.systemFeedback = `[身體信號：走不到 (${gx},${gy},${gz})：${why}。目前距離目標還有 ${Math.round(d * 10) / 10} 格${closedDoorsHint(bot, gx, gy, gz)}]`;
            }
            if (state.currentMovementMode === 'goto') state.currentMovementMode = 'idle';
            break;
        }

        case 'jump':
            bot.setControlState('jump', true);
            setTimeout(() => bot.setControlState('jump', false), 300);
            break;
    }
};

module.exports.closedDoorsHint = closedDoorsHint;
