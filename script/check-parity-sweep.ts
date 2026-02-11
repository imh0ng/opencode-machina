import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const MATRIX_PATH = resolve(ROOT, ".sisyphus/plans/artifacts/machina-parity-matrix.md")

if (!existsSync(MATRIX_PATH)) {
  console.log("SKIP: parity matrix artifact not found (.sisyphus/plans/artifacts/machina-parity-matrix.md)")
  console.log("SKIP: relying on forbidden-term/typecheck/build/test gates in CI")
  process.exit(0)
}

const lines = readFileSync(MATRIX_PATH, "utf8").split(/\r?\n/)
let start: number | null = null
let end: number | null = null

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i] ?? ""
  if (line.startsWith("| Domain | Audit Source |")) {
    start = i + 2
    continue
  }
  if (start !== null && line.trim() === "Notes for partial/missing handling:") {
    end = i
    break
  }
}

if (start === null || end === null || end < start) {
  console.error("PARITY_SWEEP_FAILED: audit-synthesis section not found")
  process.exit(1)
}

const unresolved: string[] = []
for (const row of lines.slice(start, end)) {
  const cols = row.split("|").map((c) => c.trim())
  if (cols.length < 6) {
    continue
  }
  const classification = (cols[4] ?? "").toLowerCase()
  if (classification === "partial" || classification === "missing") {
    unresolved.push(row)
  }
}

if (unresolved.length > 0) {
  console.error("PARITY_SWEEP_FAILED: unresolved classifications detected")
  for (const row of unresolved) {
    console.error(row)
  }
  process.exit(1)
}

console.log("PARITY_SWEEP_PASS: no partial/missing in audit-synthesis section")
