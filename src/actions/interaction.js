// ════════════════════════════════════════════════════════
//  src/actions/interaction.js — 互動類動作
//  涵蓋: drop, eat, equip
// ════════════════════════════════════════════════════════
'use strict';
const { goals } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const { findDroppedItems, collectDrops, droppedItemName } = require('./tools');
const fs   = require('fs');
const path = require('path');
const ROOT_DIR = path.join(__dirname, '..', '..');

module.exports = async function executeInteraction(action, ctx) {
    const { bot, state, MASTER_NAME } = ctx;

    switch (action.type) {
        // ── use_block：對指定座標的方塊按右鍵（開關門、活板門、柵欄門、拉桿、按鈕）──
        case 'use_block': {
            const ux = Math.floor(action.x), uy = Math.floor(action.y), uz = Math.floor(action.z);
            bot.pathfinder.setGoal(null);
            const blk = bot.blockAt(new Vec3(ux, uy, uz));
            if (!blk) { state.systemFeedback = `[身體信號：(${ux},${uy},${uz}) 的區塊還沒載入]`; break; }
            const n = blk.name;
            const kind = n.endsWith('_door') ? '門' : n.endsWith('_trapdoor') ? '活板門' : n.endsWith('_fence_gate') ? '柵欄門' : n === 'lever' ? '拉桿' : n.endsWith('_button') ? '按鈕' : null;
            if (!kind) { state.systemFeedback = `[身體信號：use_block 目前只支援門、活板門、柵欄門、拉桿、按鈕；(${ux},${uy},${uz}) 是 ${n}]`; break; }
            if (n.startsWith('iron_') && (kind === '門' || kind === '活板門')) { state.systemFeedback = `[身體信號：${n} 是鐵製的，徒手按右鍵開不了（要紅石訊號）]`; break; }
            const stateKey = (kind === '拉桿' || kind === '按鈕') ? 'powered' : 'open';
            const readState = () => { const b2 = bot.blockAt(new Vec3(ux, uy, uz)); try { return b2 ? b2.getProperties()[stateKey] : undefined; } catch (_) { return undefined; } };
            const beforeState = readState();
            // 伸手範圍內才按得到：太遠就先走近
            const eyeDist = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(new Vec3(ux + 0.5, uy + 0.5, uz + 0.5));
            if (eyeDist() > 4.4) {
                try { await bot.pathfinder.goto(new goals.GoalNear(ux, uy, uz, 2)); } catch (_) { /* 走不近就看現在按不按得到 */ }
            }
            if (eyeDist() > 4.8) { state.systemFeedback = `[身體信號：離 ${n} (${ux},${uy},${uz}) 太遠（${eyeDist().toFixed(1)} 格）而且走不過去，按不到]`; break; }
            try {
                await bot.lookAt(new Vec3(ux + 0.5, uy + 0.5, uz + 0.5), true);
                await bot.activateBlock(bot.blockAt(new Vec3(ux, uy, uz)));
                await bot.waitForTicks(8);
            } catch (e) { state.systemFeedback = `[身體信號：對 ${n} 按右鍵失敗：${e.message}]`; break; }
            const afterState = readState();
            const word = (st) => st === true || st === 'true' ? (stateKey === 'open' ? '開著' : '通電') : (stateKey === 'open' ? '關著' : '沒通電');
            state.systemFeedback = String(afterState) !== String(beforeState)
                ? `[身體信號：${kind} ${n} (${ux},${uy},${uz}) 從${word(beforeState)}變成${word(afterState)}]`
                : `[身體信號：對 ${n} (${ux},${uy},${uz}) 按了右鍵，但狀態沒變（還是${word(afterState)}）：可能被別的東西擋住或伺服器沒接受]`;
            break;
        }

        // ── pickup_items：走過去撿起附近的掉落物 ──
        case 'pickup_items': {
            const radius = typeof action.radius === 'number' ? Math.min(Math.max(action.radius, 1), 32) : 12;
            const nameFilter = action.name ? action.name.toLowerCase() : null;
            bot.pathfinder.setGoal(null);
            const here = bot.entity.position;
            const nearby = findDroppedItems(bot, here, radius, nameFilter);
            if (nearby.length === 0) {
                state.systemFeedback = `[身體信號：${radius} 格內沒有${nameFilter ? ' ' + nameFilter + ' 的' : ''}掉落物可以撿]`;
                break;
            }
            const before = {};
            for (const i of bot.inventory.items()) before[i.name] = (before[i.name] || 0) + i.count;
            console.log(`🧲 [撿取] 附近有 ${nearby.length} 個掉落物，開始撿`);
            const visited = await collectDrops(bot, goals, here, radius, 24, nameFilter);
            await bot.waitForTicks(10);
            // 同名物品可能分成多疊，要用總量比較
            const totals = {};
            for (const i of bot.inventory.items()) totals[i.name] = (totals[i.name] || 0) + i.count;
            const gainedTotals = Object.entries(totals)
                .map(([n, c]) => [n, c - (before[n] || 0)]).filter(([, d]) => d > 0);
            const summary = gainedTotals.map(([n, d]) => `${n} x${d}`).join('、');
            // 沒撿到的掉落物：列出座標，並判斷是不是被岩石完全包住（那就要先挖開才拿得到）
            const leftEntities = findDroppedItems(bot, here, radius, nameFilter);
            const leftDesc = leftEntities.slice(0, 5).map(e => {
                const bx = Math.floor(e.position.x), by = Math.floor(e.position.y), bz = Math.floor(e.position.z);
                const sealed = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].every(([ox, oy, oz]) => {
                    const nb = bot.blockAt(new Vec3(bx + ox, by + oy, bz + oz));
                    return nb && nb.boundingBox === 'block';
                });
                const roof = bot.blockAt(new Vec3(bx, by + 1, bz));
                const lowCeiling = roof && roof.boundingBox === 'block';
                const dist = e.position.distanceTo(bot.entity.position);
                const exact = `${e.position.x.toFixed(1)},${e.position.y.toFixed(1)},${e.position.z.toFixed(1)}`;
                const why = sealed ? '被岩石完全包住，要先挖開：tunnel_to'
                    : lowCeiling ? `離你 ${dist.toFixed(1)} 格，那一格頭頂是 ${roof.name}（只有 1 格高，人站不進去），先把頭頂挖掉（dig up 或 tunnel_to）再撿`
                    : `離你 ${dist.toFixed(1)} 格，走不到（路被擋住，常見是卡在樹葉或方塊上）；先用 dig 挖掉它旁邊或下方擋路的方塊（樹葉也可以挖）再 pickup_items，或放棄它`;
                return `${droppedItemName(e) || '物品'}@(${bx},${by},${bz})[精確 ${exact}；${why}]`;
            }).join('、');
            const left = leftEntities.length;
            const bagFull = bot.inventory.emptySlotCount() === 0;
            state.systemFeedback = gainedTotals.length
                ? `[身體信號：走過去 ${visited} 個掉落物，撿到 ${summary}${left > 0 ? `；還有 ${left} 個沒撿到：${leftDesc}` : ''}]`
                : `[身體信號：走過去 ${visited} 個掉落物，但什麼都沒撿到：${bagFull ? '背包已經滿了' : leftDesc || '掉落物已消失'}]`;
            break;
        }

        case 'drop': {
            if (!action.name) break;

            const player = bot.players[MASTER_NAME]?.entity;
            if (player) {
                const dist = bot.entity.position.distanceTo(player.position);
                if (dist > 3) {
                    console.log("🚶 [肌肉記憶] 走向哥哥準備遞交物品...");
                    bot.pathfinder.setGoal(null);
                    try {
                        await bot.pathfinder.goto(new goals.GoalNear(player.position.x, player.position.y, player.position.z, 2));
                    } catch (e) {
                        console.log("⚠️ [尋路警告] 被地形擋住，無法完全靠近哥哥:", e.message);
                    }
                }
                bot.pathfinder.setGoal(null);
                await bot.lookAt(player.position.offset(0, 1.6, 0), true);
                await bot.waitForTicks(5);
            } else {
                bot.pathfinder.setGoal(null);
            }

            if (action.name.toLowerCase() === 'all') {
                const items = bot.inventory.items();
                if (items.length === 0) {
                    state.systemFeedback = `[身體信號：背包已經是空的了，沒有東西可以丟]`;
                    break;
                }
                console.log("🗑️ [執行動作] 正在看著哥哥清空背包...");
                for (const item of items) {
                    try {
                        await bot.tossStack(item);
                        await bot.waitForTicks(5);
                    } catch (e) {
                        console.log("⚠️ [丟棄失敗]:", e.message);
                    }
                }
                state.systemFeedback = `[身體信號：已看著哥哥，將背包裡所有物品全部丟給他了]`;
            } else {
                const itemToDrop = bot.inventory.items().find(item =>
                    item.name.toLowerCase().includes(action.name.toLowerCase())
                );
                if (itemToDrop) {
                    try {
                        const countBefore = bot.inventory.items()
                            .filter(i => i.name.toLowerCase().includes(action.name.toLowerCase()))
                            .reduce((sum, i) => sum + i.count, 0);
                        await bot.tossStack(itemToDrop);
                        await bot.waitForTicks(5);
                        const countAfter = bot.inventory.items()
                            .filter(i => i.name.toLowerCase().includes(action.name.toLowerCase()))
                            .reduce((sum, i) => sum + i.count, 0);
                        const dropDelta = countBefore - countAfter;
                        state.systemFeedback = `[身體信號：已看著哥哥並成功丟出 ${action.name}]`;
                        try {
                            fs.writeFileSync(
                                path.join(ROOT_DIR, '.drop_signal'),
                                dropDelta > 0
                                    ? `SUCCESS:${action.name}:dropped=${dropDelta}:${Date.now()}`
                                    : `FAIL:toss完成但庫存沒減少:${Date.now()}`
                            );
                        } catch(_) {}
                    } catch (e) {
                        state.systemFeedback = `[身體信號：丟出 ${action.name} 失敗]`;
                        try {
                            fs.writeFileSync(
                                path.join(ROOT_DIR, '.drop_signal'),
                                `FAIL:${e.message}:${Date.now()}`
                            );
                        } catch(_) {}
                    }
                } else {
                    state.systemFeedback = `[身體信號：背包裡沒有 ${action.name} 可以丟]`;
                    try {
                        fs.writeFileSync(
                            path.join(ROOT_DIR, '.drop_signal'),
                            `FAIL:背包沒有${action.name}:${Date.now()}`
                        );
                    } catch(_) {}
                }
            }
            state.currentMovementMode = 'idle';
            break;
        }

        case 'eat': {
            if (!action.name) break;
            const food = bot.inventory.items().find(item =>
                item.name.toLowerCase().includes(action.name.toLowerCase())
            );
            if (food) {
                bot.pathfinder.setGoal(null);
                await bot.equip(food, 'hand');
                await bot.consume();
            } else {
                state.systemFeedback = `[身體信號：背包裡沒有 ${action.name} 可以吃]`;
            }
            break;
        }

        case 'equip': {
            if (!action.name) break;
            bot.pathfinder.setGoal(null);
            const wanted = action.name.toLowerCase();

            if (wanted === 'empty' || wanted === 'empty_hand' || wanted === 'none') {
                try {
                    await bot.unequip('hand');
                    state.systemFeedback = "[身體信號：我已經把手上的東西收起來了，現在是空手狀態]";
                } catch (e) {
                    console.log("⚠️ [unequip 失敗]:", e.message);
                    state.systemFeedback = "[身體信號：我想把手清空，但好像被什麼東西卡住沒辦法收起來]";
                }
                break;
            }

            let item = bot.inventory.items().find(i => i.name.toLowerCase().includes(wanted));
            if (!item) {
                if (wanted === 'sword')                    item = bot.inventory.items().find(i => i.name.toLowerCase().includes('sword'));
                else if (wanted === 'pickaxe' || wanted === 'pick') item = bot.inventory.items().find(i => i.name.toLowerCase().includes('pickaxe'));
                else if (wanted === 'axe')                 item = bot.inventory.items().find(i => i.name.toLowerCase().includes('axe'));
                else if (wanted === 'shield')              item = bot.inventory.items().find(i => i.name.toLowerCase().includes('shield'));
            }

            if (!item) {
                state.systemFeedback = `[身體信號：我在背包裡找不到 ${action.name} 可以拿在手上]`;
                try {
                    fs.writeFileSync(
                        path.join(ROOT_DIR, '.equip_signal'),
                        `FAIL:背包沒有${action.name}:${Date.now()}`
                    );
                } catch(_) {}
                break;
            }
            try {
                await bot.equip(item, 'hand');
                await bot.waitForTicks(3);
                const heldItem = bot.heldItem;
                const equipSuccess = heldItem && heldItem.name === item.name;
                state.systemFeedback = `[身體信號：我已經把 ${item.name} 拿在手上了]`;
                try {
                    fs.writeFileSync(
                        path.join(ROOT_DIR, '.equip_signal'),
                        equipSuccess
                            ? `SUCCESS:${item.name}:held=${heldItem.name}:${Date.now()}`
                            : `FAIL:equip完成但heldItem=${heldItem?.name || 'null'}:${Date.now()}`
                    );
                } catch(_) {}
            } catch (e) {
                console.log("⚠️ [equip 失敗]:", e.message);
                state.systemFeedback = `[身體信號：我想拿起 ${item.name}，但好像被什麼東西卡住拿不起來]`;
                try {
                    fs.writeFileSync(
                        path.join(ROOT_DIR, '.equip_signal'),
                        `FAIL:${e.message}:${Date.now()}`
                    );
                } catch(_) {}
            }
            break;
        }
    }
};
