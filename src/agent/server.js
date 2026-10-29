// ════════════════════════════════════════════════════════
//  src/agent/server.js — Agent API（HTTP + JSON）
//
//  GET  /health                  存活與連線狀態
//  GET  /actions                 所有動作的 schema
//  GET  /observe[?perception=1]  結構化觀察（perception=1 附上文字感知）
//  GET  /map[?radius=8&mode=layer|top|slice&dy=0&axis=x|z&heights=1]  以自己為中心的文字地圖
//  GET  /find?block=iron_ore[&radius=32&count=20]  列出附近所有符合名稱的方塊座標（由近到遠）
//  GET  /block?x=&y=&z=          查詢指定座標的方塊
//  POST /act                    執行一個動作 {"type":"gather","target":"oak_log"}
//                                （也接受 {"action":{...}, "timeoutMs":N}）
//  POST /cancel                  中止目前動作並回到待機
//  GET  /status                  目前是否忙碌、最近一次結果
//  GET  /events?since=ID&limit=N&wait=MS   事件（wait 為長輪詢毫秒數，上限 25000）
//
//  預設只綁 127.0.0.1。設定 AGENT_TOKEN 後所有請求需帶 Authorization: Bearer <token>。
// ════════════════════════════════════════════════════════
'use strict';

const http = require('http');
const { listActions } = require('./schema');
const { observe, mapView, findBlocksNear, blockAtPos } = require('./observation');
const { getEventsSince, latestEventId } = require('./events');

const MAX_BODY_BYTES = 64 * 1024;
const MAX_WAIT_MS    = 25000;

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) { reject(new Error('body_too_large')); req.destroy(); return; }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (chunks.length === 0) { resolve({}); return; }
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (_) { reject(new Error('invalid_json')); }
        });
        req.on('error', reject);
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function startAgentServer(ctx, executor, config) {
    const { bot } = ctx;

    if (!LOOPBACK_HOSTS.has(config.AGENT_HOST) && !config.AGENT_TOKEN) {
        console.log(`🚫 [Agent API] AGENT_HOST=${config.AGENT_HOST} 不是本機位址，且未設定 AGENT_TOKEN，拒絕啟動。` +
            `請設定 AGENT_TOKEN 或改綁 127.0.0.1。`);
        return null;
    }

    const server = http.createServer(async (req, res) => {
        try {
            if (config.AGENT_TOKEN) {
                const auth = req.headers['authorization'] || '';
                if (auth !== `Bearer ${config.AGENT_TOKEN}`) {
                    sendJson(res, 401, { error: 'unauthorized' });
                    return;
                }
            }

            const url = new URL(req.url, 'http://localhost');
            const route = `${req.method} ${url.pathname}`;

            switch (route) {
                case 'GET /health':
                    sendJson(res, 200, { ok: true, spawned: !!bot.entity, username: bot.username, latestEventId: latestEventId() });
                    return;

                case 'GET /actions':
                    sendJson(res, 200, { profile: (url.searchParams && url.searchParams.get('profile')) || config.AGENT_PROFILE, actions: listActions((url.searchParams && url.searchParams.get('profile')) || config.AGENT_PROFILE) });
                    return;

                case 'GET /observe':
                    sendJson(res, 200, observe(ctx, { perception: url.searchParams.get('perception') === '1' }));
                    return;

                case 'GET /map':
                    sendJson(res, 200, mapView(ctx, {
                        radius: url.searchParams.get('radius'),
                        mode: url.searchParams.get('mode'),
                        dy: url.searchParams.get('dy'),
                        axis: url.searchParams.get('axis'),
                        heights: url.searchParams.get('heights') === '1',
                    }));
                    return;

                case 'GET /find':
                    sendJson(res, 200, findBlocksNear(ctx, {
                        name: url.searchParams.get('block'),
                        radius: url.searchParams.get('radius'),
                        count: url.searchParams.get('count'),
                    }));
                    return;

                case 'GET /block':
                    sendJson(res, 200, blockAtPos(ctx,
                        parseInt(url.searchParams.get('x'), 10),
                        parseInt(url.searchParams.get('y'), 10),
                        parseInt(url.searchParams.get('z'), 10)));
                    return;

                case 'GET /status':
                    sendJson(res, 200, executor.status());
                    return;

                case 'POST /act': {
                    const body = await readJsonBody(req);
                    const action = body.action && typeof body.action === 'object' ? body.action : body;
                    const result = await executor.run(action, { timeoutMs: body.timeoutMs, profile: body.profile || config.AGENT_PROFILE });
                    const http_status = result.status === 'rejected'
                        ? (result.reason === 'busy' ? 409 : 422)
                        : 200;
                    sendJson(res, http_status, result);
                    return;
                }

                case 'POST /cancel':
                    sendJson(res, 200, await executor.cancel());
                    return;

                case 'GET /events': {
                    const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
                    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);
                    const waitMs = Math.min(parseInt(url.searchParams.get('wait') || '0', 10) || 0, MAX_WAIT_MS);
                    const deadline = Date.now() + waitMs;
                    let events = getEventsSince(since, limit);
                    while (events.length === 0 && Date.now() < deadline && !req.destroyed) {
                        await sleep(200);
                        events = getEventsSince(since, limit);
                    }
                    sendJson(res, 200, { events, latestEventId: latestEventId() });
                    return;
                }

                default:
                    sendJson(res, 404, { error: 'not_found', route });
            }
        } catch (e) {
            if (e.message === 'invalid_json') sendJson(res, 400, { error: 'invalid_json' });
            else if (e.message === 'body_too_large') sendJson(res, 413, { error: 'body_too_large' });
            else {
                console.log('⚠️ [Agent API] 處理請求時發生例外:', e.message);
                sendJson(res, 500, { error: 'internal_error', message: e.message });
            }
        }
    });

    server.on('error', (e) => console.log('🔥 [Agent API] 伺服器錯誤:', e.message));
    server.listen(config.AGENT_PORT, config.AGENT_HOST, () => {
        console.log(`🌐 [Agent API] 已啟動 http://${config.AGENT_HOST}:${config.AGENT_PORT}` +
            (config.AGENT_TOKEN ? '（需要 Bearer token）' : '（無 token，僅限本機使用）'));
    });
    return server;
}

module.exports = startAgentServer;
