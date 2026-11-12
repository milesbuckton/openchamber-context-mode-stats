/**
 * Startup benchmark: runs the built service (service/main.js) as a disposable
 * child the way the host does, twice against the same fresh data folder —
 * a cold start (no saved index) and a restart (saved index) — and records the
 * first health reply, first status, first answer with sessions, first ready
 * index, health latency while indexing and how many DBs each start re-read.
 * Session stores are only read. The child is always killed and reaped.
 *
 *   node scripts/bench-startup.ts [--runtime <exe>] [--sessions <dir>] [--entry <main.js>] [--out <file.jsonl>]
 *
 * `--runtime` defaults to this Node; pass the OpenChamber executable to use the
 * host's own runtime (ELECTRON_RUN_AS_NODE is set). `--sessions` pins the session
 * folder (otherwise discovery finds the real one).
 */

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import * as fs from "node:fs"
import http from "node:http"
import net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const arg = (name: string): string | null => {
    const i = process.argv.indexOf(name)
    return i > 0 ? process.argv[i + 1] ?? null : null
}
const runtime = arg("--runtime") ?? process.execPath
const sessions = arg("--sessions")
const out = arg("--out")
const entry = path.resolve(arg("--entry") ?? path.join(root, "service", "main.js"))
const DEADLINE_MS = 150_000

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port
        s.close(() => resolve(p))
    })
})

function call(port: number, token: string, method: string, p: string, body?: unknown): Promise<{ status: number; json: unknown; ms: number }> {
    const t = performance.now()
    return new Promise((resolve) => {
        const data = body === undefined ? undefined : JSON.stringify(body)
        const req = http.request({ host: "127.0.0.1", port, path: p, method, timeout: 20_000, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }, (res) => {
            const chunks: Buffer[] = []
            res.on("data", (c: Buffer) => chunks.push(c))
            res.on("end", () => {
                let json: unknown = null
                try {
                    json = JSON.parse(Buffer.concat(chunks).toString("utf8"))
                } catch {
                    json = null
                }
                resolve({ status: res.statusCode ?? 0, json, ms: performance.now() - t })
            })
        })
        req.on("timeout", () => req.destroy(new Error("timeout")))
        req.on("error", () => resolve({ status: 0, json: null, ms: performance.now() - t }))
        req.end(data)
    })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function dirState(dir: string): string {
    try {
        return fs.readdirSync(dir).map((n) => {
            const st = fs.statSync(path.join(dir, n))
            return `${n}:${st.size}:${st.mtimeMs}`
        }).sort().join("|")
    } catch {
        return ""
    }
}

interface Progress { phase: string; done: number; total: number; cached?: number; stale?: number }

async function run(label: string, dataDir: string) {
    const port = await freePort()
    const token = randomBytes(24).toString("hex")
    const settings = sessions ? { locations: { sessionDirs: [sessions] } } : {}
    const t0 = performance.now()
    const child = spawn(runtime, ["--no-warnings", entry], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: token, OPENCHAMBER_SERVICE_DATA_DIR: dataDir },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
    })
    let stderr = ""
    child.stderr?.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-2000)))
    const r = {
        label, firstHealthMs: 0, firstStatusMs: 0, firstStatus: null as Progress | null, firstSessionsMs: 0, firstSessions: 0,
        readyMs: 0, ready: null as Progress | null, sessions: 0, maxHealthMs: 0, healthSamples: 0, failedRequests: 0, savedMs: 0, error: "",
    }
    try {
        while (performance.now() - t0 < 15_000) {
            const h = await call(port, token, "GET", "/health")
            if (h.status === 200) {
                r.firstHealthMs = performance.now() - t0
                break
            }
            await sleep(50)
        }
        if (!r.firstHealthMs) throw new Error("no health within 15 s")
        let stop = false
        const healthLoop = (async () => {
            while (!stop) {
                const h = await call(port, token, "GET", "/health")
                r.healthSamples++
                if (h.status !== 200) r.failedRequests++
                else r.maxHealthMs = Math.max(r.maxHealthMs, h.ms)
                await sleep(200)
            }
        })()
        while (performance.now() - t0 < DEADLINE_MS) {
            const s = await call(port, token, "POST", "/v1/status", { settings })
            const j = s.json as { ok?: boolean; progress?: Progress; totals?: { sessions: number } } | null
            if (s.status !== 200 || !j?.ok || !j.progress) {
                r.failedRequests++
            } else {
                const at = performance.now() - t0
                if (!r.firstStatusMs) {
                    r.firstStatusMs = at
                    r.firstStatus = j.progress
                }
                if (!r.firstSessionsMs && (j.totals?.sessions ?? 0) > 0) {
                    r.firstSessionsMs = at
                    r.firstSessions = j.totals?.sessions ?? 0
                }
                if (j.progress.phase === "ready") {
                    r.readyMs = at
                    r.ready = j.progress
                    r.sessions = j.totals?.sessions ?? 0
                    break
                }
            }
            await sleep(250)
        }
        stop = true
        await healthLoop
        // Wait for the saved index to settle (bounded), then stop the child.
        const cacheDir = path.join(dataDir, "event-index")
        let last = dirState(cacheDir)
        let stableSince = performance.now()
        while (performance.now() - stableSince < 1500 && performance.now() - t0 < DEADLINE_MS + 30_000) {
            await sleep(250)
            const now = dirState(cacheDir)
            if (now !== last) {
                last = now
                stableSince = performance.now()
            }
        }
        r.savedMs = stableSince - t0
    } catch (error) {
        r.error = `${error instanceof Error ? error.message : String(error)} ${stderr}`.trim()
    } finally {
        child.kill()
        await new Promise((res) => {
            if (child.exitCode !== null || child.signalCode !== null) return res(null)
            const t = setTimeout(() => {
                child.kill("SIGKILL")
                res(null)
            }, 3000)
            child.once("exit", () => {
                clearTimeout(t)
                res(null)
            })
        })
    }
    return r
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cms-bench-data-"))
try {
    const results = []
    for (const label of ["cold", "warm"]) {
        const r = await run(label, dataDir)
        results.push(r)
        const line = JSON.stringify({ at: new Date().toISOString(), runtime: path.basename(runtime), store: sessions ? "pinned" : "discovered", ...r })
        console.log(line)
        if (out) fs.appendFileSync(out, line + "\n")
    }
    const files = fs.existsSync(path.join(dataDir, "event-index")) ? fs.readdirSync(path.join(dataDir, "event-index")) : []
    const bytes = files.reduce((a, n) => a + fs.statSync(path.join(dataDir, "event-index", n)).size, 0)
    console.log(JSON.stringify({ cacheFiles: files.length, cacheMB: +(bytes / 1048576).toFixed(2) }))
} finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
}
