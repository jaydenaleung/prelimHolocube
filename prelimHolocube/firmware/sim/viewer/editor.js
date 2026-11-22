// Lightweight code editor: <textarea> over a syntax-highlighted <pre>, with line numbers and error underlines.
const KEYWORDS = new Set(('auto break case char class const constexpr continue default do double else enum extern float for goto if inline int long namespace new operator private public register return short signed sizeof static struct switch template this typedef union unsigned using virtual void volatile while bool true false nullptr size_t').split(' '));
const TYPES = new Set(('uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t byte word boolean String SPISettings SPIClass HardwareSerial').split(' '));
const ARDUINO = new Set(('setup loop pinMode digitalWrite digitalRead delay delayMicroseconds millis micros Serial SPI HIGH LOW OUTPUT INPUT MSBFIRST LSBFIRST SPI_MODE0 PI map random constrain min max abs F').split(' '));

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|(^[ \t]*#[^\n]*)|(\b0[xX][0-9a-fA-F]+[uUlL]*\b|\b\d+\.?\d*(?:[eE][+-]?\d+)?[fFuUlL]*\b)|([A-Za-z_]\w*)/gm;

export function highlight(src) {
  let out = '', last = 0, m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(src))) {
    out += esc(src.slice(last, m.index));
    const t = m[0];
    let cls = null;
    if (m[1] !== undefined) cls = 'c';
    else if (m[2] !== undefined) cls = 's';
    else if (m[3] !== undefined) cls = 'p';
    else if (m[4] !== undefined) cls = 'n';
    else if (KEYWORDS.has(t)) cls = 'k';
    else if (TYPES.has(t)) cls = 't';
    else if (ARDUINO.has(t)) cls = 'a';
    out += cls ? `<span class="tok-${cls}">${esc(t)}</span>` : esc(t);
    last = m.index + t.length;
    if (t.length === 0) TOKEN.lastIndex++;
  }
  return out + esc(src.slice(last));
}

export class Editor {
  /** @param {HTMLElement} root  container; the editor builds its own children */
  constructor(root, { onChange = () => {}, onRun = () => {} } = {}) {
    this.onChange = onChange; this.onRun = onRun;
    root.classList.add('ed');
    root.innerHTML = `
      <div class="ed-gutter" aria-hidden="true"><div class="ed-gutter-inner"></div></div>
      <div class="ed-body">
        <pre class="ed-layer ed-hl" aria-hidden="true"></pre>
        <pre class="ed-layer ed-marks" aria-hidden="true"></pre>
        <textarea class="ed-input" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off" aria-label="Firmware source code"></textarea>
      </div>`;
    this.gutter = root.querySelector('.ed-gutter');
    this.gutterInner = root.querySelector('.ed-gutter-inner');
    this.hl = root.querySelector('.ed-hl');
    this.marksEl = root.querySelector('.ed-marks');
    this.ta = root.querySelector('.ed-input');
    this.marks = [];
    this.ta.addEventListener('input', () => { this._render(); this.onChange(this.ta.value); });
    this.ta.addEventListener('scroll', () => this._sync());
    this.ta.addEventListener('keydown', (e) => this._key(e));
    root.addEventListener('dragover', (e) => { e.preventDefault(); root.classList.add('drop'); });
    root.addEventListener('dragleave', () => root.classList.remove('drop'));
    root.addEventListener('drop', async (e) => {
      e.preventDefault(); root.classList.remove('drop');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) this.onFile && this.onFile(f.name, await f.text());
    });
    this._render();
  }

  get value() { return this.ta.value; }
  set value(v) { this.ta.value = v; this._render(); }

  _key(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); this.onRun(); return; }
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const ta = this.ta, s = ta.selectionStart, en = ta.selectionEnd;
      ta.setRangeText('  ', s, en, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  }

  _sync() {
    const t = this.ta;
    this.hl.scrollTop = this.marksEl.scrollTop = t.scrollTop;
    this.hl.scrollLeft = this.marksEl.scrollLeft = t.scrollLeft;
    this.gutterInner.style.transform = `translateY(${-t.scrollTop}px)`;
  }

  _render() {
    const src = this.ta.value;
    this.hl.innerHTML = highlight(src) + '\n';
    const n = src.split('\n').length;
    if (n !== this._lines) {
      this._lines = n;
      let g = '';
      for (let i = 1; i <= n; i++) g += `<div class="ln" data-ln="${i}">${i}</div>`;
      this.gutterInner.innerHTML = g;
    }
    this._renderMarks();
    this._sync();
  }

  /** marks: [{line, col, sev: 'error'|'warning'}] (1-based). Draws wavy underlines under the offending token. */
  setMarks(marks) { this.marks = marks || []; this._renderMarks(); }

  _renderMarks() {
    const lines = this.ta.value.split('\n');
    const byLine = new Map();
    for (const m of this.marks) {
      if (m.line < 1 || m.line > lines.length) continue;
      if (!byLine.has(m.line) || m.sev === 'error') byLine.set(m.line, m);
    }
    let html = '';
    lines.forEach((text, i) => {
      const m = byLine.get(i + 1);
      if (!m) { html += esc(text) + '\n'; return; }
      const col = Math.max(0, Math.min(text.length, (m.col || 1) - 1));
      let end = col;
      const rest = text.slice(col);
      const tok = /^[A-Za-z_]\w*|^\d[\w.]*|^\S/.exec(rest);
      end = tok ? col + tok[0].length : text.length;
      if (col >= text.length) { html += esc(text) + `<span class="mk ${m.sev}"> </span>\n`; return; }
      html += esc(text.slice(0, col)) + `<span class="mk ${m.sev}">${esc(text.slice(col, end))}</span>` + esc(text.slice(end)) + '\n';
    });
    this.marksEl.innerHTML = html;
    this.gutterInner.querySelectorAll('.ln.err, .ln.warn').forEach((el) => el.classList.remove('err', 'warn'));
    for (const [line, m] of byLine) {
      const el = this.gutterInner.children[line - 1];
      if (el) el.classList.add(m.sev === 'error' ? 'err' : 'warn');
    }
  }

  gotoLine(line, col = 1) {
    const lines = this.ta.value.split('\n');
    line = Math.max(1, Math.min(lines.length, line));
    let pos = 0;
    for (let i = 0; i < line - 1; i++) pos += lines[i].length + 1;
    pos += Math.max(0, Math.min(lines[line - 1].length, col - 1));
    const lineEnd = pos - Math.max(0, col - 1) + lines[line - 1].length;
    this.ta.focus();
    this.ta.setSelectionRange(pos, lineEnd);
    const lh = parseFloat(getComputedStyle(this.ta).lineHeight) || 18;
    this.ta.scrollTop = Math.max(0, (line - 4) * lh);
    this._sync();
  }
}
