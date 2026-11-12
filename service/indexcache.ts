/**
 * Persistent derived event index.
 *
 * The per-DB aggregates EventIndex builds (session ids, project folders,
 * per-day/per-hour type counts, packed model-step numbers) are saved in the
 * extension's own service data folder (`OPENCHAMBER_SERVICE_DATA_DIR`), so a
 * restarted service answers from them at once and re-reads only the session
 * DBs whose file or WAL changed. Nothing here is a copy of event text: prompts,
 * file paths of reads/edits, errors and commands stay in context-mode's DBs.
 *
 * Layout: up to 64 bucket files `bucket-XX.json`, one per hash bucket of the
 * DB path, each `{ format, version, timeZone, endian, entries: { [dbPath]:
 * { stamp, savedAt, sessions } } }`. An entry is used only for the exact DB
 * path it names and only when its stamp (size + mtime of the DB and its WAL)
 * still matches; anything unreadable, truncated or from another version or
 * time zone is ignored and rebuilt. Writes go to a uniquely named temp file
 * that is renamed over the bucket, so a crash or a second instance can at
 * worst cost a cache miss, never a wrong number.
 *
 * Ownership: an instance is authoritative for the session folders it indexes
 * (it drops entries for DBs that disappeared from them) and preserves every
 * other entry whose DB still exists, so instances with different locations
 * never delete each other's work.
 */

import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { DbSession } from "./events.ts"
import { yieldTick } from "./util.ts"

export const CACHE_FORMAT = "context-mode-stats/event-index"
/** Bump whenever the cached shape or the way DBs are read (events.ts readSessions) changes. */
export const CACHE_VERSION = 1

const BUCKETS = 64
const MAX_BUCKET_BYTES = 64 * 1024 * 1024
const STALE_TMP_MS = 60 * 60 * 1000
const FLUSH_EVERY_MS = 15_000
const RENAME_TRIES = 8
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/

export interface CachedDb {
    file: string
    stamp: string
    savedAt: number
    sessions: DbSession[]
}

interface Bucket {
    format: string
    version: number
    timeZone: string
    endian: string
    entries: Record<string, { stamp: string; savedAt: number; sessions: unknown[] }>
}

const timeZone = (): string => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown"
    } catch {
        return "unknown"
    }
}

export function normScopeDir(p: string): string {
    const r = path.resolve(p)
    return process.platform === "win32" ? r.toLowerCase() : r
}

export function bucketOf(file: string): string {
    const n = createHash("sha256").update(file).digest().readUInt16BE(0) % BUCKETS
    return `bucket-${n.toString(16).padStart(2, "0")}.json`
}

// ------------------------------------------------------------ (de)serialise

function encodeSession(s: DbSession): unknown {
    return {
        id: s.id,
        projectDir: s.projectDir,
        startedAt: s.startedAt,
        lastEventAt: s.lastEventAt,
        compactions: s.compactions,
        resumes: s.resumes,
        events: s.events,
        types: s.types,
        days: [...s.days].map(([k, d]) => [k, d.types, d.hours]),
        steps: Buffer.from(s.steps.buffer, s.steps.byteOffset, s.steps.byteLength).toString("base64"),
    }
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

function counts(v: unknown): Record<string, number> | null {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null
    const out: Record<string, number> = {}
    for (const [k, c] of Object.entries(v as Record<string, unknown>)) {
        if (!num(c)) return null
        out[k] = c
    }
    return out
}

function decodeSession(v: unknown, file: string): DbSession | null {
    if (!v || typeof v !== "object") return null
    const o = v as Record<string, unknown>
    if (typeof o.id !== "string" || !o.id || typeof o.projectDir !== "string") return null
    if (!num(o.startedAt) || !num(o.lastEventAt) || !num(o.compactions) || !num(o.resumes) || !num(o.events)) return null
    const types = counts(o.types)
    if (!types || !Array.isArray(o.days) || typeof o.steps !== "string") return null
    const days = new Map<string, { types: Record<string, number>; hours: number[] }>()
    for (const d of o.days) {
        if (!Array.isArray(d) || d.length !== 3 || typeof d[0] !== "string" || !DAY_RE.test(d[0])) return null
        const dt = counts(d[1])
        const hours = d[2]
        if (!dt || !Array.isArray(hours) || hours.length !== 24 || !hours.every(num)) return null
        days.set(d[0], { types: dt, hours: hours as number[] })
    }
    if (o.steps.length % 4 !== 0 || !B64_RE.test(o.steps)) return null
    const buf = Buffer.from(o.steps, "base64")
    if (buf.byteLength % 48 !== 0) return null
    const steps = new Float64Array(buf.byteLength / 8)
    new Uint8Array(steps.buffer).set(buf)
    if (!steps.every(Number.isFinite)) return null
    return { id: o.id, dbFile: file, projectDir: o.projectDir, startedAt: o.startedAt, lastEventAt: o.lastEventAt, compactions: o.compactions, resumes: o.resumes, events: o.events, types, days, steps }
}

/** One entry, all-or-nothing. */
function decodeEntry(file: string, v: unknown): CachedDb | null {
    if (!v || typeof v !== "object") return null
    const e = v as Record<string, unknown>
    if (typeof e.stamp !== "string" || !e.stamp || !num(e.savedAt) || !Array.isArray(e.sessions)) return null
    const sessions: DbSession[] = []
    for (const s of e.sessions) {
        const d = decodeSession(s, file)
        if (!d) return null
        sessions.push(d)
    }
    return { file, stamp: e.stamp, savedAt: e.savedAt, sessions }
}

// --------------------------------------------------------------------- store

export class IndexCache {
    readonly dir: string
    private readonly tz = timeZone()
    private readonly endian = os.endianness()
    /** This instance's view of every DB in its scope. */
    private own = new Map<string, CachedDb>()
    private scope = new Set<string>()
    private dirty = new Set<string>()
    private flushing: Promise<void> | null = null
    private timer: ReturnType<typeof setTimeout> | null = null
    private lastFlush = 0
    private disposed = false
    /** Count of failed writes, for diagnostics; never includes paths. */
    writeErrors = 0

    constructor(dir: string) {
        this.dir = dir
    }

    /** New set of session folders: forget the old view (its files on disk are kept). */
    setScope(dirs: string[]): void {
        this.own.clear()
        this.dirty.clear()
        this.scope = new Set(dirs.map(normScopeDir))
    }

    private inScope(file: string): boolean {
        return this.scope.has(normScopeDir(path.dirname(file)))
    }

    private header(): Omit<Bucket, "entries"> {
        return { format: CACHE_FORMAT, version: CACHE_VERSION, timeZone: this.tz, endian: this.endian }
    }

    private async readBucket(name: string): Promise<Bucket | null> {
        const file = path.join(this.dir, name)
        try {
            const st = await fsp.stat(file)
            if (!st.isFile() || st.size > MAX_BUCKET_BYTES) return null
            const j = JSON.parse(await fsp.readFile(file, "utf8")) as Partial<Bucket>
            const h = this.header()
            if (j.format !== h.format || j.version !== h.version || j.timeZone !== h.timeZone || j.endian !== h.endian) return null
            if (!j.entries || typeof j.entries !== "object" || Array.isArray(j.entries)) return null
            return j as Bucket
        } catch {
            return null
        }
    }

    private async bucketNames(): Promise<string[]> {
        let names: string[]
        try {
            names = await fsp.readdir(this.dir)
        } catch {
            return []
        }
        const now = Date.now()
        for (const n of names) {
            // Abandoned temp files (a crash mid-write). A recent one may be another instance's write in progress.
            if (!n.endsWith(".tmp")) continue
            try {
                const st = await fsp.stat(path.join(this.dir, n))
                if (now - st.mtimeMs > STALE_TMP_MS) await fsp.unlink(path.join(this.dir, n))
            } catch {
                // gone already
            }
        }
        return names.filter((n) => /^bucket-[0-9a-f]{2}\.json$/.test(n))
    }

    /**
     * Read every bucket; return valid entries for `present` DBs (any stamp: the
     * caller decides fresh vs stale). Entries in scope whose DB is gone mark
     * their bucket for rewriting.
     */
    async load(present: string[]): Promise<Map<string, CachedDb>> {
        const want = new Set(present)
        const out = new Map<string, CachedDb>()
        for (const name of await this.bucketNames()) {
            if (this.disposed) break
            const b = await this.readBucket(name)
            if (!b) {
                this.dirty.add(name)
                continue
            }
            for (const [file, raw] of Object.entries(b.entries)) {
                if (bucketOf(file) !== name) continue
                if (!want.has(file)) {
                    if (this.inScope(file)) this.dirty.add(name)
                    continue
                }
                const e = decodeEntry(file, raw)
                if (e) out.set(file, e)
                else this.dirty.add(name)
            }
            await yieldTick()
        }
        return out
    }

    /** Accept a loaded entry as this instance's current view without rewriting it. */
    adopt(e: CachedDb): void {
        this.own.set(e.file, e)
    }

    put(e: CachedDb): void {
        if (this.disposed) return
        this.own.set(e.file, e)
        this.dirty.add(bucketOf(e.file))
    }

    remove(file: string): void {
        if (this.disposed) return
        if (this.own.delete(file) || this.inScope(file)) this.dirty.add(bucketOf(file))
    }

    /** Write soon, at most every FLUSH_EVERY_MS. */
    requestFlush(): void {
        if (this.disposed || !this.dirty.size || this.timer) return
        const wait = Math.max(0, FLUSH_EVERY_MS - (Date.now() - this.lastFlush))
        if (wait === 0 && !this.flushing) {
            void this.flush()
            return
        }
        this.timer = setTimeout(() => {
            this.timer = null
            void this.flush()
        }, wait || FLUSH_EVERY_MS)
        this.timer.unref?.()
    }

    /** Write every dirty bucket now (serialised with any write in progress). */
    flush(): Promise<void> {
        const run = async (): Promise<void> => {
            if (!this.dirty.size) return
            this.lastFlush = Date.now()
            try {
                await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 })
            } catch {
                this.writeErrors++
                return
            }
            const names = [...this.dirty]
            this.dirty.clear()
            for (const name of names) await this.writeBucket(name)
        }
        const next = (this.flushing ?? Promise.resolve()).then(run, run)
        const tracked = next.finally(() => {
            if (this.flushing === tracked) this.flushing = null
        })
        this.flushing = tracked
        return tracked
    }

    private async writeBucket(name: string): Promise<void> {
        const entries: Bucket["entries"] = {}
        // Keep other scopes' entries whose DBs still exist.
        const current = await this.readBucket(name)
        if (current) {
            for (const [file, raw] of Object.entries(current.entries)) {
                if (this.own.has(file) || this.inScope(file) || bucketOf(file) !== name) continue
                if (fs.existsSync(file)) entries[file] = raw
            }
        }
        for (const e of this.own.values()) {
            if (bucketOf(e.file) !== name) continue
            entries[e.file] = { stamp: e.stamp, savedAt: e.savedAt, sessions: e.sessions.map(encodeSession) }
        }
        const target = path.join(this.dir, name)
        if (!Object.keys(entries).length) {
            await fsp.rm(target, { force: true }).catch(() => undefined)
            return
        }
        const body = JSON.stringify({ ...this.header(), entries })
        if (body.length > MAX_BUCKET_BYTES) {
            this.writeErrors++
            return
        }
        const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`
        try {
            await fsp.writeFile(tmp, body, { encoding: "utf8", mode: 0o600, flag: "wx" })
            for (let i = 0; ; i++) {
                try {
                    await fsp.rename(tmp, target)
                    return
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code
                    // Windows refuses to replace a file another process is reading at that moment.
                    if (i >= RENAME_TRIES || !(code === "EPERM" || code === "EACCES" || code === "EBUSY")) throw error
                    await new Promise((r) => setTimeout(r, 15 * (i + 1)))
                }
            }
        } catch {
            this.writeErrors++
            await fsp.rm(tmp, { force: true }).catch(() => undefined)
        }
    }

    /** Stop timers and write what is pending. Safe to call twice. */
    async dispose(): Promise<void> {
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
        if (this.disposed) {
            await this.flushing
            return
        }
        await this.flush()
        this.disposed = true
    }
}
