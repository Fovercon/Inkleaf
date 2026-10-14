/**
 * 命令注册表：统一分发菜单、工具栏、快捷键和测试钩子触发的操作。
 * 内置命令与插件命令通过同一注册表管理标识、可用性与执行行为。
 */

export interface CommandDef {
  /** 全局唯一 id；插件命令必须以插件 id 为前缀 */
  id: string
  /** 中文标题（命令面板/菜单展示用） */
  title: string
  run: () => void | Promise<void>
  /** 可用性（不可用时菜单置灰/面板隐藏） */
  when?: () => boolean
}

const commands = new Map<string, CommandDef>()

export function registerCommand(def: CommandDef): void {
  if (commands.has(def.id)) {
    throw new Error(`命令已注册：${def.id}`)
  }
  commands.set(def.id, def)
}

export function unregisterCommand(id: string, expected?: CommandDef): void {
  if (!expected || commands.get(id) === expected) commands.delete(id)
}

/** 执行命令；返回是否被识别（未注册返回 false 由调用方兜底） */
export function runCommand(id: string): boolean {
  const cmd = commands.get(id)
  if (!cmd) return false
  try {
    if (cmd.when && !cmd.when()) return true
    Promise.resolve(cmd.run()).catch((err) => console.error(`[commands] ${id} 执行失败`, err))
  } catch (err) {
    console.error(`[commands] ${id} 执行失败`, err)
  }
  return true
}

export function getCommand(id: string): CommandDef | undefined {
  return commands.get(id)
}

export function listCommands(): CommandDef[] {
  return [...commands.values()]
}
