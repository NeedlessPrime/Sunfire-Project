// Checks the bot's instruction and account layouts against the program
// source, so a program change cannot silently break the keeper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONFIG_FIELDS, INSTRUCTIONS } from "../src/program.js";

const src = readFileSync(new URL("../../sunfire-program/programs/sunfire/src/lib.rs", import.meta.url), "utf8");
const pending = src.includes("switchboard_on_demand")
  ? "lib.rs still reads Switchboard; run again once the keeper-fed program is in this repo"
  : false;

const RUST_TYPES = { u8: "u8", u16: "u16", u64: "u64", i64: "i64", bool: "bool", Pubkey: "pubkey", "Vec<u8>": "bytes" };

function fnArgs(name) {
  const m = src.match(new RegExp(`pub fn ${name}(?:<[^>]*>)?\\s*\\(([\\s\\S]*?)\\)\\s*->`));
  assert.ok(m, `pub fn ${name} not found in lib.rs`);
  return splitTopLevel(m[1]).filter((s) => s && !s.startsWith("ctx"))
    .map((s) => { const i = s.indexOf(":"); const t = s.slice(i + 1).trim(); return [s.slice(0, i).trim(), RUST_TYPES[t] ?? t]; });
}

// Splits on commas outside of <...>, so Context<'_, '_, 'info, 'info, X> stays whole.
function splitTopLevel(s) {
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "<") depth++;
    if (ch === ">") depth--;
    if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

function accountsStruct(fnName) {
  const ctx = src.match(new RegExp(`pub fn ${fnName}(?:<[^>]*>)?\\s*\\(\\s*ctx: Context<(?:'_, '_, 'info, 'info, )?(\\w+)`))[1];
  const body = src.match(new RegExp(`pub struct ${ctx}<'info> \\{([\\s\\S]*?)\\n\\}`))[1];
  const out = [];
  let attr = "";
  for (const line of body.split("\n").map((l) => l.trim())) {
    if (line.startsWith("#[account")) attr = line;
    else if (attr && !line.startsWith("pub ") && !line.startsWith("///")) attr += line;
    const f = line.match(/^pub (\w+): (\w+)/);
    if (f) {
      const flags = (f[2] === "Signer" ? "s" : "") + (/\b(mut|init)\b/.test(attr) ? "w" : "");
      out.push(flags ? `${f[1]}:${flags}` : f[1]);
      attr = "";
    }
  }
  return out;
}

for (const name of Object.keys(INSTRUCTIONS)) {
  test(`${name}: args match lib.rs`, { skip: pending }, () => {
    assert.deepEqual(fnArgs(name), INSTRUCTIONS[name].args);
  });
  test(`${name}: accounts match lib.rs`, { skip: pending }, () => {
    assert.deepEqual(accountsStruct(name), INSTRUCTIONS[name].accounts);
  });
}

test("Config layout matches lib.rs", { skip: pending }, () => {
  const body = src.match(/pub struct Config \{([\s\S]*?)\n\}/)[1];
  const fields = [...body.matchAll(/pub (\w+): (\w+)/g)].map(([, n, t]) => [n, RUST_TYPES[t] ?? t]);
  assert.deepEqual(fields, CONFIG_FIELDS);
});

test("the parser itself reads the current lib.rs", () => {
  // Guards the checks above: these two are stable across program versions.
  assert.deepEqual(fnArgs("disarm"), []);
  assert.deepEqual(accountsStruct("disarm"), ["authority:s", "config:w"]);
  assert.deepEqual(accountsStruct("distribute"), INSTRUCTIONS.distribute.accounts);
  assert.deepEqual(fnArgs("execute"), INSTRUCTIONS.execute.args);
  assert.deepEqual(accountsStruct("initialize").slice(0, 2), ["admin:sw", "config:w"]);
});
