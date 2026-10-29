// ════════════════════════════════════════════════════════
//  src/agent/verifier.js — 以遊戲世界真實狀態判定動作成功與否
//  成功與否不取決於動作模組印出的訊息，而是比對動作前後的世界狀態。
//  動作模組自己寫的 systemFeedback 只當作補充說明，不當判定依據。
// ════════════════════════════════════════════════════════
'use strict';

const { findDroppedItems, facingName, solidAboveCount } = require('../actions/tools');

const NEAR_DIST = 3.5;

function gains(before, after) {
    const out = {};
    for (const name of new Set([...Object.keys(before.inventory), ...Object.keys(after.inventory)])) {
        const d = (after.inventory[name] || 0) - (before.inventory[name] || 0);
        if (d !== 0) out[name] = d;
    }
    return out;
}

function sumMatching(delta, predicate, sign) {
    let total = 0;
    for (const [name, d] of Object.entries(delta)) {
        if (predicate(name) && Math.sign(d) === sign) total += Math.abs(d);
    }
    return total;
}

// gather 目標可能獲得的物品名稱：目標方塊本身、其掉落物、名稱含目標字串的物品
function expectedGatherItems(target, mcData) {
    const items = new Set();
    for (const b of mcData.blocksArray) {
        if (b.name !== target && !b.name.includes(target)) continue;
        items.add(b.name);
        for (const dropId of (b.drops || [])) {
            const it = mcData.items[dropId];
            if (it) items.add(it.name);
        }
    }
    for (const it of mcData.itemsArray) if (it.name.includes(target)) items.add(it.name);
    return items;
}

function findPlayerEntity(bot, name) {
    return bot.players[name]?.entity || null;
}

function nearTarget(bot, target) {
    const here = bot.entity.position;
    const player = findPlayerEntity(bot, target);
    if (player) return { near: player.position.distanceTo(here) <= NEAR_DIST, dist: player.position.distanceTo(here) };

    let best = null;
    for (const e of Object.values(bot.entities)) {
        if (e === bot.entity || !e.name || !e.position) continue;
        if (e.name.toLowerCase() === target || e.name.toLowerCase().includes(target)) {
            const d = e.position.distanceTo(here);
            if (best === null || d < best) best = d;
        }
    }
    const block = bot.findBlock({ matching: b => b && b.name && b.name.toLowerCase().includes(target), maxDistance: 5 });
    if (block) {
        const d = block.position.offset(0.5, 0.5, 0.5).distanceTo(here);
        if (best === null || d < best) best = d;
    }
    if (best === null) return { near: false, dist: null };
    return { near: best <= NEAR_DIST + 0.5, dist: best };
}

/**
 * 動作開始前呼叫，擷取之後驗證要用的物件參照。
 */
function capture(action, ctx) {
    const { bot } = ctx;
    const extra = {};
    if (action.type === 'dig' && bot.entity) {
        // 與 builder.js 的 dig 選取方塊邏輯一致：forward 先看頭部高度，沒有再看腳部高度
        const pos = bot.entity.position;
        const yaw = bot.entity.yaw;
        let block = null;
        if (action.direction === 'forward') {
            block = bot.blockAt(pos.offset(-Math.sin(yaw), 1, -Math.cos(yaw)));
            if (!block || block.name.includes('air')) block = bot.blockAt(pos.offset(-Math.sin(yaw), 0, -Math.cos(yaw)));
        } else if (action.direction === 'up') {
            block = bot.blockAt(pos.offset(0, 2, 0));
        } else {
            block = bot.blockAt(pos.offset(0, -1, 0));
        }
        extra.digLiquid = block && (block.name === 'water' || block.name === 'lava') ? block.name : null;
        extra.digTarget = block && !block.name.includes('air') && !extra.digLiquid ? { position: block.position.clone(), name: block.name } : null;
    }
    if (action.type === 'use_block') {
        const ub = bot.blockAt(new (require('vec3'))(Math.floor(action.x), Math.floor(action.y), Math.floor(action.z)));
        try { const pr = ub ? ub.getProperties() : {}; extra.useBefore = { name: ub && ub.name, open: pr.open, powered: pr.powered }; } catch (_) { extra.useBefore = { name: ub && ub.name }; }
    }
    if (action.type === 'pickup_items' && bot.entity) {
        const radius = typeof action.radius === 'number' ? Math.min(Math.max(action.radius, 1), 32) : 12;
        extra.itemsNearby = findDroppedItems(bot, bot.entity.position, radius, action.name ? action.name.toLowerCase() : null).length;
    }
    if (action.type === 'attack' && bot.entity) {
        extra.targetEntity = bot.nearestEntity(e =>
            e.name && e.name.toLowerCase().includes(action.target.toLowerCase()) && e.type !== 'player') || null;
    }
    return extra;
}

/**
 * 判定動作是否真的達成。
 * @returns {{ok:boolean, reason:string|null, evidence:string, details?:object}}
 */
function verify(action, before, after, extra, ctx) {
    const { bot, state, mcData } = ctx;
    const delta = gains(before, after);
    const ok = (evidence, details) => ({ ok: true, reason: null, evidence, ...(details ? { details } : {}) });
    const fail = (reason, evidence, details) => ({ ok: false, reason, evidence, ...(details ? { details } : {}) });

    switch (action.type) {
        case 'gather': {
            // 伐木（target 含 log）不分樹種：要 oak_log 但附近只有 birch 時砍到 birch_log 也是砍到了，不能判成「背包沒變化」
            const isTree = String(action.target || '').toLowerCase().includes('log');
            const expected = isTree ? null : expectedGatherItems(action.target, mcData);
            const got = isTree
                ? sumMatching(delta, n => n.endsWith('_log'), 1)
                : sumMatching(delta, n => expected.has(n), 1);
            return got > 0
                ? ok('inventory_gain', { gained: got })
                : fail('no_inventory_change', 'inventory_gain');
        }
        case 'craft': {
            const made = delta[action.name] || 0;
            return made > 0
                ? ok('inventory_gain', { crafted: made })
                : fail('no_inventory_change', 'inventory_gain');
        }
        case 'smelt': {
            const IGNORE = new Set(['furnace', 'blast_furnace', 'crafting_table', 'chest']);
            const have = Object.entries(before.inventory)
                .filter(([n]) => n === action.name || n.includes(action.name)).reduce((s, [, c]) => s + c, 0);
            const wanted = Math.min(typeof action.count === 'number' ? Math.floor(action.count) : have, have, 10);
            const consumed = sumMatching(delta, n => n === action.name || n.includes(action.name), -1);
            const produced = sumMatching(delta, n => !IGNORE.has(n) && n !== action.name && n !== 'coal' && n !== 'charcoal'
                && !n.endsWith('_planks') && !n.endsWith('_log'), 1);
            if (wanted > 0 && produced >= wanted) return ok('inventory_gain', { wanted, produced });
            return fail(produced > 0 ? 'partial' : (consumed > 0 ? 'smelt_output_missing' : 'no_inventory_change'),
                'inventory_gain', { wanted, produced });
        }
        case 'store': {
            const stored = sumMatching(delta, n => n === action.name || n.includes(action.name), -1);
            return stored > 0
                ? ok('inventory_loss', { stored })
                : fail('no_inventory_change', 'inventory_loss');
        }
        case 'fetch': {
            const got = sumMatching(delta, n => n === action.name || n.includes(action.name), 1);
            return got > 0
                ? ok('inventory_gain', { fetched: got })
                : fail('no_inventory_change', 'inventory_gain');
        }
        case 'place_block': {
            const b = bot.blockAt(new (require('vec3'))(Math.floor(action.x), Math.floor(action.y), Math.floor(action.z)));
            const want = String(action.block).toLowerCase();
            const there = b && (want.includes('torch') ? b.name.includes('torch') : b.name === want);
            return there ? ok('block', { at: b.name }) : fail('nothing_placed', 'block', { found: b ? b.name : null });
        }
        case 'use_block': {
            const ub = bot.blockAt(new (require('vec3'))(Math.floor(action.x), Math.floor(action.y), Math.floor(action.z)));
            const bf = extra.useBefore || {};
            let af = {};
            try { const pr = ub ? ub.getProperties() : {}; af = { open: pr.open, powered: pr.powered }; } catch (_) {}
            const changed = String(af.open) !== String(bf.open) || String(af.powered) !== String(bf.powered);
            return changed ? ok('block_state', { before: bf.open ?? bf.powered, after: af.open ?? af.powered }) : fail('no_state_change', 'block_state', { block: ub ? ub.name : null });
        }
        case 'place_torch': {
            return sumMatching(delta, n => n === 'torch' || n === 'soul_torch', -1) > 0
                ? ok('inventory_loss')
                : fail('nothing_placed', 'inventory_loss');
        }
        case 'pillar': {
            const want = typeof action.height === 'number' && action.height > 0 ? action.height : 2;
            const dy = after.pos.y - before.pos.y;
            return dy >= want - 0.5
                ? ok('position', { rose: Math.round(dy * 10) / 10 })
                : fail(dy >= 1 ? 'partial' : 'did_not_rise', 'position', { rose: Math.round(dy * 10) / 10, wanted: want });
        }
        case 'dig': {
            if (extra.digLiquid) return fail('target_is_liquid', 'block', { block: extra.digLiquid });
            if (!extra.digTarget) return fail('nothing_to_dig', 'block');
            const now = bot.blockAt(extra.digTarget.position);
            return now && now.name !== extra.digTarget.name
                ? ok('block_changed', { was: extra.digTarget.name, now: now.name })
                : fail('block_still_there', 'block', { block: extra.digTarget.name });
        }
        case 'staircase': {
            const dropped = before.pos.y - after.pos.y;
            if (typeof action.targetY === 'number') {
                const reached = Math.floor(after.pos.y) <= Math.max(action.targetY, -60);
                return reached
                    ? ok('position', { descended: Math.round(dropped) })
                    : fail(dropped >= 1 ? 'partial' : 'did_not_descend', 'position', { descended: Math.round(dropped), targetY: action.targetY });
            }
            const want = typeof action.steps === 'number' ? action.steps : 10;
            return dropped >= want - 1
                ? ok('position', { descended: Math.round(dropped) })
                : fail(dropped >= 1 ? 'partial' : 'did_not_descend', 'position', { descended: Math.round(dropped), wanted: want });
        }
        case 'attack': {
            // attack 是「開始戰鬥就回報」：目標找得到、身體進入戰鬥模式就算成功；打完（擊殺／中斷）由 attack_ended 事件通知
            const target = extra.targetEntity;
            if (!target) return fail('target_not_found', 'entity');
            if (target.isValid === false) return ok('entity_invalid');
            return state.currentMovementMode === 'attack'
                ? ok('attack_started')
                : fail('attack_not_started', 'mode');
        }
        case 'approach': {
            const r = nearTarget(bot, action.target);
            return r.near
                ? ok('distance', { distance: Math.round(r.dist * 10) / 10 })
                : fail(r.dist === null ? 'target_not_found' : 'target_not_reached', 'distance',
                    r.dist === null ? undefined : { distance: Math.round(r.dist * 10) / 10 });
        }
        case 'tunnel_to': {
            const range = typeof action.range === 'number' ? Math.max(0, action.range) : 0;
            const here = bot.entity.position.floored();
            const d = Math.hypot(Math.floor(action.x) - here.x, Math.floor(action.y) - here.y, Math.floor(action.z) - here.z);
            return d <= Math.max(range, 1.5)
                ? ok('distance', { distance: Math.round(d * 10) / 10 })
                : fail(d < 8 ? 'partial' : 'target_not_reached', 'distance', { remaining: Math.round(d * 10) / 10 });
        }
        case 'goto': {
            const range = typeof action.range === 'number' ? Math.max(0, action.range) : 1;
            const d = bot.entity.position.distanceTo(new (require('vec3'))(Math.floor(action.x) + 0.5, Math.floor(action.y), Math.floor(action.z) + 0.5));
            // range=0 的意思是「站在那一格」：人的所在方塊必須就是目標那一格（高度差 ≤1），距離 1 格不算
            const pos = bot.entity.position;
            const inCell = Math.floor(pos.x) === Math.floor(action.x) && Math.floor(pos.z) === Math.floor(action.z)
                && Math.abs(Math.floor(pos.y + 0.2) - Math.floor(action.y)) <= 1;
            const reached = range > 0 ? d <= range + 1.0 : inCell;
            return reached
                ? ok('distance', { distance: Math.round(d * 10) / 10 })
                : fail('target_not_reached', 'distance', { distance: Math.round(d * 10) / 10, range });
        }
        case 'face': {
            const dir = String(action.direction).toLowerCase();
            if (dir === 'up') return bot.entity.pitch < -1.0 ? ok('pitch') : fail('did_not_turn', 'pitch');
            if (dir === 'down') return bot.entity.pitch > 1.0 ? ok('pitch') : fail('did_not_turn', 'pitch');
            return facingName(bot.entity.yaw) === dir ? ok('yaw', { facing: dir }) : fail('did_not_turn', 'yaw', { facing: facingName(bot.entity.yaw), wanted: dir });
        }
        case 'follow': {
            const name = action.target || ctx.MASTER_NAME;
            return state.currentMovementMode === 'follow' && findPlayerEntity(bot, name)
                ? ok('mode')
                : fail('target_not_found', 'mode');
        }
        case 'wander':
            return state.currentMovementMode === 'wander' ? ok('mode') : fail('did_not_start', 'mode');
        case 'dive':
            return state.isDiving ? ok('state') : fail('did_not_start', 'state');
        case 'surface': {
            const feet = bot.blockAt(bot.entity.position);
            const head = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            const wet = [feet, head].some(b => b && (b.name === 'water' || b.name === 'bubble_column'));
            if (wet) return fail('still_in_water', 'block');
            // 離開水不代表脫困：頭上還壓著好幾格岩層，代表還困在地底
            const buried = solidAboveCount(bot, 12);
            return buried >= 2 ? fail('still_underground', 'enclosure', { solidAbove: buried }) : ok('block');
        }
        case 'stop':
            return state.currentMovementMode === 'idle' ? ok('mode') : fail('still_busy', 'mode');
        case 'equip': {
            const held = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
            return held && held.name.toLowerCase().includes(action.name.toLowerCase())
                ? ok('held_item')
                : fail('not_equipped', 'held_item');
        }
        case 'eat': {
            const used = sumMatching(delta, n => n.includes(action.name), -1);
            return used > 0 || after.food > before.food
                ? ok('inventory_loss_or_food')
                : fail('did_not_eat', 'inventory_loss_or_food');
        }
        case 'drop': {
            const dropped = action.name.toLowerCase() === 'all'
                ? sumMatching(delta, () => true, -1)
                : sumMatching(delta, n => n.includes(action.name.toLowerCase()), -1);
            return dropped > 0 ? ok('inventory_loss', { dropped }) : fail('no_inventory_change', 'inventory_loss');
        }
        case 'pickup_items': {
            if (extra.itemsNearby === 0) return fail('no_items_nearby', 'entities');
            const want = action.name ? action.name.toLowerCase() : null;
            const gainedAny = Object.entries(delta).some(([n, d]) => d > 0 && (!want || n.includes(want)));
            return gainedAny ? ok('inventory_gain') : fail('nothing_picked_up', 'inventory_gain');
        }
        case 'wait':
        case 'look':
        case 'jump':
        case 'say':
            return ok('none');
        default:
            return fail('no_verifier', 'none');
    }
}

module.exports = { capture, verify, gains };
