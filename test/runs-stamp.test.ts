/** Run stats files that change without a visible change of size or modification time. */

import { it } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { RunStore } from "../service/runs.ts"

it("sees an overwrite with the same size inside one file-time tick", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-runs-"))
    try {
        const file = path.join(dir, "stats-pid-4242.json")
        const tick = new Date(Date.now() - 100) // both writes land on the same recent timestamp
        const write = (start: number, calls: number) => {
            fs.writeFileSync(file, JSON.stringify({ session_start: start, updated_at: Date.now(), total_calls: calls }))
            fs.utimesSync(file, tick, tick)
        }
        const store = new RunStore()
        write(1000, 5)
        assert.deepEqual(store.read([dir]).map((r) => r.calls), [5])
        write(2000, 9) // another server overwrites: same length, same mtime
        assert.deepEqual(store.read([dir]).map((r) => r.calls).sort(), [5, 9], "both runs remembered")
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
