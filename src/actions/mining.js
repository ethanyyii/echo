// ════════════════════════════════════════════════════════
//  src/actions/mining.js — 挖礦類動作
//  涵蓋: staircase, tunnel_to
// ════════════════════════════════════════════════════════
'use strict';
const { goals } = require('mineflayer-pathfinder');
const vec3 = require('vec3');
const { describeNearlyBroken, selectTool, equipFor, yawFor, facingName, torchHabit, digBlockWithSight, collectDrops } = require('./tools');
const { executeTunnel } = require('./tunnel');
const { digShaft } = require('./shaft');
const fs   = require('fs');
const path = require('path');
const ROOT_DIR = path.join(__dirname, '..', '..');

module.exports = async function executeMining(action, ctx) {
    const { bot, state, mcData } = ctx;

    switch (action.type) {

        // ── tunnel_to：挖通道到指定座標 ──
        case 'tunnel_to': {
            await executeTunnel(action, ctx);
            break;
        }

        // ══════════════════════════════════════════════════════════
        // 【階梯式下礦模組 v2】
        // ══════════════════════════════════════════════════════════
        case 'staircase': {
            bot.pathfinder.setGoal(null);
            state.currentMovementMode = 'gather';

            const scStartY = Math.floor(bot.entity.position.y);
            const torchCount = () => bot.inventory.items().filter(i => i.name === 'torch').reduce((n, i) => n + i.count, 0);
            const scTorchesBefore = torchCount();
            let staircaseTargetY;
            if (typeof action.targetY === 'number') {
                staircaseTargetY = action.targetY;
                console.log(`⛏️ [階梯] 目標深度: Y=${staircaseTargetY}（自 Y=${scStartY} 向下挖 ${scStartY - staircaseTargetY} 層）`);
            } else if (typeof action.steps === 'number') {
                staircaseTargetY = scStartY - action.steps;
                console.log(`⛏️ [階梯] 舊格式 steps=${action.steps}，轉換目標 Y=${staircaseTargetY}`);
            } else {
                staircaseTargetY = scStartY - 10;
                console.log(`⛏️ [階梯] 未指定深度，預設挖 10 層到 Y=${staircaseTargetY}`);
            }
            staircaseTargetY = Math.max(staircaseTargetY, -60);

            if (!bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))) {
                state.systemFeedback = '[身體信號：需要鎬子才能挖階梯，但背包裡沒有！]';
                state.currentMovementMode = 'idle';
                try { fs.writeFileSync(path.join(ROOT_DIR, '.staircase_signal'), `FAIL:沒有鎬子:${Date.now()}`); } catch(_) {}
                break;
            }

            // shape=shaft：一格寬的垂直井（最快，沒有台階）。形狀不同、安全檢查也不同，獨立在 shaft.js
            if (action.shape === 'shaft') {
                const r = await digShaft(ctx, staircaseTargetY, { deadlineMs: 90000 });
                state.currentMovementMode = 'idle';
                if (r.reached) {
                    state.systemFeedback = `[身體信號：垂直井完成！最終深度 Y=${r.endY}，共下降 ${r.levels} 層（一格寬的井，沒有台階，要上來用 surface 或 pillar）]`;
                } else if (r.timedOut) {
                    bot.actionPartial = r.levels > 0;
                    state.systemFeedback = `[身體信號：垂直井時間到，已下降 ${r.levels} 層，現在 Y=${r.endY}（目標 Y=${staircaseTargetY}，還有 ${r.endY - staircaseTargetY} 層）；進度保留，用同樣的 targetY 再呼叫一次會從目前位置繼續]`;
                } else {
                    state.systemFeedback = `[身體信號：垂直井停在 Y=${r.endY}（目標 Y=${staircaseTargetY}，只下降了 ${r.levels} 層）：${r.reason || '被外部中斷（stop、逾時或逃跑）'}]`;
                }
                try { fs.writeFileSync(path.join(ROOT_DIR, '.staircase_signal'), r.reached ? `SUCCESS:shaft:finalY=${r.endY}:${Date.now()}` : `FAIL:shaft:finalY=${r.endY}:reason=${r.reason || 'unknown'}:${Date.now()}`); } catch(_) {}
                break;
            }

            // 方向：direction 參數優先，沒給就沿著目前面向。mineflayer 的 yaw 0 = 朝北 (dz=-1)，
            // 所以 dx = -sin(yaw)、dz = -cos(yaw)（與 place_block、dig 的方位定義一致）
            const rawYaw  = action.direction ? yawFor(action.direction) : bot.entity.yaw;
            const snapYaw = Math.round(rawYaw / (Math.PI / 2)) * (Math.PI / 2);
            const fdx = Math.round(-Math.sin(snapYaw));
            const fdz = Math.round(-Math.cos(snapYaw));
            console.log(`⛏️ [階梯挖礦] 啟動！朝${facingName(snapYaw)} (dx=${fdx}, dz=${fdz})，從 Y=${scStartY} 挖到 Y=${staircaseTargetY}`);
            await bot.look(snapYaw, 0, true);

            let scCompleted = 0;
            const SC_MAX_STEPS = 300;
            let scAbortReason = '';

            // 挖一個方塊：每次為它選最適合的工具；工具等級不夠就記下原因
            const scDig = async (block) => {
                if (!block || block.name === 'air' || block.boundingBox !== 'block') return true;
                const choice = selectTool(bot, mcData, block);
                if (!choice.canHarvest) {
                    scAbortReason = `工具不夠：挖 ${block.name} 需要 ${choice.needed.slice(0, 2).join(' / ')} 以上`;
                    return false;
                }
                if (choice.nearlyBroken) {
                    scAbortReason = describeNearlyBroken(choice.nearlyBroken, block.name);
                    return false;
                }
                if (!bot.canDigBlock(block)) return true;
                try {
                    await equipFor(bot, choice.tool);
                    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
                    await bot.dig(block);
                    await bot.waitForTicks(3);
                } catch (de) {
                    console.log(`  ⚠️ 挖 ${block.name} 失敗: ${de.message}`);
                }
                return true;
            };

            // 這一格以及它的上下左右前後有沒有水／岩漿（會流進來把隧道淹掉）
            const liquidAround = (x, y, z) => {
                for (const [ox, oy, oz] of [[0,0,0],[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
                    const b = bot.blockAt(new vec3(x + ox, y + oy, z + oz));
                    if (b && (b.name === 'water' || b.name === 'lava')) return { name: b.name, x: x + ox, y: y + oy, z: z + oz };
                }
                return null;
            };

            // 新位置的腳下有沒有地：從 (x, fromY) 往下找第一個不是空氣的方塊（開闊洞穴時腳下可能是好幾格的空洞）
            const MAX_SAFE_DROP = 3;     // 摔 3 格以內不會受傷
            const SC_SCAN_DOWN = 12;
            const scanGround = (x, fromY, z) => {
                for (let dy = 0; dy < SC_SCAN_DOWN; dy++) {
                    const b = bot.blockAt(new vec3(x, fromY - dy, z));
                    if (!b) return { kind: 'unknown', y: fromY - dy };
                    if (b.name === 'water' || b.name === 'lava') return { kind: 'liquid', y: b.position.y, name: b.name };
                    if (b.boundingBox === 'block') return { kind: 'solid', y: b.position.y, name: b.name };
                }
                return { kind: 'void', y: fromY - SC_SCAN_DOWN };
            };

            // 卡住時如實描述前方看到什麼，不再憑空猜「礫石或水」
            const describeColumn = (x, y, z, moveErr) => {
                const names = [1, 0, -1, -2].map(dy => { const b = bot.blockAt(new vec3(x, y + dy, z)); return b ? b.name : '未載入'; });
                const falling = names.filter(n => n === 'gravel' || n.endsWith('sand'));
                const parts = [`前方 (${x},${z}) 的方塊：頭上 ${names[0]}、腳高 ${names[1]}、下一格 ${names[2]}、腳下 ${names[3]}`];
                if (falling.length > 0) parts.push(`有會掉落的 ${falling[0]}，可能不斷掉回通道`);
                if (moveErr) parts.push(`走過去失敗：${moveErr}`);
                return parts.join('；');
            };

            // 卡住偵測：深度很久都沒變就停下來回報（原因用 describeColumn 如實描述）
            let lastMoveErr = '';
            let lastY = scStartY;
            let lastProgressAt = Date.now();
            let sameYIterations = 0;
            const STALL_MS = 35000;

            while (state.currentMovementMode === 'gather' && scCompleted < SC_MAX_STEPS) {
                const scPos = bot.entity.position.floored();
                const scX = scPos.x, scY = scPos.y, scZ = scPos.z;

                if (scY <= staircaseTargetY) {
                    console.log(`⛏️ [階梯] 抵達目標深度 Y=${scY}！`);
                    break;
                }

                if (scY < lastY) { lastY = scY; lastProgressAt = Date.now(); sameYIterations = 0; }
                else sameYIterations++;
                if (sameYIterations >= 5 || Date.now() - lastProgressAt > STALL_MS) {
                    scAbortReason = `卡住了：在 Y=${scY} 附近 ${Math.round((Date.now() - lastProgressAt) / 1000)} 秒沒有往下。${describeColumn(scX + fdx, scY, scZ + fdz, lastMoveErr)}`;
                    state.systemFeedback = `[身體信號：階梯下礦卡在 Y=${scY}（目標 Y=${staircaseTargetY}）。${scAbortReason}。建議換個方向（direction）或換個位置重新開挖]`;
                    break;
                }

                const feetHere = bot.blockAt(bot.entity.position);
                if (feetHere && (feetHere.name === 'water' || feetHere.name === 'lava')) {
                    scAbortReason = `我已經泡在${feetHere.name === 'water' ? '水' : '岩漿'}裡了（Y=${scY}）`;
                    state.systemFeedback = `[身體信號：階梯下礦停在 Y=${scY}：${scAbortReason}，繼續挖只會更糟，請先處理（往回走或換方向）]`;
                    break;
                }

                const tgX = scX + fdx, tgZ = scZ + fdz;
                console.log(`\n⛏️ [階梯] 第 ${scCompleted + 1} 層 | 當前(${scX},${scY},${scZ}) → 目標(${tgX},${scY - 1},${tgZ}) | 距目標 ${scY - staircaseTargetY} 格`);

                // 要挖的三格（頭、腳、台階）及其四周不能有水或岩漿
                let liquid = null;
                for (const dy of [1, 0, -1]) { liquid = liquid || liquidAround(tgX, scY + dy, tgZ); }
                if (liquid) {
                    const lname = liquid.name === 'water' ? '水' : '岩漿';
                    scAbortReason = `前方緊鄰${lname} (${liquid.x},${liquid.y},${liquid.z})，繼續挖會被淹／燒到`;
                    state.systemFeedback = `[身體信號：⚠️階梯停在 Y=${scY}（目標 Y=${staircaseTargetY}）：${scAbortReason}。請換個方向（direction）或換個位置，或先用方塊擋住]`;
                    console.log(`⛏️ ⚠️ [液體警報] ${scAbortReason}，停止`);
                    break;
                }
                // 前方腳下有沒有地：新位置的地板是 (tg, scY-2)。開闊洞穴時它是空的，要看底下是什麼、落差多大
                const ground = scanGround(tgX, scY - 2, tgZ);
                let landY = scY - 1;      // 新位置的腳高（一般情況是下一層）
                let scBlocked = '';
                if (ground.kind === 'liquid') {
                    scBlocked = `前方腳下是空洞，底下 (${tgX},${ground.y},${tgZ}) 是${ground.name === 'water' ? '水' : '岩漿'}，不能走下去`;
                } else if (ground.kind === 'void') {
                    scBlocked = `前方腳下是很深的空洞（往下 ${SC_SCAN_DOWN} 格都沒有地面），不能走下去`;
                } else if (ground.kind === 'solid') {
                    landY = ground.y + 1;
                    const drop = scY - landY;
                    if (drop > MAX_SAFE_DROP) {
                        scBlocked = `前方腳下是 ${drop} 格深的空洞（地面在 Y=${ground.y}，${ground.name}），落差太大，跳下去會受傷；staircase 不會硬跳。可以改用 place_block 搭台階，或換個方向／位置`;
                    } else if (drop > 1) {
                        const landLiquid = liquidAround(tgX, landY, tgZ);
                        if (landLiquid) scBlocked = `前方是 ${drop} 格的空洞，落地點旁邊有${landLiquid.name === 'water' ? '水' : '岩漿'} (${landLiquid.x},${landLiquid.y},${landLiquid.z})，不能走下去`;
                        else console.log(`⛏️ ⚠️ [洞窟] 前方腳下是 ${drop} 格的空洞，走下去（落地 Y=${landY}）`);
                    }
                }
                if (scBlocked) {
                    // 順便看看另外三個方向前方的腳下是什麼，讓玩家一次知道哪邊可以挖（以前要一個方向一個方向試）
                    const dirNames = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
                    const others = [];
                    for (const [dn, [ox, oz]] of Object.entries(dirNames)) {
                        if (ox === fdx && oz === fdz) continue;
                        const g = scanGround(scX + ox, scY - 2, scZ + oz);
                        const dropN = g.kind === 'solid' ? scY - (g.y + 1) : null;
                        const label = g.kind === 'solid' ? (dropN <= 1 ? '可以挖' : (dropN <= MAX_SAFE_DROP ? `${dropN} 格落差可走下去` : `${dropN} 格深空洞`))
                            : g.kind === 'liquid' ? `底下是${g.name === 'water' ? '水' : '岩漿'}`
                            : g.kind === 'void' ? `深不見底的空洞` : '未載入';
                        others.push(`${dn}：${label}`);
                    }
                    scBlocked += `。其他方向前方腳下：${others.join('、')}`;
                    scAbortReason = scBlocked;
                    state.systemFeedback = `[身體信號：階梯停在 Y=${scY}（目標 Y=${staircaseTargetY}）：${scBlocked}]`;
                    console.log(`⛏️ ⚠️ [前方腳下] ${scBlocked}，停止`);
                    break;
                }

                await bot.look(snapYaw, 0, true);

                // [A] 頭頂、[B] 腳高、[C] 台階
                let toolOk = true;
                for (const [label, dy] of [['A 挖頭頂', 1], ['B 挖腳高', 0], ['C 挖台階', -1]]) {
                    const b = bot.blockAt(new vec3(tgX, scY + dy, tgZ));
                    if (b && b.name !== 'air' && b.boundingBox === 'block') console.log(`  [${label}] ${b.name} at Y=${scY + dy}`);
                    if (!(await scDig(b))) { toolOk = false; break; }
                }
                if (!toolOk) {
                    state.systemFeedback = `[身體信號：階梯下礦停在 Y=${scY}（目標 Y=${staircaseTargetY}）：${scAbortReason}]`;
                    break;
                }

                await bot.look(snapYaw, 0, true);
                let scMoveOk = false;
                lastMoveErr = '';
                try {
                    await bot.pathfinder.goto(new goals.GoalBlock(tgX, landY, tgZ));
                    scMoveOk = true;
                } catch (moveErr) {
                    lastMoveErr = moveErr.message;
                    console.log(`  [D] pathfinder 失敗: ${moveErr.message}，換備援（直接往前走）...`);
                    await bot.look(snapYaw, 0.4, true);
                    bot.setControlState('forward', true);
                    await bot.waitForTicks(25);
                    bot.setControlState('forward', false);
                    await bot.waitForTicks(10);
                }

                await bot.waitForTicks(5);
                const newY = Math.floor(bot.entity.position.y);
                console.log(`  [D] ${newY <= landY ? '✅' : '⚠️'} 新 Y=${newY}（目標落點 Y=${landY}，${scMoveOk ? 'pathfinder' : '備援'}）`);
                scCompleted++;

                // 習慣：往地下挖時，周圍太暗而且背包有火把，就往腳下插一支（地表不插，有冷卻）
                if (await torchHabit(ctx, { dx: fdx, dz: fdz })) await bot.look(snapYaw, 0, true);
            }

            bot.clearControlStates();
            await bot.look(snapYaw, 0, true);

            const scFinalY = Math.floor(bot.entity.position.y);
            const scReachedTarget = scFinalY <= staircaseTargetY;
            if (!scAbortReason && !scReachedTarget && state.currentMovementMode !== 'gather') scAbortReason = '被外部中斷（stop、逾時或逃跑）';
            if (!scAbortReason && !scReachedTarget && scCompleted >= SC_MAX_STEPS) scAbortReason = `已達單次步數上限 ${SC_MAX_STEPS}`;
            console.log(`\n⛏️【階梯挖礦結束】共挖 ${scCompleted} 層，最終 Y=${scFinalY}，目標 Y=${staircaseTargetY}，${scReachedTarget ? '✅已抵達' : `⚠️未到，${scAbortReason || '原因不明'}`}`);
            if (scReachedTarget) {
                state.systemFeedback = `[身體信號：階梯下礦完成！最終深度 Y=${scFinalY}，共挖 ${scCompleted} 層]`;
            } else if (!state.systemFeedback) {
                state.systemFeedback = `[身體信號：階梯下礦中斷於 Y=${scFinalY}（目標 Y=${staircaseTargetY}，只下降了 ${scStartY - scFinalY} 層）。原因：${scAbortReason || '原因不明'}]`;
            }
            // 地底太暗會自動插火把（torchHabit）：說清楚用掉幾支、還剩幾支（玩家第 11 輪：8 支火把一次用掉 7 支，訊息只說「已插上火把」）
            const scTorchesUsed = scTorchesBefore - torchCount();
            if (scTorchesUsed > 0 && state.systemFeedback) {
                state.systemFeedback = state.systemFeedback.replace(/\]$/, `；途中自動插了 ${scTorchesUsed} 支火把（地底太暗時會自己插），背包還剩 ${torchCount()} 支]`);
            }
            // 單次呼叫的下降層數不是累計；停下來時說清楚現在在哪、還差多少
            if (!scReachedTarget && state.systemFeedback) {
                state.systemFeedback = state.systemFeedback.replace(/\]$/, `（現在 Y=${scFinalY}，離目標 Y=${staircaseTargetY} 還有 ${scFinalY - staircaseTargetY} 層；回報的下降層數只算這一次呼叫，不是累計）]`);
            }
            const scSignal = scReachedTarget
                ? `SUCCESS:reached:finalY=${scFinalY}:steps=${scCompleted}:${Date.now()}`
                : `FAIL:interrupted:finalY=${scFinalY}:targetY=${staircaseTargetY}:reason=${scAbortReason || 'unknown'}:${Date.now()}`;
            try { fs.writeFileSync(path.join(ROOT_DIR, '.staircase_signal'), scSignal); } catch(_) {}
            state.currentMovementMode = 'idle';
            break;
        }
    }
};
