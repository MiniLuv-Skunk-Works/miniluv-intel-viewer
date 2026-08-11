"use strict";
// The classifier decides what leaves the machine. Its failure modes are not
// symmetric: missing a ship scan is an inconvenience, forwarding a password is
// a breach. The rejection cases matter more than the acceptance ones.
import * as fs from "node:fs";
import * as path from "node:path";
import { classify as classifyRaw, isSlotHeader } from "../src/clipboard-filter";
import { ok } from "./support/assertions";

// A slice of EVE's real vocabulary. The live one comes from the SDE.
const VOCAB = new Set(
  (
    "tritanium pyerite mexallon isogen nocxium zydrine megacyte " +
    "antimatter charge void null javelin imperial navy standard multifrequency microwave " +
    "aurora gleam valkyrie hammerhead damage control ii i expanded cargohold reinforced " +
    "bulkheads shield extender large medium small armor plates steel trimark pump core " +
    "defense field nanite repair paste cap booster electronic hardening superiority " +
    "obelisk charon providence fenrir high power low rig slot subsystem empty adaptive " +
    "invulnerability multispectrum energized membrane coating hardener amplifier item"
  ).split(/\s+/),
);
const classify = (text: unknown) => classifyRaw(text, VOCAB);

console.log("\n=== must NEVER be transmitted ===");
const forbidden = {
  "a password": "hunter2CorrectHorse",
  "a password with a label": "password: swordfish",
  "an API key": "sk-proj-AbCdEf0123456789AbCdEf0123456789AbCdEf",
  "a bearer token": "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "a private key": "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----",
  "a URL": "https://dunk.cincoseis.tech/auth/callback?code=abc123",
  "an email address": "someone@example.com",
  "JSON config": '{"clientSecret":"abcdef","guild":"123"}',
  "source code": "function doThing() { return 42; }",
  "a SQL query": "SELECT * FROM users WHERE id = 1",
  "chat prose": "hey are you around later? we were going to do that thing",
  "a single word": "Obelisk",
  "a sentence with an item name": "I think the Obelisk had Damage Control II fitted honestly",
  empty: "",
  whitespace: "   \n\n  ",
};
for (const [what, text] of Object.entries(forbidden)) {
  const r = classify(text);
  ok("rejects " + what, r === null, r && JSON.stringify(r).slice(0, 90));
}

console.log("\n=== should be sent, as a FIT ===");
const fits = {
  "a ship scan":
    "High Power\nDamage Control II\nLow Power\nReinforced Bulkheads II\nExpanded Cargohold II",
  "medium power variant":
    "Medium Power Slot\nLarge Shield Extender II\nAdaptive Invulnerability Field II",
  "rig section first": "Rig Slot\nMedium Trimark Armor Pump II\nMedium Trimark Armor Pump II",
  "with an EFT header":
    "[Obelisk, hauler]\nHigh Power\nDamage Control II\nLow Power\nExpanded Cargohold II",
  "with empty slots":
    "High Power\n[empty high slot]\nLow Power\nReinforced Bulkheads II\nDamage Control II",
};
for (const [what, text] of Object.entries(fits)) {
  const r = classify(text);
  ok(what + " -> fit", r !== null && r.kind === "fit", r ? r.kind : "rejected");
}

console.log("\n=== should be sent, as CARGO ===");
const cargo = {
  "tab-separated with quantities": "Tritanium\t14,500,000\nPyerite\t3,200,000\nMexallon\t900,000",
  "N x Item form": "5000 x Antimatter Charge L\n120 x Nanite Repair Paste",
  "leading quantity": "5000 Antimatter Charge L\n25 Navy Cap Booster 400",
  "a single quantified line": "291 Electronic Hardening Charge",
  "module list with no slot header":
    "Damage Control II\nExpanded Cargohold II\nReinforced Bulkheads II",
};
for (const [what, text] of Object.entries(cargo)) {
  const r = classify(text);
  ok(what + " -> cargo", r !== null && r.kind === "cargo", r ? r.kind : "rejected");
}

console.log("\n=== the slot-header rule matches the dashboard's ===");
// If these drift, the viewer and the dashboard disagree about what a fit is,
// and captures land in the wrong field with no error anywhere.
const corePath =
  process.env.DASHBOARD_CORE_PARSER ||
  path.join(
    __dirname,
    "..",
    "d5",
    "miniluv-intel-dashboard-main",
    "packages",
    "core",
    "src",
    "parsing",
    "index.ts",
  );
const cases: Array<[string, boolean]> = [
  ["High Power", true],
  ["Medium Power", true],
  ["Med Power", true],
  ["Low Power", true],
  ["High Power Slot", true],
  ["Low Power Slots", true],
  ["Rig Slot", true],
  ["Rigs", true],
  ["Rig", true],
  ["Subsystem", true],
  ["Subsystem Slot", true],
  ["Damage Control II", false],
  ["Cargo", false],
  ["High", false],
  ["Drone Bay", false],
];
for (const [line, expected] of cases) {
  ok(
    `"${line}" -> ${expected ? "header" : "not a header"}`,
    isSlotHeader(line) === expected,
    String(isSlotHeader(line)),
  );
}
if (fs.existsSync(corePath)) {
  const coreSrc = fs.readFileSync(corePath, "utf8");
  ok(
    "dashboard still uses the rule this was copied from",
    /high\|med\(ium\)\?\|low\)\\s\+power/.test(coreSrc.replace(/\s+/g, " ")) ||
      /\(high\|med\(ium\)\?\|low\)/.test(coreSrc),
    "packages/core/src/parsing/index.ts changed - re-check the copy here",
  );
} else {
  console.log("  SKIP  dashboard parser comparison (set DASHBOARD_CORE_PARSER to enable)");
}

console.log("\n=== shape alone is not enough ===");
// Everything here has the shape of "a number next to a word", which an earlier
// version of this filter accepted. That version would have posted all of it.
const shaped = {
  "a credit card": "4111 1111 1111 1111",
  "a phone number": "555 0143",
  "a date of birth": "12 03 1984",
  "a postcode": "75001 Dallas",
  "a street address": "1234 Elm Street\nRockwall TX 75032",
  "a list of names": "alice\nbob\ncharlie",
  "a shopping list": "milk\nbread\neggs",
  "account balances": "Checking\t4,182\nSavings\t19,004",
  "2FA codes": "483920\n771043\n192884",
  "a seed phrase": "abandon ability able about above absent",
  "IP addresses": "192.168.1.5\n10.0.0.14",
};
for (const [what, text] of Object.entries(shaped)) {
  ok("rejects " + what, classify(text) === null, JSON.stringify(classify(text) || {}).slice(0, 70));
}

console.log("\n=== fails closed without the vocabulary ===");
ok(
  "sends nothing before the word list arrives",
  classifyRaw("Tritanium\t14,500,000\nPyerite\t3,200,000", null) === null,
  "a broken feature beats forwarding a clipboard because a fetch was slow",
);
ok(
  "an empty vocabulary is treated as absent",
  classifyRaw("Tritanium\t14,500,000\nPyerite\t3,200,000", new Set()) === null,
);

console.log("\n=== size and shape guards ===");
ok(
  "rejects an enormous clip",
  classify("Tritanium\t1\n".repeat(9000)) === null,
  "a clipboard capture has no business being a megabyte",
);
ok(
  "accepts a realistic cargo hold",
  classify(Array.from({ length: 120 }, (_, i) => `Item\t${i + 1}`).join("\n")) !== null,
);
ok(
  "tolerates one unrecognised line, not many",
  classify("Tritanium\t100\nPyerite\t200\nSomeNewPatchItem\t5") !== null &&
    classify("Tritanium\t100\nQwerty\t1\nAsdfgh\t2\nZxcvbn\t3") === null,
  "a new item after a patch is fine; a list of nonsense is not",
);
