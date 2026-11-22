// SH1107 (128x128 PMOLED) controller emulation, one instance per panel.
// Driven only by command/data bytes (the SPI bus decides which is which from the DC pin).
//
// GDDRAM layout: 16 pages x 128 columns. One byte = 8 vertically stacked pixels, bit0 on top.
// Orientation (important, UNCONFIRMED on the real stack): with 0xA0 (segment remap off) and 0xC0
// (COM scan normal), RAM column c / row r is displayed at screen x=c, y=r (y grows downward).

export const WIDTH = 128;
export const HEIGHT = 128;
export const PAGES = 16;
export const RAM_SIZE = PAGES * WIDTH;

/** Maximum value of the intensity scale returned by renderIntensity() (IREF boost can exceed 1.0). */
export const INTENSITY_MAX = 1.5;

/** mulberry32 PRNG - deterministic power-up garbage so tests are reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (v, w = 2) => '0x' + v.toString(16).toUpperCase().padStart(w, '0');

export class SH1107 {
  /**
   * @param {object} o
   * @param {number} [o.seed]            seed for power-up RAM garbage
   * @param {number} [o.irefKOhm]        IREF resistor; 1000 kOhm baseline, 750 kOhm ~ 1.33x current
   * @param {(msg:string, byte:number, level?:string)=>void} [o.onUnknown]  called for unsupported / foreign commands
   */
  constructor({ seed = 1, irefKOhm = 1000, onUnknown = null } = {}) {
    this.ram = new Uint8Array(RAM_SIZE);
    const rnd = mulberry32(seed);
    for (let i = 0; i < RAM_SIZE; i++) this.ram[i] = (rnd() * 256) | 0; // power-up RAM is undefined = speckle
    this.ramWritten = false;          // any data byte ever written since power-up
    this.pageWritten = new Uint8Array(PAGES);
    this.irefKOhm = irefKOhm;
    this.onUnknown = onUnknown;
    this.initialized = false;         // received at least one command since last reset
    this.resetCount = 0;
    this.cmdLog = [];                 // last few commands (for the UI card)
    this.reset();
  }

  /** RES low: registers go to defaults, GDDRAM is NOT touched. */
  reset() {
    this.displayOn = false;
    this.dcdc = 0x8B;        // power-on default is DC-DC ON; an external-VPP board must send 0xAD 0x8A
    this.dcdcSet = false;    // has software explicitly chosen a mode since reset
    this.contrast = 0x80;
    this.allOn = false;
    this.inverse = false;
    this.page = 0;
    this.col = 0;
    this.addrMode = 0;       // 0 = page addressing, 1 = vertical addressing
    this.segRemap = false;   // 0xA1 -> x flipped
    this.comReverse = false; // 0xC8 -> y flipped
    this.mux = 127;
    this.offset = 0;
    this.startLine = 0;
    this.clockDiv = 0x50;
    this.precharge = 0x22;
    this.vcomh = 0x35;
    this.pending = null;     // opcode waiting for its argument byte
    this.initialized = false;
    this.resetCount++;
  }

  /** Receive a command byte (DC low). Returns a short name for logging/lint. */
  command(b) {
    this.initialized = true;
    if (this.pending !== null) {
      const op = this.pending;
      this.pending = null;
      return this._applyArg(op, b);
    }
    let name;
    if (b >= 0xB0 && b <= 0xBF) { this.page = b & 0x0F; name = `page ${this.page}`; }
    else if (b <= 0x0F) { this.col = (this.col & 0x70) | b; name = `col lo ${b}`; }
    else if (b >= 0x10 && b <= 0x17) { this.col = (this.col & 0x0F) | ((b & 0x07) << 4); name = `col hi ${b & 7}`; }
    else if (b >= 0x40 && b <= 0x7F) { this.startLine = b & 0x3F; name = `start line ${this.startLine}`; }
    else {
      switch (b) {
        case 0xAE: this.displayOn = false; name = 'display off'; break;
        case 0xAF: this.displayOn = true; name = 'display on'; break;
        case 0xA4: this.allOn = false; name = 'follow RAM'; break;
        case 0xA5: this.allOn = true; name = 'entire display on'; break;
        case 0xA6: this.inverse = false; name = 'normal'; break;
        case 0xA7: this.inverse = true; name = 'inverse'; break;
        case 0xA0: this.segRemap = false; name = 'segment remap off'; break;
        case 0xA1: this.segRemap = true; name = 'segment remap on (x flip)'; break;
        case 0xC0: this.comReverse = false; name = 'COM scan normal'; break;
        case 0xC8: this.comReverse = true; name = 'COM scan reversed (y flip)'; break;
        case 0x20: this.addrMode = 0; name = 'page addressing'; break;
        case 0x21: this.addrMode = 1; name = 'vertical addressing'; break;
        case 0xE3: name = 'nop'; break;
        case 0xDA:   // u8g2's SH1107 init sends 0xDA 0x12 (an SSD1306 command). The SH1107 does not know it.
          name = 'SSD1306 COM-pins command, ignored';
          if (this.onUnknown) this.onUnknown('received 0xDA, the SSD1306 "set COM pins" command. It is not an SH1107 command, so the chip ignores it and reads the next byte as a command of its own (u8g2 sends 0x12 = "column address high nibble 2"). Harmless: u8g2 sets the column again before every write.', b, 'info');
          break;
        case 0x81: case 0xAD: case 0xA8: case 0xD3: case 0xD5: case 0xD9: case 0xDB: case 0xDC:
          this.pending = b; name = `cmd ${hex(b)} (awaiting arg)`; break;
        default:
          name = `unknown ${hex(b)}`;
          if (this.onUnknown) this.onUnknown(`Unsupported SH1107 command ${hex(b)}`, b);
      }
    }
    this._log(name);
    return name;
  }

  _applyArg(op, v) {
    let name;
    switch (op) {
      case 0x81: this.contrast = v; name = `contrast ${hex(v)}`; break;
      case 0xAD: this.dcdc = v & 0x8B; this.dcdcSet = true; name = `DC-DC ${(v & 1) ? 'on (internal)' : 'off (external VPP)'}`; break;
      case 0xA8: this.mux = v & 0x7F; name = `mux ${this.mux + 1}`; break;
      case 0xD3: this.offset = v & 0x7F; name = `display offset ${this.offset}`; break;
      case 0xD5: this.clockDiv = v; name = `clock ${hex(v)}`; break;
      case 0xD9: this.precharge = v; name = `precharge ${hex(v)}`; break;
      case 0xDB: this.vcomh = v; name = `VCOMH ${hex(v)}`; break;
      case 0xDC: this.startLine = v & 0x7F; name = `start line ${this.startLine}`; break;
      default: name = `arg ${hex(v)}`;
    }
    this._log(name);
    return name;
  }

  _log(name) {
    this.cmdLog.push(name);
    if (this.cmdLog.length > 8) this.cmdLog.shift();
  }

  /** Receive a display-data byte (DC high). */
  data(b) {
    this.ram[this.page * WIDTH + this.col] = b;
    this.ramWritten = true;
    this.pageWritten[this.page] = 1;
    if (this.addrMode === 0) {
      this.col = (this.col + 1) & 0x7F; // wraps at the page end (real chip behaviour at the edge not verified)
    } else {
      this.page = (this.page + 1) & 0x0F;
      if (this.page === 0) this.col = (this.col + 1) & 0x7F;
    }
  }

  /** Is RAM pixel (col,row) set? */
  ramBit(col, row) {
    return (this.ram[(row >> 3) * WIDTH + col] >> (row & 7)) & 1;
  }

  /** Relative current/brightness factor from contrast register and IREF resistor (1.0 = 0xFF @ 1 MOhm). */
  brightness() {
    const iref = 1000 / this.irefKOhm;
    return ((this.contrast + 1) / 256) * iref;
  }

  /**
   * Fill `out` (Uint8Array 128*128, row-major, y down) with display intensity 0..255, where 255 maps to
   * INTENSITY_MAX. Applies display on/off, entire-display-on, inverse, remap, COM scan and start line.
   */
  renderIntensity(out) {
    return intensityFromState(this.ram, this.state(), out);
  }

  /** Cheap, serialisable state for the UI / snapshots. */
  state() {
    return {
      on: this.displayOn, contrast: this.contrast, dcdc: this.dcdc, dcdcSet: this.dcdcSet,
      allOn: this.allOn, inverse: this.inverse, segRemap: this.segRemap, comReverse: this.comReverse,
      addrMode: this.addrMode, page: this.page, col: this.col, startLine: this.startLine,
      offset: this.offset, mux: this.mux + 1, ramWritten: this.ramWritten, initialized: this.initialized,
      resets: this.resetCount, log: this.cmdLog.slice(), brightness: this.brightness(),
    };
  }
}

/**
 * Same as SH1107#renderIntensity but from a plain RAM copy + state() object (used by the viewer and the
 * headless renderer, which only receive snapshots).
 */
export function intensityFromState(ram, st, out) {
  if (!st.on) { out.fill(0); return out; }
  const v = Math.max(0, Math.min(255, Math.round((st.brightness / INTENSITY_MAX) * 255)));
  const sh = st.startLine + st.offset;
  for (let sy = 0; sy < HEIGHT; sy++) {
    const comRow = st.comReverse ? HEIGHT - 1 - sy : sy;
    const ramRow = (comRow + sh) & 0x7F;
    const page = ramRow >> 3, bit = ramRow & 7;
    const base = page * WIDTH;
    for (let sx = 0; sx < WIDTH; sx++) {
      const c = st.segRemap ? WIDTH - 1 - sx : sx;
      let lit = (ram[base + c] >> bit) & 1;
      if (st.inverse) lit ^= 1;
      if (st.allOn) lit = 1;
      out[sy * WIDTH + sx] = lit ? v : 0;
    }
  }
  return out;
}
