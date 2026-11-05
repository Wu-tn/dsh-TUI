/** Shared frame interval for render throttling and animations (~60fps). */
export const FRAME_INTERVAL_MS = 16

/**
 * In-flight pty gate threshold (bytes) for scroll-drain frames — Grok
 * Build's Presenter in_flight gate. While stdout holds more unflushed
 * output than this, drain frames hold off instead of stacking latency
 * into a slow ConPTY/ssh link. Sized above one full-screen diff (~4KB at
 * 100 cols) so the gate only trips on genuine backlog, never on a single
 * in-transit frame.
 */
export const PTY_BACKLOG_BYTES = 8192

/**
 * Hard ceiling (bytes) on in-flight stdout output before the renderer stops
 * painting frames entirely — the bound that `PTY_BACKLOG_BYTES` is NOT.
 *
 * That constant only paces scroll-drain frames: it never stops the frame
 * loop. Nothing else looked at the write buffer either, and no `'drain'`
 * listener existed anywhere, so a terminal that stopped consuming (a
 * backgrounded VS Code window: xterm.js pauses the pty, the ~64KB kernel
 * buffer fills, then every subsequent write piles into this process's
 * memory) accumulated frames without bound. Observed in the field: a task
 * left running in an unfocused VS Code tab for minutes, and switching back
 * froze the whole editor while its renderer chewed through tens of MB of
 * buffered ANSI in one go.
 *
 * 256 KiB is roughly two orders of magnitude above one full-screen diff at
 * 200 columns, so ordinary streaming and scrolling never approach it; it
 * only fires when the terminal is genuinely not draining. Frames skipped
 * behind it are cheap to lose: the screen is a pure function of the tree,
 * and `frontFrame` only advances when a frame is actually written, so the
 * first frame after `drain` diffs against what the terminal really holds.
 */
export const PTY_PAINT_GATE_BYTES = Number(process.env.DSH_TUI_PTY_PAINT_GATE_BYTES) > 0
  ? Number(process.env.DSH_TUI_PTY_PAINT_GATE_BYTES)
  : 256 * 1024
