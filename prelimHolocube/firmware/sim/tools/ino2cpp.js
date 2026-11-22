// ino2cpp: turn an Arduino sketch (.ino) into a .cpp the way the Arduino builder does.
//   * prepends #include <Arduino.h>
//   * generates prototypes for every function defined at global scope, inserted just before the
//     first function definition (so typedefs / structs / globals declared above it are visible)
//   * emits #line directives so compiler diagnostics refer to the original .ino line numbers
//
// Usage: node tools/ino2cpp.js sketch.ino > sketch.cpp
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEYWORDS_NOT_FUNCS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'else', 'do', 'struct', 'class',
  'union', 'enum', 'namespace', 'typedef', 'using', 'static_assert', 'decltype', 'alignas',
]);

/**
 * Blank out comments, string/char literals and preprocessor lines while preserving every newline
 * and the exact length of the text, so offsets in the result map 1:1 onto the original source.
 */
export function sanitize(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  let atLineStart = true;
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      let j = i; while (j < n && src[j] !== '\n') j++;
      blank(i, j); i = j; continue;
    }
    if (c === '/' && c2 === '*') {
      let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2;
      blank(i, j); i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; if (src[j] === '\n') break; j++; }
      blank(i + 1, Math.min(j, n)); i = j + 1; atLineStart = false; continue;
    }
    if (c === 'R' && c2 === '"') { // raw string R"delim( ... )delim"
      const m = /^R"([^()\\ ]{0,16})\(/.exec(src.slice(i, i + 24));
      if (m) {
        const end = src.indexOf(')' + m[1] + '"', i + m[0].length);
        const j = end < 0 ? n : end + m[1].length + 2;
        blank(i + m[0].length, j - 1); i = j; atLineStart = false; continue;
      }
    }
    if (c === '#' && atLineStart) { // preprocessor directive incl. line continuations
      let j = i;
      while (j < n) {
        if (src[j] === '\n') { if (src[j - 1] === '\\' || (src[j - 1] === '\r' && src[j - 2] === '\\')) { j++; continue; } break; }
        j++;
      }
      blank(i, j); i = j; continue;
    }
    if (c === '\n') atLineStart = true;
    else if (c !== ' ' && c !== '\t' && c !== '\r') atLineStart = false;
    i++;
  }
  return out.join('');
}

const lineOf = (src, offset) => { let l = 1; for (let i = 0; i < offset; i++) if (src.charCodeAt(i) === 10) l++; return l; };

/**
 * Find global-scope function definitions.
 * Returns [{name, proto, start, line}] where `start` is the offset of the declaration's first token.
 */
export function findFunctions(src) {
  const s = sanitize(src);
  const n = s.length;
  const funcs = [];
  const declared = new Set(); // names that already have a prototype in the source
  let depth = 0;          // brace depth
  let stmtStart = 0;      // start of the current top-level statement
  const braceKinds = [];  // what each open brace belongs to: 'func' | 'scope' | 'other'
  let i = 0;
  const firstTokenOffset = (from) => { let k = from; while (k < n && /\s/.test(s[k])) k++; return k; };

  while (i < n) {
    const c = s[i];
    if (c === '{') {
      let kind = 'inner';
      if (depth === 0) {
        const head = s.slice(stmtStart, i);
        const trimmed = head.replace(/\s+$/, '');
        kind = 'other';
        if (/(^|\W)(namespace\s*\w*|extern\s*("\s*")?)$/.test(trimmed)) kind = 'scope';
        else if (/\)\s*(const\s*)?(noexcept\s*)?(override\s*)?$/.test(trimmed) ||
                 /\)\s*(__attribute__\s*\(\(.*\)\)\s*)?$/.test(trimmed)) kind = 'func';
        if (kind === 'func') {
          const f = parseFunctionHead(head, stmtStart, s);
          if (f) { f.line = lineOf(src, f.start); funcs.push(f); }
          else kind = 'skipfunc';   // a function body we do not prototype (template, member, ...): still ends the statement
        }
      }
      braceKinds.push(kind);
      if (kind === 'scope') { stmtStart = i + 1; } else depth++;
      i++;
      continue;
    }
    if (c === '}') {
      const kind = braceKinds.pop();
      if (kind !== 'scope') depth--;
      i++;
      if (kind === 'func' || kind === 'skipfunc' || kind === 'scope') stmtStart = i;
      continue;
    }
    if (depth === 0 && c === ';') {
      const stmt = s.slice(stmtStart, i);
      const m = /(\w+)\s*\([^()]*\)\s*(const)?\s*$/.exec(stmt);
      if (m && !/=/.test(stmt.slice(0, m.index)) && !/^\s*typedef/.test(stmt)) declared.add(m[1]);
      stmtStart = i + 1;
    }
    i++;
  }
  // Re-run prototype detection against original text for the chosen ones
  return funcs.filter((f) => !declared.has(f.name));
}

function parseFunctionHead(head, stmtStart, s) {
  // head: text from statement start up to (not incl.) '{'
  // strip trailing qualifiers
  let h = head.replace(/\s+$/, '').replace(/\s*(const|noexcept|override)\s*$/g, '').replace(/\s+$/, '');
  if (!h.endsWith(')')) {
    const attr = /\s*__attribute__\s*\(\(.*\)\)\s*$/.exec(h);
    if (attr) h = h.slice(0, attr.index);
    if (!h.endsWith(')')) return null;
  }
  // find matching '('
  let depth = 0, open = -1;
  for (let k = h.length - 1; k >= 0; k--) {
    if (h[k] === ')') depth++;
    else if (h[k] === '(') { depth--; if (depth === 0) { open = k; break; } }
  }
  if (open < 0) return null;
  const before = h.slice(0, open).replace(/\s+$/, '');
  const nm = /([A-Za-z_~][\w:]*|operator\s*\S+)$/.exec(before);
  if (!nm) return null;
  const name = nm[1];
  if (KEYWORDS_NOT_FUNCS.has(name) || name.includes('::') || name.startsWith('operator') || name.startsWith('~')) return null;
  if (name === 'main') return null;
  const retType = before.slice(0, nm.index).trim();
  if (/(^|\s)template\s*</.test(retType) || /(^|[\s,])(struct|class|union|enum)\s*$/.test(retType)) return null;
  if (/^(else|do)\b/.test(retType)) return null;
  const params = h.slice(open); // "(...)"
  // default arguments: skip prototype generation (definition already acts as a declaration)
  if (/=/.test(params)) return null;
  const start = stmtStart + (head.length - head.trimStart().length);
  const sig = (retType ? retType + ' ' : '') + name + params;
  return { name, proto: sig.replace(/\s+/g, ' ').trim() + ';', start };
}

/** Convert sketch source to C++. Returns { cpp, protoCount, firstFuncLine }. */
export function ino2cpp(source, filename = 'sketch.ino') {
  const funcs = findFunctions(source);
  const base = path.basename(filename).replace(/"/g, '');
  let head = `#include <Arduino.h>\n#line 1 "${base}"\n`;
  if (!funcs.length) return { cpp: head + source + '\n', protoCount: 0, firstFuncLine: 0 };
  // insert prototypes at the start of the line containing the first function definition
  const first = funcs[0];
  const lineStart = source.lastIndexOf('\n', first.start - 1) + 1;
  const before = source.slice(0, lineStart);
  const after = source.slice(lineStart);
  const protoLines = funcs.map((f) => f.proto);
  const firstLine = lineOf(source, lineStart);
  const cpp = head + before + protoLines.join('\n') + '\n' + `#line ${firstLine} "${base}"\n` + after + '\n';
  return { cpp, protoCount: funcs.length, firstFuncLine: firstLine };
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node tools/ino2cpp.js sketch.ino > sketch.cpp'); process.exit(2); }
  process.stdout.write(ino2cpp(fs.readFileSync(file, 'utf8'), file).cpp);
}
