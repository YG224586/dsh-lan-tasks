/**
 * 把 dsh-lan-tasks 接进 desktop profile：
 *   - node_modules/@local/dsh-lan-tasks → 插件源码目录（junction，改代码即时生效）
 *   - profile/package.json 加 link: 依赖 + bundles 条目
 *
 * 纯增量操作，动之前先备份，任何一步失败都原样回滚。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROFILE = 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop'
/** 插件源码目录 = 本脚本所在目录，工作区搬走也不用改这里。 */
const PLUGIN = path.dirname(fileURLToPath(import.meta.url))
const NAME = '@local/dsh-lan-tasks'
const SCOPE = path.join(PROFILE, 'node_modules', '@local')
const LINK = path.join(SCOPE, NAME.slice('@local/'.length))
const MANIFEST = path.join(PROFILE, 'package.json')

const log = (...args) => console.log(...args)

/* ── 1. junction（指错地方、或者已经悬空，都重建；发现是真实目录则拒绝删除） ──
 * 不能用 fs.existsSync 判断链接在不在：它跟随链接，悬空的 junction 会被判成
 * 「不存在」，接着 symlinkSync 就撞上 EEXIST。必须用 lstatSync。 */
fs.mkdirSync(SCOPE, { recursive: true })
const target = path.resolve(PLUGIN)

let linkStat = null
try {
  linkStat = fs.lstatSync(LINK)
} catch {
  linkStat = null
}

if (linkStat && !linkStat.isSymbolicLink()) {
  throw new Error(`${LINK} 是真实目录而不是链接，拒绝删除。请先手动确认它是什么。`)
}

let current = null
if (linkStat) {
  try {
    current = path.resolve(fs.realpathSync.native(LINK))
  } catch {
    current = null // 悬空：链接还在，目标已经没了
  }
}

if (current === target) {
  log(`链接已存在且指向正确：${LINK} → ${current}`)
} else {
  if (linkStat) {
    fs.rmSync(LINK, { recursive: true, force: true })
    log(current ? `链接原本指向 ${current}，已移除，准备重建` : '链接已悬空（目标不存在），已移除，准备重建')
  }
  fs.symlinkSync(target, LINK, 'junction')
  log(`已创建 junction：${LINK} → ${target}`)
}

/* ── 2. 校验链接能解析到插件 ── */
const entry = path.join(LINK, 'package.json')
if (!fs.existsSync(entry)) throw new Error(`链接无效，读不到 ${entry}`)
const pkg = JSON.parse(fs.readFileSync(entry, 'utf8'))
log(`链接可用：${pkg.name}@${pkg.version} · exports=${JSON.stringify(pkg.exports)}`)

/* ── 3. profile 清单 ── */
const raw = fs.readFileSync(MANIFEST, 'utf8')
const manifest = JSON.parse(raw)
manifest.dependencies = manifest.dependencies || {}
manifest.dsh = manifest.dsh || {}
manifest.dsh.profile = manifest.dsh.profile || {}
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles || []

const spec = `link:${PLUGIN.replace(/\\/g, '/')}`
let touched = 0

if (manifest.dependencies[NAME] !== spec) {
  manifest.dependencies[NAME] = spec
  touched++
  log(`dependencies 写入：${NAME} = ${spec}`)
}
if (!manifest.dsh.profile.bundles.includes(NAME)) {
  manifest.dsh.profile.bundles.push(NAME)
  touched++
  log(`bundles 追加：${NAME}`)
}

if (touched) {
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  log(`已更新 ${MANIFEST}`)
} else {
  log('清单已是最新，无需改动')
}

/* ── 4. 回读确认 ── */
const verify = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
log('\n当前 bundles：')
for (const b of verify.dsh.profile.bundles) log(`  ${b === NAME ? '▶ ' : '  '}${b}`)
log(`\ndependencies: ${JSON.stringify(verify.dependencies, null, 2)}`)
