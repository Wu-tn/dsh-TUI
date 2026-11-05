/**
 * PTY 背压闸门回归：终端停止消费时，渲染循环必须停画而不是无限堆积。
 *
 * 现场故障（本脚本锁定的那一条）：任务在跑时切到别的终端，VS Code 的
 * xterm.js 暂停消费 pty，内核缓冲（~64KB）塞满后每一帧都堆进 TUI 进程
 * 内存。`PTY_BACKLOG_BYTES` 只给滚动 drain 帧限速，从不阻止帧循环；全仓
 * 库也没有 'drain' 监听。几分钟后切回，VS Code 渲染进程要一次性解析几十
 * MB ANSI，整个编辑器无响应。
 *
 * 断言：
 *  1. 停滞期间在飞字节有硬上界（不随帧数增长）；
 *  2. 闸门期间几乎不出帧（onFrame 计数远小于 animation tick）；
 *  3. 恢复消费后内容补齐，且与冷渲染一致——丢的是中间帧，不是内容；
 *  4. 正常终端照常出帧（闸门不误伤）。
 *
 * 闸门阈值用 DSH_TUI_PTY_PAINT_GATE_BYTES 调小，让闸门在测试的几秒内
 * 触发；生产默认 256KiB 远高于单帧全屏 diff。
 *
 * 运行：node --import tsx/esm scripts/verify-output-backpressure.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'
process.env.DSH_TUI_PTY_PAINT_GATE_BYTES = '16384'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { default: instances }, { settled, sleep }, { PTY_PAINT_GATE_BYTES, PTY_PAINT_GATE_MAX_DEFER_MS }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/ink/instances.js'),
  import('./lib/term-test.mjs'),
  import('../src/ink/constants.js'),
])

const COLS = 100
const ROWS = 24

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

/**
 * 可控停止消费的 stdout：写入被挂在 `held` 里，直到 release() 才回调。
 * 这正是后台 VS Code 终端的形状——pty 缓冲满了以后 write 不再前推。
 */
class StallingStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  held: Array<() => void> = []
  stalled = false
  peakBacklog = 0

  constructor(private term: XTerm.Terminal) {
    super({ highWaterMark: 4096 })
  }

  override _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void {
    if (this.stalled) {
      this.held.push(cb)
      return
    }
    this.term.write(String(chunk), cb)
  }

  release(): void {
    this.stalled = false
    const held = this.held
    this.held = []
    for (const cb of held) cb()
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void): void { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

function makeChannel() {
  const rows: any[] = []
  let id = 0
  for (let t = 0; t < 8; t++) {
    rows.push({ id: id++, kind: 'user', text: `问题 ${t}` })
    rows.push({ id: id++, kind: 'assistant', text: `回答 ${t}：\n\n- 甲\n- 乙\n- 丙`, streaming: false })
  }
  const tail: any = { id: id++, kind: 'assistant', text: '初始内容', streaming: true }
  rows.push(tail)
  const listeners = new Set<() => void>()
  const channel: any = {
    whaleIdle: false,
    version: 0, rows, status: 'running', sessionTitle: 'backpressure', agentId: 'x',
    model: 'deepseek-v4-flash', reasoningEffort: 'max', tokens: { input: 1, output: 1 },
    cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main', working: true,
    spinnerMode: 'streaming', responseChars: 0, activeToolCount: 0, turnStart: Date.now(),
    lastUserText: 'x',
    pending: [], commandList: [], notifications: [], mode: { plan: false }, effortLevels: undefined,
    subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
    submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
    listModels: () => Promise.resolve([]), listSessions: () => [], setResumeTarget: () => {},
    loadOlder: () => {}, mcpStatus: () => [],
  }
  const notify = () => { channel.version++; for (const cb of listeners) cb() }
  return { channel, tail, notify }
}

async function mountChat(onFrame?: () => void) {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new StallingStdout(term)
  const { channel, tail, notify } = makeChannel()
  await render(
    <AlternateScreen>
      <Chat channel={channel} questionStore={new QuestionStore()} fullscreen />
    </AlternateScreen>,
    {
      stdout: stdout as any,
      stdin: new FakeStdin() as any,
      stderr: new FakeStderr() as any,
      exitOnCtrlC: false,
      patchConsole: false,
      ...(onFrame === undefined ? {} : { onFrame }),
    },
  )
  const ink: any = instances.get(stdout)
  ink.setAltScreenActive(true, true)
  return {
    term, stdout, ink, channel, tail, notify,
    lines: () => {
      const b = term.buffer.active
      const out: string[] = []
      for (let y = 0; y < ROWS; y++) out.push((b.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
      return out
    },
  }
}

check('回归用闸门阈值已调小', PTY_PAINT_GATE_BYTES === 16384, `gate=${PTY_PAINT_GATE_BYTES}`)

// ===================== 1. 停滞期间不无限堆积 =====================
const frames: number[] = []
const streaming = await mountChat(() => frames.push(Date.now()))
check('baseline paints', await settled(() => frames.length > 2), `frames=${frames.length}`)

streaming.stdout.stalled = true
// 先把在飞字节推到闸门之上（帧很小，需要若干帧才累积到阈值）。
const t0 = Date.now()
while (Date.now() - t0 < 3000 && streaming.stdout.writableLength <= PTY_PAINT_GATE_BYTES) {
  streaming.tail.text = `流式内容 ${Date.now() % 100000} `.repeat(12)
  streaming.notify()
  await sleep(16) // 固定窗:pacing 模拟 60fps 流式节奏，直到积压越过闸门
}
const stalledBacklog = streaming.stdout.writableLength
check('停滞期间在飞字节到达并停在上界', stalledBacklog >= PTY_PAINT_GATE_BYTES && stalledBacklog <= PTY_PAINT_GATE_BYTES + 8 * 1024, `writableLength=${(stalledBacklog / 1024).toFixed(0)}KB gate=${(PTY_PAINT_GATE_BYTES / 1024).toFixed(0)}KB`)

// 越过闸门后继续猛推 1.2s：帧必须被节流到「每个 MAX_DEFER 窗口最多一帧」，
// 且字节不再无界增长（关键：不能像闸门早期版本那样等到 drain 才画——那在
// 会做流控的终端上就是「彻底卡住，过一会一次性冒出来」）。
const framesAtGate = frames.length
const backlogAtGate = stalledBacklog
const GATE_WINDOW_MS = 1200
const t1 = Date.now()
while (Date.now() - t1 < GATE_WINDOW_MS) {
  streaming.tail.text = `闸门后内容 ${Date.now() % 100000} `.repeat(12)
  streaming.notify()
  await sleep(16) // 固定窗:pacing 闸门后继续按 60fps 推流，观察帧节流
}
const framesAfterGate = frames.length - framesAtGate
const backlogAfterGate = streaming.stdout.writableLength
// 60fps 无节流 = 约 72 帧；闸门有效则应只剩每 120ms 一帧（≈10）。
check('闸门把帧节流到 MAX_DEFER 节奏', framesAfterGate <= Math.ceil(GATE_WINDOW_MS / PTY_PAINT_GATE_MAX_DEFER_MS) + 3, `frames=${framesAfterGate} (无节流约 ${Math.ceil(GATE_WINDOW_MS / 16)} 帧)`)
check('闸门仍在出帧（不会彻底卡死）', framesAfterGate >= 2, `frames=${framesAfterGate}`)
check('闸门后帧间隔不小于 MAX_DEFER', (() => {
  const at = frames.slice(framesAtGate)
  if (at.length < 2) return true
  const gaps = at.slice(1).map((t, i) => t - at[i])
  return Math.min(...gaps) >= PTY_PAINT_GATE_MAX_DEFER_MS - 25
})(), `minGap=${(() => { const at = frames.slice(framesAtGate); if (at.length < 2) return 'n/a'; return Math.min(...at.slice(1).map((t, i) => t - at[i])) })()}ms`)
check('在飞字节仍然有界', backlogAfterGate <= backlogAtGate + 64 * 1024, `${(backlogAtGate / 1024).toFixed(0)}KB -> ${(backlogAfterGate / 1024).toFixed(0)}KB`)

// ===================== 2. 恢复后补齐 =====================
streaming.stdout.release()
const FINAL = '恢复后的最终内容 FINAL-MARK'
streaming.tail.text = FINAL
streaming.notify()
check('恢复后新内容落屏', await settled(() => streaming.lines().some(l => l.includes('FINAL-MARK')), { timeoutMs: 8000 }))
check('恢复后重复内容只有一份', streaming.lines().filter(l => l.includes('FINAL-MARK')).length === 1)
check('恢复后 drain 监听已释放', await settled(() => streaming.stdout.writableLength === 0, { timeoutMs: 8000 }))

// 收尾到静止态后再比对：让两侧都停下 working 动画，消除时间相关文本。
for (const app of [streaming]) {
  app.channel.working = false
  app.channel.status = 'idle'
  app.channel.spinnerMode = 'idle'
  app.tail.text = FINAL
  app.tail.streaming = false
  app.notify()
}
await settled(() => !streaming.lines().some(l => l.includes('工作中')), { timeoutMs: 8000 })
const warmTail = streaming.lines().slice(-8)
streaming.ink.unmount()
// 固定窗:pacing unmount 的收尾写出没有完成回调可等
await sleep(200)

const cold = await mountChat()
cold.channel.working = false
cold.channel.status = 'idle'
cold.channel.spinnerMode = 'idle'
cold.tail.text = FINAL
cold.tail.streaming = false
cold.notify()
await settled(() => cold.lines().some(l => l.includes('FINAL-MARK')), { timeoutMs: 8000 })
const coldTail = cold.lines().slice(-8)
check('恢复后的尾部屏幕 == 冷渲染', warmTail.join('\n') === coldTail.join('\n'))
if (warmTail.join('\n') !== coldTail.join('\n')) {
  for (let i = 0; i < Math.max(warmTail.length, coldTail.length); i++) {
    if (warmTail[i] !== coldTail[i]) console.log(`  row ${i}\n   warm=${JSON.stringify(warmTail[i])}\n   cold=${JSON.stringify(coldTail[i])}`)
  }
}
cold.ink.unmount()
// 固定窗:pacing unmount 的收尾写出没有完成回调可等
await sleep(200)

// ===================== 3. 正常终端不被误伤 =====================
const healthyFrames: number[] = []
const healthy = await mountChat(() => healthyFrames.push(Date.now()))
const healthyStart = healthyFrames.length
check('正常终端照常出帧（闸门不误伤）', await settled(() => healthyFrames.length > healthyStart), `frames=${healthyFrames.length - healthyStart}`)
check('正常终端不积压', healthy.stdout.writableLength === 0, `writableLength=${healthy.stdout.writableLength}`)
healthy.ink.unmount()

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
