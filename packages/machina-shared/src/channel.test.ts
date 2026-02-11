import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ChannelRegistry, ChannelRuntimeError } from "./channel"
import { createDefaultChannelConnectors } from "./connectors"

function makeRegistry(storageDir: string): ChannelRegistry {
  const registry = new ChannelRegistry({ storageDir })
  for (const connector of createDefaultChannelConnectors()) {
    registry.register(connector)
  }
  return registry
}

test("matrix and discord connectors run connect -> status -> disconnect", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-channel-lifecycle-"))

  try {
    const registry = makeRegistry(storageDir)

    const matrixConnected = await registry.connect({
      channelId: "ops-room",
      connectorId: "matrix",
      config: {
        homeserverUrl: "https://matrix.example.org",
        userId: "@machina:example.org",
        roomId: "!ops-room:example.org",
        accessToken: "matrix-token-12345",
      },
    })

    expect(matrixConnected.status).toBe("connected")
    expect(matrixConnected.connectorId).toBe("matrix")
    expect(matrixConnected.details?.accountId).toBe("@machina:example.org")

    const matrixStatus = await registry.status("ops-room")
    expect(matrixStatus.status).toBe("connected")
    expect(matrixStatus.connectorId).toBe("matrix")

    const matrixDisconnected = await registry.disconnect("ops-room")
    expect(matrixDisconnected.status).toBe("disconnected")
    expect(matrixDisconnected.connectorId).toBe("matrix")

    const discordConnected = await registry.connect({
      channelId: "alerts-room",
      connectorId: "discord",
      config: {
        guildId: "guild-42",
        channelId: "alerts",
        botToken: "discord-token-12345",
      },
    })

    expect(discordConnected.status).toBe("connected")
    expect(discordConnected.connectorId).toBe("discord")
    expect(discordConnected.details?.endpoint).toBe("discord://guild-42/alerts")

    const discordDisconnected = await registry.disconnect("alerts-room")
    expect(discordDisconnected.status).toBe("disconnected")
    expect(discordDisconnected.connectorId).toBe("discord")
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("channel state restores after registry restart", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-channel-restore-"))

  try {
    const first = makeRegistry(storageDir)
    await first.connect({
      channelId: "prod-ops",
      connectorId: "matrix",
      config: {
        homeserverUrl: "https://matrix.example.org",
        userId: "@restore:example.org",
        roomId: "!restore:example.org",
        accessToken: "matrix-restore-token",
      },
    })

    const second = makeRegistry(storageDir)
    const restored = await second.status("prod-ops")

    expect(restored.status).toBe("connected")
    expect(restored.connectorId).toBe("matrix")
    expect(restored.details?.accountId).toBe("@restore:example.org")
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("invalid credentials fail deterministically without secret echo", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-channel-invalid-"))
  const leakedSecret = "invalid-super-secret-token"

  try {
    const registry = makeRegistry(storageDir)

    let errorCode = ""
    let errorMessage = ""
    try {
      await registry.connect({
        channelId: "security-room",
        connectorId: "discord",
        config: {
          guildId: "guild-sec",
          channelId: "security",
          botToken: leakedSecret,
        },
      })
    } catch (error) {
      const normalized = error as ChannelRuntimeError
      errorCode = normalized.code
      errorMessage = normalized.message
    }

    expect(errorCode).toBe("INVALID_CREDENTIALS")
    expect(errorMessage).toContain("Authentication failed for discord")
    expect(errorMessage.includes(leakedSecret)).toBe(false)

    const status = await registry.status("security-room")
    expect(status.status).toBe("disconnected")
    expect(status.error?.code).toBe("INVALID_CREDENTIALS")
    expect((status.error?.message ?? "").includes(leakedSecret)).toBe(false)
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("disconnect is idempotent and does not mutate disconnected state", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-channel-idempotent-disconnect-"))

  try {
    const registry = makeRegistry(storageDir)

    await registry.connect({
      channelId: "idempotent-room",
      connectorId: "matrix",
      config: {
        homeserverUrl: "https://matrix.example.org",
        userId: "@idempotent:example.org",
        roomId: "!idempotent:example.org",
        accessToken: "matrix-token-idempotent",
      },
    })

    const first = await registry.disconnect("idempotent-room")
    const second = await registry.disconnect("idempotent-room")

    expect(first.status).toBe("disconnected")
    expect(second.status).toBe("disconnected")
    expect(second.connectorId).toBe("matrix")
    expect(second.updatedAt).toBe(first.updatedAt)
    expect(second.error).toBeNull()
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("upstream connector errors are sanitized before throw and persisted status", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-channel-redaction-"))
  const leakedSecret = "secret=super-secret-token-1234567890"

  try {
    const registry = new ChannelRegistry({ storageDir })
    registry.register({
      id: "failing-upstream",
      validateConfig: () => ({ ok: true, config: {} }),
      connect: async () => {
        throw new Error(`upstream auth failed: ${leakedSecret}`)
      },
      disconnect: async () => ({ status: "disconnected" }),
    })

    let errorCode = ""
    let errorMessage = ""
    try {
      await registry.connect({
        channelId: "upstream-room",
        connectorId: "failing-upstream",
        config: {},
      })
    } catch (error) {
      const normalized = error as ChannelRuntimeError
      errorCode = normalized.code
      errorMessage = normalized.message
    }

    expect(errorCode).toBe("CHANNEL_CONNECT_FAILED")
    expect(errorMessage.includes(leakedSecret)).toBe(false)
    expect(errorMessage.includes("[REDACTED]")).toBe(true)

    const status = await registry.status("upstream-room")
    expect(status.status).toBe("disconnected")
    expect(status.error?.code).toBe("CHANNEL_CONNECT_FAILED")
    expect((status.error?.message ?? "").includes(leakedSecret)).toBe(false)
    expect((status.error?.message ?? "").includes("[REDACTED]")).toBe(true)
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("config validation failure returns deterministic validation code", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-channel-config-"))

  try {
    const registry = makeRegistry(storageDir)

    let errorCode = ""
    let errorMessage = ""
    try {
      await registry.connect({
        channelId: "bad-config-room",
        connectorId: "matrix",
        config: {
          homeserverUrl: "https://matrix.example.org",
          userId: "",
          roomId: "",
          accessToken: "matrix-token-12345",
        },
      })
    } catch (error) {
      const normalized = error as ChannelRuntimeError
      errorCode = normalized.code
      errorMessage = normalized.message
    }

    expect(errorCode).toBe("CONFIG_VALIDATION_ERROR")
    expect(errorMessage).toContain("missing userId")
    expect(errorMessage).toContain("missing roomId")
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})
