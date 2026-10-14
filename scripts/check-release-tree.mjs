// Check tracked release inputs; generated local files and CI proof artifacts are excluded.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const internalFiles = new Set([
  '.zcodeignore',
  'ITERATION-LOG.md',
  'build/icon-prompt.txt',
  'docs/00-五轮调研迭代计划.md',
  'docs/01-功能差距分析.md',
  'docs/02-优化路线方案.md',
  'docs/03-架构设计说明书-现状.md',
  'docs/04-插件化架构设计.md',
  'docs/05-AI时代竞争力战略.md',
  'docs/06-开发日志.md',
])
const internalDirectories = ['.zcode/', 'verify/', 'docs/bugs/']

try {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const tracked = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean)
  const errors = []
  for (const filename of tracked) {
    if (internalFiles.has(filename) || internalDirectories.some(directory =>
      filename === directory.slice(0, -1) || filename.startsWith(directory))) {
      errors.push(`Internal development material is tracked: ${filename}`)
    }
  }

  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  if (pkg.author !== 'Inkleaf contributors') errors.push('package.json author must be Inkleaf contributors')
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    errors.push('package.json must use a stable x.y.z version')
  }
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
    errors.push('package.json and package-lock.json root versions must match')
  }

  if (errors.length) {
    console.error(`Release tree check failed:\n${errors.map(error => `- ${error}`).join('\n')}`)
    process.exitCode = 1
  } else {
    console.log(`Release tree check passed (${tracked.length} tracked files).`)
  }
} catch (error) {
  console.error(`Release tree check could not run: ${error.message}`)
  process.exitCode = 1
}
