/**
 * 命令注册表（docs/04 §六）——菜单、工具栏、快捷键、测试钩子的统一分发层。
 * 内置命令与（未来的）插件命令在此同源注册：A2 问题（菜单 switch-case 硬编码）的消解点。
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
    console.warn(`[commands] 重复注册命令: ${def.id}，后注册者生效`)
  }
  commands.set(def.id, def)
}

/** 执行命令；返回是否被识别（未注册返回 false 由调用方兜底） */
export function runCommand(id: string): boolean {
  const cmd = commands.get(id)
  if (!cmd) return false
  if (cmd.when && !cmd.when()) return true // 已识别但当前不可用：吞掉，不执行
  void cmd.run()
  return true
}

export function getCommand(id: string): CommandDef | undefined {
  return commands.get(id)
}

export function listCommands(): CommandDef[] {
  return [...commands.values()]
}
