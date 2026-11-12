/**
 * Persistent derived index: what survives a service restart, what is re-read,
 * and what the cache must never contain or break.
 */

import { after, afterEach, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Engine } from "../service/engine.ts"
import { EventIndex, indexSessionDb } from "../service/events.ts"
import type { DbSession } from "../service/events.ts"
import { normalizeSettings } from "../service/settings.ts"
import { SES_CHILD, SES_MAIN, SES_OTHER, makeFixture, sessionDb, step } from "./fixtures.ts"
import type { Fixture } from "./fixtures.ts"

const tmpRoots: string[] = []
function tmpDir(prefix: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    tmpRoots.push(d)
    return d
}
after(() => {
    for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true })
})

/** A reader that counts (and records the order of) every SQLite read. */
function spyReader(hook?: (file: string) => void) {
    const files: string[] = []
    const read = (file: string): DbSession[] => {
        files.push(path.basename(file))
        hook?.(file)
        return indexSessionDb(file)
    }
    return { read, files }
}

/** Order-independent picture of everything the index answers with. */
function snap(idx: EventIndex) {
    return idx.sessions()
        .map((s) => ({ ...s, days: [...s.days].sort((a, b) => (a[0] < b[0] ? -1 : 1)), steps: [...s.steps] }))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
}

function cacheFiles(dir: string): string[] {
    const out: string[] = []
    const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name)
            if (e.isDirectory()) walk(p)
            else out.push(p)
        }
    }
    if (fs.existsSync(dir)) walk(dir)
    return out
}

async function build(dirs: string[], cacheDir: string | null, hook?: (file: string) => void, sliceMs?: number) {
    const spy = spyReader(hook)
    const idx = new EventIndex({ cacheDir, reader: spy.read, sliceMs })
    await idx.refresh(dirs)
    return { idx, spy }
}

let fx: Fixture
let cacheDir: string
const ALL_DBS = ["aaaaaaaaaaaaaaaa.db", "aaaaaaaaaaaaaaaa__wt1.db", "bbbbbbbbbbbbbbbb.db", "cccccccccccccccc.db"]

beforeEach(() => {
    fx = makeFixture()
    cacheDir = tmpDir("cm-cache-")
})
afterEach(() => fx.cleanup())

describe("persistent index cache", () => {
    it("cold build reads every DB once and writes a derived cache", async () => {
        const { idx, spy } = await build([fx.sessionsDir], cacheDir)
        assert.deepEqual([...spy.files].sort(), ALL_DBS)
        assert.equal(idx.progress.phase, "ready")
        await idx.dispose()
        const files = cacheFiles(cacheDir)
        assert.ok(files.length > 0, "cache written")
        assert.ok(files.every((f) => f.endsWith(".json")), `only finished cache files remain: ${files.map((f) => path.basename(f)).join(", ")}`)
    })

    it("a new index (service restart) reuses the cache without reading any DB", async () => {
        const cold = await build([fx.sessionsDir], cacheDir)
        const expected = snap(cold.idx)
        await cold.idx.dispose()
        const warm = await build([fx.sessionsDir], cacheDir)
        assert.deepEqual(warm.spy.files, [], "no SQLite reads on a warm start")
        assert.deepEqual(snap(warm.idx), expected)
        assert.equal(warm.idx.progress.phase, "ready")
        assert.equal(warm.idx.progress.cached, ALL_DBS.length)
        assert.equal(warm.idx.projectForHash("aaaaaaaaaaaaaaaa"), "/work/alpha")
        await warm.idx.dispose()
    })

    it("re-reads only a changed or new DB", async () => {
        const cold = await build([fx.sessionsDir], cacheDir)
        await cold.idx.dispose()
        const db = new DatabaseSync(path.join(fx.sessionsDir, "bbbbbbbbbbbbbbbb.db"))
        db.prepare("INSERT INTO session_events (session_id, type, category, data, project_dir, source_hook) VALUES (?, 'user_prompt', 'p', 'again', '/work/beta', 't')").run(SES_OTHER)
        db.close()
        sessionDb(path.join(fx.sessionsDir, "dddddddddddddddd.db"), "/work/delta", [["ses_new000000000000000000004", "user_prompt", "hi", 1]], [["ses_new000000000000000000004", 0]])
        const warm = await build([fx.sessionsDir], cacheDir)
        assert.deepEqual([...warm.spy.files].sort(), ["bbbbbbbbbbbbbbbb.db", "dddddddddddddddd.db"])
        assert.equal(warm.idx.get(SES_OTHER)?.types.user_prompt, 2)
        assert.ok(warm.idx.get("ses_new000000000000000000004"))
        assert.equal(warm.idx.get(SES_MAIN)?.types.user_prompt, 1, "unchanged data still served from the cache")
        await warm.idx.dispose()
    })

    it("treats a WAL-only change as a change", async () => {
        const file = path.join(fx.sessionsDir, "eeeeeeeeeeeeeeee.db")
        const writer = new DatabaseSync(file)
        try {
            writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            writer.exec("CREATE TABLE session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL, data TEXT NOT NULL, project_dir TEXT NOT NULL DEFAULT '', source_hook TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))")
            const ins = writer.prepare("INSERT INTO session_events (session_id, type, category, data, project_dir, source_hook) VALUES ('ses_wal0000000000000000000005', 'file_read', 'f', 'x', '/work/wal', 't')")
            ins.run()
            const cold = await build([fx.sessionsDir], cacheDir)
            assert.equal(cold.idx.get("ses_wal0000000000000000000005")?.types.file_read, 1)
            await cold.idx.dispose()
            const before = fs.statSync(file)
            ins.run()
            const afterStat = fs.statSync(file)
            assert.equal(afterStat.size, before.size, "main DB file unchanged: only the WAL moved")
            assert.equal(afterStat.mtimeMs, before.mtimeMs, "main DB file unchanged: only the WAL moved")
            const warm = await build([fx.sessionsDir], cacheDir)
            assert.deepEqual(warm.spy.files, ["eeeeeeeeeeeeeeee.db"])
            assert.equal(warm.idx.get("ses_wal0000000000000000000005")?.types.file_read, 2)
            await warm.idx.dispose()
        } finally {
            writer.close()
        }
    })

    it("drops a deleted DB's counts and its cache entry", async () => {
        const cold = await build([fx.sessionsDir], cacheDir)
        await cold.idx.dispose()
        fs.rmSync(path.join(fx.sessionsDir, "bbbbbbbbbbbbbbbb.db"))
        const warm = await build([fx.sessionsDir], cacheDir)
        assert.deepEqual(warm.spy.files, [])
        assert.equal(warm.idx.get(SES_OTHER), undefined)
        await warm.idx.dispose()
        const text = cacheFiles(cacheDir).map((f) => fs.readFileSync(f, "utf8")).join("\n")
        assert.ok(!text.includes("bbbbbbbbbbbbbbbb.db"), "entry removed from the cache")

        // The same live index notices a removal too.
        const live = await build([fx.sessionsDir], null)
        fs.rmSync(path.join(fx.sessionsDir, "aaaaaaaaaaaaaaaa__wt1.db"))
        await live.idx.refresh([fx.sessionsDir])
        assert.equal(live.idx.get(SES_CHILD), undefined)
    })

    for (const [name, damage] of [
        ["garbage", (f: string) => fs.writeFileSync(f, "\u0000\u0001not json")],
        ["truncated", (f: string) => fs.writeFileSync(f, fs.readFileSync(f, "utf8").slice(0, Math.floor(fs.statSync(f).size / 2)))],
        ["incompatible version", (f: string) => {
            const j = JSON.parse(fs.readFileSync(f, "utf8"))
            j.version = 999
            fs.writeFileSync(f, JSON.stringify(j))
        }],
        ["other time zone", (f: string) => {
            const j = JSON.parse(fs.readFileSync(f, "utf8"))
            j.timeZone = "Mars/Olympus_Mons"
            fs.writeFileSync(f, JSON.stringify(j))
        }],
        ["malformed entry", (f: string) => {
            const j = JSON.parse(fs.readFileSync(f, "utf8"))
            for (const k of Object.keys(j.entries)) j.entries[k].sessions = [{ id: 5, steps: "%%%" }]
            fs.writeFileSync(f, JSON.stringify(j))
        }],
    ] as const) {
        it(`rebuilds safely from a ${name} cache`, async () => {
            const cold = await build([fx.sessionsDir], cacheDir)
            const expected = snap(cold.idx)
            await cold.idx.dispose()
            for (const f of cacheFiles(cacheDir)) damage(f)
            const again = await build([fx.sessionsDir], cacheDir)
            assert.deepEqual([...again.spy.files].sort(), ALL_DBS, "every DB re-read")
            assert.deepEqual(snap(again.idx), expected)
            await again.idx.dispose()
            const healed = await build([fx.sessionsDir], cacheDir)
            assert.deepEqual(healed.spy.files, [], "cache rewritten after the rebuild")
            await healed.idx.dispose()
        })
    }

    it("keeps scopes apart: no leak from, and no deletion of, another location's data", async () => {
        const otherDir = tmpDir("cm-other-")
        sessionDb(path.join(otherDir, "ffffffffffffffff.db"), "/work/other", [["ses_far0000000000000000000006", "user_prompt", "x", 3]], [["ses_far0000000000000000000006", 0]])
        const a = await build([fx.sessionsDir], cacheDir)
        await a.idx.dispose()
        const b = await build([otherDir], cacheDir)
        assert.deepEqual(b.idx.sessions().map((s) => s.id), ["ses_far0000000000000000000006"])
        await b.idx.dispose()
        const a2 = await build([fx.sessionsDir], cacheDir)
        assert.deepEqual(a2.spy.files, [], "the other scope's writes kept this scope's entries")
        assert.equal(a2.idx.get("ses_far0000000000000000000006"), undefined)
        // One index switching locations forgets the old one.
        await a2.idx.refresh([otherDir])
        assert.deepEqual(a2.idx.sessions().map((s) => s.id), ["ses_far0000000000000000000006"])
        await a2.idx.dispose()
    })

    it("two instances writing at once leave a valid cache and no temp files", async () => {
        const stale = path.join(cacheDir, "stale.json.1.deadbeef.tmp")
        const fresh = path.join(cacheDir, "fresh.json.2.cafef00d.tmp")
        fs.writeFileSync(stale, "half")
        fs.utimesSync(stale, new Date(Date.now() - 3 * 3_600_000), new Date(Date.now() - 3 * 3_600_000))
        fs.writeFileSync(fresh, "another instance is writing this")
        const one = new EventIndex({ cacheDir })
        const two = new EventIndex({ cacheDir })
        await Promise.all([one.refresh([fx.sessionsDir]), two.refresh([fx.sessionsDir])])
        await Promise.all([one.dispose(), two.dispose()])
        const files = cacheFiles(cacheDir)
        assert.ok(!files.includes(stale), "abandoned temp file swept")
        assert.ok(files.includes(fresh), "a recent temp file of another instance is left alone")
        fs.rmSync(fresh)
        for (const f of cacheFiles(cacheDir)) assert.doesNotThrow(() => JSON.parse(fs.readFileSync(f, "utf8")), path.basename(f))
        const third = await build([fx.sessionsDir], cacheDir)
        assert.deepEqual(third.spy.files, [])
        await third.idx.dispose()
    })

    it("stores derived aggregates only, never event text", async () => {
        const { idx } = await build([fx.sessionsDir], cacheDir)
        await idx.dispose()
        const text = cacheFiles(cacheDir).map((f) => fs.readFileSync(f, "utf8")).join("\n")
        for (const secret of ["Please fix the login bug", "TypeError", "login.ts", "subtask: write tests", "Use the existing session store", "npm test"]) {
            assert.ok(!text.includes(secret), `cache must not contain ${secret}`)
        }
    })

    it("dispose stops a cold scan; the next start reads only what was not saved", async () => {
        const many = tmpDir("cm-many-")
        for (let i = 0; i < 30; i++) {
            const sid = `ses_many${String(i).padStart(19, "0")}`
            sessionDb(path.join(many, `${i.toString(16).padStart(16, "0")}.db`), "/work/many", [[sid, "user_prompt", "p", i + 1]], [[sid, 0]])
        }
        let disposing = null as Promise<void> | null
        const spy = spyReader(() => {
            if (spy.files.length === 3) disposing = idx.dispose()
        })
        const idx = new EventIndex({ cacheDir, reader: spy.read, sliceMs: 0 })
        await idx.refresh([many])
        await disposing
        const firstReads = spy.files.length
        assert.equal(firstReads, 3, "no DB read after dispose")
        const next = await build([many], cacheDir)
        assert.equal(next.spy.files.length, 30 - firstReads, "work done before dispose was kept")
        assert.equal(next.idx.sessions().length, 30)
        await next.idx.dispose()
    })
})

describe("startup order and responsiveness", () => {
    it("reads the most recently written DBs first on a cold start", async () => {
        const dir = tmpDir("cm-order-")
        const now = Date.now()
        for (let i = 0; i < 12; i++) {
            const file = path.join(dir, `${(i + 1).toString(16).padStart(16, "0")}.db`)
            sessionDb(file, "/work/o", [[`ses_o${String(i).padStart(22, "0")}`, "user_prompt", "p", 5]], [[`ses_o${String(i).padStart(22, "0")}`, 0]])
            // Shuffle ages so file name order is not mtime order.
            const age = ((i * 7) % 12) * 60_000
            fs.utimesSync(file, new Date(now - age), new Date(now - age))
        }
        const { spy } = await build([dir], null)
        assert.equal(spy.files.length, 12)
        const mtimes = spy.files.map((f) => fs.statSync(path.join(dir, f)).mtimeMs)
        assert.deepEqual(mtimes, [...mtimes].sort((a, b) => b - a), "newest first")
    })

    it("serves a changed DB's saved figures, marked stale, until it is re-read", async () => {
        const cold = await build([fx.sessionsDir], cacheDir)
        await cold.idx.dispose()
        const db = new DatabaseSync(path.join(fx.sessionsDir, "bbbbbbbbbbbbbbbb.db"))
        db.prepare("INSERT INTO session_events (session_id, type, category, data, project_dir, source_hook) VALUES (?, 'user_prompt', 'p', 'again', '/work/beta', 't')").run(SES_OTHER)
        db.close()
        let seen: { prompts?: number; stale?: number; phase?: string } = {}
        const spy = spyReader(() => {
            seen = { prompts: idx.get(SES_OTHER)?.types.user_prompt, stale: idx.progress.stale, phase: idx.progress.phase }
        })
        const idx = new EventIndex({ cacheDir, reader: spy.read })
        await idx.refresh([fx.sessionsDir])
        assert.deepEqual(seen, { prompts: 1, stale: 1, phase: "scanning" }, "old figures available while the new ones are read")
        assert.equal(idx.get(SES_OTHER)?.types.user_prompt, 2)
        assert.equal(idx.progress.stale, 0)
        await idx.dispose()
    })

    it("keeps the event loop responsive while slow DBs are read", async () => {
        const dir = tmpDir("cm-slow-")
        for (let i = 0; i < 24; i++) {
            const sid = `ses_slow${String(i).padStart(19, "0")}`
            sessionDb(path.join(dir, `${(i + 1).toString(16).padStart(16, "0")}.db`), "/work/s", [[sid, "user_prompt", "p", 2]], [[sid, 0]])
        }
        const busy = (ms: number) => {
            const end = performance.now() + ms
            while (performance.now() < end) { /* simulated slow disk */ }
        }
        let maxGap = 0
        let last = performance.now()
        const probe = setInterval(() => {
            const t = performance.now()
            maxGap = Math.max(maxGap, t - last)
            last = t
        }, 5)
        const progress: number[] = []
        const spy = spyReader(() => busy(25))
        const idx = new EventIndex({ reader: spy.read })
        const run = idx.refresh([dir])
        const sampler = setInterval(() => progress.push(idx.progress.done), 10)
        await run
        clearInterval(probe)
        clearInterval(sampler)
        assert.ok(maxGap < 160, `event loop blocked for ${maxGap.toFixed(0)} ms`)
        assert.ok(progress.some((d) => d > 0 && d < 24), "progress visible mid-scan")
        assert.deepEqual(progress, [...progress].sort((a, b) => a - b), "progress never goes backwards")
    })
})

describe("engine with the cache", () => {
    const settingsFor = (f: Fixture) => normalizeSettings({
        locations: { sessionDirs: [f.sessionsDir], statsDirs: [f.statsDir], contentDirs: [f.contentDir], opencodeDb: f.opencodeDb },
    })
    const strip = (o: unknown) => JSON.parse(JSON.stringify(o, (k, v) => (k === "generatedAt" || k === "uptimeMs" || k === "progress" ? undefined : v)))

    it("answers a restarted service's first request from the cache, with identical numbers", async () => {
        const settings = settingsFor(fx)
        const cold = new Engine()
        const cctx = cold.context(settings)
        await cold.events.refresh(cctx.sessionDirs)

        const first = new Engine({ cacheDir })
        await first.events.refresh(first.context(settings).sessionDirs)
        await first.dispose()

        const warm = new Engine({ cacheDir })
        const t = performance.now()
        const wctx = await warm.prepare(settings)
        const status = warm.status(wctx)
        assert.ok(performance.now() - t < 1500, "first request bounded")
        assert.equal(status.totals.sessions, 4, "first answer already has every cached session")
        await warm.events.refresh(wctx.sessionDirs)
        assert.deepEqual(strip(warm.overview(wctx, {}, 10)), strip(cold.overview(cctx, {}, 10)))
        assert.deepEqual(strip(warm.sessionsPage(wctx, {}, "tokens", "desc", 0, 50)), strip(cold.sessionsPage(cctx, {}, "tokens", "desc", 0, 50)))
        assert.deepEqual(strip(warm.brief(wctx, SES_MAIN, null)), strip(cold.brief(cctx, SES_MAIN, null)))
        assert.deepEqual(strip(warm.detail(wctx, SES_MAIN, { offset: 0, limit: 50, types: null, topN: 10 })), strip(cold.detail(cctx, SES_MAIN, { offset: 0, limit: 50, types: null, topN: 10 })))
        await warm.dispose()
    })

    it("works without a cache folder (memory only)", async () => {
        const e = new Engine({ cacheDir: null })
        const ctx = e.context(settingsFor(fx))
        await e.events.refresh(ctx.sessionDirs)
        assert.equal(e.status(ctx).totals.sessions, 4)
        await e.dispose()
    })
})

void step
