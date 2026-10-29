// ════════════════════════════════════════════════════════
//  src/agent/observation.js — 結構化觀察與狀態快照
//  只讀取 bot / state，不修改任何狀態。
//  perception.js（文字感知）簽名不動；它會清除 state.systemFeedback，
//  所以這裡呼叫它時會先存後還。
// ════════════════════════════════════════════════════════
'use strict';

const getCurrentPerception = require('../perception');
const { facingName, lightAt, skyLightAt, solidAboveCount, isUnderground, torchNearby, isTool } = require('../actions/tools');

const HOSTILE_MOBS = new Set(['zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray',
    'bogged', 'creeper', 'spider', 'cave_spider', 'slime', 'magma_cube', 'witch', 'phantom',
    'silverfish', 'endermite', 'ghast', 'blaze', 'wither_skeleton', 'piglin', 'piglin_brute',
    'hoglin', 'zoglin', 'ravager', 'vindicator', 'evoker', 'pillager', 'vex', 'shulker',
    'guardian', 'elder_guardian', 'warden']);

const HIGH_DANGER_MOBS = new Set(['warden', 'wither_skeleton', 'ender_dragon', 'wither', 'ravager',
    'piglin_brute', 'elder_guardian', 'evoker']);

const NEARBY_BLOCK_RADIUS = 5;
const ENTITY_RADIUS       = 24;
const RESOURCE_RADIUS     = 32;
const MAX_ENTITIES        = 20;

// 礦石每一種各列最近一個（以前所有礦合成一類，只列最近的一個，深處的鑽石要靠 find 才看得到）
const ORE_TYPES = ['coal', 'iron', 'copper', 'gold', 'redstone', 'lapis', 'diamond', 'emerald'];

// 資源類別 → 方塊名稱判定，快取每個 mcData 的 id 清單
const RESOURCE_CATEGORIES = {
    log:             n => n.endsWith('_log') || n.endsWith('_stem'),
    ...Object.fromEntries(ORE_TYPES.map(t => [`${t}_ore`, n => n === `${t}_ore` || n === `deepslate_${t}_ore`])),
    other_ore:       n => (n.endsWith('_ore') && !ORE_TYPES.some(t => n === `${t}_ore` || n === `deepslate_${t}_ore`)) || n === 'ancient_debris',
    stone:           n => n === 'stone' || n === 'cobblestone' || n === 'deepslate',
    water:           n => n === 'water',
    lava:            n => n === 'lava',
    crafting_table:  n => n === 'crafting_table',
    furnace:         n => n === 'furnace' || n === 'blast_furnace',
    chest:           n => n === 'chest' || n === 'barrel',
};

const categoryIdCache = new WeakMap();

function getCategoryIds(mcData) {
    let cached = categoryIdCache.get(mcData);
    if (cached) return cached;
    cached = {};
    for (const [cat, pred] of Object.entries(RESOURCE_CATEGORIES)) {
        cached[cat] = mcData.blocksArray.filter(b => pred(b.name)).map(b => b.id);
    }
    categoryIdCache.set(mcData, cached);
    return cached;
}

function round1(n) { return Math.round(n * 10) / 10; }

function inventoryCounts(bot) {
    const counts = {};
    for (const item of bot.inventory.items()) {
        counts[item.name] = (counts[item.name] || 0) + item.count;
    }
    return counts;
}

function heldItemInfo(bot) {
    const slot = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
    if (!slot) return null;
    const info = { name: slot.name, count: slot.count };
    if (slot.maxDurability != null && slot.durabilityUsed != null) {
        info.durabilityLeft = slot.maxDurability - slot.durabilityUsed;
        info.durabilityMax = slot.maxDurability;
    }
    return info;
}

/**
 * 動作前後比對用的輕量快照。
 */
function takeSnapshot(bot, state) {
    const p = bot.entity ? bot.entity.position : null;
    return {
        t: Date.now(),
        pos: p ? { x: p.x, y: p.y, z: p.z } : null,
        health: bot.health,
        food: bot.food,
        mode: state.currentMovementMode,
        held: bot.entity ? (heldItemInfo(bot)?.name || null) : null,
        inventory: bot.entity ? inventoryCounts(bot) : {},
        tools: bot.entity ? toolDurabilities(bot) : {},
    };
}

// 背包裡每種工具目前的耐久（同名多把取最低）：{ iron_pickaxe: {left, max} }
function toolDurabilities(bot) {
    const out = {};
    for (const item of bot.inventory.items()) {
        if (!isTool(item) || item.maxDurability == null || item.durabilityUsed == null) continue;
        const left = item.maxDurability - item.durabilityUsed;
        if (!out[item.name] || left < out[item.name].left) out[item.name] = { left, max: item.maxDurability };
    }
    return out;
}

/**
 * 失敗分析用的周圍環境快照（寫進軌跡，以後卡住不用靠推測）：
 * 腳下、頭上、面向前方的方塊，附近 3 格最近的液體，頭上實心格數。
 */
function surroundings(bot) {
    if (!bot.entity) return null;
    const base = bot.entity.position.floored();
    const name = (v) => { const b = bot.blockAt(v); return b ? b.name : 'unloaded'; };
    const yaw = bot.entity.yaw;
    const fx = Math.round(-Math.sin(yaw)), fz = Math.round(-Math.cos(yaw));
    let liquid = null;
    for (let dx = -3; dx <= 3; dx++) {
        for (let dy = -3; dy <= 3; dy++) {
            for (let dz = -3; dz <= 3; dz++) {
                const b = bot.blockAt(base.offset(dx, dy, dz));
                if (!b || (b.name !== 'water' && b.name !== 'lava')) continue;
                const d = Math.hypot(dx, dy, dz);
                if (!liquid || d < liquid.dist) liquid = { name: b.name, dist: round1(d), at: [b.position.x, b.position.y, b.position.z] };
            }
        }
    }
    return {
        blockPos: [base.x, base.y, base.z],
        facing: facingName(yaw),
        feet: name(base),
        below: name(base.offset(0, -1, 0)),
        below2: name(base.offset(0, -2, 0)),
        head: name(base.offset(0, 1, 0)),
        above: name(base.offset(0, 2, 0)),
        aheadFeet: name(base.offset(fx, 0, fz)),
        aheadHead: name(base.offset(fx, 1, fz)),
        aheadBelow: name(base.offset(fx, -1, fz)),
        liquidWithin3: liquid,
        solidAbove: solidAboveCount(bot),
    };
}

function scanNearbyBlocks(bot) {
    const origin = bot.entity.position.floored();
    const summary = {};
    const r = NEARBY_BLOCK_RADIUS;
    for (let dx = -r; dx <= r; dx++) {
        for (let dy = -2; dy <= 3; dy++) {
            for (let dz = -r; dz <= r; dz++) {
                const block = bot.blockAt(origin.offset(dx, dy, dz));
                if (!block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') continue;
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                const s = summary[block.name];
                if (!s) summary[block.name] = { count: 1, nearest: round1(dist) };
                else { s.count++; if (dist < s.nearest) s.nearest = round1(dist); }
            }
        }
    }
    return summary;
}

function scanResources(bot, mcData) {
    const ids = getCategoryIds(mcData);
    const here = bot.entity.position;
    const out = {};
    for (const [cat, list] of Object.entries(ids)) {
        if (list.length === 0) continue;
        let found = null;
        try { found = bot.findBlock({ matching: list, maxDistance: RESOURCE_RADIUS }); } catch (_) {}
        if (found) {
            out[cat] = {
                block: found.name,
                position: { x: found.position.x, y: found.position.y, z: found.position.z },
                distance: round1(found.position.distanceTo(here)),
            };
        }
    }
    return out;
}

function scanEntities(bot) {
    const here = bot.entity.position;
    const list = [];
    for (const e of Object.values(bot.entities)) {
        if (e === bot.entity || !e.position) continue;
        const dist = e.position.distanceTo(here);
        if (dist > ENTITY_RADIUS) continue;
        const name = e.type === 'player' ? e.username : (e.name || e.displayName || 'unknown');
        const lower = String(name).toLowerCase();
        let droppedItem = null;
        if (lower === 'item') {
            try { const it = e.getDroppedItem && e.getDroppedItem(); if (it) droppedItem = { name: it.name, count: it.count }; } catch (_) {}
        }
        list.push({
            id: e.id,
            name,
            ...(droppedItem ? { item: droppedItem } : {}),
            type: e.type,
            distance: round1(dist),
            // 方塊座標（floor），和 /block、/find、/map 用同一套；以前用四捨五入，會和方塊座標差 1
            position: { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) },
            hostile: HOSTILE_MOBS.has(lower),
            highDanger: HIGH_DANGER_MOBS.has(lower),
        });
    }
    list.sort((a, b) => a.distance - b.distance);
    return list.slice(0, MAX_ENTITIES);
}

function scanHazards(bot) {
    const pos = bot.entity.position;
    const hazards = [];
    for (let dy = -2; dy >= -6; dy--) {
        const b = bot.blockAt(pos.offset(0, dy, 0));
        if (!b) break;
        if (b.name === 'lava') { hazards.push(`lava_below_${Math.abs(dy)}`); break; }
        if (b.name !== 'air' && b.name !== 'cave_air') break;
        if (dy === -6) hazards.push('drop_5_or_more_below');
    }
    for (const [dx, dz, dir] of [[0, -1, 'north'], [0, 1, 'south'], [1, 0, 'east'], [-1, 0, 'west']]) {
        const b = bot.blockAt(pos.offset(dx, 0, dz));
        if (b && b.name === 'lava') hazards.push(`lava_${dir}`);
    }
    const feet = bot.blockAt(pos);
    const head = bot.blockAt(pos.offset(0, 1, 0));
    if ((feet && feet.name === 'lava') || (head && head.name === 'lava')) hazards.push('in_lava');
    // 只有頭真的泡在水裡才算缺氧危險；上岸後氣量還在回升的幾秒不算（玩家兩輪都遇到地表假警報）
    const headWet = !!(head && (head.name === 'water' || head.name === 'bubble_column'));
    if (headWet && bot.oxygenLevel != null && bot.oxygenLevel < 10) hazards.push('low_oxygen');
    return hazards;
}

function equipmentInfo(bot) {
    const out = {};
    const slots = { head: 5, chest: 6, legs: 7, feet: 8, offhand: 45 };
    for (const [label, idx] of Object.entries(slots)) {
        const it = bot.inventory.slots[idx];
        if (it) out[label] = it.name;
    }
    return out;
}

/**
 * 完整結構化觀察。
 * @param {object} ctx - { bot, state, mcData, MASTER_NAME }
 * @param {{perception?: boolean}} opts
 */
function observe(ctx, opts = {}) {
    const { bot, state, mcData, MASTER_NAME } = ctx;
    if (!bot.entity) return { ready: false };

    const pos = bot.entity.position;
    const feet = bot.blockAt(pos);
    const head = bot.blockAt(pos.offset(0, 1, 0));
    const below = bot.blockAt(pos.offset(0, -1, 0));
    const tod = bot.time.timeOfDay;

    let biome = null;
    try { biome = mcData.biomes[bot.world.getBiome(pos)]?.name || null; } catch (_) {}

    const entities = scanEntities(bot);
    const master = MASTER_NAME ? entities.find(e => e.type === 'player' && e.name === MASTER_NAME) : null;

    const obs = {
        ready: true,
        t: Date.now(),
        self: {
            position: { x: round1(pos.x), y: round1(pos.y), z: round1(pos.z) },
            dimension: bot.game.dimension,
            biome,
            health: bot.health,
            food: bot.food,
            oxygen: bot.oxygenLevel ?? null,
            inWater: !!((feet && feet.name === 'water') || (head && head.name === 'water')),
            feetInWater: !!(feet && feet.name === 'water'),
            headInWater: !!(head && head.name === 'water'),
            waterSeconds: state.waterSince ? Math.round((Date.now() - state.waterSince) / 1000) : 0,
            inBubbleColumn: !!((feet && feet.name === 'bubble_column') || (head && head.name === 'bubble_column')),
            // 封閉空間資訊：頭上有幾格實心方塊擋著（0 = 上面是開放的）、是不是在地底、天空光
            enclosure: {
                solidAbove: solidAboveCount(bot, 40),
                underground: solidAboveCount(bot, 12) >= 2,     // 以頭上實心格數為準；天空光在樹冠下也會很低，不能拿來判斷地底
                skyLight: skyLightAt(bot, pos.floored()),
            },
            onGround: bot.entity.onGround,
            // blockPos 是「站著的那一格」的整數座標，和 /block、/map、/find 用的是同一套；position 是精確的小數座標
            // 站的這一格的方塊光照（火把等人造光，0–15）；查不到是 null。地底沒有火把通常是 0，怪物在 0 時才會生成
            lightLevel: lightAt(bot, pos.floored()),
            // 光照數字來自伺服器封包，區塊載入後被改動的地方（挖開、放火把）不一定會更新；torchNearby 是用方塊本身判斷的，比較可靠
            torchNearby: torchNearby(bot, 6),
            torchesInInventory: bot.inventory.items().filter(i => i.name === 'torch').reduce((n, i) => n + i.count, 0),
            blockPos: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
            facing: facingName(bot.entity.yaw),   // north(-Z) / south(+Z) / east(+X) / west(-X)
            blockAbove: (bot.blockAt(pos.offset(0, 2, 0)) || {}).name || null,
            blockAhead: (bot.blockAt(pos.offset(-Math.round(Math.sin(bot.entity.yaw)), 0, -Math.round(Math.cos(bot.entity.yaw)))) || {}).name || null,
            blockAheadHead: (bot.blockAt(pos.offset(-Math.round(Math.sin(bot.entity.yaw)), 1, -Math.round(Math.cos(bot.entity.yaw)))) || {}).name || null,
            yaw: Math.round(bot.entity.yaw * 100) / 100,
            pitch: Math.round(bot.entity.pitch * 100) / 100,
            blockBelow: below ? below.name : null,
            mode: state.currentMovementMode,
            busyWithBackgroundTask: state.currentMovementMode !== 'idle',
            held: heldItemInfo(bot),
            equipment: equipmentInfo(bot),
        },
        world: {
            timeOfDay: tod,
            isNight: tod >= 13000 && tod < 23000,
            raining: !!bot.isRaining,
        },
        inventory: inventoryCounts(bot),
        // 背包裡的工具與剩餘耐久（durabilityLeft 是還能用幾次，durabilityMax 是全新時的總次數）
        tools: bot.inventory.items().filter(isTool).map(i => ({
            name: i.name,
            held: !!(bot.heldItem && i.slot === bot.heldItem.slot),
            durabilityLeft: i.maxDurability != null && i.durabilityUsed != null ? i.maxDurability - i.durabilityUsed : null,
            durabilityMax: i.maxDurability != null ? i.maxDurability : null,
        })),
        inventorySlotsUsed: bot.inventory.items().length,
        nearbyBlocks: scanNearbyBlocks(bot),
        resources: scanResources(bot, mcData),
        entities,
        master: MASTER_NAME ? {
            name: MASTER_NAME,
            online: !!bot.players[MASTER_NAME],
            nearby: !!master,
            distance: master ? master.distance : null,
        } : null,
        hazards: scanHazards(bot),
        feedback: state.systemFeedback || '',
    };

    if (opts.perception) {
        const savedFeedback = state.systemFeedback;
        try { obs.perceptionText = getCurrentPerception(bot, state, mcData); }
        finally { state.systemFeedback = savedFeedback; }
    }
    return obs;
}

// ════════════════════════════════════════════════════════
//  文字地圖：讓只看文字的模型也能「看到」周圍地形
// ════════════════════════════════════════════════════════
const MAP_LEGEND = {
    '@': '自己', '.': '空氣', '~': '水', '!': '岩漿', 'g': '草地', 'd': '泥土', 's': '石頭類', 'c': '鵝卵石', 'n': '沙/砂岩',
    'v': '礫石', 'T': '原木', 'l': '樹葉', 'p': '木板', 'k': '煤礦', 'I': '鐵礦', 'u': '銅礦', 'G': '金礦', 'R': '紅石礦', 'L': '青金石礦', 'M': '鑽石礦', 'E': '綠寶石礦', 'O': '其他礦石', 'C': '工作台', 'F': '熔爐', 'H': '箱子/木桶', 'i': '火把',
    'w': '雪', 'x': '冰', 'B': '基岩', 'b': '床', 'D': '門', '#': '其他實心方塊', '+': '其他非實心方塊（花草等）',
    'Z': '敵對生物', 'm': '其他生物', 'P': '玩家', '*': '掉落物', '?': '尚未載入',
};

function blockChar(block) {
    if (!block) return '?';
    const n = block.name;
    if (n === 'air' || n === 'cave_air' || n === 'void_air') return '.';
    if (n === 'water' || n === 'bubble_column') return '~';
    if (n === 'lava') return '!';
    if (n === 'grass_block') return 'g';
    if (['dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mud', 'dirt_path', 'farmland'].includes(n)) return 'd';
    if (n === 'cobblestone' || n === 'mossy_cobblestone') return 'c';
    if (['stone', 'deepslate', 'andesite', 'granite', 'diorite', 'tuff', 'netherrack', 'end_stone', 'blackstone'].includes(n)) return 's';
    if (n === 'sand' || n === 'red_sand' || n === 'sandstone') return 'n';
    if (n === 'gravel') return 'v';
    if (n.endsWith('_log') || n.endsWith('_stem') || n.endsWith('_wood')) return 'T';
    if (n.endsWith('_leaves')) return 'l';
    if (n.endsWith('_planks')) return 'p';
    if (n.endsWith('_ore') || n === 'ancient_debris') {
        if (n.includes('coal')) return 'k';
        if (n.includes('iron')) return 'I';
        if (n.includes('copper')) return 'u';
        if (n.includes('gold')) return 'G';
        if (n.includes('redstone')) return 'R';
        if (n.includes('lapis')) return 'L';
        if (n.includes('diamond')) return 'M';
        if (n.includes('emerald')) return 'E';
        return 'O';
    }
    if (n === 'crafting_table') return 'C';
    if (n === 'furnace' || n === 'blast_furnace' || n === 'smoker') return 'F';
    if (n === 'chest' || n === 'barrel' || n === 'trapped_chest' || n === 'ender_chest') return 'H';
    if (n === 'torch' || n === 'wall_torch' || n === 'soul_torch') return 'i';
    if (n === 'snow' || n === 'snow_block' || n === 'powder_snow') return 'w';
    if (n.includes('ice')) return 'x';
    if (n === 'bedrock') return 'B';
    if (n.endsWith('_bed')) return 'b';
    if (n.endsWith('_door') || n.endsWith('_trapdoor')) return 'D';
    return block.boundingBox === 'block' ? '#' : '+';
}

// 相對高度：0-9 往上，a-i 往下（a = -1），超出範圍 *
function heightChar(dyBlock) {
    if (dyBlock >= 0) return dyBlock <= 9 ? String(dyBlock) : '*';
    return dyBlock >= -9 ? String.fromCharCode('a'.charCodeAt(0) + (-dyBlock - 1)) : '*';
}

/**
 * 以機器人為中心的文字地圖。
 *   mode=layer：第 (自己 Y + dy) 層的水平切片
 *   mode=top：俯視，每格顯示最上層的非空氣方塊
 * 北在上（z 減少），東在右（x 增加）。heights=true 時另附高度圖。
 */
function mapView(ctx, opts = {}) {
    const { bot } = ctx;
    if (!bot.entity) return { ready: false };
    const radius = Math.max(1, Math.min(parseInt(opts.radius, 10) || 8, 20));
    const mode = opts.mode === 'top' ? 'top' : (opts.mode === 'slice' ? 'slice' : 'layer');
    const axis = opts.axis === 'z' ? 'z' : 'x';
    const dy = parseInt(opts.dy, 10) || 0;
    const origin = bot.entity.position.floored();

    const marks = new Map();
    for (const e of Object.values(bot.entities)) {
        if (e === bot.entity || !e.position) continue;
        const ex = Math.floor(e.position.x), ez = Math.floor(e.position.z);
        if (Math.abs(ex - origin.x) > radius || Math.abs(ez - origin.z) > radius) continue;
        if (Math.abs(e.position.y - origin.y) > 3) continue;
        const name = String(e.type === 'player' ? 'player' : (e.name || '')).toLowerCase();
        const ch = e.type === 'player' ? 'P' : name === 'item' ? '*' : HOSTILE_MOBS.has(name) ? 'Z' : 'm';
        const key = `${ex},${ez}`;
        if (!marks.has(key) || ch === 'Z') marks.set(key, ch);
    }

    // 垂直切面：以自己為中心的直立剖面。axis=x → 固定 z，橫軸是 x（西→東）；axis=z → 固定 x，橫軸是 z（北→南）。縱軸 y 由上到下。
    if (mode === 'slice') {
        const Vec3 = require('vec3');
        const sliceRows = [];
        for (let yy = origin.y + radius; yy >= origin.y - radius; yy--) {
            let line = '';
            for (let h = -radius; h <= radius; h++) {
                if (h === 0 && yy === origin.y) { line += '@'; continue; }
                const bx = axis === 'x' ? origin.x + h : origin.x;
                const bz = axis === 'x' ? origin.z : origin.z + h;
                line += blockChar(bot.blockAt(new Vec3(bx, yy, bz)));
            }
            sliceRows.push(line);
        }
        return {
            ready: true, origin: { x: origin.x, y: origin.y, z: origin.z }, radius, mode, axis,
            yRange: [origin.y + radius, origin.y - radius],
            hRange: axis === 'x' ? [origin.x - radius, origin.x + radius] : [origin.z - radius, origin.z + radius],
            note: '垂直切面：每一列是一個 Y（最上面一列 Y=' + (origin.y + radius) + '，往下遞減），橫軸是 ' + (axis === 'x' ? 'X（西→東）' : 'Z（北→南）'),
            rows: sliceRows,
            legend: MAP_LEGEND,
        };
    }

    // 俯視在地底時，從頭頂附近開始往下看，不然會一路看穿岩層、顯示地表，讓人以為自己在地面
    const buried = solidAboveCount(bot, 12) >= 2;
    const topScanFrom = buried ? 2 : 16;

    const rows = [];
    const heightRows = [];
    for (let z = origin.z - radius; z <= origin.z + radius; z++) {
        let line = '', hline = '';
        for (let x = origin.x - radius; x <= origin.x + radius; x++) {
            if (x === origin.x && z === origin.z) { line += '@'; hline += '@'; continue; }
            let ch, h = '.';
            if (mode === 'layer') {
                ch = blockChar(bot.blockAt(origin.offset(x - origin.x, dy, z - origin.z)));
            } else {
                ch = '?';
                for (let y = origin.y + topScanFrom; y >= origin.y - 24; y--) {
                    const b = bot.blockAt(origin.offset(x - origin.x, y - origin.y, z - origin.z));
                    if (!b) continue;
                    if (b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') {
                        ch = blockChar(b);
                        h = heightChar(y - origin.y);
                        break;
                    }
                    ch = '.';
                }
            }
            line += marks.get(`${x},${z}`) || ch;
            hline += h;
        }
        rows.push(line);
        heightRows.push(hline);
    }

    return {
        ready: true,
        origin: { x: origin.x, y: origin.y, z: origin.z },
        radius, mode, dy,
        xRange: [origin.x - radius, origin.x + radius],
        zRange: [origin.z - radius, origin.z + radius],
        note: '北在上（z 減少），東在右（x 增加）；每個字元是一格方塊' + (mode === 'top' && buried ? '。你在地底（頭上有岩層），這張俯視圖只顯示頭頂附近以下的結構，不是地表' : ''),
        rows,
        ...(opts.heights ? { heightRows, heightNote: '右邊的高度圖（俯視時才有）：每格那個方塊相對你的腳（所在方塊）的高度——數字 0～9 = 比腳高 0～9 格（0 = 和腳同高，會擋路）；字母 a～i = 比腳低 1～9 格（a = 低 1 格，平地通常是 a）；* = 差超過 9 格；@ = 你自己' } : {}),
        legend: MAP_LEGEND,
    };
}

/**
 * 找出附近所有符合名稱（子字串）的方塊座標，由近到遠。
 */
function findBlocksNear(ctx, opts = {}) {
    const { bot } = ctx;
    if (!bot.entity) return { ready: false };
    const name = String(opts.name || '').toLowerCase().trim();
    if (!name) return { error: 'name 必填' };
    const radius = Math.max(1, Math.min(parseInt(opts.radius, 10) || 32, 64));
    const count = Math.max(1, Math.min(parseInt(opts.count, 10) || 20, 100));
    const here = bot.entity.position;
    const positions = bot.findBlocks({
        matching: b => b && b.name && b.name.includes(name),
        maxDistance: radius,
        count,
    });
    const blocks = positions.map(p => {
        const b = bot.blockAt(p);
        return { name: b ? b.name : null, x: p.x, y: p.y, z: p.z, distance: round1(p.distanceTo(here)) };
    }).sort((a, b) => a.distance - b.distance);
    return { ready: true, query: name, radius, found: blocks.length, blocks };
}

function blockAtPos(ctx, x, y, z) {
    const { bot } = ctx;
    if (!bot.entity) return { ready: false };
    const b = bot.blockAt(new (require('vec3'))(x, y, z));
    if (!b) return { x, y, z, loaded: false };
    return { x, y, z, loaded: true, name: b.name, solid: b.boundingBox === 'block', diggable: bot.canDigBlock(b) };
}

module.exports = { observe, mapView, findBlocksNear, blockAtPos, takeSnapshot, surroundings, inventoryCounts, HOSTILE_MOBS, HIGH_DANGER_MOBS };
