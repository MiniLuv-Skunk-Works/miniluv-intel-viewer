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
 * `vocabulary` is a Set of words that appear in real EVE item names, fetched
 * from the dashboard. Without it nothing is ever sent - see the note below.
 */
function classify(raw, vocabulary) {
  const text = String(raw ?? "");
  if (!text.trim()) return null;
  if (text.length > 64_000) return null;

  for (const pattern of NEVER) {
    if (pattern.test(text)) return null;
  }

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  // Shape alone is not enough, and this is the whole lesson of this filter.
  // "a number next to a word" also describes a credit card, a phone number, a
  // postcode and a shopping list - all of which an earlier version of this
  // happily forwarded. So a capture must also be written in EVE's vocabulary.
  //
  // No vocabulary means fail closed. Sending nothing is a broken feature;
  // sending someone's clipboard because the word list had not downloaded yet
  // is a breach.
  if (!vocabulary || typeof vocabulary.has !== "function" || vocabulary.size === 0) {
    return null;
  }

  // A single line is the ambiguous case. "Obelisk" is a real EVE word, so the
  // vocabulary check passes it - but so would any one word someone copied for
  // any reason. One line is only accepted if it carries a quantity, which is
  // what makes it a cargo row rather than a word.
  if (lines.length === 1) {
    const only = lines[0];
    const quantified = QTY_TAB.test(only) || QTY_X.test(only) || QTY_LEAD.test(only);
    if (!quantified) return null;
  }

  const isFit = isSlotHeader(lines.find(l => !/^\[.*\]$/.test(l)) ?? lines[0]);

  let itemish = 0;
  let vocabHits = 0;
  for (const line of lines) {
    if (!looksLikeItemLine(line)) continue;
    itemish += 1;
    if (lineIsEveVocabulary(line, vocabulary)) vocabHits += 1;
  }

  if (itemish / lines.length < 0.8) return null;

  // Every line that names something must name something EVE knows about.
  // One unrecognised line is tolerated - a new item after a patch, a typo -
  // but a list of names or groceries fails this outright.
  if (vocabHits < Math.max(1, itemish - 1)) return null;

  return { kind: isFit ? "fit" : "cargo", text };
}

/** Strip quantities and punctuation, then require every remaining word to be
 *  one EVE uses in an item name. */
function lineIsEveVocabulary(line, vocabulary) {
  let name = line.trim();
  if (/^\[.*\]$/.test(name)) return true;          // [Obelisk, fit] / [empty slot]
  if (isSlotHeader(name)) return true;

  name = name.split("\t")[0];                      // "Tritanium\t14,500,000"
  name = name.replace(/^[\d,]+\s*x\s+/i, "");      // "5000 x Foo"
  name = name.replace(/^[\d,]+\s+/, "");           // "5000 Foo"
  name = name.replace(/\s+[\d,]+$/, "");           // "Foo 5000"

  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2);
  if (!words.length) return false;
  return words.every(w => vocabulary.has(w));
}

module.exports = { classify, isSlotHeader, looksLikeItemLine, lineIsEveVocabulary, SLOT_HEADER };
