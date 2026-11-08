import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MailboxStore } from '../src/comms/mailbox-store.js';

const ROOT = path.resolve(process.env.AGENT_STATE_DIR ?? '.agent-state');
const PORT = Number(process.env.DASHBOARD_PORT ?? 8787);
const HOST = process.env.DASHBOARD_HOST ?? '127.0.0.1';
const HUMAN_NAME = process.env.DASHBOARD_HUMAN_NAME ?? 'Jayyy69';
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dashboard');
const NAME = /^[A-Za-z0-9_]{1,16}$/;
const MIME = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function json(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
}

function agentNames() {
    if (!existsSync(ROOT)) return [];
    return readdirSync(ROOT, { withFileTypes: true })
        .filter(
            entry =>
                entry.isDirectory() &&
                entry.name !== HUMAN_NAME &&
                NAME.test(entry.name) &&
                existsSync(path.join(ROOT, entry.name, 'status.json')),
        )
        .map(entry => entry.name);
}

function readJson(file, fallback = null) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function readTelemetry(name, limit = 80) {
    const file = path.join(ROOT, name, 'telemetry.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-Math.min(Math.max(Number(limit) || 80, 1), 300))
        .flatMap(line => {
            try {
                return [JSON.parse(line)];
            } catch {
                return [];
            }
        });
}

function latestSnapshot(events) {
    return [...events].reverse().find(event => event.event === 'observation') ?? {};
}

function agentSummary(name) {
    const dir = path.join(ROOT, name);
    const events = readTelemetry(name, 120);
    const status = readJson(path.join(dir, 'status.json'), { agent: name, status: 'unknown' });
    const runtime = readJson(path.join(dir, 'runtime-status.json'), {});
    const observation = latestSnapshot(events);
    const latest = events.at(-1) ?? {};
    return {
        name,
        status: runtime.status ?? status.status ?? 'unknown',
        updatedAt: latest.time ?? status.updatedAt ?? null,
        objective: status.objective ?? '',
        health: observation.health ?? null,
        food: observation.food ?? null,
        position: observation.position ?? null,
        gameMode: observation.gameMode ?? null,
        inventory: observation.inventory ?? [],
        lastEvent: latest.event ?? null,
        lastMessage: latest.message ?? latest.errorMessage ?? latest.result ?? null,
    };
}

function agentDetail(name, limit) {
    const summary = agentSummary(name);
    const events = readTelemetry(name, limit);
    return { ...summary, events: events.reverse() };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 10000) reject(new Error('Request body too large'));
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const match = url.pathname.match(/^\/api\/agents\/([^/]+)(?:\/prompt)?$/);
    if (url.pathname === '/api/agents' && req.method === 'GET') return json(res, 200, { agents: agentNames().map(agentSummary) });
    if (match && req.method === 'GET') {
        const name = decodeURIComponent(match[1]);
        if (!NAME.test(name) || !agentNames().includes(name)) return json(res, 404, { error: 'Agent not found' });
        return json(res, 200, agentDetail(name, url.searchParams.get('limit')));
    }
    if (match && url.pathname.endsWith('/prompt') && req.method === 'POST') {
        const name = decodeURIComponent(match[1]);
        if (!NAME.test(name) || !agentNames().includes(name)) return json(res, 404, { error: 'Agent not found' });
        try {
            const body = JSON.parse(await readBody(req));
            const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
            if (!prompt || prompt.length > 2000) return json(res, 400, { error: 'Prompt must be 1-2000 characters' });
            const mailbox = new MailboxStore(path.join(ROOT, name, 'mailbox.sqlite'), 'Jayyy69');
            try {
                const id = mailbox.sendDM(name, prompt);
                return json(res, 202, { accepted: true, id, from: 'Jayyy69', to: name });
            } finally {
                mailbox.close();
            }
        } catch (error) {
            return json(res, 400, { error: String(error.message ?? error) });
        }
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
        return createReadStream(path.join(PUBLIC, 'index.html')).pipe(res);
    }
    return json(res, 404, { error: 'Not found' });
}

createServer((req, res) => {
    handle(req, res).catch(error => json(res, 500, { error: String(error.message ?? error) }));
}).listen(PORT, HOST, () => {
    console.log(`Dashboard listening at http://${HOST}:${PORT}`);
    console.log(`Reading agent state from ${ROOT}`);
});
