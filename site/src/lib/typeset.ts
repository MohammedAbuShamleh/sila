// Built from code points so the source stays ASCII (and the characters stay visible in review).
export const NBSP = String.fromCharCode(0x00a0)
const WAW = String.fromCharCode(0x0648)

// Line-break hygiene for copy, without touching its visible text:
// - the conjunction waw written apart before a Latin name would otherwise dangle at a line end;
// - multi-word Latin names ("Claude Code") must not split across lines.
export const typeset = (text: string) =>
  text
    .replace(new RegExp(`(^|\\s)${WAW} (?=\\S)`, 'g'), `$1${WAW}${NBSP}`)
    .replace(/([A-Za-z]) (?=[A-Za-z])/g, `$1${NBSP}`)
