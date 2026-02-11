import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { banner, runCli } from "./index"

type WorkflowLog = {
  operationId: string
  workflowName: string
  status: string
  startedAt: string
  finishedAt: string
}

test("banner() includes brand", () => {
  expect(banner()).toContain("machina")
})

test("runCli --version prints marker and version", async () => {
  const out = await runCli(["--version"])

  expect(out.code).toBe(0)
  expect(out.stdout.includes("[MACHINA] machina ")).toBe(true)
})

test("runCli workflow list exposes at least five concrete workflows", async () => {
  const out = await runCli(["workflow", "list"])
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as { workflows: string[] }
  expect(payload.workflows).toContain("status")
  expect(payload.workflows).toContain("doctor")
  expect(payload.workflows).toContain("storage.migrate")
  expect(payload.workflows).toContain("storage.integrity")
  expect(payload.workflows).toContain("storage.compact")
  expect(payload.workflows.length).toBeGreaterThanOrEqual(5)
})

test("runCli status workflow includes structured operation log", async () => {
  const out = await runCli(["status"], { MACHINA_PLUGIN_MODE: "local" })
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as {
    status: string
    result: { runtime: string; pluginStatus: string }
    log: WorkflowLog
  }

  expect(payload.status).toBe("completed")
  expect(payload.result.runtime).toBe("machina")
  expect(payload.log.workflowName).toBe("status")
  expect(payload.log.status).toBe("completed")
  expect(payload.log.operationId.startsWith("op-status-")).toBe(true)
  expect(Date.parse(payload.log.startedAt)).toBeGreaterThan(0)
  expect(Date.parse(payload.log.finishedAt)).toBeGreaterThan(0)
})

test("runCli doctor --json reports loaded in local mode with log", async () => {
  const out = await runCli(["doctor", "--json"], { MACHINA_PLUGIN_MODE: "local" })

  expect(out.code).toBe(0)
  const payload = JSON.parse(out.stdout) as {
    status: string
    result: { runtime: string; plugin: { status: string } }
    log: WorkflowLog
  }

  expect(payload.status).toBe("completed")
  expect(payload.result.runtime).toBe("machina")
  expect(payload.result.plugin.status).toBe("loaded")
  expect(payload.log.workflowName).toBe("doctor")
})

test("runCli doctor --json fails with deterministic error on invalid config", async () => {
  const out = await runCli(["doctor", "--json"], { MACHINA_PLUGIN_MODE: "invalid" })

  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as {
    status: string
    result: { plugin: { status: string; code: string; hint: string } }
    log: WorkflowLog
  }

  expect(payload.status).toBe("completed")
  expect(payload.result.plugin.status).toBe("error")
  expect(payload.result.plugin.code).toBe("INVALID_MODE")
  expect(payload.result.plugin.hint.includes("local, dev, or prod")).toBe(true)
  expect(payload.log.operationId.startsWith("op-doctor-")).toBe(true)
})

test("five core workflows run end-to-end through CLI with operation logs", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-cli-workflow-"))

  try {
    const commands: Array<[string[], string]> = [
      [["status"], "status"],
      [["doctor", "--json"], "doctor"],
      [["storage", "migrate", `--storage-dir=${storageDir}`], "storage.migrate"],
      [["storage", "integrity", `--storage-dir=${storageDir}`], "storage.integrity"],
      [["storage", "compact", `--storage-dir=${storageDir}`], "storage.compact"],
    ]

    for (const [argv, workflowName] of commands) {
      const out = await runCli(argv, { MACHINA_PLUGIN_MODE: "local" })
      expect(out.code).toBe(0)

      const payload = JSON.parse(out.stdout) as { status: string; log: WorkflowLog }
      expect(payload.status).toBe("completed")
      expect(payload.log.workflowName).toBe(workflowName)
      expect(payload.log.status).toBe("completed")
      expect(payload.log.operationId.length).toBeGreaterThan(0)
    }
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("runCli workflow cancel-smoke cancels and leaves no orphan process", async () => {
  const out = await runCli(["workflow", "cancel-smoke", "--cancel-after-ms=100"])
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as {
    scenario: string
    noOrphan: boolean
    tracker: { childPid: number | null; aliveAfterCleanup: boolean | null }
    status: string
    log: WorkflowLog
  }

  expect(payload.scenario).toBe("workflow.cancel-smoke")
  expect(payload.status).toBe("cancelled")
  expect(payload.noOrphan).toBe(true)
  expect(payload.tracker.childPid).not.toBeNull()
  expect(payload.tracker.aliveAfterCleanup).toBe(false)
  expect(payload.log.workflowName).toBe("long-running")
  expect(payload.log.status).toBe("cancelled")
  expect(payload.log.operationId.startsWith("op-long-running-")).toBe(true)
})

test("channel connectors command lists matrix and discord", async () => {
  const out = await runCli(["channel", "connectors"])
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as { connectors: string[] }
  expect(payload.connectors).toContain("matrix")
  expect(payload.connectors).toContain("discord")
})

test("channel connect -> status -> disconnect lifecycle works with persisted status", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-cli-channel-lifecycle-"))

  try {
    const connectOut = await runCli([
      "channel",
      "connect",
      "ops-room",
      "matrix",
      `--storage-dir=${storageDir}`,
      '--config-json={"homeserverUrl":"https://matrix.example.org","userId":"@machina:example.org","roomId":"!ops:example.org","accessToken":"matrix-token-12345"}',
    ])
    expect(connectOut.code).toBe(0)

    const connectPayload = JSON.parse(connectOut.stdout) as {
      status: string
      connectorId: string
      details: { accountId: string }
    }
    expect(connectPayload.status).toBe("connected")
    expect(connectPayload.connectorId).toBe("matrix")
    expect(connectPayload.details.accountId).toBe("@machina:example.org")

    const statusAfterRestart = await runCli(["channel", "status", "ops-room", `--storage-dir=${storageDir}`])
    expect(statusAfterRestart.code).toBe(0)

    const statusPayload = JSON.parse(statusAfterRestart.stdout) as {
      status: string
      connectorId: string
      details: { accountId: string }
    }
    expect(statusPayload.status).toBe("connected")
    expect(statusPayload.connectorId).toBe("matrix")
    expect(statusPayload.details.accountId).toBe("@machina:example.org")

    const disconnectOut = await runCli(["channel", "disconnect", "ops-room", `--storage-dir=${storageDir}`])
    expect(disconnectOut.code).toBe(0)

    const disconnectPayload = JSON.parse(disconnectOut.stdout) as { status: string; connectorId: string }
    expect(disconnectPayload.status).toBe("disconnected")
    expect(disconnectPayload.connectorId).toBe("matrix")
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("channel connect invalid credentials returns deterministic non-secret error", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-cli-channel-invalid-"))
  const invalidToken = "invalid-super-secret-token"

  try {
    const out = await runCli([
      "channel",
      "connect",
      "alerts-room",
      "discord",
      `--storage-dir=${storageDir}`,
      `--config-json={"guildId":"guild-1","channelId":"alerts","botToken":"${invalidToken}"}`,
    ])

    expect(out.code).toBe(2)
    expect((out.stderr ?? "")).toContain("INVALID_CREDENTIALS")
    expect((out.stderr ?? "").includes(invalidToken)).toBe(false)

    const payload = JSON.parse(out.stdout) as { code: string; message: string }
    expect(payload.code).toBe("INVALID_CREDENTIALS")
    expect(payload.message).toContain("Authentication failed for discord")
    expect(payload.message.includes(invalidToken)).toBe(false)
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})
