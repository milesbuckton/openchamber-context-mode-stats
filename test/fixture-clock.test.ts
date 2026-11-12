/** The fixture's duplicated model steps stay duplicates however long building it takes. */

import { it } from "node:test"
import assert from "node:assert/strict"
import * as path from "node:path"
import { indexSessionDb, mergeSession, stepCount } from "../service/events.ts"
import { SES_MAIN, makeFixture } from "./fixtures.ts"

it("uses one clock for every DB of a fixture", () => {
    const real = Date.now
    let t = real()
    Date.now = () => (t += 700) // a slow machine: every clock read is 0.7 s later
    let fx
    try {
        fx = makeFixture()
    } finally {
        Date.now = real
    }
    try {
        const a = indexSessionDb(path.join(fx.sessionsDir, "aaaaaaaaaaaaaaaa.db")).find((s) => s.id === SES_MAIN)
        const b = indexSessionDb(path.join(fx.sessionsDir, "aaaaaaaaaaaaaaaa__wt1.db")).find((s) => s.id === SES_MAIN)
        assert.ok(a && b)
        assert.equal(stepCount(mergeSession([a, b]).steps), 4, "3 shared + 1 unique step")
    } finally {
        fx.cleanup()
    }
})
