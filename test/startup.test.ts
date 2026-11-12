/** Panel startup: polling while the service indexes, and what the panel says meanwhile. */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { NO_REPORT_LINE, NO_REPORT_TITLE, Poller, STARTUP_DELAYS, STARTUP_WINDOW_MS, progressLine } from "../panel/startup.ts"
import type { PollOutcome } from "../panel/startup.ts"
import type { IndexProgress } from "../service/types.ts"

/** Fake clock + timers: one pending timer at most is what the poller promises. */
function harness(outcomes: (PollOutcome | null)[] | (() => Promise<PollOutcome | null>)) {
    let now = 0
    const timers = new Map<number, { at: number; fn: () => void; ms: number }>()
    let seq = 0
    let runs = 0
    const state = { hidden: false, busy: false }
    const queue = Array.isArray(outcomes) ? [...outcomes] : null
    const poller = new Poller({
        run: () => {
            runs++
            if (!queue) return (outcomes as () => Promise<PollOutcome | null>)()
            return Promise.resolve(queue.length > 1 ? queue.shift()! : queue[0])
        },
        isHidden: () => state.hidden,
        isBusy: () => state.busy,
        setTimer: (fn, ms) => {
            const id = ++seq
            timers.set(id, { at: now + ms, fn, ms })
            return id
        },
        clearTimer: (id) => void timers.delete(id as number),
        now: () => now,
    })
    const pending = () => [...timers.values()]
    /** Fire the single pending timer and let the run settle. */
    const fire = async () => {
        const list = pending()
        assert.equal(list.length, 1, `exactly one timer pending (found ${list.length})`)
        const [id, t] = [...timers.entries()][0]
        timers.delete(id)
        now = t.at
        t.fn()
        for (let i = 0; i < 5; i++) await Promise.resolve()
        return t.ms
    }
    return { poller, pending, fire, state, get runs() { return runs }, advance: (ms: number) => { now += ms } }
}

const notReady: PollOutcome = { ready: false }
const ready: PollOutcome = { ready: true }

describe("startup polling", () => {
    it("polls quickly while the service indexes, then returns to the saved cadence", async () => {
        const h = harness([notReady, notReady, notReady, notReady, notReady, notReady, ready, ready])
        h.poller.configure(60)
        h.poller.observe(notReady) // the first render's answer
        const delays: number[] = []
        for (let i = 0; i < 8; i++) delays.push(await h.fire())
        assert.deepEqual(delays.slice(0, 7), [...STARTUP_DELAYS, STARTUP_DELAYS[STARTUP_DELAYS.length - 1], STARTUP_DELAYS[STARTUP_DELAYS.length - 1]].slice(0, 7))
        assert.equal(delays[7], 60_000, "saved 60-second cadence restored once ready")
        assert.equal(h.pending()[0].ms, 60_000)
    })

    it("gives up fast polling after a bounded window", async () => {
        const h = harness([notReady])
        h.poller.configure(60)
        h.poller.observe(notReady)
        let last = 0
        for (let i = 0; i < 200 && last !== 60_000; i++) last = await h.fire()
        assert.equal(last, 60_000)
        assert.ok(h.runs <= Math.ceil(STARTUP_WINDOW_MS / STARTUP_DELAYS[0]) + 1, `bounded retries (${h.runs})`)
    })

    it("never polls when the owner chose manual refresh", async () => {
        const h = harness([notReady])
        h.poller.configure(0)
        h.poller.observe(notReady)
        assert.equal(h.pending().length, 0)
    })

    it("never polls slower than the saved cadence while starting", async () => {
        const h = harness([notReady])
        h.poller.configure(1)
        h.poller.observe(notReady)
        assert.equal(h.pending()[0].ms, 1000)
    })

    it("does not overlap a request that is still running", async () => {
        let release: (o: PollOutcome) => void = () => undefined
        const h = harness(() => new Promise((r) => { release = r }))
        h.poller.configure(60)
        h.poller.observe(notReady)
        await h.fire()
        assert.equal(h.runs, 1)
        assert.equal(h.pending().length, 0, "nothing scheduled while the request runs")
        h.poller.configure(60) // a settings save while in flight
        if (h.pending().length) await h.fire()
        assert.equal(h.runs, 1, "no second request while the first is open")
        release(ready)
        for (let i = 0; i < 5; i++) await Promise.resolve()
        assert.equal(h.pending().length, 1)
        assert.equal(h.pending()[0].ms, 60_000)
    })

    it("waits for a render the user started instead of stacking another", async () => {
        const h = harness([notReady])
        h.poller.configure(60)
        h.poller.observe(notReady)
        h.state.busy = true
        await h.fire()
        assert.equal(h.runs, 0)
        assert.equal(h.pending().length, 1, "retries shortly")
        h.state.busy = false
        await h.fire()
        assert.equal(h.runs, 1)
    })

    it("skips requests while hidden but keeps its schedule alive", async () => {
        const h = harness([notReady])
        h.poller.configure(60)
        h.poller.observe(notReady)
        h.state.hidden = true
        await h.fire()
        assert.equal(h.runs, 0)
        assert.equal(h.pending().length, 1)
    })

    it("schedules nothing after disposal, even when a request resolves late", async () => {
        let release: (o: PollOutcome) => void = () => undefined
        const h = harness(() => new Promise((r) => { release = r }))
        h.poller.configure(60)
        h.poller.observe(notReady)
        await h.fire()
        h.poller.dispose()
        release(notReady)
        for (let i = 0; i < 5; i++) await Promise.resolve()
        h.poller.observe(notReady)
        assert.equal(h.pending().length, 0)
    })

    it("a superseded request leaves scheduling to the render that replaced it", async () => {
        const h = harness([null])
        h.poller.configure(60)
        h.poller.observe(notReady)
        await h.fire()
        assert.equal(h.pending().length, 0)
        h.poller.observe(ready)
        assert.equal(h.pending()[0].ms, 60_000)
    })

    it("re-arms quick polling when a restarted service is indexing again", async () => {
        const h = harness([notReady])
        h.poller.configure(60)
        h.poller.observe(ready)
        assert.equal(h.pending()[0].ms, 60_000)
        h.poller.observe(notReady)
        assert.equal(h.pending()[0].ms, STARTUP_DELAYS[0])
    })
})

describe("startup wording", () => {
    const base: IndexProgress = { phase: "scanning", done: 3, total: 40, startedAt: 1, finishedAt: 0 }

    it("does not claim the context-mode server is down when there is only no report", () => {
        assert.doesNotMatch(NO_REPORT_LINE, /not running|down|failed|stopped/i)
        assert.match(NO_REPORT_TITLE, /tool call/i)
    })

    it("describes a cold index, a cache update and stale saved figures truthfully", () => {
        assert.match(progressLine(base, 10_000) ?? "", /3 of 40.*newest first/i)
        const warm = progressLine({ ...base, cached: 2000, total: 5, done: 1 }, 10_000) ?? ""
        assert.match(warm, /2,000|2000/)
        assert.match(warm, /1 of 5/)
        const stale = progressLine({ ...base, cached: 2000, total: 5, done: 1, stale: 4, savedAt: 10_000 - 120_000 }, 10_000) ?? ""
        assert.match(stale, /4 .*saved.*2 min/i)
        assert.match(progressLine({ ...base, phase: "loading", done: 0, total: 0 }, 1) ?? "", /saved index/i)
        assert.equal(progressLine({ ...base, phase: "ready" }, 1), null)
        assert.doesNotMatch(warm + stale, /%/, "no invented percentage in the text")
    })
})
