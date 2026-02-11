import { test, expect } from "bun:test"
import { defaultsUrl, getPluginStatus, info, OpenMachinaPlugin, resolvePluginRegistration } from "./index"

test("defaultsUrl points at workspace defaults.json", async () => {
  expect(defaultsUrl.pathname.endsWith("/config/defaults.json")).toBe(true)
  expect(await Bun.file(defaultsUrl).exists()).toBe(true)
})

test("info() returns stable shape", async () => {
  const out = await info()
  expect(out.name).toBe("open-machina")
  expect(out.marker).toBe("[OPEN-MACHINA]")
  expect(out.version.length > 0).toBe(true)
  expect(out.defaultsUrl.includes("defaults.json")).toBe(true)
})

test("resolvePluginRegistration supports local/dev/prod", async () => {
  const local = await resolvePluginRegistration({ MACHINA_PLUGIN_MODE: "local" })
  expect(local.mode).toBe("local")
  expect(local.resolvedEntry?.endsWith("/packages/open-machina-plugin/src/index.ts")).toBe(true)

  const dev = await resolvePluginRegistration({ MACHINA_PLUGIN_MODE: "dev" })
  expect(dev.mode).toBe("dev")
  expect(dev.resolvedEntry?.endsWith("/packages/open-machina-plugin/dist/index.js")).toBe(true)

  const prod = await resolvePluginRegistration({ MACHINA_PLUGIN_MODE: "prod" })
  expect(prod.mode).toBe("prod")
  expect(prod.resolvedEntry).toBe("open-machina-plugin")
})

test("getPluginStatus returns actionable invalid mode error", async () => {
  const out = await getPluginStatus({ MACHINA_PLUGIN_MODE: "broken" })

  expect(out.status).toBe("error")
  if (out.status === "error") {
    expect(out.code).toBe("INVALID_MODE")
    expect(out.hint.includes("local, dev, or prod")).toBe(true)
  }
})

test("OpenMachinaPlugin returns tool hooks compatible with OpenCode", async () => {
  const hooks = await OpenMachinaPlugin({
    directory: "/tmp/project",
    worktree: "/tmp/project",
    serverUrl: new URL("http://localhost:4096"),
  })

  expect(typeof hooks.tool).toBe("object")
  expect(Object.keys(hooks.tool ?? {})).toContain("open_machina_info")
  expect(Object.keys(hooks.tool ?? {})).toContain("open_machina_connectors")
  expect(Object.keys(hooks.tool ?? {})).toContain("open_machina_workspace")

  if (!hooks.tool?.open_machina_info) {
    throw new Error("open_machina_info tool missing")
  }

  const out = await hooks.tool.open_machina_info.execute({}, {
    sessionID: "s-1",
    messageID: "m-1",
    agent: "default",
    directory: "/tmp/project",
    worktree: "/tmp/project",
  })
  const payload = JSON.parse(out) as { identity: { name: string } }
  expect(payload.identity.name).toBe("open-machina")
})
