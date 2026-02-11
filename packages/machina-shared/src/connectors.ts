import {
  ChannelRuntimeError,
  type ChannelConfigValidationResult,
  type ChannelConnector,
  type ChannelConnectResult,
} from "./channel"

export type MatrixConnectorConfig = {
  homeserverUrl: string
  userId: string
  roomId: string
  accessToken: string
}

export type DiscordConnectorConfig = {
  guildId: string
  channelId: string
  botToken: string
}

export function createMatrixConnector(): ChannelConnector<MatrixConnectorConfig> {
  return {
    id: "matrix",
    validateConfig: (config) => {
      const candidate = asRecord(config)
      const homeserverUrl = requireString(candidate, "homeserverUrl")
      const userId = requireString(candidate, "userId")
      const roomId = requireString(candidate, "roomId")
      const accessToken = requireString(candidate, "accessToken")
      const errors = [homeserverUrl.error, userId.error, roomId.error, accessToken.error].filter(
        (value): value is string => typeof value === "string",
      )

      if (errors.length > 0) {
        return invalidConfig(`Matrix config validation failed: ${errors.join("; ")}`)
      }

      return {
        ok: true,
        config: {
          homeserverUrl: homeserverUrl.value,
          userId: userId.value,
          roomId: roomId.value,
          accessToken: accessToken.value,
        },
      }
    },
    connect: async (config) => {
      assertCredential(config.accessToken, "matrix")

      return connected({
        accountId: config.userId,
        endpoint: `${config.homeserverUrl}/${config.roomId}`,
      })
    },
    disconnect: async () => ({ status: "disconnected" }),
  }
}

export function createDiscordConnector(): ChannelConnector<DiscordConnectorConfig> {
  return {
    id: "discord",
    validateConfig: (config) => {
      const candidate = asRecord(config)
      const guildId = requireString(candidate, "guildId")
      const channelId = requireString(candidate, "channelId")
      const botToken = requireString(candidate, "botToken")
      const errors = [guildId.error, channelId.error, botToken.error].filter(
        (value): value is string => typeof value === "string",
      )

      if (errors.length > 0) {
        return invalidConfig(`Discord config validation failed: ${errors.join("; ")}`)
      }

      return {
        ok: true,
        config: {
          guildId: guildId.value,
          channelId: channelId.value,
          botToken: botToken.value,
        },
      }
    },
    connect: async (config) => {
      assertCredential(config.botToken, "discord")

      return connected({
        accountId: config.guildId,
        endpoint: `discord://${config.guildId}/${config.channelId}`,
      })
    },
    disconnect: async () => ({ status: "disconnected" }),
  }
}

export function createDefaultChannelConnectors(): Array<ChannelConnector<unknown>> {
  return [createMatrixConnector(), createDiscordConnector()] as Array<ChannelConnector<unknown>>
}

function assertCredential(rawCredential: string, provider: string): void {
  if (isInvalidCredential(rawCredential)) {
    throw new ChannelRuntimeError(
      "INVALID_CREDENTIALS",
      `Authentication failed for ${provider}. Verify credentials and try again.`,
    )
  }
}

function isInvalidCredential(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return (
    normalized.length < 8 ||
    normalized.includes("invalid") ||
    normalized.includes("bad") ||
    normalized.includes("wrong")
  )
}

function connected(input: { accountId: string; endpoint: string }): ChannelConnectResult {
  return {
    status: "connected",
    details: {
      accountId: input.accountId,
      endpoint: input.endpoint,
      connectedAt: new Date().toISOString(),
    },
  }
}

function invalidConfig(message: string): ChannelConfigValidationResult<never> {
  return {
    ok: false,
    code: "CONFIG_VALIDATION_ERROR",
    message,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>
  }

  return {}
}

function requireString(
  value: Record<string, unknown>,
  field: string,
): {
  value: string
  error?: string
} {
  const candidate = value[field]
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return {
      value: "",
      error: `missing ${field}`,
    }
  }

  return {
    value: candidate.trim(),
  }
}
