import { readFile, rename, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ensureStorageInitialized } from "./storage"

export type ChannelConnectionStatus = "connected" | "disconnected"

export type ChannelConfigValidationResult<Config> =
  | {
      ok: true
      config: Config
    }
  | {
      ok: false
      code: "CONFIG_VALIDATION_ERROR"
      message: string
    }

export type ChannelConnectionDetails = {
  accountId: string
  endpoint: string
  connectedAt: string
}

export type ChannelConnectResult = {
  status: "connected"
  details: ChannelConnectionDetails
}

export type ChannelStatusResult = {
  channelId: string
  connectorId: string | null
  status: ChannelConnectionStatus
  details: ChannelConnectionDetails | null
  updatedAt: string | null
  error: {
    code: string
    message: string
  } | null
}

export type ChannelConnector<Config> = {
  readonly id: string
  validateConfig: (config: unknown) => ChannelConfigValidationResult<Config>
  connect: (config: Config) => Promise<ChannelConnectResult>
  disconnect: () => Promise<{ status: "disconnected" }>
}

export type PersistedChannelState = {
  connectorId: string
  status: ChannelConnectionStatus
  details: ChannelConnectionDetails | null
  updatedAt: string
  error: {
    code: string
    message: string
  } | null
}

type PersistedChannelStateFile = {
  schemaVersion: 1
  channels: Record<string, PersistedChannelState>
}

export class ChannelRuntimeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "ChannelRuntimeError"
    this.code = code
  }
}

export class ChannelRegistry {
  private readonly connectors = new Map<string, ChannelConnector<unknown>>()
  private readonly storageDir?: string
  private loaded = false
  private readonly channelState = new Map<string, PersistedChannelState>()

  constructor(options: { storageDir?: string } = {}) {
    this.storageDir = options.storageDir
  }

  register<Config>(connector: ChannelConnector<Config>): void {
    if (this.connectors.has(connector.id)) {
      throw new ChannelRuntimeError("CONNECTOR_ALREADY_REGISTERED", `Connector already registered: ${connector.id}`)
    }

    this.connectors.set(connector.id, connector as ChannelConnector<unknown>)
  }

  listConnectors(): string[] {
    return [...this.connectors.keys()].sort()
  }

  async connect(input: { channelId: string; connectorId: string; config: unknown }): Promise<ChannelStatusResult> {
    await this.ensureLoaded()
    const connector = this.connectors.get(input.connectorId)
    if (!connector) {
      throw new ChannelRuntimeError("CONNECTOR_NOT_FOUND", `Connector not found: ${input.connectorId}`)
    }

    const validation = connector.validateConfig(input.config)
    if (!validation.ok) {
      throw new ChannelRuntimeError(validation.code, validation.message)
    }

    try {
      const result = await connector.connect(validation.config)
      const persisted: PersistedChannelState = {
        connectorId: input.connectorId,
        status: "connected",
        details: result.details,
        updatedAt: new Date().toISOString(),
        error: null,
      }
      this.channelState.set(input.channelId, persisted)
      await this.persist()
      return this.toStatus(input.channelId, persisted)
    } catch (error) {
      const normalized = normalizeChannelError(error)
      const persisted: PersistedChannelState = {
        connectorId: input.connectorId,
        status: "disconnected",
        details: null,
        updatedAt: new Date().toISOString(),
        error: {
          code: normalized.code,
          message: normalized.message,
        },
      }
      this.channelState.set(input.channelId, persisted)
      await this.persist()
      throw new ChannelRuntimeError(normalized.code, normalized.message)
    }
  }

  async status(channelId: string): Promise<ChannelStatusResult> {
    await this.ensureLoaded()
    const current = this.channelState.get(channelId)
    if (!current) {
      return {
        channelId,
        connectorId: null,
        status: "disconnected",
        details: null,
        updatedAt: null,
        error: null,
      }
    }

    return this.toStatus(channelId, current)
  }

  async disconnect(channelId: string): Promise<ChannelStatusResult> {
    await this.ensureLoaded()
    const current = this.channelState.get(channelId)
    if (!current) {
      return {
        channelId,
        connectorId: null,
        status: "disconnected",
        details: null,
        updatedAt: null,
        error: null,
      }
    }

    if (current.status === "disconnected") {
      return this.toStatus(channelId, current)
    }

    const connector = this.connectors.get(current.connectorId)
    if (!connector) {
      throw new ChannelRuntimeError("CONNECTOR_NOT_FOUND", `Connector not found: ${current.connectorId}`)
    }

    await connector.disconnect()

    const next: PersistedChannelState = {
      connectorId: current.connectorId,
      status: "disconnected",
      details: null,
      updatedAt: new Date().toISOString(),
      error: null,
    }

    this.channelState.set(channelId, next)
    await this.persist()
    return this.toStatus(channelId, next)
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return
    }

    const current = await this.readStateFile()
    for (const [channelId, state] of Object.entries(current.channels)) {
      this.channelState.set(channelId, state)
    }

    this.loaded = true
  }

  private async persist(): Promise<void> {
    const filePath = await this.getStateFilePath()
    const payload: PersistedChannelStateFile = {
      schemaVersion: 1,
      channels: Object.fromEntries(this.channelState.entries()),
    }

    const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
    await rename(tempPath, filePath)
  }

  private async readStateFile(): Promise<PersistedChannelStateFile> {
    const filePath = await this.getStateFilePath()
    if (!(await fileExists(filePath))) {
      return {
        schemaVersion: 1,
        channels: {},
      }
    }

    const raw = await readFile(filePath, "utf8")
    const parsed = JSON.parse(raw) as Partial<PersistedChannelStateFile>
    if (parsed.schemaVersion !== 1 || typeof parsed.channels !== "object" || parsed.channels === null) {
      throw new ChannelRuntimeError("CHANNEL_STATE_INVALID", "Channel state file is invalid")
    }

    return {
      schemaVersion: 1,
      channels: parsed.channels as Record<string, PersistedChannelState>,
    }
  }

  private async getStateFilePath(): Promise<string> {
    const storage = await ensureStorageInitialized(this.storageDir)
    return join(storage.rootDir, "channels-state.json")
  }

  private toStatus(channelId: string, state: PersistedChannelState): ChannelStatusResult {
    return {
      channelId,
      connectorId: state.connectorId,
      status: state.status,
      details: state.details,
      updatedAt: state.updatedAt,
      error: state.error,
    }
  }
}

export function parseConfigJson(value: string | undefined): unknown {
  if (!value) {
    return {}
  }

  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new ChannelRuntimeError("CONFIG_JSON_INVALID", "Invalid JSON value for --config-json")
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function normalizeChannelError(error: unknown): { code: string; message: string } {
  if (error instanceof ChannelRuntimeError) {
    return {
      code: error.code,
      message: sanitizeErrorMessage(error.message),
    }
  }

  if (error instanceof Error) {
    return {
      code: "CHANNEL_CONNECT_FAILED",
      message: sanitizeErrorMessage(error.message),
    }
  }

  return {
    code: "CHANNEL_CONNECT_FAILED",
    message: sanitizeErrorMessage(String(error)),
  }
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/\b(token|secret|password|apikey|api-key|access[_-]?token)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b[a-z0-9_-]{24,}\b/gi, "[REDACTED]")
}
