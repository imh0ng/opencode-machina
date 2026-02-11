import { appendFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createDefaultChannelConnectors } from "./connectors"
import { ensureStorageInitialized } from "./storage"

export const AUDIT_LOG_FILE_NAME = "audit-log.jsonl"
export const MAINTENANCE_MARKER_FILE_NAME = "maintenance-marker.txt"

export type ToolCategory = "runtime" | "channel" | "storage"
export type PermissionClass = "safe" | "privileged"

export type PermissionState = {
  privilegedApproved: boolean
}

export type ToolExecutionRequest<Input> = {
  input: Input
  actor: string
  operationId: string
  permissionState: PermissionState
  storageDir?: string
  env?: NodeJS.ProcessEnv
}

export type ElevatedAuditRecord = {
  eventType: "PRIVILEGED_ACTION"
  operationId: string
  actor: string
  timestamp: string
  action: string
  decision: "approved" | "denied"
  category: ToolCategory
  permissionClass: PermissionClass
  status: "succeeded" | "failed" | "blocked"
  inputKeys: string[]
}

export type ToolExecutionResult<Output> = {
  output: Output
  auditRecord?: ElevatedAuditRecord
}

export type ToolDefinition<Input, Output> = {
  readonly id: string
  readonly category: ToolCategory
  readonly permissionClass: PermissionClass
  run: (request: ToolExecutionRequest<Input>) => Promise<Output>
}

export type ToolSummary = {
  id: string
  category: ToolCategory
  permissionClass: PermissionClass
}

export class ToolPolicyError extends Error {
  readonly code: string
  readonly toolId: string
  readonly requiredPermissionClass: PermissionClass

  constructor(toolId: string, requiredPermissionClass: PermissionClass) {
    super(`Policy denied for action '${toolId}': explicit privileged approval is required`)
    this.name = "ToolPolicyError"
    this.code = "POLICY_DENIED"
    this.toolId = toolId
    this.requiredPermissionClass = requiredPermissionClass
  }
}

export class ToolRuntimeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "ToolRuntimeError"
    this.code = code
  }
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition<unknown, unknown>>()

  register<Input, Output>(definition: ToolDefinition<Input, Output>): void {
    if (this.definitions.has(definition.id)) {
      throw new ToolRuntimeError("TOOL_ALREADY_REGISTERED", `Tool already registered: ${definition.id}`)
    }

    this.definitions.set(definition.id, definition as ToolDefinition<unknown, unknown>)
  }

  listTools(): ToolSummary[] {
    return [...this.definitions.values()]
      .map((definition) => ({
        id: definition.id,
        category: definition.category,
        permissionClass: definition.permissionClass,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  async execute<Input, Output>(toolId: string, request: ToolExecutionRequest<Input>): Promise<ToolExecutionResult<Output>> {
    const definition = this.definitions.get(toolId) as ToolDefinition<Input, Output> | undefined
    if (!definition) {
      throw new ToolRuntimeError("TOOL_NOT_FOUND", `Tool not found: ${toolId}`)
    }

    if (definition.permissionClass === "privileged" && !request.permissionState.privilegedApproved) {
      await appendPrivilegedAuditRecord(definition, request, "blocked", "denied")
      throw new ToolPolicyError(definition.id, definition.permissionClass)
    }

    let auditRecord: ElevatedAuditRecord | undefined

    try {
      const output = await definition.run(request)
      if (definition.permissionClass === "privileged") {
        auditRecord = await appendPrivilegedAuditRecord(definition, request, "succeeded", "approved")
      }
      return { output, auditRecord }
    } catch (error) {
      if (definition.permissionClass === "privileged") {
        auditRecord = await appendPrivilegedAuditRecord(definition, request, "failed", "approved")
      }
      throw error
    }
  }
}

export function createMachinaToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()

  registry.register<{}, { ok: true; runtime: "machina" }>({
    id: "runtime.ping",
    category: "runtime",
    permissionClass: "safe",
    run: async () => ({ ok: true, runtime: "machina" }),
  })

  registry.register<{}, { connectors: string[] }>({
    id: "channel.list-connectors",
    category: "channel",
    permissionClass: "safe",
    run: async () => ({
      connectors: createDefaultChannelConnectors()
        .map((connector) => connector.id)
        .sort(),
    }),
  })

  registry.register<{ note?: string }, { status: "written"; markerPath: string }>({
    id: "storage.write-maintenance-marker",
    category: "storage",
    permissionClass: "privileged",
    run: async ({ input, storageDir, env }) => {
      const storage = await ensureStorageInitialized(storageDir, env)
      const markerPath = join(storage.rootDir, MAINTENANCE_MARKER_FILE_NAME)
      const note = typeof input.note === "string" && input.note.trim().length > 0 ? input.note.trim() : "maintenance"
      await writeFile(markerPath, `${note}\n`, "utf8")
      return {
        status: "written",
        markerPath,
      }
    },
  })

  return registry
}

async function appendPrivilegedAuditRecord<Input, Output>(
  definition: ToolDefinition<Input, Output>,
  request: ToolExecutionRequest<Input>,
  status: "succeeded" | "failed" | "blocked",
  decision: "approved" | "denied",
): Promise<ElevatedAuditRecord> {
  const storage = await ensureStorageInitialized(request.storageDir, request.env)
  const record: ElevatedAuditRecord = {
    eventType: "PRIVILEGED_ACTION",
    operationId: request.operationId,
    actor: request.actor,
    timestamp: new Date().toISOString(),
    action: definition.id,
    decision,
    category: definition.category,
    permissionClass: definition.permissionClass,
    status,
    inputKeys: extractInputKeys(request.input),
  }

  const auditPath = join(storage.rootDir, AUDIT_LOG_FILE_NAME)
  await appendFile(auditPath, `${JSON.stringify(record)}\n`, "utf8")
  return record
}

function extractInputKeys(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return []
  }

  return Object.keys(input as Record<string, unknown>).sort()
}
