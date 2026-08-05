"use strict";
// Deciding what a clipboard capture is, and whether it should leave the machine.
//
// This runs in the VIEWER, deliberately. The alternative - post everything and
// let the server classify - would be simpler and would put every password,
// private message and API key anyone copies onto the dashboard server, where
// it would also land in access logs. Whatever this function rejects never
// leaves the computer.
//
// So the default is reject. Something has to look like EVE data to be sent.

// Must stay identical to isSlotHeader in packages/core/src/parsing/index.ts.
// test-clipboard.js asserts the two agree; if that fails, the dashboard and the
// viewer have started disagreeing about what a fit is.
const SLOT_HEADER =
  /^(?:(?:high|med(?:ium)?|low)\s+power(?:\s+slots?)?|rig(?:\s+slots?)?s?|subsystem(?:\s+slots?)?s?)$/i;

// Lines that look like an EVE inventory row.
const QTY_TAB = /^[^\t]+\t[\d,]+(\t|$)/;        // Tritanium\t14,500,000
const QTY_X = /^[\d,]+\s*x\s+\S/i;              // 5000 x Antimatter Charge L
const QTY_LEAD = /^[\d,]+\s+\S/;                // 5000 Antimatter Charge L
const BARE_ITEM = /^[A-Za-z][A-Za-z0-9 '\-.,/()]{2,60}$/;  // Damage Control II

// Anything matching these is never sent, whatever else it looks like. These are
// the shapes of things people copy that are none of the dashboard's business.
const NEVER = [
  /https?:\/\//i,                    // links
  /^[\w.+-]+@[\w-]+\.\w+$/m,         // email addresses
  /-----BEGIN [A-Z ]+-----/,         // keys and certificates
  /\b[A-Za-z0-9_-]{32,}\b/,          // tokens, hashes, long secrets
  // JSON, but not an EFT fit - those open with "[Obelisk, hauler]", so a bare
  // leading bracket is not enough to go on. Real JSON arrays open with an
  // object, a string or a number.
  /^\s*\{\s*["']/,
  /^\s*\[\s*[{"\d]/,
  /^\s*(?:function|const|let|var|import|class|def|SELECT|<\?php)\b/mi,  // code
  /password|passwd|secret|api[_ -]?key|bearer/i,
];

function isSlotHeader(line) {
  return SLOT_HEADER.test(String(line).trim());
}

function looksLikeItemLine(line) {
  const t = line.trim();
  if (!t) return false;
  if (/^\[.*\]$/.test(t)) return true;              // [Obelisk, fit name]
  if (isSlotHeader(t)) return true;
  if (/^\[empty .* slot\]$/i.test(t)) return true;
  return QTY_TAB.test(t) || QTY_X.test(t) || QTY_LEAD.test(t) || BARE_ITEM.test(t);
}

/**
 * Returns { kind: "fit" | "cargo", text } if this should be sent, or null.
 *
 * kind is decided by the first meaningful line: a slot header means the game
 * gave us a fitting, anything else is treated as cargo.
 */
function classify(raw) {
  const text = String(raw ?? "");
  if (!text.trim()) return null;
  if (text.length > 64_000) return null;

  for (const pattern of NEVER) {
    if (pattern.test(text)) return null;
  }

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  // A single line is the ambiguous case - "Damage Control II" is an item, but
  // so is half the English language. One line is only accepted if it carries a
  // quantity, which prose does not.
  if (lines.length === 1) {
    const only = lines[0];
    const quantified = QTY_TAB.test(only) || QTY_X.test(only) || QTY_LEAD.test(only);
    if (!quantified) return null;
    return { kind: "cargo", text };
  }

  // Otherwise most of it has to read as inventory. A stray line is fine; a
  // paragraph of chat with one item name in it is not.
  const matching = lines.filter(looksLikeItemLine).length;
  if (matching / lines.length < 0.8) return null;

  const first = lines.find(l => !/^\[.*\]$/.test(l)) ?? lines[0];
  return { kind: isSlotHeader(first) ? "fit" : "cargo", text };
}

module.exports = { classify, isSlotHeader, looksLikeItemLine, SLOT_HEADER };
