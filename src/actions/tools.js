// ════════════════════════════════════════════════════════
//  src/actions/tools.js — 工具選擇（供各動作模組共用）
//  像正常玩家一樣選工具：需要特定等級才會掉落的方塊（礦石、石頭…）只考慮「採得動」的工具，
//  其中挖掘最快的優先；不需要特定工具的方塊，沒有工具比空手快就空手。
// ════════════════════════════════════════════════════════
'use strict';

const vec3 = require('vec3');

const TOOL_SUFFIXES = ['_pickaxe', '_axe', '_shovel', '_hoe', '_sword', 'shears'];

const isTool = item => TOOL_SUFFIXES.some(s => item.name.endsWith(s) || item.name === s);

/**
 * 為指定方塊選出最適合的工具。
 * @returns {{tool: object|null, canHarvest: boolean, needed: string[]}}
 *   tool=null 且 canHarvest=true 表示空手最好；canHarvest=false 時 needed 是能採集它的工具名稱（由低階到高階）
 */
function selectTool(bot, mcData, block) {
    const mustHarvest = !!block.harvestTools;
    const digTimeWith = (type) => block.digTime(type, false, false, true, [], bot.entity.effects || {});
    const left = (item) => (item.maxDurability != null && item.durabilityUsed != null) ? item.maxDurability - item.durabilityUsed : Infinity;
    // 貴重工具（鐵、鑽石、獄髓）：挖便宜的方塊時盡量省著用
    const PRECIOUS = /^(iron|diamond|netherite)_/;

    // 玩家用 tool 參數指定了工具：背包有、採得動、還有耐久就照它的意思用
    const isCheap = !(block.name.endsWith('_ore') || block.name === 'ancient_debris');
    // 選到的工具耐久只剩 ≤4 次就算「快壞了」：呼叫端可以停下來說明，而不是挖到工具消失。
    // 貴重工具（鐵、鑽石）拿去挖便宜的方塊時，門檻放寬到 15%：那把鎬子是留著挖礦石用的（玩家第 8 輪用 tool=iron_pickaxe
    // 挖了 69 階石頭，鐵鎬從 250 耗到 11，差點挖不了鑽石）
    const nearly = (item) => {
        if (!item) return null;
        const l = left(item);
        const precious = isCheap && PRECIOUS.test(item.name) && item.maxDurability != null;
        const reserve = precious ? Math.max(4, Math.ceil(item.maxDurability * 0.15)) : 4;
        return l <= reserve ? { name: item.name, left: l, max: item.maxDurability, precious } : null;
    };
    const pref = bot.preferredToolName;
    if (pref) {
        // 同名的工具可能有好幾把（例如 213/250 和 37/250 兩把鐵鎬）：用耐久最多的那把，不是背包裡排第一個的
        const chosen = bot.inventory.items().filter(i => i.name === pref).sort((a, b) => left(b) - left(a))[0];
        if (chosen && isTool(chosen) && (!mustHarvest || block.canHarvest(chosen.type)) && left(chosen) > 0) {
            return { tool: chosen, canHarvest: true, needed: [], nearlyBroken: nearly(chosen) };
        }
    }
    // 便宜的方塊：不是礦石的一般方塊（石頭、泥土、深板岩、礫石…）
    const cheapBlock = !(block.name.endsWith('_ore') || block.name === 'ancient_debris');

    let candidates = bot.inventory.items().filter(isTool).filter(i => !mustHarvest || block.canHarvest(i.type));
    // 快壞的工具（含貴重工具的保留線）不用，除非沒有別的選擇。
    // 注意要在「省著用便宜工具」之前就排除：否則便宜工具快壞時，會因為只剩它一個候選而停下，
    // 明明背包有耐久滿格的鐵鎬（玩家第 9 輪遇到：石鎬剩 4 次就說「沒有別的工具能挖 diorite」）
    const usable = candidates.filter(i => !nearly(i));
    if (usable.length > 0) candidates = usable;

    if (mustHarvest && candidates.length === 0) {
        const needed = Object.keys(block.harvestTools)
            .map(id => mcData.items[id] && mcData.items[id].name)
            .filter(Boolean)
            .sort((a, b) => a.length - b.length);
        return { tool: null, canHarvest: false, needed };
    }

    // 便宜的方塊：有非貴重的工具能挖就用它，把鐵鎬、鑽石鎬留給礦石
    if (cheapBlock) {
        const frugal = candidates.filter(i => !PRECIOUS.test(i.name));
        if (frugal.length > 0) candidates = frugal;
    }

    let bestTool = null;
    let bestTime = mustHarvest ? Infinity : digTimeWith(null);   // 不需要特定工具時，空手是基準
    for (const item of candidates) {
        const t = digTimeWith(item.type);
        if (t < bestTime) { bestTime = t; bestTool = item; }
    }
    return { tool: bestTool, canHarvest: true, needed: [], nearlyBroken: nearly(bestTool) };
}

// 把 selectTool 回報的 nearlyBroken 變成給玩家看的說明
function describeNearlyBroken(nb, blockName) {
    if (nb.precious) {
        return `${nb.name} 耐久只剩 ${nb.left}/${nb.max}（低於 15%），它是留著挖礦石用的貴重工具，不再拿來挖 ${blockName} 這種便宜的方塊，先停下；可以改用 tool 參數指定石鎬或木鎬，或先做新的鎬子`;
    }
    return `${nb.name} 耐久只剩 ${nb.left}/${nb.max}，再挖會壞掉，先停下（沒有別的工具能挖 ${blockName}）；可以先做新的鎬子`;
}

// 把 selectTool 選出的工具拿到手上（tool=null 表示空手）
async function equipFor(bot, tool) {
    const held = bot.heldItem;
    if (tool) {
        if (!held || held.type !== tool.type) await bot.equip(tool, 'hand');
    } else if (held && isTool(held)) {
        await bot.unequip('hand');
    }
}

// 掉落物實體的物品名稱（沒有資料時回傳 null）
function droppedItemName(entity) {
    try {
        const item = entity.getDroppedItem && entity.getDroppedItem();
        return item ? item.name : null;
    } catch (_) { return null; }
}

/**
 * 找出中心點附近的掉落物實體，可依物品名稱過濾。
 */
function findDroppedItems(bot, center, radius, nameFilter = null, exclude = null) {
    const out = [];
    for (const e of Object.values(bot.entities)) {
        if (e.name !== 'item' || !e.isValid || !e.position) continue;
        if (exclude && exclude.has(e.id)) continue;
        if (e.position.distanceTo(center) > radius) continue;
        if (nameFilter) {
            const n = droppedItemName(e);
            if (!n || !n.includes(nameFilter)) continue;
        }
        out.push(e);
    }
    out.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
    return out;
}

/**
 * 撿起中心點附近的掉落物（正常玩家挖完礦、殺完怪都會把掉出來的東西撿乾淨）。
 * 每個掉落物只嘗試一次，避免撿不到的東西造成無限迴圈。回傳嘗試走過去的數量。
 */
async function collectDrops(bot, goals, center, radius = 8, maxPickups = 16, nameFilter = null) {
    const tried = new Set();
    let visited = 0;
    for (let i = 0; i < maxPickups; i++) {
        const drop = findDroppedItems(bot, center, radius, nameFilter, tried)[0];
        if (!drop) break;
        tried.add(drop.id);
        visited++;
        // 撿東西要站到掉落物那一格上（距離 1 格內不保證撿得到：掉落物的高度、碰撞箱都可能差一點）。
        // 走不到那一格再退而求其次走到附近。
        const bx = Math.floor(drop.position.x), by = Math.floor(drop.position.y), bz = Math.floor(drop.position.z);
        let reached = false;
        try {
            await bot.pathfinder.goto(new goals.GoalBlock(bx, by, bz));
            reached = true;
        } catch (e1) {
            try { await bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1)); reached = true; }
            catch (e2) { console.log(`⚠️ [撿取] 走不到掉落物 (${bx},${by},${bz}): ${e2.message}`); }
        }
        await bot.waitForTicks(reached ? 8 : 2);
    }
    return visited;
}

// mineflayer 的 yaw：0 = 朝北 (dz=-1)，π/2 = 朝西 (dx=-1)，π = 朝南，-π/2 = 朝東
const DIRECTION_YAW = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 };

function yawFor(direction) {
    const d = String(direction).toLowerCase();
    return d in DIRECTION_YAW ? DIRECTION_YAW[d] : 0;
}

// 最接近的四個方位名稱
function facingName(yaw) {
    const normalized = ((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const idx = Math.round(normalized / (Math.PI / 2)) % 4;   // 0 北 1 西 2 南 3 東
    return ['north', 'west', 'south', 'east'][idx];
}

/**
 * 在腳下放一個方塊（疊高）。正確的做法是起跳後「看著高度」，升到比新方塊整整高 1 格以上才放：
 * 新方塊會佔據腳下那一格，身體必須先離開它，而跳的頂點大約只有 1.25 格、可用的時間窗只有約 3 個 tick，
 * 所以不能用固定的延遲（太早放會被伺服器拒絕，就得再跳一次）。
 * @returns {{placed: boolean, reason?: string}}
 */
async function placeUnderFeet(bot, refBlock) {
    const topY = refBlock.position.y + 1;            // 新方塊的底面 = 參考方塊的頂面
    await bot.lookAt(refBlock.position.offset(0.5, 1, 0.5), true);
    bot.setControlState('jump', true);
    let risen = false;
    for (let i = 0; i < 14; i++) {
        await bot.waitForTicks(1);
        if (bot.entity.position.y >= topY + 1.15) { risen = true; break; }
    }
    bot.setControlState('jump', false);              // 只跳這一下
    if (!risen) return { placed: false, reason: 'did_not_rise' };
    try {
        await bot.placeBlock(refBlock, new vec3(0, 1, 0));
        return { placed: true };
    } catch (e) {
        return { placed: false, reason: e.message };
    }
}

/**
 * 像一般玩家一樣挖一個方塊：先確認視線打得到它。被別的方塊擋住（例如樹葉）就先把擋住的清掉，
 * 不隔著東西挖（伺服器不檢查視線，所以不檢查的話隔著樹葉也砍得到，但那不自然）。
 * @returns {{dug: boolean, reason?: string, cleared?: number}}
 */
async function digBlockWithSight(bot, mcData, block) {
    let cleared = 0;
    for (let i = 0; i < 5; i++) {
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
        const hit = bot.blockAtCursor(5);
        if (!hit) return { dug: false, reason: 'out_of_reach', cleared };
        if (hit.position.equals(block.position)) {
            const choice = selectTool(bot, mcData, block);
            if (!choice.canHarvest) return { dug: false, reason: `need_${choice.needed[0] || 'better_tool'}`, cleared };
            await equipFor(bot, choice.tool);
            await bot.dig(block);
            return { dug: true, cleared };
        }
        // 視線被別的方塊擋住：把它清掉再試
        const choice = selectTool(bot, mcData, hit);
        if (!choice.canHarvest || !bot.canDigBlock(hit)) return { dug: false, reason: `blocked_by_${hit.name}`, cleared };
        await equipFor(bot, choice.tool);
        await bot.dig(hit);
        cleared++;
    }
    return { dug: false, reason: 'could_not_clear_view', cleared };
}

function solidBelowFeet(bot) {
    const p = bot.entity.position;
    const b = bot.blockAt(new vec3(Math.floor(p.x), Math.floor(p.y - 0.1), Math.floor(p.z)));
    return !!(b && b.boundingBox === 'block');
}

// 等身體落地站穩（最多 maxMs）。走進下一格後人常常還在落下，這時讀到的高度會差一格，下一步就會用錯的高度重算。
async function settleOnGround(bot, maxMs = 1200) {
    const end = Date.now() + maxMs;
    while (Date.now() < end && bot.entity) {
        const v = bot.entity.velocity;
        // 站在地上時 vy 是重力的 -0.0784，不是 0；而且腳下要真的有實心方塊：剛挖掉腳下那格時客戶端要過一個物理刻才發現沒地板，
        // 那一刻 onGround 還是 true，不能當成已經站穩
        if (bot.entity.onGround && Math.abs(v.y) < 0.1 && solidBelowFeet(bot)) return true;
        await bot.waitForTicks(1);
    }
    return false;
}

// 某一格的方塊光照（火把、岩漿等發出的光，0–15）。查不到時回傳 null。
function lightAt(bot, pos) {
    try {
        const l = bot.world.getBlockLight(pos);
        return typeof l === 'number' ? l : null;
    } catch (_) { return null; }
}

// 某一格的天空光（0–15，地底是 0）。查不到時回傳 null。
function skyLightAt(bot, pos) {
    try {
        const l = bot.world.getSkyLight(pos);
        return typeof l === 'number' ? l : null;
    } catch (_) { return null; }
}

// 頭上有幾格實心方塊擋著（往上數到 limit 格為止，樹葉不算）
function solidAboveCount(bot, limit = 24) {
    const base = bot.entity.position.floored();
    let n = 0;
    for (let dy = 2; dy < 2 + limit; dy++) {
        const b = bot.blockAt(base.offset(0, dy, 0));
        if (b && b.boundingBox === 'block' && !b.name.endsWith('_leaves')) n++;
    }
    return n;
}

/**
 * 是不是在地底：頭上有 ≥ 2 格實心方塊擋著，或天空光很低（任一成立）。
 * 注意：客戶端的光照資料是伺服器推送的，區塊載入之後被改動的方塊（挖開、蓋住、放火把）不一定會更新，
 * 所以天空光讀到「很亮」不代表真的在地表，不能只看它；頭上有沒有岩層是更可靠的真相。
 */
function isUnderground(bot) {
    if (bot.game && bot.game.dimension && bot.game.dimension !== 'overworld') return false;   // 下界、終界不在此習慣範圍
    if (solidAboveCount(bot, 12) >= 2) return true;
    const sky = skyLightAt(bot, bot.entity.position.floored());
    return sky !== null && sky <= 3;
}

// 附近 radius 格內有沒有火把（查不到光照時用來判斷「已經有人照亮這裡」）
function torchNearby(bot, radius = 6) {
    const b = bot.findBlock({ matching: x => x && (x.name === 'torch' || x.name === 'wall_torch'), maxDistance: radius });
    return !!b;
}

// 方塊光照低於這個值就算「太暗」，要插火把（0–15；怪物在這個亮度以下會生成）。想調整就改這裡。
const TORCH_LIGHT_MAX = 7;
const TORCH_COOLDOWN_MS = 6000;
let lastTorchAt = 0;

/**
 * 火把習慣：在地底、周圍太暗、背包有火把時，往腳下的地面插一支。地表不插。
 * 在會往地下走的動作裡每隔一小段呼叫一次即可（有冷卻，不會連續狂插）。
 * @returns {Promise<boolean>} 這次有沒有插
 */
async function torchHabit(ctx, opts = {}) {
    const { bot } = ctx;
    if (!bot.entity) return false;
    if (Date.now() - lastTorchAt < TORCH_COOLDOWN_MS) return false;
    if (!bot.inventory.items().some(i => i.name === 'torch')) return false;
    const feet = bot.blockAt(bot.entity.position);
    if (feet && (feet.name === 'water' || feet.name === 'lava')) return false;
    if (!isUnderground(bot)) return false;
    const light = lightAt(bot, bot.entity.position.floored());
    // 附近 6 格內已經有火把就不用再插（放了火把之後客戶端的光照數字可能還是舊的，所以用方塊本身判斷）
    if (torchNearby(bot, 6)) return false;
    const dark = light === null || light <= TORCH_LIGHT_MAX;
    if (!dark) return false;
    lastTorchAt = Date.now();
    console.log(`🔦 [火把習慣] 地底太暗（光照 ${light === null ? '未知' : light}），插一支火把`);
    try { await ctx.exec([{ type: 'place_torch', dx: opts.dx || 0, dz: opts.dz || 0 }]); } catch (_) {}
    return true;
}

module.exports = { describeNearlyBroken, selectTool, equipFor, isTool, TOOL_SUFFIXES, droppedItemName, findDroppedItems, collectDrops, yawFor, facingName, placeUnderFeet, digBlockWithSight, settleOnGround, solidBelowFeet, lightAt, skyLightAt, solidAboveCount, isUnderground, torchNearby, torchHabit };
