import { createDefaultChannelConnectors } from "open-machina-shared"

export const defaultsUrl = new URL("../../../config/defaults.json", import.meta.url)

export type PluginMode = "local" | "dev" | "prod"

type PluginModeConfig = {
  source: string
  entry: string
}

type DefaultsConfig = {
  identity: {
    name: string
    marker: string
  }
  version: string
  plugin: {
    name: string
    mode: PluginMode
    modes: Record<PluginMode, PluginModeConfig>
  }
}

export type PluginRegistration = {
  mode: PluginMode
  name: string
  source: string
  entry: string
  resolvedEntry?: string
}

export type PluginStatus =
  | {
      status: "loaded"
      registration: PluginRegistration
    }
  | {
      status: "error"
      code: "INVALID_MODE" | "CONFIG_NOT_FOUND" | "PLUGIN_NOT_FOUND"
      message: string
      hint: string
      registration?: PluginRegistration
    }

type OpenCodePluginInput = {
  directory: string
  worktree: string
  serverUrl: URL
}

type OpenCodeToolContext = {
  sessionID: string
  messageID: string
  agent: string
  directory: string
  worktree: string
}

type OpenCodeTool = {
  description: string
  args: Record<string, unknown>
  execute: (args: Record<string, unknown>, context: OpenCodeToolContext) => Promise<string>
}

type OpenCodeHooks = {
  tool?: Record<string, OpenCodeTool>
  config?: (input: Record<string, unknown>) => Promise<void>
}

export async function info() {
  const config = await getDefaultsConfig()

  return {
    name: config.identity.name,
    marker: config.identity.marker,
    version: config.version,
    defaultsUrl: defaultsUrl.toString(),
  }
}

export function getDefaultsConfig(): Promise<DefaultsConfig> {
  return Bun.file(defaultsUrl).json() as Promise<DefaultsConfig>
}

export async function resolvePluginRegistration(env: NodeJS.ProcessEnv = process.env): Promise<PluginRegistration> {
  const config = await getDefaultsConfig()
  const mode = (env.MACHINA_PLUGIN_MODE || config.plugin.mode) as PluginMode

  if (!isPluginMode(mode)) {
    throw new Error(`Invalid MACHINA_PLUGIN_MODE \"${mode}\". Expected one of: local, dev, prod.`)
  }

  const modeConfig = config.plugin.modes[mode]
  const registration: PluginRegistration = {
    mode,
    name: config.plugin.name,
    source: modeConfig.source,
    entry: modeConfig.entry,
  }

  const overridePath = env.MACHINA_PLUGIN_PATH
  if (overridePath && overridePath.trim().length > 0) {
    registration.resolvedEntry = overridePath
    return registration
  }

  if (mode === "prod") {
    registration.resolvedEntry = modeConfig.entry
    return registration
  }

  const repoRoot = new URL("../../../", import.meta.url)
  registration.resolvedEntry = Bun.fileURLToPath(new URL(modeConfig.entry, repoRoot))

  return registration
}

export async function getPluginStatus(env: NodeJS.ProcessEnv = process.env): Promise<PluginStatus> {
  if (!(await Bun.file(defaultsUrl).exists())) {
    return {
      status: "error",
      code: "CONFIG_NOT_FOUND",
      message: `Machina defaults config not found at ${defaultsUrl.pathname}`,
      hint: "Ensure open-machina/config/defaults.json exists and is readable.",
    }
  }

  let registration: PluginRegistration

  try {
    registration = await resolvePluginRegistration(env)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid plugin mode configuration."
    return {
      status: "error",
      code: "INVALID_MODE",
      message,
      hint: "Set MACHINA_PLUGIN_MODE to local, dev, or prod.",
    }
  }

  if (registration.mode !== "prod") {
    const target = registration.resolvedEntry ?? registration.entry
    const exists = await Bun.file(target).exists()

    if (!exists) {
      return {
        status: "error",
        code: "PLUGIN_NOT_FOUND",
        message: `Plugin entry not found for mode ${registration.mode}: ${target}`,
        hint: "Run `bun --cwd=/Users/hong/machina-project/open-machina run build` or set MACHINA_PLUGIN_PATH to a valid entry file.",
        registration,
      }
    }
  }

  return {
    status: "loaded",
    registration,
  }
}

export async function OpenMachinaPlugin(input: OpenCodePluginInput): Promise<OpenCodeHooks> {
  return {
    tool: {
      open_machina_info: {
        description: "Returns open-machina runtime identity and plugin registration status.",
        args: {},
        execute: async () => {
          const identity = await info()
          const status = await getPluginStatus(process.env)
          return JSON.stringify(
            {
              identity,
              status,
            },
            null,
            2,
          )
        },
      },
      open_machina_connectors: {
        description: "Lists available open-machina channel connectors.",
        args: {},
        execute: async () => {
          const connectors = createDefaultChannelConnectors().map((item) => item.id)
          return JSON.stringify({ connectors }, null, 2)
        },
      },
      open_machina_workspace: {
        description: "Returns OpenCode workspace metadata seen by open-machina plugin.",
        args: {},
        execute: async (_args, ctx) => {
          return JSON.stringify(
            {
              directory: input.directory,
              worktree: input.worktree,
              serverUrl: input.serverUrl.toString(),
              session: {
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                agent: ctx.agent,
              },
            },
            null,
            2,
          )
        },
      },
    },
    config: async (_input) => {
      return
    },
  }
}

export default OpenMachinaPlugin

function isPluginMode(value: string): value is PluginMode {
  return value === "local" || value === "dev" || value === "prod"
}
