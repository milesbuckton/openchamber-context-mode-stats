/**
 * Refresh orchestration races: a scheduled poll superseded by a newer render,
 * and user renders started while a poll's request is still open. Uses the
 * same `createRefreshLoop` wiring the panel uses, with a fake clock and a fake
 * transport that counts open requests.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Poller, RenderPump, STARTUP_DELAYS, createRefreshLoop } from "../panel/startup.ts"
import type { PollOutcome, RenderOpts } from "../panel/startup.ts"

const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
}

function fakeTimers() {
    let now = 0
    let seq = 0
    const timers = new Map<number, { fn: () => void; ms: number }>()
    return {
        timers,
        set: (fn: () => void, ms: number) => {
            const id = ++seq
            timers.set(id, { fn, ms })
            return id
        },
        clear: (id: unknown) => void timers.delete(id as number),
        now: () => now,
        delays: () => [...timers.values()].map((t) => t.ms),
        fire: () => {
            const [[id, t]] = [...timers.entries()]
            timers.delete(id)
            now += t.ms
            t.fn()
        },
    }
}

describe("poller: a superseded poll", () => {
    async function race(newer: PollOutcome | null, opts: { dispose?: boolean; refreshSec?: number; reject?: boolean } = {}) {
        const t = fakeTimers()
        let settleRun: (o: PollOutcome | null) => void = () => undefined
        let failRun: (e: unknown) => void = () => undefined
        const poller = new Poller({
            run: () => new Promise((res, rej) => { settleRun = res; failRun = rej }),
            isHidden: () => false,
            isBusy: () => false,
            setTimer: t.set,
            clearTimer: t.clear,
            now: t.now,
        })
        poller.configure(opts.refreshSec ?? 60)
        if (!t.timers.size) return { poller, delays: t.delays() }
        t.fire() // the poll starts; its request is open
        if (newer) poller.observe(newer) // a newer user render finishes first
        if (opts.dispose) poller.dispose()
        if (opts.reject) failRun(new Error("transport"))
        else settleRun(null) // the older render notices it was superseded
        await settle()
        return { poller, delays: t.delays() }
    }

    it("re-arms the saved cadence after a newer ready result", async () => {
        assert.deepEqual((await race({ ready: true })).delays, [60_000])
    })

    it("keeps bounded quick polling after a newer not-ready result", async () => {
        const { delays } = await race({ ready: false })
        assert.equal(delays.length, 1)
        assert.ok(delays[0] <= STARTUP_DELAYS[STARTUP_DELAYS.length - 1], `quick delay, got ${delays[0]}`)
    })

    it("re-arms even when no newer result has arrived yet", async () => {
        assert.equal((await race(null)).delays.length, 1)
    })

    it("re-arms after a rejected run without inventing a not-ready result", async () => {
        const { delays } = await race({ ready: true }, { reject: true })
        assert.deepEqual(delays, [60_000], "the newer ready state stands")
    })

    it("stays stopped when disposed before the old poll settles", async () => {
        assert.deepEqual((await race({ ready: true }, { dispose: true })).delays, [])
        assert.deepEqual((await race({ ready: true }, { dispose: true, reject: true })).delays, [])
    })

    it("stays manual-only", async () => {
        assert.deepEqual((await race({ ready: false }, { refreshSec: 0 })).delays, [])
    })
})

/** Fake panel: each render makes two service requests (status, then the view) like the real one. */
function fakePanel() {
    const t = fakeTimers()
    const pending: { resolve: () => void; label: string }[] = []
    let open = 0
    let maxOpen = 0
    let seq = 0
    let view = "sessions"
    const rendered: { view: string; keepScroll: boolean }[] = []
    let phase: "scanning" | "ready" = "scanning"
    const request = (label: string) => new Promise<void>((resolve) => {
        open++
        maxOpen = Math.max(maxOpen, open)
        pending.push({ label, resolve: () => { open--; resolve() } })
    })
    const render = async (opts: RenderOpts): Promise<PollOutcome | null> => {
        const mine = ++seq
        const stale = () => mine !== seq
        await request("status")
        if (stale()) return null
        const v = view
        await request(`view:${v}`)
        if (stale()) return null
        rendered.push({ view: v, keepScroll: opts.keepScroll })
        return { ready: phase === "ready" }
    }
    const loop = createRefreshLoop({
        render,
        supersede: () => void seq++,
        isHidden: () => false,
        setTimer: t.set,
        clearTimer: t.clear,
        now: t.now,
    })
    /** Answer the oldest open request. */
    const answer = async () => {
        const p = pending.shift()
        assert.ok(p, "a request is open")
        p.resolve()
        await settle()
        return p.label
    }
    const drain = async () => {
        while (pending.length) await answer()
    }
    return {
        t, loop, rendered, answer, drain,
        get open() { return open },
        get maxOpen() { return maxOpen },
        go: (v: string) => { view = v },
        ready: () => { phase = "ready" },
    }
}

describe("refresh loop: user renders while a poll is open", () => {
    it("never has two requests open and renders the latest navigation", async () => {
        const p = fakePanel()
        p.loop.poller.configure(60)
        p.t.fire() // automatic poll starts: status request open
        assert.equal(p.open, 1)
        p.go("insights")
        void p.loop.paint({ keepScroll: false })
        p.go("runs")
        void p.loop.paint({ keepScroll: true })
        assert.equal(p.open, 1, "user intent waits for the open request")
        await p.drain()
        assert.equal(p.maxOpen, 1, "at most one service request at a time")
        assert.deepEqual(p.rendered, [{ view: "runs", keepScroll: false }], "one coalesced render of the latest view; scroll-to-top kept")
        assert.equal(p.t.timers.size, 1, "polling continues")
        assert.ok(p.t.delays()[0] <= STARTUP_DELAYS[STARTUP_DELAYS.length - 1], "still indexing: quick cadence")
    })

    it("returns to the saved cadence when the coalesced render finds the index ready", async () => {
        const p = fakePanel()
        p.loop.poller.configure(60)
        p.t.fire()
        p.ready()
        void p.loop.paint({ keepScroll: true })
        await p.drain()
        assert.deepEqual(p.t.delays(), [60_000])
        assert.equal(p.maxOpen, 1)
    })

    it("a poll timer that fires during a user render waits instead of stacking", async () => {
        const p = fakePanel()
        p.loop.poller.configure(1)
        void p.loop.paint({ keepScroll: true })
        assert.equal(p.open, 1)
        p.t.fire() // poll due while the user render is open
        assert.equal(p.open, 1)
        await p.drain()
        while (p.t.timers.size && p.t.delays()[0] < 1000) {
            p.t.fire()
            await p.drain()
        }
        assert.equal(p.maxOpen, 1)
        assert.equal(p.t.timers.size, 1)
    })

    it("dispose during an open poll leaves no timer behind", async () => {
        const p = fakePanel()
        p.loop.poller.configure(60)
        p.t.fire()
        void p.loop.paint({ keepScroll: true })
        p.loop.poller.dispose()
        await p.drain()
        assert.equal(p.t.timers.size, 0)
        assert.equal(p.maxOpen, 1)
    })
})

describe("render pump", () => {
    it("resolves every waiter of a coalesced render with its outcome", async () => {
        const gates: (() => void)[] = []
        let n = 0
        const pump = new RenderPump(async () => {
            await new Promise<void>((r) => gates.push(r))
            return { ready: ++n === 2 }
        }, () => undefined)
        const first = pump.request({ keepScroll: true })
        const a = pump.request({ keepScroll: true })
        const b = pump.request({ keepScroll: true })
        assert.equal(pump.busy, true)
        gates.shift()!()
        await settle()
        gates.shift()!()
        assert.deepEqual(await first, { ready: false })
        assert.deepEqual(await a, { ready: true })
        assert.deepEqual(await b, { ready: true })
        await settle()
        assert.equal(pump.busy, false)
    })
})
