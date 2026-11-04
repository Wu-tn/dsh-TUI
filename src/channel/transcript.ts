/** Backend-neutral transcript limits and text helpers shared by the projector,
 *  the fold pass and the local-output paths. */

export const ARGS_PREVIEW_LIMIT = 160

export const RESULT_PREVIEW_LIMIT = 240

/** Local `!`-command output cap (mirrors the result preview limit). */
export const LOCAL_OUTPUT_LIMIT = 240

/**
 * In-memory transcript window cap. Older rows beyond this count are folded:
 * their full-text fields (assistant/reasoning text, tool args/results) are
 * dropped and only the preview/status metadata kept, so a long merge/deploy
 * turn cannot grow the TUI's RAM without bound. The session log still holds
 * everything (`/export` reads it, `/resume` replays it); the
 * folded row keeps its kind/id so scrolling and selection stay stable.
 */
export const MAX_ROWS = 600

/**
 * Collapse every whitespace run to one space, trim, and clip to `limit`
 * characters — the one-line preview shown on a collapsed card.
 *
 * Bounded on purpose: `replace(/\s+/g, ' ')` allocates a full flattened copy
 * of the WHOLE input, and one tool result can be tens of megabytes (a build
 * log, a minified file). Measured 40 ms per MiB — 360 ms for 10 MiB — on the
 * projector's synchronous path, which is what stalls a turn when a huge
 * result lands. Only the first `limit` flattened characters can ever be
 * shown, so walk the source's whitespace-delimited words and stop as soon as
 * the budget is exceeded. `\S+` and `\s+` are complements in JS regex, so the
 * result is byte-identical to the old whole-string form.
 */
export function preview(text: string, limit: number): string {
  if (text.length === 0) return ''
  let flat = ''
  let exceeded = false
  const words = /\S+/g
  let match: RegExpExecArray | null
  while ((match = words.exec(text)) !== null) {
    if (flat !== '') {
      if (flat.length + 1 > limit) {
        exceeded = true
        break
      }
      flat += ' '
    }
    const word = match[0]
    const room = limit - flat.length
    if (word.length > room) {
      flat += word.slice(0, room)
      exceeded = true
      break
    }
    flat += word
  }
  return exceeded ? `${flat.slice(0, limit)}…` : flat
}

/**
 * One report line that keeps its shape: blank rows stay blank and leading
 * indentation survives; a stray newline still cannot become a second row.
 */
export function previewIndented(text: string, limit: number): string {
  const line = text.replace(/[\r\n]+/gu, ' ').replace(/\s+$/u, '')
  // A truly empty Text node measures as zero height; one no-break space keeps
  // the blank row the report asked for without painting anything.
  if (line === '') return '\u00a0'
  return line.length <= limit ? line : `${line.slice(0, limit)}…`
}

/**
 * Keep local rows inside the transcript budget: drop the oldest `local` block
 * (its title plus its `local-output` lines) until the incoming report fits.
 * A run of headerless `local-output` rows (a `!!` replay with no `local`
 * companion) counts as one block — nothing marks a boundary inside it.
 * Local rows cannot be restored from backend history, so nothing else bounds
 * them — `foldRows` deliberately leaves them alone. Shared by `pushLocal`
 * (channel-side reports) and the projector (backend command reports).
 */
export function trimLocalRows(rows: { kind: string }[], nextLines: number): void {
  let count = rows.reduce((sum, row) => sum + Number(row.kind === 'local' || row.kind === 'local-output'), nextLines)
  for (let i = 0; count > MAX_ROWS && i < rows.length;) {
    if (rows[i]!.kind !== 'local' && rows[i]!.kind !== 'local-output') { i++; continue }
    let end = i + 1
    while (rows[end]?.kind === 'local-output') end++
    count -= end - i
    rows.splice(i, end - i)
  }
}
