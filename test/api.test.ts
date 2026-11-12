/** The panel's service client against a fake host: one request open at a time, failures do not jam the queue. */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { HostClient } from "@openchamber/sdk"
import { createApi } from "../panel/api.ts"
import { DEFAULT_SERVICE_SETTINGS } from "../service/settings.ts"

function fakeHost() {
    let open = 0
    let maxOpen = 0
    const order: string[] = []
    const gates: (() => void)[] = []
    const host = {
        serviceRequest: async (req: { path: string; body?: string }) => {
            open++
            maxOpen = Math.max(maxOpen, open)
            order.push(req.path)
            await new Promise<void>((r) => gates.push(r))
            open--
            if (req.path === "/v1/fail") return { status: 500, body: JSON.stringify({ ok: false, error: "boom", code: "X" }) }
            return { status: 200, body: JSON.stringify({ ok: true, path: req.path }) }
        },
    } as unknown as HostClient
    const release = async () => {
        for (let i = 0; i < 50 && !gates.length; i++) await Promise.resolve()
        gates.shift()?.()
        for (let i = 0; i < 20; i++) await Promise.resolve()
    }
    return { host, order, release, get open() { return open }, get maxOpen() { return maxOpen }, get waiting() { return gates.length } }
}

describe("panel service client", () => {
    it("keeps at most one request open, in call order, even for parallel callers", async () => {
        const h = fakeHost()
        const api = createApi(h.host, () => DEFAULT_SERVICE_SETTINGS)
        const all = Promise.all([api("/v1/overview"), api("/v1/sessions"), api("/v1/status")])
        await h.release()
        await h.release()
        await h.release()
        const out = (await all) as { path: string }[]
        assert.equal(h.maxOpen, 1)
        assert.deepEqual(h.order, ["/v1/overview", "/v1/sessions", "/v1/status"])
        assert.deepEqual(out.map((o) => o.path), h.order)
    })

    it("a failed request rejects its caller and does not block the next", async () => {
        const h = fakeHost()
        const api = createApi(h.host, () => DEFAULT_SERVICE_SETTINGS)
        const bad = api("/v1/fail")
        const good = api("/v1/status")
        await h.release()
        await assert.rejects(bad, /boom/)
        await h.release()
        assert.deepEqual(await good, { ok: true, path: "/v1/status" })
        assert.equal(h.maxOpen, 1)
    })
})
