import net from 'node:net';
import fs from 'node:fs';

const MAX_CMD = 8000;
const AGENT_RE = /^[A-Za-z0-9_]{1,16}$/;

export const OUT_CAP = 16000;

export function sharedReadme(peers, { vm = false, root = '/shared' } = {}) {
    return `# Shared machine\n\nUsed by: ${peers.join(', ')}.\n${vm ? 'A full Linux VM (Ubuntu) shared by all agents: persistent disk, internet access, root (sudo), apt/pip/npm installs.\n' : ''}Every shared_exec command is appended to ${root}/log with its author. It cannot see or control the game.\n\n- plans/  plans and designs\n- notes/  notes and status\n- tools/  scripts anyone can run\n`;
}

export function logEntry(started, req, result) {
    return `${new Date(started).toISOString()} [${req.agent}] $ ${req.command.replace(/\n/g, '\n  ')}\n  -> exit ${result.exitCode ?? result.signal}${result.timedOut ? ' (timeout)' : ''} ${result.ms}ms\n`;
}

export function serveSharedMachine({ socketPath, run, concurrency = 4 }) {
    let active = 0;
    const queue = [];
    const pump = () => {
        while (active < concurrency && queue.length) {
            const job = queue.shift();
            active++;
            run(job.req)
                .then(job.done, err => job.done({ error: String(err?.message ?? err).slice(0, 200) }))
                .finally(() => {
                    active--;
                    pump();
                });
        }
    };
    try {
        fs.unlinkSync(socketPath);
    } catch {}
    const server = net.createServer(conn => {
        let buf = '';
        conn.setEncoding('utf8');
        conn.on('data', d => {
            buf += d;
            if (buf.length > 64000) {
                conn.end(JSON.stringify({ error: 'request too large' }) + '\n');
                return;
            }
            const i = buf.indexOf('\n');
            if (i < 0) return;
            let req;
            try {
                req = JSON.parse(buf.slice(0, i));
            } catch {
                conn.end(JSON.stringify({ error: 'bad json' }) + '\n');
                return;
            }
            buf = '';
            const timeout = Number.isInteger(req.timeout) ? Math.min(Math.max(req.timeout, 1), 120) : 30;
            if (
                !AGENT_RE.test(req.agent ?? '') ||
                typeof req.command !== 'string' ||
                !req.command.trim() ||
                req.command.length > MAX_CMD
            ) {
                conn.end(JSON.stringify({ error: 'invalid request' }) + '\n');
                return;
            }
            queue.push({
                req: { agent: req.agent, command: req.command, timeout },
                done: r => {
                    try {
                        conn.end(JSON.stringify(r) + '\n');
                    } catch {}
                },
            });
            pump();
        });
        conn.on('error', () => {});
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
            if (process.platform === 'linux') fs.chmodSync(socketPath, 0o660);
            resolve(server);
        });
    });
}
