/**
 * Startup behaviour of the panel, kept free of the DOM so it can be tested:
 *
 * - `Poller` schedules automatic refreshes. While the service is still
 *   indexing (or not answering yet) it polls quickly, backing off, for a
 *   bounded window, never slower than the owner's saved cadence; once the
 *   index is ready it returns to that cadence. Manual-only means no automatic
 *   requests at all. At most one timer and one request exist at a time.
 * - The wording for index progress and for a missing context-mode report.
 */

import type { IndexProgress } from "../service/types.ts"
import { ago, full } from "./format.ts"

export interface PollOutcome {
    /** The service answered and its index is complete. */
    ready: boolean
}

export interface PollerDeps {
    /** One refresh. Resolves null when a newer render superseded it. Should not throw. */
    run(): Promise<PollOutcome | null>
    /** Hidden page or a view that is not refreshed: skip the request, keep the schedule. */
    isHidden(): boolean
    /** Another render is in flight. */
    isBusy(): boolean
    setTimer(fn: () => void, ms: number): unknown
    clearTimer(handle: unknown): void
    now(): number
}

/** Delays between quick polls while the service starts, then the last one repeats. */
export const STARTUP_DELAYS = [1000, 1500, 2000, 3000, 5000] as const
/** Quick polling stops after this long without a ready index. */
export const STARTUP_WINDOW_MS = 120_000
const BUSY_RETRY_MS = 250

export class Poller {
    private refreshSec = 0
    private timer: unknown = null
    private inFlight = false
    private disposed = false
    private starting = true
    private startedAt: number | null = null
    private attempt = 0
    private everReady = false

    private readonly deps: PollerDeps

    constructor(deps: PollerDeps) {
        this.deps = deps
    }

    /** The owner's saved cadence in seconds; 0 = manual only. */
    configure(refreshSec: number): void {
        this.refreshSec = Math.max(0, refreshSec)
        this.schedule()
    }

    /** Report the result of any render, scheduled or user-initiated. */
    observe(o: PollOutcome): void {
        if (this.disposed) return
        if (o.ready) {
            this.starting = false
            this.everReady = true
        } else {
            if (!this.starting && this.everReady) {
                // The service restarted (idle stop) and is indexing again.
                this.starting = true
                this.startedAt = null
                this.attempt = 0
            }
            if (this.starting && this.startedAt === null) this.startedAt = this.deps.now()
        }
        this.schedule()
    }

    dispose(): void {
        this.disposed = true
        this.clear()
    }

    private clear(): void {
        if (this.timer !== null) this.deps.clearTimer(this.timer)
        this.timer = null
    }

    private delay(): number | null {
        if (!this.refreshSec) return null
        const normal = Math.max(1000, this.refreshSec * 1000)
        if (this.starting && (this.startedAt === null || this.deps.now() - this.startedAt < STARTUP_WINDOW_MS)) {
            return Math.min(normal, STARTUP_DELAYS[Math.min(this.attempt, STARTUP_DELAYS.length - 1)])
        }
        return normal
    }

    private schedule(ms = this.delay()): void {
        this.clear()
        if (this.disposed || this.inFlight || ms === null) return
        this.timer = this.deps.setTimer(() => this.tick(), ms)
    }

    private tick(): void {
        this.timer = null
        if (this.disposed || this.inFlight) return
        if (this.deps.isHidden()) {
            this.schedule()
            return
        }
        if (this.deps.isBusy()) {
            this.schedule(BUSY_RETRY_MS)
            return
        }
        if (this.starting) this.attempt++
        this.inFlight = true
        this.deps.run().then(
            (o) => {
                this.inFlight = false
                if (o) this.observe(o)
            },
            () => {
                this.inFlight = false
                this.observe({ ready: false })
            },
        )
    }
}

// ------------------------------------------------------------------ wording

export const NO_REPORT_LINE = "No recent context-mode activity report"
export const NO_REPORT_TITLE =
    "context-mode writes a report after it answers a tool call. No report from a running context-mode server was found; " +
    "that alone does not mean the server failed to start."

/** What the index is doing, or null once it is ready. Counts only: no invented percentage. */
export function progressLine(p: IndexProgress | null | undefined, now = Date.now()): string | null {
    if (!p) return null
    if (p.phase === "loading") return "Loading the saved index…"
    if (p.phase !== "scanning") return null
    if (p.cached || p.stale) {
        let s = `Updating the index: ${full(p.done)} of ${full(p.total)} changed session databases read`
        s += p.cached ? `; ${full(p.cached)} loaded from the saved index.` : "."
        if (p.stale) s += ` ${full(p.stale)} still show saved figures from ${ago(p.savedAt ?? 0, now)}.`
        return s
    }
    return `Indexing context-mode history: ${full(p.done)} of ${full(p.total)} session databases, newest first. Numbers fill in as it goes.`
}
