// ════════════════════════════════════════════════════════
//  src/actions/shaft.js — 垂直往下挖（一格寬的井）
//  staircase shape=shaft 與 tunnel_to（目標在正下方時）共用。
//  每一層只挖腳下那一格（上面本來就是空的，不用像階梯那樣挖 3～4 格），落下一格再挖下一層，所以最快。
//  代價：沒有台階，上不來（要用 surface 或 pillar）。安全靠「落下前先檢查」：
//  腳下那格與四周有水／岩漿、底下是液體或虛空、落差超過 3 格，都會停下來說明，不會硬挖。
// ════════════════════════════════════════════════════════
'use strict';
const vec3 = require('vec3');
const { selectTool, describeNearlyBroken, equipFor, digBlockWithSight, torchHabit, settleOnGround } = require('./tools');

const MAX_SAFE_DROP = 3;      // 摔 3 格以內不會受傷
const SCAN_DOWN = 12;

function liquidAround(bot, x, y, z) {
    for (const [ox, oy, oz] of [[0,0,0],[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
        const b = bot.blockAt(new vec3(x + ox, y + oy, z + oz));
        if (b && (b.name === 'water' || b.name === 'lava')) return b;
    }
    return null;
}

/**
 * 從 (x, y, z) 開始往下挖到 targetY。
 * @returns {{reached:boolean, levels:number, reason:string, timedOut:boolean, startY:number, endY:number}}
 */
async function digShaft(ctx, targetY, opts = {}) {
    const { bot, state, mcData } = ctx;
    const deadline = Date.now() + (opts.deadlineMs || 90000);
    const startY = Math.floor(bot.entity.position.y + 0.01);
    let levels = 0, reason = '', timedOut = false, stalls = 0;

    state.currentMovementMode = 'gather';
    bot.pathfinder.setGoal(null);

    while (state.currentMovementMode === 'gather') {
        await settleOnGround(bot, 1500);
        const p = bot.entity.position;
        const x = Math.floor(p.x), z = Math.floor(p.z), y = Math.floor(p.y + 0.01);
        if (y <= targetY) break;
        if (Date.now() >= deadline) { timedOut = true; break; }
        const tLevel = Date.now();

        const feet = bot.blockAt(p);
        if (feet && (feet.name === 'water' || feet.name === 'lava')) { reason = `我已經泡在${feet.name === 'water' ? '水' : '岩漿'}裡了（Y=${y}）`; break; }

        const target = bot.blockAt(new vec3(x, y - 1, z));      // 這一層要挖的方塊 = 腳下那格
        if (!target) { reason = `腳下 (${x},${y - 1},${z}) 的區塊還沒載入`; break; }

        // 安全檢查（挖之前）：這一格與四周不能有水／岩漿（會灌進井裡）
        const near = liquidAround(bot, x, y - 1, z);
        if (near) { reason = `腳下那格緊鄰${near.name === 'water' ? '水' : '岩漿'} (${near.position.x},${near.position.y},${near.position.z})，繼續挖會被淹／燒到`; break; }

        // 挖掉之後會落到哪：從 y-2 往下找第一個實心方塊
        let landY = null, ground = null;
        for (let dy = 2; dy <= SCAN_DOWN; dy++) {
            const b = bot.blockAt(new vec3(x, y - dy, z));
            if (!b) { reason = `底下 (${x},${y - dy},${z}) 的區塊還沒載入`; break; }
            if (b.name === 'water' || b.name === 'lava') { reason = `再往下 (${x},${y - dy},${z}) 是${b.name === 'water' ? '水' : '岩漿'}，不能挖下去`; break; }
            if (b.boundingBox === 'block') { ground = b; landY = b.position.y + 1; break; }
        }
        if (reason) break;
        if (!ground) { reason = `腳下往下 ${SCAN_DOWN} 格都沒有地面（很深的空洞），不能挖下去`; break; }
        const drop = y - landY;
        if (drop > MAX_SAFE_DROP) { reason = `挖開之後會掉 ${drop} 格（地面在 Y=${ground.position.y}，${ground.name}），落差太大會受傷，不挖`; break; }
        const landNear = liquidAround(bot, x, landY, z);
        if (landNear) { reason = `落地點旁邊有${landNear.name === 'water' ? '水' : '岩漿'} (${landNear.position.x},${landNear.position.y},${landNear.position.z})，不能挖下去`; break; }

        // 挖腳下那格（腳下本來就是空氣的洞穴地面不用挖，直接落下）
        if (target.boundingBox === 'block') {
            const choice = selectTool(bot, mcData, target);
            if (!choice.canHarvest) { reason = `工具不夠：挖 ${target.name} 需要 ${choice.needed.slice(0, 2).join(' / ')} 以上`; break; }
            if (choice.nearlyBroken) { reason = describeNearlyBroken(choice.nearlyBroken, target.name); break; }
            const t0 = Date.now();
            try { await digBlockWithSight(bot, mcData, target); } catch (_) { /* 下面用高度有沒有降來判斷 */ }
            const dt = Date.now() - t0;
            if (dt > 1500) console.log(`⛏️ [井] 挖 ${target.name} 花了 ${dt}ms（偏慢）`);
        }

        const before = y;
        const tFall = Date.now();
        await settleOnGround(bot, 1500);
        const after = Math.floor(bot.entity.position.y + 0.01);
        console.log(`⛏️ [井] Y=${before}→${after}｜檢查+挖 ${tFall - tLevel}ms、落地 ${Date.now() - tFall}ms`);
        if (after < before) { levels += before - after; stalls = 0; }
        else if (++stalls >= 3) { reason = `連續 3 次都沒有往下：人卡在 Y=${after}，腳下是 ${(bot.blockAt(new vec3(x, after - 1, z)) || {}).name || '未載入'}`; break; }

        await torchHabit(ctx, { dx: 0, dz: 0 }).catch(() => {});
    }

    bot.clearControlStates();
    const endY = Math.floor(bot.entity.position.y + 0.01);
    return { reached: endY <= targetY, levels, reason, timedOut, startY, endY };
}

module.exports = { digShaft };
