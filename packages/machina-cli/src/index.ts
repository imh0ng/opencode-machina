import { spawn } from "node:child_process"
import { once } from "node:events"
import {
  ToolPolicyError,
  ToolRuntimeError,
  ChannelRegistry,
  ChannelRuntimeError,
  WorkflowEngine,
  createMachinaToolRegistry,
  createDefaultChannelConnectors,
  parseConfigJson,
  type WorkflowRunResult,
  brand,
  checkSessionIntegrity,
  compactSessions,
  runMigrations,
  sleepWithSignal,
} from "machina-shared"
import { getPluginStatus, info } from "machina-plugin"

export function banner() {
  return `Welcome to ${brand()}`
}

type CliResult = {
  code: number
  stdout: string
  stderr?: string
}

type StatusWorkflowResult = {
  runtime: string
  pluginStatus: "loaded" | "error"
}

type DoctorWorkflowResult = {
  runtime: string
  plugin: Awaited<ReturnType<typeof getPluginStatus>>
}

type StorageMigrateResult = Awaited<ReturnType<typeof runMigrations>>
type StorageIntegrityResult = Awaited<ReturnType<typeof checkSessionIntegrity>>
type StorageCompactResult = Awaited<ReturnType<typeof compactSessions>>

type CancellationTracker = {
  childPid: number | null
  aliveAfterCleanup: boolean | null
}

type LongRunningPayload = {
  tracker?: CancellationTracker
}

const workflowEngine = createWorkflowEngine()
let toolOperationCounter = 0

export async function runCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<CliResult> {
  const args = normalizeArgs(argv)

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return {
      code: 0,
      stdout: [
        "machina [--version] [status] [doctor --json] [storage migrate|integrity|compact] [workflow list|run|cancel-smoke]",
        "",
        "Commands:",
        "  --version                                  Print Machina identity marker and version",
        "  status                                     Run status workflow",
        "  doctor --json                              Run doctor workflow",
        "  storage migrate                            Run storage migration workflow",
        "  storage integrity                          Run storage integrity workflow",
        "  storage compact                            Run storage compaction workflow",
        "  channel connectors                         List available channel connectors",
        "  channel connect <channel-id> <connector-id> --config-json=<json>",
        "                                             Connect channel using connector and config payload",
        "  channel status <channel-id>                Show current channel connection status",
        "  channel disconnect <channel-id>            Disconnect channel",
        "  workflow list                              List available workflows",
        "  workflow run <workflow-name>               Run workflow by name",
        "  workflow cancel-smoke                      Run deterministic cancellation scenario",
        "  tool list                                  List registered tools and permission classes",
        "  tool run <tool-id>                         Run a tool invocation",
        "                                             --approve=true|false --actor=<id> --operation-id=<id>",
        "                                             --note=<text> (for storage.write-maintenance-marker)",
        "",
        "Flags:",
        "  --storage-dir=<path>                       Override storage root for this invocation",
        "  --cancel-after-ms=<milliseconds>           Cancel workflow after timeout",
      ].join("\n"),
    }
  }

  if (args[0] === "--version" || args[0] === "-v") {
    const metadata = await info()
    return {
      code: 0,
      stdout: `${metadata.marker} ${metadata.name} ${metadata.version}`,
    }
  }

  if (args[0] === "status") {
    const execution = await workflowEngine.run<{ env: NodeJS.ProcessEnv }, StatusWorkflowResult>("status", {
      payload: { env },
    })
    return toCliResult(execution)
  }

  if (args[0] === "doctor" && args[1] === "--json") {
    const execution = await workflowEngine.run<{ env: NodeJS.ProcessEnv }, DoctorWorkflowResult>("doctor", {
      payload: { env },
    })

    return toCliResult(execution)
  }

  if (args[0] === "storage") {
    const storageDir = getStorageDirArg(args)

    if (args[1] === "migrate") {
      const execution = await workflowEngine.run<
        { storageDir?: string; env: NodeJS.ProcessEnv },
        StorageMigrateResult
      >("storage.migrate", {
        payload: { storageDir, env },
      })
      return toCliResult(execution)
    }

    if (args[1] === "integrity") {
      const execution = await workflowEngine.run<
        { storageDir?: string; env: NodeJS.ProcessEnv },
        StorageIntegrityResult
      >("storage.integrity", {
        payload: { storageDir, env },
      })
      return toCliResult(execution)
    }

    if (args[1] === "compact") {
      const execution = await workflowEngine.run<
        { storageDir?: string; env: NodeJS.ProcessEnv },
        StorageCompactResult
      >("storage.compact", {
        payload: { storageDir, env },
      })
      return toCliResult(execution)
    }
  }

  if (args[0] === "channel") {
    const storageDir = getStorageDirArg(args)
    const registry = createChannelRegistry(storageDir)

    if (args[1] === "connectors") {
      return {
        code: 0,
        stdout: JSON.stringify(
          {
            connectors: registry.listConnectors(),
          },
          null,
          2,
        ),
      }
    }

    if (args[1] === "connect") {
      const channelId = args[2]
      const connectorId = args[3]
      if (!channelId || !connectorId) {
        return {
          code: 1,
          stdout: "",
          stderr: "Missing required args. Usage: channel connect <channel-id> <connector-id> --config-json=<json>",
        }
      }

      try {
        const status = await registry.connect({
          channelId,
          connectorId,
          config: parseConfigJson(getStringArg(args, "--config-json=")),
        })

        return {
          code: 0,
          stdout: JSON.stringify(status, null, 2),
        }
      } catch (error) {
        const normalized = normalizeChannelError(error)
        return {
          code: 2,
          stdout: JSON.stringify(
            {
              code: normalized.code,
              message: normalized.message,
            },
            null,
            2,
          ),
          stderr: `${normalized.code}: ${normalized.message}`,
        }
      }
    }

    if (args[1] === "status") {
      const channelId = args[2]
      if (!channelId) {
        return {
          code: 1,
          stdout: "",
          stderr: "Missing required arg. Usage: channel status <channel-id>",
        }
      }

      const status = await registry.status(channelId)
      return {
        code: 0,
        stdout: JSON.stringify(status, null, 2),
      }
    }

    if (args[1] === "disconnect") {
      const channelId = args[2]
      if (!channelId) {
        return {
          code: 1,
          stdout: "",
          stderr: "Missing required arg. Usage: channel disconnect <channel-id>",
        }
      }

      try {
        const status = await registry.disconnect(channelId)
        return {
          code: 0,
          stdout: JSON.stringify(status, null, 2),
        }
      } catch (error) {
        const normalized = normalizeChannelError(error)
        return {
          code: 2,
          stdout: JSON.stringify(
            {
              code: normalized.code,
              message: normalized.message,
            },
            null,
            2,
          ),
          stderr: `${normalized.code}: ${normalized.message}`,
        }
      }
    }
  }

  if (args[0] === "workflow" && args[1] === "list") {
    return {
      code: 0,
      stdout: JSON.stringify(
        {
          workflows: workflowEngine.listWorkflows(),
        },
        null,
        2,
      ),
    }
  }

  if (args[0] === "workflow" && args[1] === "run") {
    const workflowName = args[2]
    if (!workflowName) {
      return {
        code: 1,
        stdout: "",
        stderr: "Missing workflow name. Usage: workflow run <workflow-name>",
      }
    }

    if (workflowName === "long-running") {
      const tracker: CancellationTracker = { childPid: null, aliveAfterCleanup: null }
      const cancelAfterMs = getNumberArg(args, "--cancel-after-ms=")
      const execution = await workflowEngine.run<LongRunningPayload, { note: string }>("long-running", {
        payload: { tracker },
        cancelAfterMs,
      })

      return {
        code: execution.status === "completed" ? 0 : execution.status === "cancelled" ? 130 : 1,
        stdout: JSON.stringify(
          {
            result: execution.result,
            error: execution.error,
            tracker,
            log: execution.log,
          },
          null,
          2,
        ),
      }
    }

    return {
      code: 1,
      stdout: "",
      stderr: `workflow run currently supports: long-running`,
    }
  }

  if (args[0] === "workflow" && args[1] === "cancel-smoke") {
    const cancelAfterMs = getNumberArg(args, "--cancel-after-ms=") ?? 120
    const tracker: CancellationTracker = { childPid: null, aliveAfterCleanup: null }
    const execution = await workflowEngine.run<LongRunningPayload, { note: string }>("long-running", {
      payload: { tracker },
      cancelAfterMs,
    })

    const noOrphan = execution.status === "cancelled" && tracker.childPid !== null && tracker.aliveAfterCleanup === false

    return {
      code: noOrphan ? 0 : 5,
      stdout: JSON.stringify(
        {
          scenario: "workflow.cancel-smoke",
          noOrphan,
          tracker,
          log: execution.log,
          status: execution.status,
          error: execution.error,
        },
        null,
        2,
      ),
      stderr: noOrphan ? undefined : "CANCELLATION_SMOKE_FAILED: orphan process detected or cancellation did not complete",
    }
  }

  if (args[0] === "tool") {
    const registry = createMachinaToolRegistry()

    if (args[1] === "list") {
      return {
        code: 0,
        stdout: JSON.stringify(
          {
            tools: registry.listTools(),
          },
          null,
          2,
        ),
      }
    }

    if (args[1] === "run") {
      const toolId = args[2]
      if (!toolId) {
        return {
          code: 1,
          stdout: "",
          stderr: "Missing tool id. Usage: tool run <tool-id> --approve=true|false --actor=<id>",
        }
      }

      const approve = getBooleanArg(args, "--approve=") ?? false
      const actor = getStringArg(args, "--actor=") ?? "cli-user"
      const operationId = getStringArg(args, "--operation-id=") ?? nextToolOperationId()
      const note = getStringArg(args, "--note=")
      const storageDir = getStorageDirArg(args)
      const input = typeof note === "string" ? ({ note } as Record<string, unknown>) : {}

      try {
        const execution = await registry.execute<Record<string, unknown>, unknown>(toolId, {
          input,
          actor,
          operationId,
          permissionState: {
            privilegedApproved: approve,
          },
          storageDir,
          env,
        })

        return {
          code: 0,
          stdout: JSON.stringify(
            {
              status: "completed",
              operationId,
              actor,
              toolId,
              approved: approve,
              result: execution.output,
              audit: execution.auditRecord ?? null,
            },
            null,
            2,
          ),
        }
      } catch (error) {
        if (error instanceof ToolPolicyError) {
          return {
            code: 3,
            stdout: JSON.stringify(
              {
                code: error.code,
                message: error.message,
                operationId,
                actor,
                action: toolId,
                approved: approve,
              },
              null,
              2,
            ),
            stderr: `${error.code}: ${error.message}`,
          }
        }

        if (error instanceof ToolRuntimeError) {
          return {
            code: 2,
            stdout: JSON.stringify(
              {
                code: error.code,
                message: error.message,
                operationId,
                actor,
                action: toolId,
                approved: approve,
              },
              null,
              2,
            ),
            stderr: `${error.code}: ${error.message}`,
          }
        }

        const message = error instanceof Error ? error.message : String(error)
        return {
          code: 2,
          stdout: JSON.stringify(
            {
              code: "TOOL_EXECUTION_FAILED",
              message,
              operationId,
              actor,
              action: toolId,
              approved: approve,
            },
            null,
            2,
          ),
          stderr: `TOOL_EXECUTION_FAILED: ${message}`,
        }
      }
    }
  }

  return {
    code: 1,
    stdout: "",
    stderr: `Unknown command: ${args.join(" ")}. Try --help.`,
  }
}

function createWorkflowEngine(): WorkflowEngine {
  const engine = new WorkflowEngine()

  engine.register<{ env: NodeJS.ProcessEnv }, StatusWorkflowResult>({
    name: "status",
    run: async ({ payload }) => {
      const plugin = await getPluginStatus(payload.env)
      return {
        runtime: "machina",
        pluginStatus: plugin.status,
      }
    },
  })

  engine.register<{ env: NodeJS.ProcessEnv }, DoctorWorkflowResult>({
    name: "doctor",
    run: async ({ payload }) => {
      const plugin = await getPluginStatus(payload.env)
      return {
        runtime: "machina",
        plugin,
      }
    },
  })

  engine.register<{ storageDir?: string; env: NodeJS.ProcessEnv }, StorageMigrateResult>({
    name: "storage.migrate",
    run: async ({ payload }) => runMigrations({ storageDir: payload.storageDir }, payload.env),
  })

  engine.register<{ storageDir?: string; env: NodeJS.ProcessEnv }, StorageIntegrityResult>({
    name: "storage.integrity",
    run: async ({ payload }) => checkSessionIntegrity(payload.storageDir, payload.env),
  })

  engine.register<{ storageDir?: string; env: NodeJS.ProcessEnv }, StorageCompactResult>({
    name: "storage.compact",
    run: async ({ payload }) => compactSessions(payload.storageDir, payload.env),
  })

  engine.register<LongRunningPayload, { note: string }>({
    name: "long-running",
    run: async ({ signal, payload, addCleanup, throwIfAborted }) => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      })

      if (payload.tracker) {
        payload.tracker.childPid = child.pid ?? null
      }

      addCleanup(async () => {
        await terminateChildProcess(child)
        if (payload.tracker && payload.tracker.childPid !== null) {
          payload.tracker.aliveAfterCleanup = isProcessAlive(payload.tracker.childPid)
        }
      })

      while (true) {
        throwIfAborted()
        await sleepWithSignal(250, signal)
      }
    },
  })

  return engine
}

function toCliResult(execution: WorkflowRunResult<unknown>): CliResult {
  const payload = {
    status: execution.status,
    result: execution.result,
    error: execution.error,
    log: execution.log,
  }

  if (execution.status === "completed") {
    return {
      code: 0,
      stdout: JSON.stringify(payload, null, 2),
    }
  }

  if (execution.status === "cancelled") {
    return {
      code: 130,
      stdout: JSON.stringify(payload, null, 2),
      stderr: execution.error,
    }
  }

  return {
    code: 4,
    stdout: JSON.stringify(payload, null, 2),
    stderr: execution.error,
  }
}

function normalizeArgs(argv: string[]): string[] {
  if (argv.length > 0 && argv[0] === "--") {
    return argv.slice(1)
  }

  return argv
}

function getStorageDirArg(args: string[]): string | undefined {
  for (const arg of args) {
    if (arg.startsWith("--storage-dir=")) {
      const value = arg.slice("--storage-dir=".length)
      return value.length > 0 ? value : undefined
    }
  }

  return undefined
}

function getNumberArg(args: string[], prefix: string): number | undefined {
  for (const arg of args) {
    if (!arg.startsWith(prefix)) {
      continue
    }

    const raw = arg.slice(prefix.length)
    if (raw.length === 0) {
      return undefined
    }

    const value = Number(raw)
    if (Number.isNaN(value) || value < 0) {
      return undefined
    }

    return value
  }

  return undefined
}

function getStringArg(args: string[], prefix: string): string | undefined {
  for (const arg of args) {
    if (!arg.startsWith(prefix)) {
      continue
    }

    const raw = arg.slice(prefix.length)
    return raw.length > 0 ? raw : undefined
  }

  return undefined
}

function getBooleanArg(args: string[], prefix: string): boolean | undefined {
  const value = getStringArg(args, prefix)
  if (typeof value !== "string") {
    return undefined
  }

  if (value === "true") {
    return true
  }

  if (value === "false") {
    return false
  }

  return undefined
}

function nextToolOperationId(): string {
  toolOperationCounter += 1
  return `op-tool-${String(toolOperationCounter).padStart(4, "0")}`
}

function createChannelRegistry(storageDir?: string): ChannelRegistry {
  const registry = new ChannelRegistry({ storageDir })
  for (const connector of createDefaultChannelConnectors()) {
    registry.register(connector)
  }
  return registry
}

function normalizeChannelError(error: unknown): { code: string; message: string } {
  if (error instanceof ChannelRuntimeError) {
    return {
      code: error.code,
      message: error.message,
    }
  }

  if (error instanceof Error) {
    return {
      code: "CHANNEL_RUNTIME_ERROR",
      message: error.message,
    }
  }

  return {
    code: "CHANNEL_RUNTIME_ERROR",
    message: String(error),
  }
}

async function terminateChildProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.killed || child.exitCode !== null) {
    return
  }

  child.kill("SIGTERM")
  const exitedSoftly = await waitForExit(child, 300)
  if (exitedSoftly) {
    return
  }

  child.kill("SIGKILL")
  await waitForExit(child, 300)
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) {
    return true
  }

  const timeoutPromise = new Promise<false>((resolve) => {
    setTimeout(() => resolve(false), timeoutMs)
  })

  const exitPromise = once(child, "exit").then(() => true)
  return Promise.race([exitPromise, timeoutPromise])
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
