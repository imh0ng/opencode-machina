import { readdirSync, readFileSync, statSync } from "node:fs"
import { relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "out", "coverage", ".turbo"])
const TEXT_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".yml", ".yaml", ".json", ".svg"])
const PATTERN = /open[\s_-]?claw|borrowed from|derived from|ported from|fork(?:ed)? from|based on|inspired by|adapted from/i

type Match = { file: string; line: number; text: string }
type PathMatch = { file: string; text: string }

const listFiles = (dir: string, acc: string[]): string[] => {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      listFiles(full, acc)
      continue
    }
    if (!entry.isFile()) continue
    const parts = entry.name.split(".")
    const last = parts.length > 1 ? (parts[parts.length - 1] ?? "") : ""
    const ext = last.length > 0 ? `.${last}` : ""
    if (!TEXT_EXTENSIONS.has(ext)) continue
    acc.push(full)
  }
  return acc
}

const contentMatches: Match[] = []
const filePathMatches: PathMatch[] = []
const files = listFiles(ROOT, []).sort((a, b) => a.localeCompare(b))

for (const fullPath of files) {
  const rel = relative(ROOT, fullPath).split(sep).join("/")
  if (PATTERN.test(rel)) {
    filePathMatches.push({ file: rel, text: rel })
  }

  let content = ""
  try {
    const size = statSync(fullPath).size
    if (size > 2_000_000) continue
    content = readFileSync(fullPath, "utf8")
  } catch {
    continue
  }

  const lines = content.split(/\r?\n/)
  lines.forEach((line, i) => {
    if (PATTERN.test(line)) {
      contentMatches.push({ file: rel, line: i + 1, text: line.trimEnd() })
    }
  })
}

contentMatches.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)))
filePathMatches.sort((a, b) => a.file.localeCompare(b.file))

if (contentMatches.length === 0 && filePathMatches.length === 0) {
  console.log("OK: no forbidden terminology found")
  process.exit(0)
}

for (const match of filePathMatches) {
  console.error(`${match.file}:PATH: ${match.text}`)
}
for (const match of contentMatches) {
  console.error(`${match.file}:${match.line}: ${match.text}`)
}

console.error(`FAIL: ${filePathMatches.length + contentMatches.length} forbidden match(es) found`)
process.exit(1)
