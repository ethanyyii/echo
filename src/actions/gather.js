// ════════════════════════════════════════════════════════
//  src/actions/gather.js — 採集類動作
//  涵蓋: gather (含專業伐木 + 連鎖挖礦)
// ════════════════════════════════════════════════════════
'use strict';
const { goals } = require('mineflayer-pathfinder');
const vec3 = require('vec3');
const { describeNearlyBroken, findDroppedItems, selectTool, equipFor, collectDrops, placeUnderFeet, digBlockWithSight, torchHabit } = require('./tools');
const { tunnelToPosition } = require('./tunnel');
const fs   = require('fs');
const path = require('path');
const ROOT_DIR = path.join(__dirname, '..', '..');

/**
 * 檢查 bot 是否有清晰視線到目標方塊
 * 正常玩家不能隔牆挖礦
 */
function hasLineOfSight(bot, targetBlock) {
    const botEyePos = bot.entity.position.offset(0, 1.62, 0);
    const targetCenter = targetBlock.position.offset(0.5, 0.5, 0.5);

    // 檢查六個面的中心點，任一面可見即算有視線
    const faceOffsets = [
        { x: 0.5, y: 0.5, z: 0 },
        { x: 0.5, y: 0.5, z: 1 },
        { x: 0, y: 0.5, z: 0.5 },
        { x: 1, y: 0.5, z: 0.5 },
        { x: 0.5, y: 0, z: 0.5 },
        { x: 0.5, y: 1, z: 0.5 },
    ];

    for (const offset of faceOffsets) {
        const facePoint = targetBlock.position.offset(offset.x, offset.y, offset.z);
        const block = bot.blockAtCursor(5); // mineflayer 內建射線檢測
        if (block && block.position.equals(targetBlock.position)) return true;
    }

    // 備用：直線距離 + 高度差檢查（保守判斷）
    const dist = botEyePos.distanceTo(targetCenter);
    const heightDiff = Math.abs(botEyePos.y - targetCenter.y);
    return dist <= 4.5 && heightDiff <= 1.5;
}

/**
 * 把玩家給的 target 解析成要找的方塊名稱集合，依序嘗試：
 *   exact   方塊本身的名稱（含 deepslate_ 變體，例如 iron_ore 也包含 deepslate_iron_ore）。stone 不會再比對到 stone_bricks。
 *   drop    target 其實是掉落物名稱（cobblestone ← stone、raw_iron ← iron_ore、diamond ← diamond_ore）
 *   partial 名稱包含 target 的方塊（最後手段）
 */
function candidateTargets(mcData, target) {
    const t = target.toLowerCase();
    const out = [];
    const exact = [t, 'deepslate_' + t].filter(n => mcData.blocksByName[n]);
    // 草地上的泥土全在草方塊下面；真人挖的是表面的草方塊（一樣掉泥土），不是往下挖洞。要泥土時草方塊等一起算
    if (t === 'dirt') for (const n of ['grass_block', 'podzol', 'mycelium']) if (mcData.blocksByName[n]) exact.push(n);
    if (exact.length) out.push({ how: 'exact', names: new Set(exact) });
    const item = mcData.itemsByName[t];
    if (item) {
        const viaDrop = new Set();
        for (const b of mcData.blocksArray) if ((b.drops || []).includes(item.id) && b.name !== t) viaDrop.add(b.name);
        if (viaDrop.size) out.push({ how: 'drop', names: viaDrop });
    }
    const partial = new Set(mcData.blocksArray.filter(b => b.name.includes(t)).map(b => b.name));
    if (partial.size) out.push({ how: 'partial', names: partial });
    return out;
}

// 腳下正下方那一欄的方塊：站著挖它就是在挖自己腳下，會一路往下挖成洞（玩家：gather dirt 從 Y108 挖到 Y101）。
// 正常玩家挖旁邊的方塊，不挖腳下站的那塊；所以選目標時先避開它（只剩它時才用）。
function isUnderFoot(bot, pos) {
    const fp = bot.entity.position;
    return Math.floor(fp.x) === pos.x && Math.floor(fp.z) === pos.z && pos.y < Math.floor(fp.y + 0.01);
}

module.exports = async function executeGather(action, ctx) {
    const { bot, state, mcData } = ctx;

    switch (action.type) {
        case 'gather': {
            if (!action.target) break;
            bot.pathfinder.setGoal(null);
            state.currentMovementMode = 'gather';

            console.log(`🪓 [肌肉記憶] 雷達掃描中，準備採集: ${action.target}`);
            let targetBlock = null;
            let resolvedHow = 'exact';
            let resolvedNames = [];
            const isTree = action.target.toLowerCase().includes('log');
            const wantLog = action.target.toLowerCase();
            const wantSpecific = isTree && wantLog.endsWith('_log') && !!mcData.blocksByName[wantLog];   // 指定了樹種（oak_log），不是泛稱 log

            if (isTree) {
                targetBlock = bot.findBlock({
                    matching: (b) => {
                        if (!b || !b.position || !b.name) return false;
                        if (!b.name.includes('log')) return false;
                        for (let i = 1; i <= 16; i++) {
                            try {
                                const upBlock = bot.blockAt(b.position.offset(0, i, 0));
                                if (upBlock && upBlock.name.includes('leaves')) return true;
                            } catch (_) { continue; }
                        }
                        return false;
                    },
                    maxDistance: 96
                });
                if (!targetBlock) {
                    targetBlock = bot.findBlock({
                        matching: (b) => {
                            if (!b || !b.name) return false;
                            return b.name.includes('log') && !b.name.includes('stripped');
                        },
                        maxDistance: 96
                    });
                    if (targetBlock) console.log("🌲 [伐木] 附近無活樹，找到原木殘幹，直接開採。");
                }
                // 指定了樹種就優先砍那個樹種（只要它不比最近的樹遠超過 24 格）；否則砍最近的樹並在結果說明換了樹種
                if (targetBlock && wantSpecific && targetBlock.name !== wantLog) {
                    const same = bot.findBlock({ matching: [mcData.blocksByName[wantLog].id], maxDistance: 96 });
                    if (same && bot.entity.position.distanceTo(same.position) <= bot.entity.position.distanceTo(targetBlock.position) + 24) targetBlock = same;
                }
            } else {
                for (const cand of candidateTargets(mcData, action.target)) {
                    const ids = [...cand.names].map(n => mcData.blocksByName[n].id);
                    const found = bot.findBlocks({ matching: ids, maxDistance: 64, count: 16 });
                    const pick = found.find(p => !isUnderFoot(bot, p)) || found[0];
                    targetBlock = pick ? bot.blockAt(pick) : null;
                    if (targetBlock) { resolvedHow = cand.how; resolvedNames = [...cand.names]; break; }
                }
            }

            if (!targetBlock) {
                console.log(`🚶 [目標搜尋] 附近 64 格沒有 ${action.target}，開始有目的性移動尋找...`);
                const tried = candidateTargets(mcData, action.target).flatMap(c => [...c.names]).slice(0, 6);
                const angle = Math.random() * Math.PI * 2;
                const randomX = Math.floor(bot.entity.position.x + Math.cos(angle) * 25);
                const randomZ = Math.floor(bot.entity.position.z + Math.sin(angle) * 25);
                try {
                    await bot.pathfinder.goto(new goals.GoalNearXZ(randomX, randomZ, 2));
                    state.systemFeedback = `[身體信號：附近 64 格找不到 ${action.target}${tried.length ? '（找過的方塊：' + tried.join('、') + '）' : '（世界裡沒有這個名稱的方塊或掉落物）'}，已隨機移動 25 格擴展搜索範圍，再下達一次 gather 會從這裡繼續找]`;
                } catch (e) {
                    state.systemFeedback = `[身體信號：附近找不到 ${action.target}，而且地形阻擋無法移動搜索。]`;
                }
                state.currentMovementMode = 'idle';
                break;
            }

            try {
                const blockName = targetBlock.name.toLowerCase();
                // 依方塊的採集需求選最好的工具（需要特定等級的方塊，只考慮採得動的工具）
                const toolChoice = selectTool(bot, mcData, targetBlock);
                if (!toolChoice.canHarvest) {
                    const have = bot.inventory.items().filter(i => i.name.endsWith('_pickaxe')).map(i => i.name);
                    state.systemFeedback = `[身體信號：我沒有能採集 ${blockName} 的工具。需要 ${toolChoice.needed.slice(0, 3).join(' / ')} 或更高等級；` +
                        `目前${have.length ? '只有 ' + have.join('、') : '沒有任何鎬子'}，挖了也不會掉落物品]`;
                    state.currentMovementMode = 'idle';
                    break;
                }
                let bestTool = toolChoice.tool;
                await equipFor(bot, bestTool);
                console.log(`🔧 [工具切換] ${bestTool ? '裝備了 ' + bestTool.name : '空手'}`);

                if (isTree) {
                    const logsBefore = bot.inventory.items()
                        .filter(i => i.name.includes('log'))
                        .reduce((sum, i) => sum + i.count, 0);
                    console.log("🌲 [進階伐木] 啟動專業伐木工序...");
                    let baseLog = targetBlock;
                    while (true) {
                        if (!baseLog || !baseLog.position) break;
                        const below = bot.blockAt(baseLog.position.offset(0, -1, 0));
                        if (below && below.name && below.name.includes('log')) baseLog = below;
                        else break;
                    }
                    if (!baseLog || !baseLog.position) {
                        state.systemFeedback = `[身體信號：伐木索敵失敗，樹根位置資料損壞，放棄此目標。]`;
                        state.currentMovementMode = 'idle';
                        break;
                    }

                    let reachedBase = false;
                    for (const radius of [2, 3, 4]) {
                        try {
                            await bot.pathfinder.goto(new goals.GoalNear(
                                baseLog.position.x, baseLog.position.y, baseLog.position.z, radius
                            ));
                            reachedBase = true; break;
                        } catch (pathErr) {
                            console.log(`🌲 [進階伐木] 尋路至樹根失敗 (半徑${radius}): ${pathErr.message}`);
                        }
                    }
                    if (!reachedBase) {
                        console.log("🌲 [進階伐木] 樹根完全無法到達，放棄此目標");
                        state.systemFeedback = `[身體信號：找到原木但完全無法靠近，已放棄，請換個位置！]`;
                        try { fs.writeFileSync(path.join(ROOT_DIR, '.gather_signal'), 'FAIL:樹根無法到達:' + Date.now()); } catch(_) {}
                        state.currentMovementMode = 'idle';
                        break;
                    }

                    // count = 最多砍幾根（不給就整棵）。樹根最後一定會被砍（人站在上面往下挖），所以往上砍的額度是 count-1；
                    // count=1 時不爬樹，直接砍樹根
                    const logLimit = typeof action.count === 'number' && action.count >= 1 ? Math.min(Math.floor(action.count), 64) : Infinity;
                    const upwardLimit = Number.isFinite(logLimit) ? Math.max(0, logLimit - 1) : Infinity;
                    let dugUp = 0;
                    const upReached = () => dugUp >= upwardLimit;

                    if (upwardLimit === 0) {
                        const rootDig = await digBlockWithSight(bot, mcData, baseLog);
                        if (!rootDig.dug) console.log(`🌲 [伐木] 樹根砍不到 (${rootDig.reason})`);
                        await bot.waitForTicks(5);
                    } else {
                    let log2 = bot.blockAt(baseLog.position.offset(0, 1, 0));
                    let log3 = bot.blockAt(baseLog.position.offset(0, 2, 0));
                    if (log2 && log2.name.includes('log') && !upReached()) { await bot.dig(log2); dugUp++; await bot.waitForTicks(5); }
                    if (log3 && log3.name.includes('log') && !upReached()) { await bot.dig(log3); dugUp++; await bot.waitForTicks(5); }

                    try {
                        await bot.pathfinder.goto(new goals.GoalBlock(baseLog.position.x, baseLog.position.y + 1, baseLog.position.z));
                    } catch (_) {
                        console.log("🌲 [進階伐木] 無法跳上樹根，改從旁邊開始挖");
                    }

                    let startY = Math.floor(bot.entity.position.y);
                    let failsafe = 0;

                    while (failsafe < 20 && state.currentMovementMode === 'gather' && !upReached()) {
                        failsafe++;
                        let nearbyLogs = bot.findBlocks({
                            matching: b => b.name.includes('log'),
                            maxDistance: 4.5, count: 15
                        });

                        if (nearbyLogs.length > 0) {
                            for (const pos of nearbyLogs) {
                                if (upReached()) break;
                                const blockToDig = bot.blockAt(pos);
                                if (blockToDig && bot.canDigBlock(blockToDig)) {
                                    // 先確認視線：被樹葉擋住就先清掉樹葉，不隔著東西砍
                                    bot.swingArm('right');
                                    const dig = await digBlockWithSight(bot, mcData, blockToDig);
                                    if (dig.dug) {
                                        dugUp++;
                                        await bot.waitForTicks(3);
                                    } else {
                                        console.log(`🌲 [伐木] 這根原木砍不到 (${dig.reason})，跳過`);
                                    }
                                }
                            }
                        } else {
                            let higherLogs = bot.findBlocks({
                                matching: b => b.name.includes('log'),
                                maxDistance: 10
                            }).filter(pos => pos.y > bot.entity.position.y);

                            if (higherLogs.length > 0) {
                                const closestHigh = higherLogs.sort((a, b) => a.y - b.y)[0];
                                let gotCloser = false;
                                try {
                                    await bot.pathfinder.goto(new goals.GoalNear(closestHigh.x, closestHigh.y, closestHigh.z, 3));
                                    gotCloser = true;
                                    console.log(`🪜 [進階伐木] 靠近高處原木 Y=${closestHigh.y} 成功`);
                                } catch (_) {}

                                if (!gotCloser) {
                                    console.log("🪜 [進階伐木] 樹太高了，啟動墊腳模式！");
                                    const dirtBlock = bot.inventory.items().find(item =>
                                        item.name.includes('dirt') || item.name.includes('cobblestone')
                                    );
                                    if (!dirtBlock) {
                                        console.log("🪜 [進階伐木] 沒有墊腳石，放棄上方原木");
                                        state.systemFeedback = `[身體信號：樹太高了，但我沒有泥土或石頭可以墊腳，剩下的砍不到了！]`;
                                        break;
                                    }
                                    await bot.equip(dirtBlock, 'hand');
                                    const footBlock = bot.blockAt(bot.entity.position.offset(0, -1, 0));
                                    if (footBlock && footBlock.position && footBlock.boundingBox === 'block') {
                                        // 起跳後看著高度，升到夠高才放，通常一跳就疊上去
                                        const placeRes = await placeUnderFeet(bot, footBlock);
                                        if (placeRes.placed) console.log("🪜 [進階伐木] 墊腳成功，高度 +1");
                                        else console.log(`⚠️ [進階伐木] 墊腳失敗: ${placeRes.reason}`);
                                        await bot.waitForTicks(8);
                                    } else {
                                        console.log("🪜 [進階伐木] 腳下沒有實心方塊，無法墊腳");
                                        break;
                                    }
                                    if (bestTool) await bot.equip(bestTool, 'hand');
                                }
                            } else {
                                break;
                            }
                        }
                    }

                    console.log("🪓 [進階伐木] 樹頂清理完畢，開始往下挖掉墊腳石與樹根...");
                    // 人沒有站在樹上（例如 count 限制讓頭頂的原木還在，跳不上樹根）就直接砍樹根，不跑「往下挖」那段（會挖到地面）
                    const onTree = Math.floor(bot.entity.position.y) > baseLog.position.y;
                    if (!onTree) {
                        const rootNow = bot.blockAt(baseLog.position);
                        if (rootNow && rootNow.name.includes('log')) {
                            const rd = await digBlockWithSight(bot, mcData, rootNow);
                            if (!rd.dug) console.log(`🌲 [伐木] 樹根砍不到 (${rd.reason})`);
                            await bot.waitForTicks(5);
                        }
                    }
                    while (onTree && Math.floor(bot.entity.position.y) >= startY && state.currentMovementMode === 'gather') {
                        const blockUnder = bot.blockAt(bot.entity.position.offset(0, -1, 0));
                        if (blockUnder && blockUnder.name !== 'air' && blockUnder.name !== 'bedrock') {
                            if (blockUnder.name.includes('dirt')) {
                                const shovel = bot.inventory.items().find(item => item.name.includes('shovel'));
                                if (shovel) await bot.equip(shovel, 'hand');
                            } else if (blockUnder.name.includes('log')) {
                                if (bestTool) await bot.equip(bestTool, 'hand');
                            }
                            await bot.lookAt(blockUnder.position, true);
                            await bot.dig(blockUnder);
                            await bot.waitForTicks(5);
                        } else {
                            break;
                        }
                    }
                    }   // end: upwardLimit > 0（要爬上去砍的流程）
                    console.log('🌳【伐木流程結束】開始撿掉落物。');
                    await collectDrops(bot, goals, baseLog.position, 6);
                    await bot.waitForTicks(20); // 再等 1 秒讓最後的掉落物被撿起
                    // 還留在附近、沒撿到的原木掉落物（常卡在樹葉上方走不到）：說出座標，別讓玩家以為都撿完了
                    let leftoverLogs = findDroppedItems(bot, baseLog.position, 9, 'log');
                    if (leftoverLogs.length > 0) {
                        // 宣布「沒撿到」之前先再試一次、等一下：剛掉下來還在滾動的原木常常下一秒就被撿起來了
                        await collectDrops(bot, goals, baseLog.position, 9, 4, 'log');
                        await bot.waitForTicks(25);
                        leftoverLogs = findDroppedItems(bot, baseLog.position, 9, 'log');
                    }
                    if (leftoverLogs.length > 0) {
                        const where = leftoverLogs.slice(0, 3).map(e => `(${Math.floor(e.position.x)},${Math.floor(e.position.y)},${Math.floor(e.position.z)})`).join('、');
                        state.systemFeedback = (state.systemFeedback ? state.systemFeedback.replace(/\]$/, '') + '；' : '[身體信號：')
                            + `還有 ${leftoverLogs.length} 個原木掉落物沒撿到，停在 ${where}（多半卡在樹葉上方走不到；可以用 pickup_items 試試，或站到那附近再撿）]`;
                    }
                    {
                        const logsAfter = bot.inventory.items()
                            .filter(i => i.name.includes('log'))
                            .reduce((sum, i) => sum + i.count, 0);
                        const logDelta = logsAfter - logsBefore;
                        const priorNote = state.systemFeedback ? ` ${state.systemFeedback.replace(/^\[身體信號：/, '').replace(/\]$/, '')}` : '';
                        const treeNote = Number.isFinite(logLimit)
                            ? (logDelta < logLimit
                                ? `（count=${logLimit}，但這棵樹只有 ${logDelta} 根可砍，所以沒到上限；要更多得再找下一棵）`
                                : `（count=${logLimit}，到上限就停，樹上可能還有剩）`)
                            : '（整棵砍完；想限制數量可以加 count 參數）';
                        const choppedName = targetBlock.name;
                        const speciesNote = (wantSpecific && choppedName !== wantLog)
                            ? `（附近沒有 ${wantLog}，或比最近的 ${choppedName} 遠很多，所以砍的是 ${choppedName}；樹種不同一樣能做木板和木棍，要指定樹種得自己走到那種樹旁邊，find ${wantLog} 可以列出座標）`
                            : '';
                        state.systemFeedback = logDelta > 0
                            ? `[身體信號：砍樹，背包原木 +${logDelta}${treeNote}${speciesNote}。${priorNote}]`
                            : `[身體信號：伐木結束，但背包原木沒有增加（可能砍不到或掉落物沒撿到）。${priorNote}]`;
                        const signalContent = logDelta > 0
                            ? `SUCCESS:delta+${logDelta}:${Date.now()}`
                            : `FAIL:庫存沒增加(before=${logsBefore},after=${logsAfter}):${Date.now()}`;
                        try { fs.writeFileSync(path.join(ROOT_DIR, '.gather_signal'), signalContent); } catch(_) {}
                    }

                } else {
                    let blocksMined = 0;
                    let currentTarget = targetBlock;
                    const originalName = targetBlock.name;
                    const searchCenter = targetBlock.position.clone();
                    // 最多挖幾個：玩家用 count 指定，預設 15、上限 64；訊息會說明是不是因為到上限才停
                    const maxBlocks = typeof action.count === 'number' && action.count >= 1 ? Math.min(Math.floor(action.count), 64) : 15;
                    // 如實記錄這次做了什麼，結束時一起回報（以前只說「沒有挖到」，玩家看不出人到底去哪、做了什麼）
                    const notes = [];
                    const startPos = bot.entity.position.clone();
                    const startDist = startPos.distanceTo(targetBlock.position);
                    let travelCapped = false;
                    let partialStop = false;     // 挖通道挖到一半被時間預算切斷（還沒到目標）
                    // 開頭直接走失敗（pathfinder 思考超時要 5 秒）的目標，迴圈裡不要再讓它思考一次，直接改挖通道
                    let knownUnreachable = null;
                    let knownUnreachableMsg = '';
                    if (resolvedHow === 'drop') notes.push(`${action.target} 是掉落物不是方塊，改挖會掉出它的 ${resolvedNames.slice(0, 3).join('/')}`);
                    else if (resolvedHow === 'partial') notes.push(`沒有叫 ${action.target} 的方塊，改用名稱包含它的 ${originalName}`);
                    const budgetEnd = Date.now() + 85000;    // 單次動作 100 秒，預留約 15 秒給撿掉落物與回報
                    const budgetLeft = () => Math.max(5000, budgetEnd - Date.now());
                    // 走路加時間上限：路太遠時走到一半就停下來回報進度，而不是一路走到動作被強制逾時
                    const gotoCapped = async (goal, ms) => {
                        let timer;
                        const cap = new Promise((_, rej) => { timer = setTimeout(() => { bot.pathfinder.stop(); rej(new Error(`TRAVEL_CAP:${Math.round(ms / 1000)}`)); }, ms); });
                        try { await Promise.race([bot.pathfinder.goto(goal), cap]); }
                        finally { clearTimeout(timer); }
                    };
                    const itemsBefore = bot.inventory.items()
                        .reduce((sum, i) => sum + i.count, 0);

                    // 預期會掉出來的物品（用來如實回報「撿到幾個」）
                    const dropNames = new Set((targetBlock.drops || [])
                        .map(id => mcData.items[id] && mcData.items[id].name).filter(Boolean));
                    if (dropNames.size === 0) dropNames.add(originalName);
                    const countDrops = () => bot.inventory.items()
                        .filter(i => dropNames.has(i.name)).reduce((sum, i) => sum + i.count, 0);
                    const dropsBefore = countDrops();
                    const invBefore = {};
                    for (const it of bot.inventory.items()) invBefore[it.name] = (invBefore[it.name] || 0) + it.count;

                    // 已經放棄的目標與每個目標清障礙的次數，避免在同一個目標上無限空轉
                    const skipped = new Set();
                    const posKey = p => `${p.x},${p.y},${p.z}`;
                    const clearAttempts = new Map();
                    const tunneled = new Set();
                    const findNext = (maxDistance = 8) => bot.findBlock({
                        matching: b => b.name === originalName && !skipped.has(posKey(b.position)) && !isUnderFoot(bot, b.position),
                        useExtraInfo: true,   // matching 要讀 b.position 就必須開這個，否則 position 是空的
                        maxDistance,
                        point: searchCenter
                    });
                    let loopGuard = 0;

                    if (bot.entity.position.distanceTo(currentTarget.position) > 4) {
                        try {
                            await gotoCapped(new goals.GoalNear(
                                currentTarget.position.x, currentTarget.position.y, currentTarget.position.z, 2
                            ), Math.min(60000, budgetLeft()));
                        } catch (pathErr) {
                            console.log(`⛏️ [挖礦] 尋路失敗: ${pathErr.message}`);
                            if (pathErr.message.startsWith('TRAVEL_CAP')) {
                                travelCapped = true;
                                notes.push(`走了 ${pathErr.message.split(':')[1]} 秒還沒走到，先停下來回報進度（路很遠或要繞路，再呼叫一次 gather 會從目前位置繼續）`);
                            } else {
                                notes.push(`直接走過去失敗（${pathErr.message}）`);
                                knownUnreachable = `${currentTarget.position.x},${currentTarget.position.y},${currentTarget.position.z}`;
                                knownUnreachableMsg = pathErr.message;
                            }
                        }
                    }

                    while (!travelCapped && currentTarget && blocksMined < maxBlocks && state.currentMovementMode === 'gather' && loopGuard++ < 80 && Date.now() < budgetEnd) {
                        await torchHabit(ctx);   // 地底太暗又有火把就先插一支（地表不插）
                        const distToBlock = bot.entity.position.distanceTo(currentTarget.position);

                        // 步驟一：移動到方塊正旁邊（距離 2 格以內）
                        if (distToBlock > 2.5) {
                            try {
                                if (knownUnreachable === posKey(currentTarget.position)) throw new Error(knownUnreachableMsg || 'No path to the goal!');
                                await gotoCapped(new goals.GoalNear(
                                    currentTarget.position.x,
                                    currentTarget.position.y,
                                    currentTarget.position.z,
                                    2
                                ), Math.min(40000, budgetLeft()));
                                // goto 回傳成功不代表真的到了（超時後的下一次 goto 會直接「成功」）：以實際距離為準
                                const nowReach = bot.entity.position.offset(0, 1.62, 0).distanceTo(currentTarget.position.offset(0.5, 0.5, 0.5));
                                // 門檻要和下面「直接挖」的可及距離（4.8）一致：正常走到（目標半徑 2 格 + 眼睛高度）最遠約 3.2 格，
                                // 超過 4.8 就是 pathfinder 假裝走到了（上一個動作被切斷後的下一次 goto 會立刻回報成功），要改挖通道而不是放棄目標
                                if (nowReach > 4.8) throw new Error(`走完了但離它還有 ${nowReach.toFixed(1)} 格`);
                            } catch (pathErr) {
                                if (pathErr.message.startsWith('TRAVEL_CAP')) {
                                    travelCapped = true;
                                    notes.push(`走了 ${pathErr.message.split(':')[1]} 秒還沒走到 ${currentTarget.name}，先停下來回報進度（再呼叫一次 gather 會從目前位置繼續）`);
                                    break;
                                }
                                // 走不過去：礦通常藏在岩石裡 → 像玩家一樣挖通道過去（每個目標只試一次）
                                const tkey = posKey(currentTarget.position);
                                if (!tunneled.has(tkey)) {
                                    tunneled.add(tkey);
                                    console.log(`⛏️ [挖礦] 走不過去 (${pathErr.message})，改挖通道到 (${tkey})`);
                                    const tr = await tunnelToPosition(ctx, currentTarget.position.x, currentTarget.position.y, currentTarget.position.z, { range: 1, deadlineMs: Math.max(10000, budgetLeft() - 5000) });
                                    state.currentMovementMode = 'gather';
                                    notes.push(`走不過去，改挖通道到 (${tkey})：挖了 ${tr.steps} 步，${tr.arrived ? '到達' : `沒到（還差 ${tr.remaining} 格：${tr.reason}）`}`);
                                    knownUnreachable = null;      // 通道挖過之後路徑已經改變，不能再沿用「走不過去」的舊結論
                                    if (tr.arrived) continue;       // 通道挖通了，回到迴圈開頭重新判斷
                                    if (tr.timedOut && tr.steps > 0) {
                                        // 不是挖不動，是時間用完：這個目標不能放棄，再呼叫一次要從這裡接著挖
                                        partialStop = true;
                                        currentTarget = null;
                                        continue;
                                    }
                                    console.log(`⛏️ [挖礦] 通道沒挖到目標：${tr.reason}`);
                                } else {
                                    notes.push(`(${tkey}) 走不過去，通道也已經試過，放棄這個目標（${pathErr.message}）`);
                                }
                                skipped.add(tkey);
                                currentTarget = findNext(4);
                                continue;
                            }
                        }

                        // 步驟二：確認視線（不能隔牆挖礦）
                        await bot.lookAt(currentTarget.position.offset(0.5, 0.5, 0.5));
                        await bot.waitForTicks(2);

                        const eyeBlock = bot.blockAtCursor(4);
                        const hasLOS = eyeBlock && eyeBlock.position.x === currentTarget.position.x
                                                && eyeBlock.position.y === currentTarget.position.y
                                                && eyeBlock.position.z === currentTarget.position.z;

                        if (!hasLOS) {
                            const blocker = eyeBlock;
                            const targetKey = posKey(currentTarget.position);
                            const attempts = (clearAttempts.get(targetKey) || 0) + 1;
                            clearAttempts.set(targetKey, attempts);

                            if (blocker && blocker.name === originalName && blocksMined >= maxBlocks) { currentTarget = null; continue; }   // 擋路的是同種方塊，也算在 count 內
                            if (blocker && blocker.name !== 'air' && blocker.name !== 'bedrock' && attempts <= 12) {
                                // 有東西擋在中間：換最適合它的工具清掉，再回來挖目標
                                console.log(`⛏️ [挖礦] 視線被 ${blocker.name} 遮擋，先清除障礙物`);
                                try {
                                    const clearChoice = selectTool(bot, mcData, blocker);
                                    if (!clearChoice.canHarvest || !bot.canDigBlock(blocker)) throw new Error('清不掉這個障礙物');
                                    await equipFor(bot, clearChoice.tool);
                                    await bot.dig(blocker);
                                    if (blocker.name === originalName) blocksMined++;
                                    console.log(`⛏️ [挖礦] 已清除障礙物 ${blocker.name}`);
                                    await bot.waitForTicks(3);
                                } catch (clearErr) {
                                    console.log(`⛏️ [挖礦] 無法清除障礙物: ${clearErr.message}，跳過此目標`);
                                    skipped.add(targetKey);
                                    currentTarget = findNext();
                                }
                            } else {
                                // 射線沒打到目標、也沒有可清的遮擋物（或這個目標清太多次了）：
                                // 直接挖；但必須在可及範圍內（伺服器不收太遠的挖掘），而且挖完要確認方塊真的消失才算數
                                try {
                                    const direct = selectTool(bot, mcData, currentTarget);
                                    if (!direct.canHarvest) throw new Error('沒有能採集它的工具');
                                    const reach = bot.entity.position.offset(0, 1.62, 0).distanceTo(currentTarget.position.offset(0.5, 0.5, 0.5));
                                    if (reach > 4.8) throw new Error(`離它還有 ${reach.toFixed(1)} 格，超出能挖的距離`);
                                    await equipFor(bot, direct.tool);
                                    const digPos = currentTarget.position.clone();
                                    await bot.dig(currentTarget);
                                    await bot.waitForTicks(4);
                                    const after = bot.blockAt(digPos);
                                    if (after && after.name === originalName) throw new Error('挖完方塊還在原地（伺服器沒有接受）');
                                    blocksMined++;
                                    console.log(`⛏️ [挖礦] 已直接挖掉第 ${blocksMined} 個 ${originalName}`);
                                    await bot.waitForTicks(5);
                                } catch (digErr) {
                                    notes.push(`(${currentTarget.position.x},${currentTarget.position.y},${currentTarget.position.z}) 沒挖成：${digErr.message}`);
                                    console.log(`⛏️ [挖礦] 直接挖掘失敗，放棄這個目標: ${digErr.message}`);
                                    skipped.add(targetKey);
                                }
                                currentTarget = findNext();
                            }
                            continue;
                        }

                        // 步驟三：每次下鎬前都重新選工具（鎬子可能剛壞掉），確認可挖掘後執行
                        const digChoice = selectTool(bot, mcData, currentTarget);
                        if (!digChoice.canHarvest) {
                            console.log(`⛏️ [挖礦] 沒有能採集 ${currentTarget.name} 的工具了（可能鎬子壞了）`);
                            state.systemFeedback = `[身體信號：挖到一半沒有能採集 ${currentTarget.name} 的工具了（需要 ${digChoice.needed.slice(0, 3).join(' / ')} 以上），可能是鎬子壞了]`;
                            break;
                        }
                        if (digChoice.nearlyBroken) {
                            notes.push(describeNearlyBroken(digChoice.nearlyBroken, currentTarget.name));
                            break;
                        }
                        await equipFor(bot, digChoice.tool);
                        if (bot.canDigBlock(currentTarget)) {
                            bot.swingArm('right');
                            const digPos2 = currentTarget.position.clone();
                            await bot.dig(currentTarget);
                            await bot.waitForTicks(4);
                            const after2 = bot.blockAt(digPos2);
                            if (after2 && after2.name === originalName) {
                                notes.push(`(${digPos2.x},${digPos2.y},${digPos2.z}) 挖完方塊還在原地（伺服器沒有接受），放棄這個目標`);
                                skipped.add(posKey(digPos2));
                            } else {
                                blocksMined++;
                                console.log(`⛏️ [挖礦] 已挖掉第 ${blocksMined} 個 ${originalName}`);
                            }
                            await bot.waitForTicks(5);
                        } else {
                            console.log(`⛏️ [挖礦] 無法挖掘 ${currentTarget.name}`);
                            skipped.add(posKey(currentTarget.position));
                        }

                        currentTarget = findNext(4);
                    }
                    // 為什麼停在這裡：時間預算用完（要留時間撿掉落物）、附近沒有更多了，還是已達上限
                    // 走路被上限切斷，但確實比出發時更靠近目標：也是「進行中」，不是失敗
                    if (travelCapped && startDist - bot.entity.position.distanceTo(searchCenter) >= 2) bot.actionPartial = true;
                    if (partialStop) {
                        bot.actionPartial = true;
                        notes.push('時間預算用完，通道還沒挖到目標，進度保留（再呼叫一次 gather 會從目前位置接著挖）');
                    }
                    if (!travelCapped && !partialStop && blocksMined < maxBlocks) {
                        if (Date.now() >= budgetEnd) notes.push(`時間預算用完（已挖 ${blocksMined} 個），先去撿掉落物；還想挖的話再呼叫一次`);
                        else if (!currentTarget) notes.push(`附近（約 4 格內）沒有更多 ${originalName} 了，只挖到 ${blocksMined} 個，沒有達到 ${maxBlocks} 個`);
                    }
                    const mineNote = state.systemFeedback ? ` ${state.systemFeedback.replace(/^\[身體信號：/, '').replace(/\]$/, '')}` : '';
                    console.log(`⛏️【採礦任務完成】已挖掘 ${blocksMined} 個 ${originalName}。`);
                    const posAtLastDig = bot.entity.position.clone();
                    // 主動走回挖礦中心把掉落物撿起
                    if (blocksMined > 0) {      // 一個都沒挖到就沒有掉落物可撿，不必走回去（目標可能還在走不到的地方）
                        try {
                            await bot.pathfinder.goto(new goals.GoalNear(
                                searchCenter.x, searchCenter.y, searchCenter.z, 1
                            ));
                        } catch (_) {}
                        await collectDrops(bot, goals, searchCenter);
                        await bot.waitForTicks(20); // 再等 1 秒讓最後的掉落物被撿起
                    }
                    {
                        const picked = countDrops() - dropsBefore;
                        const dropLabel = [...dropNames].join('/');
                        // 全程摘要：目標在哪、多遠、人最後在哪、做了哪些事（看得出為什麼沒挖到）
                        const endPos = bot.entity.position;
                        const t0 = searchCenter;
                        const summary = `目標 ${originalName} 在 (${t0.x},${t0.y},${t0.z})，出發時距離 ${Math.round(startDist)} 格、高度差 ${t0.y - Math.floor(startPos.y)}；` +
                            `結束時人在 (${Math.floor(endPos.x)},${Math.floor(endPos.y)},${Math.floor(endPos.z)})，離它 ${Math.round(endPos.distanceTo(t0))} 格，移動了 ${Math.round(endPos.distanceTo(startPos))} 格（Y ${Math.floor(startPos.y)}→${Math.floor(endPos.y)}）`;
                        // 順手撿到的其他東西（挖通道時挖到的泥土、石頭，砂礫掉出的燧石等），以前只有背包變化看得到
                        const extras = [];
                        const invNow = {};
                        for (const it of bot.inventory.items()) invNow[it.name] = (invNow[it.name] || 0) + it.count;
                        for (const [name, n] of Object.entries(invNow)) {
                            const d = n - (invBefore[name] || 0);
                            if (d > 0 && !dropNames.has(name)) extras.push([name, d]);
                        }
                        extras.sort((a, b) => b[1] - a[1]);
                        if (extras.length) notes.push(`順手還撿到：${extras.slice(0, 5).map(([n, d]) => `${n}×${d}`).join('、')}`);
                        if (blocksMined > 0 && picked >= 0 && picked < blocksMined) notes.push(`挖掉 ${blocksMined} 個但只撿到 ${picked} 個，可能還有掉落物留在原地（可用 pickup_items 撿）`);
                        const movedAfterDig = endPos.distanceTo(posAtLastDig);
                        if (movedAfterDig > 3) notes.push(`挖完後為了撿掉落物（也包含清樹葉掉出的樹苗）又移動了 ${Math.round(movedAfterDig)} 格，所以結束位置不在挖礦的地方`);
                        const noteText = notes.length ? `；過程：${notes.join('；')}` : '';
                        const limitText = blocksMined >= maxBlocks ? `（已達本次上限 ${maxBlocks} 個，還有的話可以再呼叫，或用 count 調整）` : '';
                        state.systemFeedback = blocksMined === 0
                            ? `[身體信號：沒有挖到任何 ${originalName}。${summary}${noteText}。${mineNote}]`
                            : picked > 0
                                ? `[身體信號：挖掉 ${blocksMined} 個 ${originalName}，撿到 ${picked} 個 ${dropLabel}${limitText}。${noteText ? summary + noteText + '。' : ''}${mineNote}]`
                                : `[身體信號：嘗試挖了 ${blocksMined} 個 ${originalName}，但背包沒有出現任何 ${dropLabel}，這 ${blocksMined} 個很可能根本沒挖成（離太遠、伺服器沒有接受），不要當成已經挖到；也可能是掉落物在原地（可用 pickup_items 試試）。${summary}${noteText}。${mineNote}]`;
                        const itemsAfter = bot.inventory.items()
                            .reduce((sum, i) => sum + i.count, 0);
                        const itemDelta = itemsAfter - itemsBefore;
                        const mineSignalContent = (blocksMined > 0 && itemDelta > 0)
                            ? `SUCCESS:mined=${blocksMined}:delta+${itemDelta}:${Date.now()}`
                            : `FAIL:挖了${blocksMined}塊但庫存沒增加(delta=${itemDelta}):${Date.now()}`;
                        try { fs.writeFileSync(path.join(ROOT_DIR, '.mine_signal'), mineSignalContent); } catch(_) {}
                    }
                }

            } catch (e) {
                console.log("⚠️ [採集失敗]:", e.message);
                state.systemFeedback = `[身體信號：採集任務被中斷或卡住了 (${e.message})]`;
                try { fs.writeFileSync(path.join(ROOT_DIR, '.gather_signal'), 'FAIL:' + e.message + ':' + Date.now()); } catch(_) {}
                try { fs.writeFileSync(path.join(ROOT_DIR, '.mine_signal'), 'FAIL:' + e.message + ':' + Date.now()); } catch(_) {}
            } finally {
                state.currentMovementMode = 'idle';
            }
            break;
        }
    }
};
