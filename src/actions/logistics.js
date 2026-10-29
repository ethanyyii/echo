// ════════════════════════════════════════════════════════
//  src/actions/logistics.js — 物流類動作
//  涵蓋: craft, smelt, store, fetch
// ════════════════════════════════════════════════════════
'use strict';
const { goals } = require('mineflayer-pathfinder');
const vec3 = require('vec3');
const { collectDrops, findDroppedItems } = require('./tools');
const { placeBlockNear } = require('./placement');
const fs   = require('fs');
const path = require('path');
const ROOT_DIR = path.join(__dirname, '..', '..');

// 材料不足時，找出「最接近做得出來」的配方，說明需要什麼、缺什麼
function describeMissing(bot, mcData, itemId) {
    const list = mcData.recipes[itemId];
    if (!list || list.length === 0) return '這個物品沒有合成配方（可能只能挖、打怪或冶煉取得）';
    const have = {};
    for (const it of bot.inventory.items()) have[it.type] = (have[it.type] || 0) + it.count;
    const nameOf = (id) => (mcData.items[id] ? mcData.items[id].name : String(id));
    let best = null;
    for (const r of list) {
        const need = {};
        const add = (id) => { if (id != null && id !== -1) need[id] = (need[id] || 0) + 1; };
        if (r.inShape) r.inShape.forEach(row => row.forEach(add));
        if (r.ingredients) r.ingredients.forEach(add);
        let short = 0;
        const lack = [];
        for (const [id, n] of Object.entries(need)) {
            const miss = n - (have[id] || 0);
            if (miss > 0) { short += miss; lack.push(`${nameOf(id)}×${miss}`); }
        }
        if (!best || short < best.short) best = { short, lack, need };
    }
    const needText = Object.entries(best.need).map(([id, n]) => `${nameOf(id)}×${n}`).join('、');
    return best.lack.length > 0 ? `配方需要 ${needText}；還缺 ${best.lack.join('、')}` : `配方需要 ${needText}`;
}

module.exports = async function executeLogistics(action, ctx) {
    const { bot, state, mcData } = ctx;   // ctx 本身也要傳給 placeBlockNear

    switch (action.type) {

        // ── craft ──
        case 'craft': {
            if (!action.name) { state.systemFeedback = '[身體信號：craft 指令缺少 name 參數]'; break; }
            const craftItemName = action.name.toLowerCase().replace(/[\s\-]+/g, '_');
            bot.pathfinder.setGoal(null);

            const craftItemData = mcData.itemsByName[craftItemName];
            if (!craftItemData) {
                console.log(`🔨 [合成] 未知物品: ${craftItemName}`);
                state.systemFeedback = `[身體信號：不認識物品 ${action.name}，無法合成]`;
                break;
            }
            console.log(`🔨 [合成] 目標: ${craftItemName} (id=${craftItemData.id})`);

            try {
                let placedCraftingTable = false;
                let tableRecovered = false;
                let ctBlock = null;
                let recipes = bot.recipesFor(craftItemData.id, null, 1, null);

                // 就算有工作台也做不出來 = 材料不夠：直接說缺什麼，不要先花十秒放工作台再失敗
                if (recipes.length === 0 && bot.recipesFor(craftItemData.id, null, 1, true).length === 0) {
                    const missText = describeMissing(bot, mcData, craftItemData.id);
                    state.systemFeedback = `[身體信號：材料不足，無法合成 ${craftItemName}：${missText}]`;
                    try { fs.writeFileSync(path.join(ROOT_DIR, '.craft_signal'), `FAIL:材料不足(${craftItemName}):${Date.now()}`); } catch(_) {}
                    break;
                }

                if (recipes.length === 0) {
                    console.log(`🔨 [合成] 需要工作台，開始搜尋...`);
                    ctBlock = bot.findBlock({ matching: mcData.blocksByName['crafting_table'].id, maxDistance: 6 });

                    if (!ctBlock) {
                        let ctInInventory = bot.inventory.items().find(i => i.name === 'crafting_table');
                        // 背包沒有桌子，但附近地上有掉落的桌子（上一次回收沒撿到）：先撿起來，不要拿 4 塊木板再做一張
                        if (!ctInInventory) {
                            const droppedTable = findDroppedItems(bot, bot.entity.position, 10, 'crafting_table');
                            if (droppedTable.length > 0) {
                                console.log(`🔨 [合成] 附近地上有掉落的工作台，先撿起來`);
                                await collectDrops(bot, goals, droppedTable[0].position, 3, 2, 'crafting_table');
                                await bot.waitForTicks(12);
                                ctInInventory = bot.inventory.items().find(i => i.name === 'crafting_table');
                            }
                        }
                        if (!ctInInventory) {
                            console.log(`🔨 [合成] 背包無工作台，嘗試自動合成工作台...`);
                            const ctItemData = mcData.itemsByName['crafting_table'];
                            const ctRecipes = bot.recipesFor(ctItemData.id, null, 1, null);
                            if (ctRecipes.length === 0) {
                                state.systemFeedback = `[身體信號：需要工作台但背包沒有，且木板材料不足以自動合成！]`;
                                break;
                            }
                            await Promise.race([
                                bot.craft(ctRecipes[0], 1, null),
                                new Promise((_, reject) => setTimeout(() => reject(new Error('自動合成工作台超時，可能材料不足')), 8000))
                            ]);
                            await bot.waitForTicks(8);
                            ctInInventory = bot.inventory.items().find(i => i.name === 'crafting_table');
                            if (!ctInInventory) {
                                state.systemFeedback = `[身體信號：自動合成工作台失敗，原料可能不足]`;
                                try { fs.writeFileSync(path.join(ROOT_DIR, '.craft_signal'), `FAIL:自動合成工作台失敗(${craftItemName}):${Date.now()}`); } catch(_) {}
                                break;
                            }
                            console.log(`🔨 [合成] 工作台自動合成成功！`);
                        }

                        await bot.equip(ctInInventory, 'hand');
                        await bot.waitForTicks(3);
                        // 附近所有空位都考慮；隧道裡沒空位就挖開旁邊的牆做出空位
                        const tablePlace = await placeBlockNear(ctx, 'crafting_table');
                        if (!tablePlace.placed) { state.systemFeedback = `[身體信號：放不下工作台：${tablePlace.message}]`; break; }
                        console.log(`🔨 [合成] 工作台已放置 ${tablePlace.message}`);

                        await bot.waitForTicks(15);
                        ctBlock = bot.findBlock({ matching: mcData.blocksByName['crafting_table'].id, maxDistance: 6 });
                        if (!ctBlock) {
                            state.systemFeedback = `[身體信號：工作台放置後仍無法找到工作台方塊，放置失敗]`;
                            try { fs.writeFileSync(path.join(ROOT_DIR, '.craft_signal'), `FAIL:工作台放置後找不到方塊(${craftItemName}):${Date.now()}`); } catch(_) {}
                            break;
                        }
                        placedCraftingTable = true;
                    }

                    recipes = bot.recipesFor(craftItemData.id, null, 1, ctBlock);
                }

                if (recipes.length === 0) {
                    state.systemFeedback = `[身體信號：無法合成 ${craftItemName}，配方不存在或材料不足！]`;
                    if (placedCraftingTable && ctBlock) { try { await bot.dig(bot.blockAt(ctBlock.position)); } catch(_) {} }
                    try { fs.writeFileSync(path.join(ROOT_DIR, '.craft_signal'), `FAIL:找不到${craftItemName}的合成配方:${Date.now()}`); } catch(_) {}
                    break;
                }

                if (ctBlock) {
                    const distToCT = bot.entity.position.distanceTo(ctBlock.position);
                    if (distToCT > 4) {
                        try { await bot.pathfinder.goto(new goals.GoalNear(ctBlock.position.x, ctBlock.position.y, ctBlock.position.z, 2)); } catch (_) {}
                    }
                    await bot.lookAt(ctBlock.position.offset(0.5, 0.5, 0.5), true);
                    await bot.waitForTicks(3);
                }

                // count = 想要的成品數量（例如木板 count=16 會合成 4 次）；材料不夠就降到做得出來的次數
                const perCraft = (recipes[0].result && recipes[0].result.count) || 1;
                let crafts = typeof action.count === 'number' ? Math.max(1, Math.ceil(action.count / perCraft)) : 1;
                while (crafts > 1 && bot.recipesFor(craftItemData.id, null, crafts, ctBlock || null).length === 0) crafts--;
                console.log(`🔨 [合成] 開始合成 ${craftItemName} x${crafts * perCraft}（${crafts} 次）...`);
                // mineflayer 的 bot.craft(recipe, n) 連續合成時不等伺服器回應，第 2 次起會丟成品（實測 count=8 扣了材料卻沒有火把）。
                // 實測（約 50% 機率）：第 1 次合成的伺服器確認封包若在第 2 次點擊途中才到，客戶端背包會錯亂，
                // 材料被扣、成品沒給（客戶端還會樂觀地顯示有成品，所以不能用客戶端數量判斷）。
                // 所以一次合成一次，每次之後等伺服器的背包更新到齊，再做下一次。
                for (let n = 0; n < crafts; n++) {
                    await Promise.race([
                        bot.craft(recipes[0], 1, ctBlock || null),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('合成超時，可能材料不足')), 15000))
                    ]);
                    await bot.waitForTicks(12);
                }
                await bot.waitForTicks(10);
                console.log(`🔨 [合成] ✅ 合成成功: ${craftItemName}`);

                if (placedCraftingTable && ctBlock) {
                    console.log(`🔨 [合成] 軍事回收工作台...`);
                    const axeItem = bot.inventory.items().find(i => i.name.toLowerCase().includes('axe'));
                    try {
                        if (axeItem) await bot.equip(axeItem, 'hand');
                        else await bot.unequip('hand');
                    } catch (_) {}
                    const distToCT2 = bot.entity.position.distanceTo(ctBlock.position);
                    if (distToCT2 > 4) {
                        try { await bot.pathfinder.goto(new goals.GoalNear(ctBlock.position.x, ctBlock.position.y, ctBlock.position.z, 2)); } catch (_) {}
                    }
                    await bot.waitForTicks(3);
                    const ctStillThere = bot.blockAt(ctBlock.position);
                    if (ctStillThere && ctStillThere.name === 'crafting_table') {
                        const tablesBefore = bot.inventory.items().filter(i => i.name === 'crafting_table').reduce((n, i) => n + i.count, 0);
                        await bot.lookAt(ctBlock.position.offset(0.5, 0.5, 0.5), true);
                        await bot.dig(ctStillThere);
                        await bot.waitForTicks(10);
                        // 挖下來的工作台是掉落物，要走過去撿起來，並確認真的回到背包
                        await collectDrops(bot, goals, ctBlock.position, 4, 4, 'crafting_table');
                        const tableCount = () => bot.inventory.items().filter(i => i.name === 'crafting_table').reduce((n, i) => n + i.count, 0);
                        // 剛掉出來的物品有約 0.5 秒拾取延遲，第一次太快會撿不到：等一下再撿，最多再試兩次
                        for (let retry = 0; retry < 2 && tableCount() <= tablesBefore; retry++) {
                            await bot.waitForTicks(15);
                            await collectDrops(bot, goals, ctBlock.position, 5, 4, 'crafting_table');
                            await bot.waitForTicks(6);
                        }
                        const tablesAfter = tableCount();
                        tableRecovered = tablesAfter > tablesBefore;
                        console.log(tableRecovered ? `🔨 [合成] ✅ 工作台已回收進背包！` : `⚠️ [合成] 工作台挖下來了，但沒有撿回背包`);
                    }
                }

                // count 是「想要的成品數量」，但配方一次產出固定數量（stick 一次 4 個）：說清楚實際做了幾次、共得幾個
                const wantedCount = typeof action.count === 'number' ? action.count : null;
                const madeCount = crafts * perCraft;
                const countNote = (wantedCount !== null && madeCount !== wantedCount)
                    ? `（要 ${wantedCount} 個，這個配方一次產 ${perCraft} 個，所以做了 ${crafts} 次，共 ${madeCount} 個）` : '';
                state.systemFeedback = `[身體信號：✅ 成功合成 ${craftItemName}！${countNote}${placedCraftingTable ? (tableRecovered ? '工作台已回收進背包。' : `工作台沒有撿回背包（掉在原地 (${ctBlock.position.x},${ctBlock.position.y},${ctBlock.position.z}) 附近，可以用 pickup_items 撿）。`) : ''}]`;
                // 物理校驗：確認合成品真的進了背包
                await bot.waitForTicks(10);
                const craftedItem = bot.inventory.items().find(i =>
                    i.name.toLowerCase() === craftItemName || i.name.toLowerCase().includes(craftItemName.split('_')[0])
                );
                const craftSignal = craftedItem
                    ? `SUCCESS:${craftItemName}:count=${craftedItem.count}:${Date.now()}`
                    : `FAIL:合成指令完成但背包沒有${craftItemName}:${Date.now()}`;
                try { fs.writeFileSync(path.join(ROOT_DIR, '.craft_signal'), craftSignal); } catch(_) {}

            } catch (craftErr) {
                console.log(`⚠️ [合成失敗]:`, craftErr.message);
                state.systemFeedback = `[身體信號：合成 ${craftItemName} 失敗：${craftErr.message}]`;
                try { fs.writeFileSync(path.join(ROOT_DIR, '.craft_signal'), 'FAIL:' + craftErr.message + ':' + Date.now()); } catch(_) {}
            }
            break;
        }

        // ── smelt ──
        case 'smelt': {
            if (!action.name && !action.target) { state.systemFeedback = '[身體信號：smelt 指令缺少 name 參數]'; break; }
            const smeltTarget = (action.name || action.target).toLowerCase().replace(/[\s\-]+/g, '_');
            bot.pathfinder.setGoal(null);
            console.log(`🔥 [熔煉] 目標物品: ${smeltTarget}`);

            try {
                let furnaceBlock = bot.findBlock({ matching: mcData.blocksByName['furnace'].id, maxDistance: 6 });
                let placedFurnace = false;
                let furnaceRecovered = false;

                if (!furnaceBlock) {
                    const furnaceItem = bot.inventory.items().find(i => i.name === 'furnace');
                    if (!furnaceItem) { state.systemFeedback = `[身體信號：附近沒有熔爐，背包也沒有熔爐可以放置！]`; break; }
                    await bot.equip(furnaceItem, 'hand');
                    await bot.waitForTicks(3);
                    const furnacePlace = await placeBlockNear(ctx, 'furnace');
                    if (!furnacePlace.placed) { state.systemFeedback = `[身體信號：放不下熔爐：${furnacePlace.message}]`; break; }
                    placedFurnace = true;
                    console.log(`🔥 [熔煉] 熔爐已放置 ${furnacePlace.message}`);
                    await bot.waitForTicks(5);
                    furnaceBlock = bot.findBlock({ matching: mcData.blocksByName['furnace'].id, maxDistance: 4 });
                    if (!furnaceBlock) { state.systemFeedback = `[身體信號：熔爐放置後找不到方塊！]`; break; }
                }

                const smeltDist = bot.entity.position.distanceTo(furnaceBlock.position);
                if (smeltDist > 3.5) {
                    try { await bot.pathfinder.goto(new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2)); } catch(_) {}
                }
                await bot.lookAt(furnaceBlock.position.offset(0.5, 0.5, 0.5), true);
                await bot.waitForTicks(3);

                const smeltInput = bot.inventory.items().find(i =>
                    i.name.toLowerCase() === smeltTarget || i.name.toLowerCase().includes(smeltTarget)
                );
                if (!smeltInput) { state.systemFeedback = `[身體信號：背包裡沒有 ${smeltTarget} 可以燒！]`; break; }

                // 數量：預設整疊，可用 count 指定；單次上限 10（每個約 10 秒，避免超過動作逾時）
                const inputTotal = bot.inventory.items()
                    .filter(i => i.type === smeltInput.type).reduce((sum, i) => sum + i.count, 0);
                let smeltCount = typeof action.count === 'number' ? Math.floor(action.count) : inputTotal;
                smeltCount = Math.max(1, Math.min(smeltCount, inputTotal, 10));

                // 燃料：優先煤/木炭（每個燒 8 個），其次木板與原木（每個燒 1.5 個）；不拿正在燒的原料當燃料
                const fuelItem = bot.inventory.items().find(i => i.type !== smeltInput.type && (i.name === 'coal' || i.name === 'charcoal')) ||
                    bot.inventory.items().find(i => i.type !== smeltInput.type && (i.name.endsWith('_planks') || i.name.endsWith('_log')));
                if (!fuelItem) { state.systemFeedback = `[身體信號：背包沒有任何燃料（煤/木炭/木板），無法燒煉！]`; break; }
                const smeltsPerFuel = (fuelItem.name === 'coal' || fuelItem.name === 'charcoal') ? 8 : 1.5;
                const fuelHave = bot.inventory.items()
                    .filter(i => i.type === fuelItem.type).reduce((sum, i) => sum + i.count, 0);
                smeltCount = Math.min(smeltCount, Math.floor(fuelHave * smeltsPerFuel));
                if (smeltCount < 1) { state.systemFeedback = `[身體信號：燃料不夠燒煉 ${smeltTarget}！]`; break; }
                const fuelNeeded = Math.ceil(smeltCount / smeltsPerFuel);

                console.log(`🔥 [熔煉] 開啟熔爐介面，放入 ${smeltInput.name} x${smeltCount} / 燃料 ${fuelItem.name} x${fuelNeeded}`);
                const furnaceWindow = await bot.openFurnace(furnaceBlock);
                await bot.waitForTicks(5);
                await furnaceWindow.putFuel(fuelItem.type, null, fuelNeeded);
                await bot.waitForTicks(3);
                await furnaceWindow.putInput(smeltInput.type, null, smeltCount);
                await bot.waitForTicks(3);

                // 等燒完：每秒檢查一次輸出格並取出，直到數量到齊、逾時或被 stop 中斷
                state.currentMovementMode = 'smelt';
                const smeltDeadline = Date.now() + smeltCount * 10000 + 8000;
                let collected = 0;
                let outputName = null;
                console.log(`🔥 [熔煉] 等待燒煉 ${smeltCount} 個（約 ${smeltCount * 10} 秒）...`);
                while (collected < smeltCount && Date.now() < smeltDeadline && state.currentMovementMode === 'smelt') {
                    await new Promise(r => setTimeout(r, 1000));
                    if (furnaceWindow.outputItem()) {
                        try {
                            const taken = await furnaceWindow.takeOutput();
                            if (taken) { collected += taken.count; outputName = taken.name; }
                        } catch (te) { console.log(`⚠️ [熔煉] 取出成品失敗: ${te.message}`); }
                    }
                }
                const wasInterrupted = state.currentMovementMode !== 'smelt';
                if (!wasInterrupted) state.currentMovementMode = 'idle';

                // 沒燒完的原料與剩餘燃料收回背包
                try { if (furnaceWindow.inputItem()) await furnaceWindow.takeInput(); } catch(_) {}
                try { if (furnaceWindow.fuelItem()) await furnaceWindow.takeFuel(); } catch(_) {}
                try { if (furnaceWindow.outputItem()) { const t = await furnaceWindow.takeOutput(); if (t) { collected += t.count; outputName = t.name; } } } catch(_) {}
                console.log(`🔥 [熔煉] 取出成品: ${outputName || '(空)'} x${collected}`);
                furnaceWindow.close();
                await bot.waitForTicks(5);

                if (placedFurnace) {
                    console.log(`🔥 [熔煉] 軍事回收熔爐...`);
                    try {
                        const pickaxe = bot.inventory.items().find(i => i.name.toLowerCase().includes('pickaxe'));
                        if (pickaxe) await bot.equip(pickaxe, 'hand');
                        const fStillThere = bot.blockAt(furnaceBlock.position);
                        if (fStillThere && (fStillThere.name === 'furnace' || fStillThere.name === 'lit_furnace')) {
                            const furnacesBefore = bot.inventory.items().filter(i => i.name === 'furnace').reduce((n, i) => n + i.count, 0);
                            await bot.dig(fStillThere);
                            await bot.waitForTicks(10);
                            // 挖下來的熔爐是掉落物，要走過去撿起來並確認真的回到背包
                            await collectDrops(bot, goals, furnaceBlock.position, 4, 4, 'furnace');
                            const furnacesAfter = bot.inventory.items().filter(i => i.name === 'furnace').reduce((n, i) => n + i.count, 0);
                            furnaceRecovered = furnacesAfter > furnacesBefore;
                            console.log(furnaceRecovered ? `🔥 [熔煉] ✅ 熔爐已回收進背包！` : `⚠️ [熔煉] 熔爐挖下來了，但沒有撿回背包`);
                        }
                    } catch(re) { console.log(`⚠️ [熔煉] 回收熔爐失敗: ${re.message}`); }
                }

                const recycleNote = placedFurnace ? (furnaceRecovered ? '，熔爐已回收進背包。' : '，熔爐沒有撿回背包（掉在原地附近，可以用 pickup_items 撿）。') : '';
                if (collected >= smeltCount) {
                    state.systemFeedback = `[身體信號：✅ 熔煉完成！${smeltInput.name} x${smeltCount} → ${outputName} x${collected}${recycleNote}]`;
                } else if (collected > 0) {
                    state.systemFeedback = `[身體信號：熔煉只完成一部分：${smeltInput.name} x${smeltCount} → ${outputName} x${collected}${wasInterrupted ? '（被中斷）' : '（逾時）'}${recycleNote}]`;
                } else {
                    state.systemFeedback = `[身體信號：熔煉 ${smeltInput.name} 沒有得到任何成品${wasInterrupted ? '（被中斷）' : '（逾時）'}${recycleNote}]`;
                }
                // 物理校驗：成品是 takeOutput 的回傳值，確認數量大於 0
                const smeltSignal = collected > 0
                    ? `SUCCESS:${smeltTarget}→${outputName}:count=${collected}/${smeltCount}:${Date.now()}`
                    : `FAIL:takeOutput回傳空或數量為0:${Date.now()}`;
                try { fs.writeFileSync(path.join(ROOT_DIR, '.smelt_signal'), smeltSignal); } catch(_) {}

            } catch (smeltErr) {
                if (state.currentMovementMode === 'smelt') state.currentMovementMode = 'idle';
                console.log(`⚠️ [熔煉失敗]:`, smeltErr.message);
                state.systemFeedback = `[身體信號：熔煉 ${smeltTarget} 失敗：${smeltErr.message}]`;
            }
            break;
        }

        // ── store ──
        case 'store': {
            if (!action.name && !action.target) { state.systemFeedback = '[身體信號：store 指令缺少 name 參數]'; break; }
            const storeTarget = (action.name || action.target).toLowerCase().replace(/[\s\-]+/g, '_');
            bot.pathfinder.setGoal(null);
            console.log(`📦 [倉儲] 存入目標: ${storeTarget}`);

            try {
                let chestBlock = bot.findBlock({ matching: mcData.blocksByName['chest'].id, maxDistance: 6 });
                let placedChest = false;

                if (!chestBlock) {
                    const chestItem = bot.inventory.items().find(i => i.name === 'chest');
                    if (!chestItem) { state.systemFeedback = `[身體信號：附近沒有寶箱，背包也沒有寶箱可以放置！]`; break; }
                    await bot.equip(chestItem, 'hand');
                    await bot.waitForTicks(3);
                    const chestPlace = await placeBlockNear(ctx, 'chest');
                    if (!chestPlace.placed) { state.systemFeedback = `[身體信號：放不下寶箱：${chestPlace.message}]`; break; }
                    placedChest = true;
                    console.log(`📦 [倉儲] 寶箱已放置 ${chestPlace.message}`);
                    await bot.waitForTicks(5);
                    chestBlock = bot.findBlock({ matching: mcData.blocksByName['chest'].id, maxDistance: 4 });
                    if (!chestBlock) { state.systemFeedback = `[身體信號：寶箱放置後找不到方塊！]`; break; }
                }

                if (bot.entity.position.distanceTo(chestBlock.position) > 3.5) {
                    try { await bot.pathfinder.goto(new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2)); } catch(_) {}
                }
                await bot.lookAt(chestBlock.position.offset(0.5, 0.5, 0.5), true);
                await bot.waitForTicks(3);

                const storeItems = bot.inventory.items().filter(i =>
                    i.name.toLowerCase() === storeTarget || i.name.toLowerCase().includes(storeTarget)
                );
                if (storeItems.length === 0) { state.systemFeedback = `[身體信號：背包裡沒有 ${storeTarget} 可以存入！]`; break; }

                const chestWindow = await bot.openContainer(chestBlock);
                await bot.waitForTicks(5);
                let totalStored = 0;
                for (const si of storeItems) {
                    try { await chestWindow.deposit(si.type, null, si.count); totalStored += si.count; await bot.waitForTicks(3); }
                    catch(de) { console.log(`⚠️ [倉儲] deposit 失敗: ${de.message}`); }
                }
                chestWindow.close();
                await bot.waitForTicks(5);

                console.log(`📦 [倉儲] ✅ 已存入 ${totalStored} 個 ${storeTarget}`);
                state.systemFeedback = `[身體信號：✅ 已將 ${totalStored} 個 ${storeTarget} 存入寶箱！]`;
                // 物理校驗：確認 totalStored > 0
                const storeSignal = totalStored > 0
                    ? `SUCCESS:${storeTarget}:stored=${totalStored}:${Date.now()}`
                    : `FAIL:deposit完成但totalStored=0:${Date.now()}`;
                try { fs.writeFileSync(path.join(ROOT_DIR, '.store_signal'), storeSignal); } catch(_) {}

            } catch (storeErr) {
                console.log(`⚠️ [倉儲失敗]:`, storeErr.message);
                state.systemFeedback = `[身體信號：存入 ${storeTarget} 失敗：${storeErr.message}]`;
            }
            break;
        }

        // ── fetch ──
        case 'fetch': {
            if (!action.name && !action.target) { state.systemFeedback = '[身體信號：fetch 指令缺少 name 參數]'; break; }
            const fetchTarget = (action.name || action.target).toLowerCase().replace(/[\s\-]+/g, '_');
            const fetchCount = typeof action.count === 'number' ? action.count : 1;
            bot.pathfinder.setGoal(null);
            console.log(`📤 [取物] 目標: ${fetchTarget} x${fetchCount}`);

            try {
                const fetchChestBlock = bot.findBlock({ matching: mcData.blocksByName['chest'].id, maxDistance: 6 });
                if (!fetchChestBlock) { state.systemFeedback = `[身體信號：附近找不到寶箱！]`; break; }

                if (bot.entity.position.distanceTo(fetchChestBlock.position) > 3.5) {
                    try { await bot.pathfinder.goto(new goals.GoalNear(fetchChestBlock.position.x, fetchChestBlock.position.y, fetchChestBlock.position.z, 2)); } catch(_) {}
                }
                await bot.lookAt(fetchChestBlock.position.offset(0.5, 0.5, 0.5), true);
                await bot.waitForTicks(3);

                const fetchWindow = await bot.openContainer(fetchChestBlock);
                await bot.waitForTicks(5);
                const fetchItem = fetchWindow.containerItems().find(i =>
                    i.name.toLowerCase() === fetchTarget || i.name.toLowerCase().includes(fetchTarget)
                );

                if (!fetchItem) { fetchWindow.close(); state.systemFeedback = `[身體信號：寶箱裡沒有 ${fetchTarget}！]`; break; }

                const actualCount = Math.min(fetchCount, fetchItem.count);
                await fetchWindow.withdraw(fetchItem.type, null, actualCount);
                await bot.waitForTicks(5);
                fetchWindow.close();
                await bot.waitForTicks(3);

                console.log(`📤 [取物] ✅ 已取出 ${actualCount} 個 ${fetchItem.name}`);
                state.systemFeedback = `[身體信號：✅ 已從寶箱取出 ${actualCount} 個 ${fetchItem.name}！]`;
                // 物理校驗：確認物品真的進了背包
                await bot.waitForTicks(5);
                const fetchedInInventory = bot.inventory.items().find(i =>
                    i.name.toLowerCase() === fetchTarget || i.name.toLowerCase().includes(fetchTarget)
                );
                const fetchSignal = fetchedInInventory
                    ? `SUCCESS:${fetchTarget}:count=${fetchedInInventory.count}:${Date.now()}`
                    : `FAIL:withdraw完成但背包沒有${fetchTarget}:${Date.now()}`;
                try { fs.writeFileSync(path.join(ROOT_DIR, '.fetch_signal'), fetchSignal); } catch(_) {}

            } catch (fetchErr) {
                console.log(`⚠️ [取物失敗]:`, fetchErr.message);
                state.systemFeedback = `[身體信號：取物 ${fetchTarget} 失敗：${fetchErr.message}]`;
                try { fs.writeFileSync(path.join(ROOT_DIR, '.fetch_signal'), 'FAIL:' + fetchErr.message + ':' + Date.now()); } catch(_) {}
            }
            break;
        }
    }
};
