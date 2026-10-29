// ════════════════════════════════════════════════════════
//  src/actions/placement.js — 放置方塊（供 place_block、craft 放工作台、smelt 放熔爐、store 放箱子共用）
//
//    placeBlockAt(ctx, itemName, x, y, z)   在指定座標放一個方塊（agent 自己決定座標）
//    placeBlockNear(ctx, itemName)          在附近找個地方放；沒空位就挖開旁邊的牆做出空位
// ════════════════════════════════════════════════════════
'use strict';

const Vec3 = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { selectTool, equipFor } = require('./tools');
const { closedDoorsHint } = require('./movement');

const REACH = 4.4;
// 面向量：參考方塊在目標的哪一邊 → 點擊的面（參考方塊朝向目標的那一面）
const SIDES = [
    { ref: [0, -1, 0], face: [0, 1, 0] },     // 參考方塊在目標下面：點它的上面（最自然）
    { ref: [0, 0, -1], face: [0, 0, 1] },
    { ref: [0, 0, 1], face: [0, 0, -1] },
    { ref: [-1, 0, 0], face: [1, 0, 0] },
    { ref: [1, 0, 0], face: [-1, 0, 0] },
    { ref: [0, 1, 0], face: [0, -1, 0] },     // 參考方塊在目標上面：點它的下面
];

const isAirLike = (b) => !!b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air');
// 可以被直接放進去取代的格子（Minecraft 的 replaceable）：空氣、水、草、蕨、雪層、藤蔓、枯灌木。
// 花、樹苗、農作物、火把不是——伺服器會拒絕，客戶端要等 5 秒的 blockUpdate 才逾時（玩家：放在 azure_bluet 上白等 15 秒）
const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'water', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'seagrass', 'tall_seagrass', 'snow', 'vine', 'dead_bush', 'light', 'fire']);
const isReplaceable = (b) => !!b && REPLACEABLE.has(b.name);

function blockMatches(block, itemName) {
    if (!block) return false;
    if (itemName.includes('torch')) return block.name.includes('torch');
    return block.name === itemName;
}

// 那格裡有沒有別的生物（怪物、動物、玩家）：實心方塊放不進有生物站著的格子，伺服器會拒絕，客戶端要等 5 秒的 blockUpdate 逾時才知道
function entityInCell(bot, x, y, z) {
    for (const e of Object.values(bot.entities)) {
        if (!e || e === bot.entity || !e.position || e.type === 'object' || e.name === 'item' || e.name === 'arrow') continue;
        const w = (e.width || 0.6) / 2, h = e.height || 1.8;
        if (e.position.x + w > x && e.position.x - w < x + 1 && e.position.y + h > y && e.position.y < y + 1 && e.position.z + w > z && e.position.z - w < z + 1) {
            return String(e.name || e.username || e.type);
        }
    }
    return null;
}

function overlapsBot(bot, x, y, z) {
    const p = bot.entity.position;
    return p.x + 0.3 > x && p.x - 0.3 < x + 1 && p.y + 1.8 > y && p.y < y + 1 && p.z + 0.3 > z && p.z - 0.3 < z + 1;
}

// 從眼睛看向參考方塊的那一面，射線第一個打到的方塊必須就是參考方塊（隔著牆是放不了的，伺服器不檢查但真人做不到）
function canSeeFace(bot, ref, face) {
    const eye = bot.entity.position.offset(0, 1.62, 0);
    const point = ref.position.offset(0.5 + face.x * 0.49, 0.5 + face.y * 0.49, 0.5 + face.z * 0.49);
    const diff = point.minus(eye);
    const dist = diff.norm();
    if (dist > REACH) return false;
    const hit = bot.world.raycast(eye, diff.normalize(), dist + 0.2);
    return !!hit && hit.position.x === ref.position.x && hit.position.y === ref.position.y && hit.position.z === ref.position.z;
}

function supportsFor(bot, x, y, z) {
    const out = [];
    for (const s of SIDES) {
        const ref = bot.blockAt(new Vec3(x + s.ref[0], y + s.ref[1], z + s.ref[2]));
        if (ref && ref.boundingBox === 'block') out.push({ ref, face: new Vec3(s.face[0], s.face[1], s.face[2]) });
    }
    return out;
}

/**
 * 在指定座標放一個方塊。
 * @returns {{placed: boolean, reason?: string, message?: string, position?: object}}
 */
async function placeBlockAt(ctx, itemName, x, y, z) {
    const { bot, mcData } = ctx;
    const item = bot.inventory.items().find(i => i.name === itemName);
    if (!item) return { placed: false, reason: 'no_item', message: `背包裡沒有 ${itemName}` };
    if (!mcData.blocksByName[itemName] && !itemName.includes('torch')) {
        return { placed: false, reason: 'not_a_block', message: `${itemName} 不是可以放置的方塊` };
    }

    const target = bot.blockAt(new Vec3(x, y, z));
    if (!target) return { placed: false, reason: 'not_loaded', message: `(${x},${y},${z}) 的區塊還沒載入` };
    if (blockMatches(target, itemName)) return { placed: true, already: true, message: `(${x},${y},${z}) 本來就是 ${itemName}`, position: { x, y, z } };
    if (!isReplaceable(target)) {
        // 玩家常常把地板放在「地面那一層」：直接告訴它這一欄往上第一個放得下的格子在哪一層
        let freeY = null;
        for (let yy = y + 1; yy <= y + 8 && freeY === null; yy++) if (isReplaceable(bot.blockAt(new Vec3(x, yy, z)))) freeY = yy;
        const hint = freeY !== null ? `；這一欄（${x},${z}）往上第一個放得下的格子是 y=${freeY}，要蓋在地面上就放在 y=${freeY}` : '';
        const plant = target.boundingBox !== 'block';
        return { placed: false, reason: 'occupied', message: `(${x},${y},${z}) 已經是 ${target.name}${plant ? '（花草、樹苗這類植物不能直接蓋過去）' : ''}，要先挖掉它（dig 或 gather），或換一個空氣的座標${hint}` };
    }

    const solidItem = !itemName.includes('torch');
    if (solidItem && overlapsBot(bot, x, y, z)) {
        return { placed: false, reason: 'inside_self', message: `(${x},${y},${z}) 是我自己站的位置，實心方塊放不進去；請先移動到旁邊` };
    }

    if (solidItem) {
        const who = entityInCell(bot, x, y, z);
        if (who) return { placed: false, reason: 'entity_in_cell', message: `(${x},${y},${z}) 這一格裡有生物（${who}）站著，方塊放不進去；等牠走開、或先把牠趕走／打倒再放` };
    }

    const supports = supportsFor(bot, x, y, z);
    if (supports.length === 0) {
        return { placed: false, reason: 'no_support', message: `(${x},${y},${z}) 周圍六個面都沒有實心方塊可以靠（懸空），要先在旁邊放一個方塊` };
    }

    const center = new Vec3(x + 0.5, y + 0.5, z + 0.5);
    const visibleSupports = () => supports.filter(({ ref, face }) => canSeeFace(bot, ref, face));
    let usable = visibleSupports();
    if (usable.length === 0) {
        // 太遠或被擋住：走近到目標旁邊再看一次
        if (bot.entity.position.offset(0, 1.62, 0).distanceTo(center) > 2.5) {
            try { await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 2)); } catch (_) { /* 走不近就看現在看不看得到 */ }
        }
        usable = visibleSupports();
    }
    if (usable.length === 0) {
        const far = bot.entity.position.offset(0, 1.62, 0).distanceTo(center) > REACH;
        return far
            ? { placed: false, reason: 'too_far', message: `離 (${x},${y},${z}) 太遠（${bot.entity.position.offset(0, 1.62, 0).distanceTo(center).toFixed(1)} 格，伸手最多 ${REACH} 格）而且走不過去：你現在在 (${Math.floor(bot.entity.position.x)},${Math.floor(bot.entity.position.y)},${Math.floor(bot.entity.position.z)})，路被擋住了（可能被自己蓋的牆圍住）${closedDoorsHint(bot, x, y, z)}` }
            : { placed: false, reason: 'blocked_view', message: `(${x},${y},${z}) 在伸手範圍內，但中間隔著方塊、看不到可以靠的那一面（不能隔牆放）；先挖開擋住的方塊，或換個位置` };
    }

    await bot.equip(item, 'hand');
    let lastError = '';
    for (const { ref, face } of usable) {
        try {
            await bot.lookAt(ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5), true);
            await bot.waitForTicks(2);
            await bot.placeBlock(ref, face);
            await bot.waitForTicks(4);
            if (blockMatches(bot.blockAt(new Vec3(x, y, z)), itemName)) {
                return { placed: true, message: `在 (${x},${y},${z}) 放了 ${itemName}`, position: { x, y, z } };
            }
        } catch (e) { lastError = e.message; }
    }
    const friendly = /blockUpdate.*did not fire|timeout/i.test(lastError) ? '伺服器沒有接受（等了 5 秒沒有回應）：常見原因是那格剛好有生物或掉落物擋著、方塊被別的東西佔了、或離太遠' : lastError;
    return { placed: false, reason: 'rejected', message: `試了 ${usable.length} 個面都放不上去${friendly ? '（' + friendly + '）' : ''}` };
}

/**
 * 在附近找個地方放一個方塊（工作台、熔爐、箱子）。附近沒有空位就挖開旁邊的牆做出空位。
 * @returns {{placed: boolean, position?: object, madeSpace?: boolean, message?: string}}
 */
async function placeBlockNear(ctx, itemName) {
    const { bot, mcData } = ctx;
    const feet = bot.entity.position.floored();

    const candidates = () => {
        const out = [];
        for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -1; dy <= 2; dy++) {
            const x = feet.x + dx, y = feet.y + dy, z = feet.z + dz;
            const b = bot.blockAt(new Vec3(x, y, z));
            if (!isAirLike(b)) continue;
            if (overlapsBot(bot, x, y, z)) continue;
            // 不擋住自己的路：腳和頭那兩格、自己正前後的格子盡量不放（排在後面）
            const supports = supportsFor(bot, x, y, z).filter(({ ref, face }) => canSeeFace(bot, ref, face));
            if (supports.length === 0) continue;       // 看不到任何可以靠的面（隔著牆）就不考慮
            const hasFloor = supports.some(s => s.face.y === 1);
            const dist = Math.hypot(dx, dz) + Math.abs(dy) * 1.5;
            out.push({ x, y, z, score: dist + (hasFloor ? 0 : 2) + (dy < 0 ? 1 : 0) });
        }
        return out.sort((a, b) => a.score - b.score);
    };

    for (const c of candidates().slice(0, 8)) {
        const r = await placeBlockAt(ctx, itemName, c.x, c.y, c.z);
        if (r.placed) return { placed: true, position: r.position, message: r.message };
    }

    // 沒有空位：挖開旁邊一塊牆（優先挑不是礦石、不是水旁邊的），做出一格空位再放
    const walls = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const b = bot.blockAt(feet.offset(dx, 0, dz));
        if (!b || b.boundingBox !== 'block' || b.name === 'bedrock') continue;
        const ore = b.name.endsWith('_ore') || b.name === 'ancient_debris';
        walls.push({ block: b, ore });
    }
    walls.sort((a, b) => Number(a.ore) - Number(b.ore));
    for (const { block } of walls) {
        const choice = selectTool(bot, mcData, block);
        if (!choice.canHarvest || !bot.canDigBlock(block)) continue;
        try {
            await equipFor(bot, choice.tool);
            await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
            await bot.dig(block);
            await bot.waitForTicks(6);
        } catch (_) { continue; }
        const r = await placeBlockAt(ctx, itemName, block.position.x, block.position.y, block.position.z);
        if (r.placed) return { placed: true, madeSpace: true, position: r.position, message: `旁邊沒有空位，挖開了一塊 ${block.name} 做出空位，${r.message}` };
    }

    return {
        placed: false,
        message: `附近沒有可以放 ${itemName} 的空位，旁邊的牆也挖不開（工具不夠或是基岩）。需要至少一格空位：可以先 dig 挖開一塊牆，或用 place_block 指定座標`,
    };
}

module.exports = { placeBlockAt, placeBlockNear };
