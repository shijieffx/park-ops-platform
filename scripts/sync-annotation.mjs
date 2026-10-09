/**
 * 把 Demo B（图像标注工作台）的构建产物同步到 public/annotation/。
 *
 * 为什么放进 public/ 而不是直接拷进 dist/：
 *   部署时托管平台会重新执行 vite build，dist/ 会被清空重建；
 *   而 dist/ 属于构建产物，不会随源码上传到部署环境。
 *   只有 public/ 下的内容既会被上传，又会在构建时自动复制进 dist/。
 *
 * 用法（先构建 Demo B，再同步）：
 *   cd ../demo-annotation && npm run build
 *   cd ../demo-park-ops && npm run sync:annotation
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(__dirname, '..', '..', 'demo-annotation', 'dist')
const DEST = path.resolve(__dirname, '..', 'public', 'annotation')

if (!fs.existsSync(path.join(SRC, 'index.html'))) {
  console.error('未找到 Demo B 的构建产物：' + SRC)
  console.error('请先在 demo-annotation/ 目录下执行 npm run build')
  process.exit(1)
}

/** 手写递归复制：不用 fs.cpSync，部分环境下该调用会被文件代理拦截（EIO） */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name)
    const d = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

fs.rmSync(DEST, { recursive: true, force: true })
copyDir(SRC, DEST)

let count = 0
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(dir, e.name))
    else count++
  }
}
walk(DEST)

console.log('已同步标注工具产物 → ' + DEST)
console.log('文件数：' + count)
