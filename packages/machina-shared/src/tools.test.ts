import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AUDIT_LOG_FILE_NAME,
  MAINTENANCE_MARKER_FILE_NAME,
  ToolPolicyError,
  createMachinaToolRegistry,
} from "./tools"

test("privileged tool denies without explicit approval and records denied audit", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-tools-denied-"))

  try {
    const registry = createMachinaToolRegistry()
    let code = ""
    let message = ""

    try {
      await registry.execute("storage.write-maintenance-marker", {
        input: { note: "token-secret-123" },
        actor: "test-agent",
        operationId: "op-tools-denied-0001",
        permissionState: { privilegedApproved: false },
        storageDir,
      })
    } catch (error) {
      const normalized = error as ToolPolicyError
      code = normalized.code
      message = normalized.message
    }

    expect(code).toBe("POLICY_DENIED")
    expect(message).toBe("Policy denied for action 'storage.write-maintenance-marker': explicit privileged approval is required")

    expect(await fileExists(join(storageDir, MAINTENANCE_MARKER_FILE_NAME))).toBe(false)

    const auditLines = (await readFile(join(storageDir, AUDIT_LOG_FILE_NAME), "utf8")).trim().split("\n")
    expect(auditLines).toHaveLength(1)
    const audit = JSON.parse(auditLines[0] ?? "{}") as {
      operationId: string
      actor: string
      action: string
      decision: string
      status: string
      inputKeys: string[]
      timestamp: string
    }
    expect(audit.operationId).toBe("op-tools-denied-0001")
    expect(audit.actor).toBe("test-agent")
    expect(audit.action).toBe("storage.write-maintenance-marker")
    expect(audit.decision).toBe("denied")
    expect(audit.status).toBe("blocked")
    expect(audit.inputKeys).toEqual(["note"])
    expect(Date.parse(audit.timestamp)).toBeGreaterThan(0)
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("privileged tool approved path writes marker and appends approved audit without secrets", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-tools-approved-"))
  const secretNote = "token-super-secret-987"

  try {
    const registry = createMachinaToolRegistry()
    const result = await registry.execute<{ note: string }, { status: string; markerPath: string }>(
      "storage.write-maintenance-marker",
      {
        input: { note: secretNote },
        actor: "test-agent",
        operationId: "op-tools-approved-0001",
        permissionState: { privilegedApproved: true },
        storageDir,
      },
    )

    expect(result.output.status).toBe("written")
    expect(await fileExists(result.output.markerPath)).toBe(true)

    const auditRaw = await readFile(join(storageDir, AUDIT_LOG_FILE_NAME), "utf8")
    const auditLines = auditRaw.trim().split("\n")
    expect(auditLines).toHaveLength(1)
    const audit = JSON.parse(auditLines[0] ?? "{}") as {
      operationId: string
      actor: string
      action: string
      decision: string
      status: string
      inputKeys: string[]
      timestamp: string
    }

    expect(audit.operationId).toBe("op-tools-approved-0001")
    expect(audit.actor).toBe("test-agent")
    expect(audit.action).toBe("storage.write-maintenance-marker")
    expect(audit.decision).toBe("approved")
    expect(audit.status).toBe("succeeded")
    expect(audit.inputKeys).toEqual(["note"])
    expect(Date.parse(audit.timestamp)).toBeGreaterThan(0)
    expect(auditRaw.includes(secretNote)).toBe(false)
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("safe tool runs without privileged approval", async () => {
  const registry = createMachinaToolRegistry()
  const result = await registry.execute("runtime.ping", {
    input: {},
    actor: "test-agent",
    operationId: "op-tools-safe-0001",
    permissionState: { privilegedApproved: false },
  })

  expect(result.output).toEqual({ ok: true, runtime: "machina" })
})

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
