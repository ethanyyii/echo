// ════════════════════════════════════════════════════════
//  src/agent/events.js — 事件緩衝區
//  反射層、聊天、動作結果等事件寫進這裡，外部大腦透過 GET /events 讀取。
// ════════════════════════════════════════════════════════
'use strict';

const MAX_EVENTS = 500;

const buffer = [];
let nextId = 1;

function pushEvent(type, data = {}) {
    // 流水號與型別放在資料「後面」：呼叫端傳進來的欄位（例如動作的 id）不能蓋掉事件自己的 id，
    // 否則 ?since= 的過濾會把之後的事件全部漏掉。
    const event = { ...data, id: nextId++, t: Date.now(), type };
    buffer.push(event);
    if (buffer.length > MAX_EVENTS) buffer.shift();
    return event;
}

function getEventsSince(sinceId = 0, limit = 100) {
    const out = [];
    for (const e of buffer) {
        if (e.id > sinceId) out.push(e);
        if (out.length >= limit) break;
    }
    return out;
}

function latestEventId() {
    return nextId - 1;
}

module.exports = { pushEvent, getEventsSince, latestEventId };
