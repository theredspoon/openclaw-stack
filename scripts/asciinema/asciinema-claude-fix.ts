#!/usr/bin/env bun
// @ts-nocheck

/**
 * strip-cast — Strip problematic terminal escape sequences from asciinema .cast files.
 *
 * When recording TUI apps like Claude Code (which uses Ink), the captured
 * escape sequences can hijack terminal input during `asciinema play`,
 * making Ctrl+C and other controls unresponsive.
 *
 * The main culprits:
 *   - DSR (Device Status Report) requests like ESC[6n cause the terminal
 *     to *respond* with cursor position data injected into stdin, which
 *     collides with asciinema's own input handling.
 *   - Private mode set/reset (DECSET/DECRST) sequences toggle raw mode,
 *     bracketed paste, mouse tracking, focus reporting, etc.
 *   - Kitty keyboard protocol sequences
 *   - OSC sequences (title setting, clipboard, etc.)
 *
 * This script strips all of the above while preserving SGR (colors/styles)
 * and basic cursor movement so playback still looks right.
 */

const USAGE = `
strip-cast — Strip problematic escape sequences from asciinema .cast files

Usage:
  strip-cast <input.cast> [output.cast]
  strip-cast -i <input.cast>

Arguments:
  input.cast          Path to the asciinema recording to clean
  output.cast         Path for the cleaned output (default: <input>-clean.cast)

Options:
  -i, --in-place      Edit the file in place
  -n, --nuke          Nuke ALL escape sequences (leaves only plain text)
  -v, --verbose       Print stats about stripped sequences
  -d, --dry-run       Show what would be stripped without writing
  -h, --help          Show this help message

Examples:
  strip-cast session.cast                    # → session-clean.cast
  strip-cast session.cast cleaned.cast       # → cleaned.cast
  strip-cast -i session.cast                 # overwrite session.cast
  strip-cast -iv session.cast               # in-place + verbose
  strip-cast -n session.cast                 # strip ALL escapes (plain text)
  cat session.cast | strip-cast - > out.cast # read from stdin
`.trim()

// --- Argument parsing ---

const rawArgs = process.argv.slice(2)

if (rawArgs.includes('-h') || rawArgs.includes('--help') || rawArgs.length === 0) {
  console.log(USAGE)
  process.exit(0)
}

// Expand combined short flags: -iv → -i -v
const args: string[] = []
for (const arg of rawArgs) {
  if (/^-[a-z]{2,}$/i.test(arg)) {
    for (const ch of arg.slice(1)) args.push(`-${ch}`)
  } else {
    args.push(arg)
  }
}

const flags = {
  inPlace: args.includes('-i') || args.includes('--in-place'),
  verbose: args.includes('-v') || args.includes('--verbose'),
  dryRun: args.includes('-d') || args.includes('--dry-run'),
  nukeAll: args.includes('-n') || args.includes('--nuke'),
}

const positional = args.filter((a) => !a.startsWith('-'))

if (positional.length === 0) {
  console.error('Error: No input file specified.\n')
  console.log(USAGE)
  process.exit(1)
}

const inputPath = positional[0]
const outputPath = flags.inPlace
  ? inputPath
  : positional[1] ?? inputPath.replace(/\.cast$/, '-clean.cast')

// --- Sequence stripping ---

const stats = {
  privateMode: 0,
  dsr: 0,
  osc: 0,
  kitty: 0,
  cpr: 0,
  fullScreen: 0,
  scrollRegion: 0,
  other: 0,
  total: 0,
}

function count(category: keyof typeof stats) {
  stats[category]++
  stats.total++
  return ''
}

/**
 * Strip problematic sequences while keeping visual ones.
 *
 * What we KEEP:
 *   - SGR (Select Graphic Rendition): ESC[...m — colors, bold, etc.
 *   - CUP (Cursor Position): ESC[...H — cursor movement
 *   - CUU/CUD/CUF/CUB: ESC[...A/B/C/D — cursor up/down/forward/back
 *   - ED (Erase Display): ESC[...J — clear screen
 *   - EL (Erase Line): ESC[...K — clear line
 *   - SU/SD (Scroll): ESC[...S/T — scroll up/down
 *
 * What we STRIP:
 *   - All DECSET/DECRST private modes: ESC[?...h / ESC[?...l
 *   - DSR requests: ESC[6n, ESC[?6n (cause terminal to respond with CPR)
 *   - CPR responses: ESC[row;colR (shouldn't be in output)
 *   - DA (Device Attributes) requests: ESC[c, ESC[>c (prompt responses)
 *   - OSC sequences: ESC]...ST or ESC]...BEL (title, clipboard, etc.)
 *   - DCS sequences: ESC P...ST (device control strings)
 *   - Kitty keyboard protocol: ESC[?...u, ESC[>...u, ESC[=...u
 *   - Window manipulation: ESC[...t
 *   - Application/normal keypad mode: ESC = / ESC >
 *   - Designate character set: ESC ( X / ESC ) X
 *   - Save/restore cursor: ESC 7 / ESC 8
 *   - Set scrolling region: ESC[top;bottomr
 *   - Full reset: ESC c
 */
function stripSequences(data: string): string {
  if (flags.nukeAll) {
    // Nuclear option: strip ALL escape sequences, leave only plain text
    let result = data
    // CSI sequences
    result = result.replace(/\x1b\[[^@-~]*[@-~]/g, () => count('other'))
    // OSC sequences
    result = result.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, () => count('other'))
    // DCS sequences
    result = result.replace(/\x1bP[^\x1b]*\x1b\\/g, () => count('other'))
    // Two-char escapes (ESC + single char)
    result = result.replace(/\x1b[^[\]P]/g, () => count('other'))
    return result
  }

  let result = data

  // --- Order matters: more specific patterns first ---

  // 1. OSC sequences: ESC ] ... (BEL | ESC \)
  result = result.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, () => count('osc'))

  // 2. DCS sequences: ESC P ... ESC \
  result = result.replace(/\x1bP[^\x1b]*\x1b\\/g, () => count('other'))

  // 3. All private mode set/reset: ESC [ ? (params) h/l
  result = result.replace(/\x1b\[\?[\d;]*[hl]/g, () => count('privateMode'))

  // 4. DSR (Device Status Report): ESC [ Ps n  and  ESC [ ? Ps n
  result = result.replace(/\x1b\[\??[\d;]*n/g, () => count('dsr'))

  // 5. CPR (Cursor Position Report): ESC [ row ; col R
  result = result.replace(/\x1b\[\d+;\d+R/g, () => count('cpr'))

  // 6. DA (Device Attributes) requests/responses: ESC [ c / ESC [ > c / ESC [ = c
  result = result.replace(/\x1b\[[>=?]?[\d;]*c/g, () => count('dsr'))

  // 7. Kitty keyboard protocol: ESC [ ? u / ESC [ > u / ESC [ = u / ESC [ < u
  result = result.replace(/\x1b\[[?>=<][\d;]*u/g, () => count('kitty'))

  // 8. Window manipulation: ESC [ ... t
  result = result.replace(/\x1b\[[\d;]*t/g, () => count('other'))

  // 9. Set scrolling region: ESC [ top ; bottom r
  result = result.replace(/\x1b\[\d*;\d*r/g, () => count('scrollRegion'))

  // 10. DECSTBM with no params or single param: ESC [ r / ESC [ Ps r
  result = result.replace(/\x1b\[\d*r/g, () => count('scrollRegion'))

  // 11. Application/normal keypad mode: ESC = / ESC >
  result = result.replace(/\x1b[=>]/g, () => count('other'))

  // 12. Designate character set: ESC ( X / ESC ) X
  result = result.replace(/\x1b[()][A-Z0-9]/g, () => count('other'))

  // 13. Save/restore cursor: ESC 7 / ESC 8
  result = result.replace(/\x1b[78]/g, () => count('other'))

  // 14. Full reset: ESC c (RIS)
  result = result.replace(/\x1bc/g, () => count('fullScreen'))

  // 15. Set/reset mode (non-private): ESC [ Ps h / ESC [ Ps l
  //     e.g. insert mode, linefeed/newline mode
  result = result.replace(/\x1b\[\d*[hl]/g, () => count('other'))

  // 16. Cursor save/restore (ANSI form): ESC [ s / ESC [ u
  //     Be careful not to catch Kitty sequences (already handled above)
  result = result.replace(/\x1b\[s/g, () => count('other'))
  result = result.replace(/\x1b\[u/g, () => count('other'))

  return result
}

// --- Main ---

async function main() {
  let content: string

  if (inputPath === '-') {
    content = await Bun.stdin.text()
  } else {
    const file = Bun.file(inputPath)
    if (!(await file.exists())) {
      console.error(`Error: File not found: ${inputPath}`)
      process.exit(1)
    }
    content = await file.text()
  }

  const lines = content.split('\n')
  const cleaned: string[] = []
  let droppedEvents = 0

  for (const line of lines) {
    if (!line.trim()) {
      cleaned.push(line)
      continue
    }

    // Header line (JSON object) — pass through
    if (line.startsWith('{')) {
      cleaned.push(line)
      continue
    }

    // Event lines: JSON arrays
    try {
      const parsed = JSON.parse(line)

      if (!Array.isArray(parsed)) {
        cleaned.push(line)
        continue
      }

      const [timeOrInterval, type, data] = parsed

      if (type === 'o' && typeof data === 'string') {
        const stripped = stripSequences(data)
        if (stripped.length === 0) {
          droppedEvents++
          continue
        }
        cleaned.push(JSON.stringify([timeOrInterval, type, stripped]))
      } else {
        cleaned.push(line)
      }
    } catch {
      cleaned.push(line)
    }
  }

  const output = cleaned.join('\n')

  if (flags.dryRun) {
    console.log('Dry run — no files written.\n')
    printStats(droppedEvents)
    return
  }

  if (inputPath === '-') {
    process.stdout.write(output)
  } else {
    await Bun.write(outputPath, output)
    console.log(`Wrote cleaned recording to ${outputPath}`)
  }

  if (flags.verbose) {
    printStats(droppedEvents)
  }
}

function printStats(droppedEvents: number) {
  console.log(`\nStripped ${stats.total} sequence(s):`)
  if (stats.privateMode) console.log(`  Private mode (DECSET/DECRST): ${stats.privateMode}`)
  if (stats.dsr) console.log(`  Device status/attributes:     ${stats.dsr}`)
  if (stats.cpr) console.log(`  Cursor position reports:      ${stats.cpr}`)
  if (stats.osc) console.log(`  OSC (title/clipboard/etc):    ${stats.osc}`)
  if (stats.kitty) console.log(`  Kitty keyboard protocol:      ${stats.kitty}`)
  if (stats.scrollRegion) console.log(`  Scroll region changes:        ${stats.scrollRegion}`)
  if (stats.fullScreen) console.log(`  Full terminal reset:          ${stats.fullScreen}`)
  if (stats.other) console.log(`  Other (keypad/charset/etc):   ${stats.other}`)
  if (droppedEvents) console.log(`  Empty events dropped:         ${droppedEvents}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
