// ════════════════════════════════════════════════════════
//  src/actions/builder.js — 建築類動作
//  涵蓋: place_block, place_torch（內部用）, pillar, dig
// ════════════════════════════════════════════════════════
'use strict';
const { goals } = require('mineflayer-pathfinder');
const vec3 = require('vec3');
const { placeUnderFeet, selectTool, equipFor } = require('./tools');
const { placeBlockAt } = require('./placement');
const fs   = require('fs');
const path = require('path');
const ROOT_DIR = path.join(__dirname, '..', '..');

module.exports = async function executeBuilder(action, ctx) {
    const { bot, state, mcData, MASTER_NAME } = ctx;

    switch (action.type) {

        // ── place_block：在指定座標放一個方塊（座標由 agent 決定）──
        case 'place_block': {
            const px = Math.floor(action.x), py = Math.floor(action.y), pz = Math.floor(action.z);
            bot.pathfinder.setGoal(null);
            const r = await placeBlockAt(ctx, String(action.block).toLowerCase(), px, py, pz);
            state.systemFeedback = r.placed
                ? `[身體信號：${r.message}]`
                : `[身體信號：沒放成功 (${px},${py},${pz})：${r.message}]`;
            try {
                fs.writeFileSync(path.join(ROOT_DIR, '.build_signal'),
                    r.placed ? `SUCCESS:place_block:${action.block}@${px},${py},${pz}:${Date.now()}` : `FAIL:place_block:${r.reason}:${Date.now()}`);
            } catch(_) {}
            break;
        }

        // ── place_torch ──
        case 'place_torch': {
            const torchItem = bot.inventory.items().find(i => i.name === 'torch');
            if (!torchItem) {
                console.log('🔦 [插火把] 背包沒有火把，略過');
                state.systemFeedback = '[身體信號：我想插火把，但背包裡沒有火把了！]';
                try { fs.writeFileSync(path.join(ROOT_DIR, '.torch_signal'), `FAIL:背包沒有火把:${Date.now()}`); } catch(_) {}
                break;
            }

            let travelDX = (typeof action.dx === 'number') ? action.dx : 0;
            let travelDZ = (typeof action.dz === 'number') ? action.dz : 0;
            if (travelDX === 0 && travelDZ === 0) {
                const snapYaw = Math.round(bot.entity.yaw / (Math.PI / 2)) * (Math.PI / 2);
                travelDX = Math.round(-Math.sin(snapYaw));
                travelDZ = Math.round(-Math.cos(snapYaw));
            }
            const originalYaw = bot.entity.yaw;
            const sides = [
                { sx:  travelDZ, sz: -travelDX },
                { sx: -travelDZ, sz:  travelDX },
            ];
            const pos = bot.entity.position.floored();
            const prevSlot = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
            let placed = false;

            // 先試最簡單、最像玩家的做法：插在腳下的地面上（火把沒有碰撞，插在自己站的那一格也可以）
            {
                const floorHere = bot.blockAt(bot.entity.position.offset(0, -1, 0));
                const feetHere = bot.blockAt(bot.entity.position);
                if (floorHere && floorHere.boundingBox === 'block' && !floorHere.name.includes('water') && !floorHere.name.includes('lava') &&
                    feetHere && (feetHere.name === 'air' || feetHere.name === 'cave_air')) {
                    try {
                        await bot.equip(torchItem, 'hand');
                        await bot.waitForTicks(2);
                        await bot.lookAt(floorHere.position.offset(0.5, 1.0, 0.5), true);
                        await bot.waitForTicks(2);
                        await bot.placeBlock(floorHere, new vec3(0, 1, 0));
                        await bot.waitForTicks(5);
                        const chk = bot.blockAt(bot.entity.position);
                        if (chk && chk.name.includes('torch')) {
                            console.log('🔦 [插火把] ✅ 插在腳下的地面');
                            placed = true;
                        }
                    } catch (fe) {
                        console.log(`🔦 [插火把] 腳下插把失敗: ${fe.message}，改試兩側壁龕`);
                    }
                }
            }

            for (const { sx, sz } of sides) {
                if (placed) break;
                const nichePos = new vec3(pos.x + sx, pos.y + 1, pos.z + sz);
                const basePos  = new vec3(pos.x + sx, pos.y,     pos.z + sz);

                const baseBlock = bot.blockAt(basePos);
                if (!baseBlock || baseBlock.name === 'air' || baseBlock.name === 'cave_air' ||
                    baseBlock.name.includes('water') || baseBlock.name.includes('lava')) {
                    console.log(`🔦 [插火把] 壁龕底座 (${basePos.x},${basePos.y},${basePos.z}) 不是實心方塊 (${baseBlock?.name})，換邊`);
                    continue;
                }

                const nicheBlock = bot.blockAt(nichePos);
                if (nicheBlock && nicheBlock.name !== 'air' && nicheBlock.name !== 'cave_air' &&
                    !nicheBlock.name.includes('torch')) {
                    try {
                        console.log(`🔦 [插火把] 挖壁龕 @ (${nichePos.x},${nichePos.y},${nichePos.z}) [${nicheBlock.name}]`);
                        const pick = bot.inventory.items().find(i => i.name.includes('pickaxe'));
                        if (pick) { try { await bot.equip(pick, 'hand'); } catch(_) {} }
                        await bot.lookAt(nichePos.offset(0.5, 0.5, 0.5), true);
                        await bot.waitForTicks(2);
                        await bot.dig(bot.blockAt(nichePos), true);
                        await bot.waitForTicks(5);
                    } catch(de) {
                        console.log(`🔦 [插火把] 挖壁龕失敗: ${de.message}，換邊`);
                        continue;
                    }
                }

                try {
                    await bot.equip(torchItem, 'hand');
                    await bot.waitForTicks(2);
                    const freshBase = bot.blockAt(basePos);
                    if (!freshBase || freshBase.name === 'air' || freshBase.name === 'cave_air') {
                        console.log(`🔦 [插火把] 底座在挖洞後消失？換邊`);
                        continue;
                    }
                    await bot.lookAt(freshBase.position.offset(0.5, 1.0, 0.5), true);
                    await bot.waitForTicks(2);
                    await bot.placeBlock(freshBase, new vec3(0, 1, 0));
                    await bot.waitForTicks(5);
                    const check = bot.blockAt(nichePos);
                    if (!check || !check.name.includes('torch')) {
                        throw new Error(`物理驗證失敗：${check?.name ?? 'null'} 不是火把`);
                    }
                    console.log(`🔦 [插火把] ✅ 壁龕火把物理驗證通過！位置 (${nichePos.x},${nichePos.y},${nichePos.z})`);
                    placed = true;
                } catch(pe) {
                    console.log(`🔦 [插火把] 壁龕插把失敗: ${pe.message}，換邊`);
                }
            }

            // 兩側沒有牆可以做壁龕時（例如在空地），退而求其次：像一般玩家一樣插在身旁的地面上
            if (!placed) {
                console.log('🔦 [插火把] 左右兩側壁龕均失敗，改插在身旁地面');
                const groundSpots = [[travelDX, travelDZ], [sides[0].sx, sides[0].sz], [sides[1].sx, sides[1].sz], [-travelDX, -travelDZ]];
                for (const [gx, gz] of groundSpots) {
                    if (placed) break;
                    const floorB = bot.blockAt(pos.offset(gx, -1, gz));
                    const spaceB = bot.blockAt(pos.offset(gx, 0, gz));
                    if (!floorB || floorB.boundingBox !== 'block' || floorB.name.includes('water') || floorB.name.includes('lava')) continue;
                    if (!spaceB || (spaceB.name !== 'air' && spaceB.name !== 'cave_air')) continue;
                    try {
                        await bot.equip(torchItem, 'hand');
                        await bot.waitForTicks(2);
                        await bot.lookAt(floorB.position.offset(0.5, 1.0, 0.5), true);
                        await bot.waitForTicks(2);
                        await bot.placeBlock(floorB, new vec3(0, 1, 0));
                        await bot.waitForTicks(5);
                        const check = bot.blockAt(pos.offset(gx, 0, gz));
                        if (check && check.name.includes('torch')) {
                            console.log(`🔦 [插火把] ✅ 地面火把物理驗證通過！位置 (${pos.x + gx},${pos.y},${pos.z + gz})`);
                            placed = true;
                        }
                    } catch (ge) {
                        console.log(`🔦 [插火把] 地面插把失敗: ${ge.message}`);
                    }
                }
            }

            if (!placed) console.log('🔦 [插火把] ⚠️ 找不到任何可以插火把的地方');
            state.systemFeedback = placed
                ? '[身體信號：✅ 已插上火把]'
                : '[身體信號：附近找不到可以插火把的地方（兩側沒有牆，身旁也沒有空的地面）]';
            try { await bot.look(originalYaw, 0, true); } catch(_) {}
            await bot.waitForTicks(2);
            if (prevSlot) { try { await bot.equip(prevSlot, 'hand'); } catch(_) {} }

            // Signal 寫入（placed 已經是物理校驗過的結果）
            try {
                fs.writeFileSync(
                    path.join(ROOT_DIR, '.torch_signal'),
                    placed
                        ? `SUCCESS:torch:placed=true:${Date.now()}`
                        : `FAIL:左右兩側壁龕均失敗:${Date.now()}`
                );
            } catch(_) {}
            break;
        }

        // ── dig ──
        case 'dig': {
            let targetBlock = null;
            const pos = bot.entity.position;
            const yaw = bot.entity.yaw;

            if (action.direction === 'forward') {
                targetBlock = bot.blockAt(pos.offset(-Math.sin(yaw), 1, -Math.cos(yaw)));
                if (!targetBlock || targetBlock.name.includes('air')) {
                    targetBlock = bot.blockAt(pos.offset(-Math.sin(yaw), 0, -Math.cos(yaw)));
                }
            } else if (action.direction === 'up') {
                targetBlock = bot.blockAt(pos.offset(0, 2, 0));
            } else {
                targetBlock = bot.blockAt(pos.offset(0, -1, 0));
            }

            if (targetBlock && (targetBlock.name === 'water' || targetBlock.name === 'lava')) {
                state.systemFeedback = `[身體信號：那個位置是${targetBlock.name === 'water' ? '水' : '岩漿'}，液體不能挖。要先用方塊把它填掉，或換個位置/方向]`;
                break;
            }
            if (targetBlock && !targetBlock.name.includes('air') && bot.canDigBlock(targetBlock)) {
                bot.pathfinder.setGoal(null);
                // 和 gather 一樣：依這個方塊選最適合的工具（需要特定等級的方塊，工具不夠就說明）
                const digChoice = selectTool(bot, ctx.mcData, targetBlock);
                if (!digChoice.canHarvest) {
                    state.systemFeedback = `[身體信號：我沒有能採集 ${targetBlock.name} 的工具（需要 ${digChoice.needed.slice(0, 3).join(' / ')} 以上），挖了也不會掉落]`;
                    break;
                }
                await equipFor(bot, digChoice.tool);
                await bot.lookAt(targetBlock.position, false);
                bot.swingArm('right');
                await bot.dig(targetBlock);
            } else {
                state.systemFeedback = "[身體信號：前方沒有方塊或方塊太硬無法挖掘]";
            }
            break;
        }

        // ── pillar ──
        case 'pillar': {
            const baseY2 = Math.floor(bot.entity.position.y);
            const requestedHeight = (typeof action.height === 'number' && action.height > 0) ? action.height : 2;
            let targetY = baseY2 + requestedHeight;

            if (action.target === 'player' && bot.players[MASTER_NAME]?.entity) {
                const playerY = Math.floor(bot.players[MASTER_NAME].entity.position.y);
                targetY = Math.max(targetY, playerY);
            }

            // 墊腳的方塊每一跳前都要重新挑：一種用完要換下一種；挖頭頂時換成鎬子，放方塊前也要拿回方塊
            const findPlaceable = () => {
            let placeableCandidates = bot.inventory.items().filter(item => {
                const n = item.name.toLowerCase();
                if (n.includes('sword') || n.includes('pickaxe') || n.includes('axe') ||
                    n.includes('shovel') || n.includes('hoe')) return false;
                if (n.includes('bow') || n.includes('arrow') || n.includes('bucket') || n.includes('boat')) return false;
                if (n.includes('helmet') || n.includes('chestplate') || n.includes('leggings') ||
                    n.includes('boots') || n.includes('shield')) return false;
                if (n.includes('fish') || n.includes('beef') || n.includes('pork') || n.includes('bread') ||
                    n.includes('apple') || n.includes('carrot') || n.includes('potato')) return false;
                return (
                    n.includes('dirt') || n.includes('grass') || n.includes('stone') ||
                    n.includes('cobblestone') || n.includes('netherrack') || n.includes('sand') ||
                    n.includes('sandstone') || n.includes('planks') || n.includes('log') ||
                    n.includes('deepslate') || n.includes('granite') || n.includes('diorite') ||
                    n.includes('andesite') || n.includes('terracotta') || n.includes('concrete') ||
                    n.includes('wool') || n.includes('glass') || n.includes('moss') ||
                    n.includes('mud') || n.includes('bricks')
                );
            });
            if (placeableCandidates.length === 0) {
                placeableCandidates = bot.inventory.items().filter(item => mcData.blocksByName[item.name]);
            }
            return placeableCandidates;
            };
            const blockItem = findPlaceable()[0];
            if (!blockItem) {
                state.systemFeedback = "[身體信號：我身上沒有可以當作墊腳石的方塊，沒辦法幫自己墊高]";
                break;
            }

            await bot.equip(blockItem, 'hand');
            bot.pathfinder.setGoal(null);
            state.currentMovementMode = 'pillar';
            let stuckCounter = 0;
            let jumpCount = 0, placedCount = 0;

            try {
                let feetBlock = bot.blockAt(bot.entity.position);
                let headBlock = bot.blockAt(bot.entity.position.offset(0, 1, 0));

                if ((feetBlock && (feetBlock.name.includes('water') || feetBlock.name.includes('lava'))) ||
                    (headBlock && (headBlock.name.includes('water') || headBlock.name.includes('lava')))) {
                    console.log("🏊 [越獄系統] 檢測到身處液體中，啟動水上脫困程序...");
                    const p = bot.entity.position;
                    let bestShore = null, shortestDist = 999;
                    for (let x = -8; x <= 8; x++) {
                        for (let z = -8; z <= 8; z++) {
                            for (let y = -4; y <= 4; y++) {
                                const block  = bot.blockAt(p.offset(x, y, z));
                                const above  = bot.blockAt(p.offset(x, y+1, z));
                                const above2 = bot.blockAt(p.offset(x, y+2, z));
                                if (block && block.boundingBox === 'block' &&
                                    above  && above.boundingBox  === 'empty' && !above.name.includes('water')  && !above.name.includes('lava') &&
                                    above2 && above2.boundingBox === 'empty' && !above2.name.includes('water') && !above2.name.includes('lava')) {
                                    const dist = p.distanceTo(block.position);
                                    if (dist < shortestDist) { shortestDist = dist; bestShore = block.position; }
                                }
                            }
                        }
                    }
                    if (bestShore) {
                        console.log(`🏊 [水上脫困] 發現岸邊 (距離 ${Math.round(shortestDist)} 格)，正在游過去...`);
                        bot.pathfinder.setGoal(new goals.GoalBlock(bestShore.x, bestShore.y + 1, bestShore.z));
                        for (let i = 0; i < 100; i++) {
                            if (bot.entity.position.distanceTo(new vec3(bestShore.x, bestShore.y + 1, bestShore.z)) < 1.5) break;
                            await bot.waitForTicks(1);
                        }
                        bot.pathfinder.setGoal(null);
                        await bot.waitForTicks(10);
                    } else {
                        console.log("🏊 [水上脫困] 附近 8 格內沒有岸邊，準備在牆上造人工陸地...");
                        bot.setControlState('jump', true);
                        await bot.waitForTicks(20);
                        let wallRef = null, faceVecW = null;
                        const offsets = [
                            { v: new vec3(1,0,0), f: new vec3(-1,0,0) },
                            { v: new vec3(-1,0,0), f: new vec3(1,0,0) },
                            { v: new vec3(0,0,1), f: new vec3(0,0,-1) },
                            { v: new vec3(0,0,-1), f: new vec3(0,0,1) }
                        ];
                        for (const off of offsets) {
                            const b = bot.blockAt(bot.entity.position.offset(off.v.x, 0, off.v.z));
                            if (b && b.boundingBox === 'block') { wallRef = b; faceVecW = off.f; break; }
                        }
                        if (wallRef) {
                            try {
                                await bot.lookAt(wallRef.position.offset(0.5, 0.5, 0.5));
                                await bot.placeBlock(wallRef, faceVecW);
                                bot.setControlState('forward', true);
                                await bot.waitForTicks(15);
                                bot.setControlState('forward', false);
                            } catch(e) { console.log("⚠️ 原地造陸失敗"); }
                        }
                        bot.setControlState('jump', false);
                    }
                }

                while (Math.floor(bot.entity.position.y) < targetY) {
                    if (state.currentMovementMode !== 'pillar') break;
                    const pos = bot.entity.position.floored();
                    let ceilingCleared = true;
                    const tIter = Date.now();
                    let ceilDug = 0;

                    for (let i = 2; i <= 5; i++) {
                        const ceilBlock = bot.blockAt(pos.offset(0, i, 0));
                        if (ceilBlock && ceilBlock.name !== 'air' && !ceilBlock.name.includes('water') && ceilBlock.boundingBox === 'block') {
                            if (bot.canDigBlock(ceilBlock)) {
                                await bot.lookAt(ceilBlock.position.offset(0.5, 0.5, 0.5), false);
                                // 手上拿的是墊腳的方塊：不換工具直接挖，石頭要空手挖約 8 秒一塊（實測），所以先換成最適合的工具
                                const ceilTool = selectTool(bot, mcData, ceilBlock);
                                if (ceilTool.tool) await equipFor(bot, ceilTool.tool);
                                await bot.waitForTicks(2);
                                bot.swingArm('right');
                                await bot.dig(ceilBlock);
                                ceilDug++;
                                await bot.waitForTicks(2);
                            } else {
                                state.systemFeedback = `[身體信號：頭頂的 ${ceilBlock.displayName} 挖不動，墊高中斷]`;
                                ceilingCleared = false; break;
                            }
                        }
                    }

                    if (!ceilingCleared) { state.currentMovementMode = 'idle'; break; }

                    {   // 手上要拿著可以放的方塊：挖頭頂換成鎬子了、或這一種用完了，都重新挑一種拿起來
                        const pick = findPlaceable()[0];
                        if (!pick) { state.systemFeedback = "[身體信號：方塊已耗盡，墊高中斷]"; break; }
                        const held = bot.heldItem;
                        if (!held || held.name !== pick.name) await bot.equip(pick, 'hand');
                    }

                    const refBlock = bot.blockAt(pos.offset(0, -1, 0));
                    if (!refBlock || refBlock.name === 'air' || refBlock.name.includes('water') || refBlock.name.includes('lava')) {
                        await bot.waitForTicks(5);
                        bot.setControlState('jump', true);
                        await bot.waitForTicks(5);
                        bot.setControlState('jump', false);
                        continue;
                    }

                    // 起跳後看著高度，升到夠高才放，所以通常一跳就疊上去
                    jumpCount++;
                    const tPlace = Date.now();
                    const placeRes = await placeUnderFeet(bot, refBlock);
                    console.log(`🧱 [墊高] 第 ${jumpCount} 跳｜Y=${bot.entity.position.y.toFixed(2)}｜清頭頂 ${ceilDug} 塊 ${tPlace - tIter}ms｜起跳放置 ${Date.now() - tPlace}ms｜${placeRes.placed ? '放上去了' : '沒放上去：' + placeRes.reason}`);
                    if (placeRes.placed) {
                        placedCount++;
                        stuckCounter = 0;
                    } else {
                        console.log(`🧱 [墊高] 這一跳沒放上去: ${placeRes.reason}`);
                        stuckCounter++;
                        if (stuckCounter >= 3) { state.systemFeedback = "[身體信號：地形卡住導致方塊無法放置，墊高中斷]"; break; }
                    }
                    await bot.waitForTicks(4);
                }
            } finally {
                if (state.currentMovementMode === 'pillar') {
                    state.currentMovementMode = 'idle';
                    bot.clearControlStates();
                    const finalY = Math.floor(bot.entity.position.y);
                    const heightGained = finalY - baseY2;
                    if (finalY >= targetY) {
                        state.systemFeedback = `[身體信號：已墊高 ${heightGained} 格（起跳 ${jumpCount} 次，放了 ${placedCount} 個方塊）]`;
                        try {
                            fs.writeFileSync(
                                path.join(ROOT_DIR, '.pillar_signal'),
                                `SUCCESS:finalY=${finalY}:targetY=${targetY}:gained=${heightGained}:${Date.now()}`
                            );
                        } catch(_) {}
                    } else {
                        try {
                            fs.writeFileSync(
                                path.join(ROOT_DIR, '.pillar_signal'),
                                `FAIL:finalY=${finalY}:targetY=${targetY}:gained=${heightGained}:${Date.now()}`
                            );
                        } catch(_) {}
                    }
                }
            }
            break;
        }
    }
};
