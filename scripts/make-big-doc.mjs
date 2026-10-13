// Generates a large markdown fixture (~2600 lines / ~110KB) for performance testing.
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const lines = ['# 性能测试大文档', '', '用于测量大文件的渲染耗时。包含一个 Mermaid 图与大量常规块。', '']
lines.push('```mermaid')
lines.push('flowchart LR')
lines.push('    A[输入] --> B{解析}')
lines.push('    B --> C[渲染]')
lines.push('```')
lines.push('')

const WORDS = '在信息爆炸的时代如何高效地阅读与整理资料成为一项基础能力，' +
  'Markdown 以其简洁的语法和广泛的支持成为书写的事实标准，' +
  '配合本地文件夹管理与全文检索可以构建出完全属于自己的知识库。'

for (let s = 1; s <= 200; s++) {
  lines.push(`## 第 ${s} 节：主题要点`)
  lines.push('')
  lines.push(`${WORDS}${WORDS.slice(0, 40)}（第 ${s} 次重复以构造真实体量的段落。）`)
  lines.push('')
  lines.push('- 要点甲：结构化思考')
  lines.push('- 要点乙：渐进式总结')
  lines.push('- 要点丙：定期回顾')
  lines.push('')
  lines.push(`| 指标 | 第 ${s} 节数值 |`)
  lines.push('| ---- | ---- |')
  lines.push(`| 阅读时长 | ${s} 分钟 |`)
  lines.push(`| 复杂度 | O(log ${s}) |`)
  lines.push('')
  lines.push('```javascript')
  lines.push(`function section${s}(input) {`)
  lines.push(`  const result = input.map(x => x * ${s})`)
  lines.push('  return result.filter(Boolean)')
  lines.push('}')
  lines.push('```')
  lines.push('')
  lines.push(`行内公式 $a_{${s}}^2 + b^2 = c^2$ 与结论文字。`)
  lines.push('')
}

const out = path.resolve(process.cwd(), 'test-library/大文档.md')
writeFileSync(out, lines.join('\n'))
console.log('wrote', out, `${lines.length} lines`)
