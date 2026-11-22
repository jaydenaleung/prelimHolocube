// Hardware lint: catches failure modes seen on the real Holocube bring-up.
// Warnings carry the virtual timestamp (microseconds) at which they were detected.

export const LEVEL = { error: 'error', warn: 'warn', info: 'info' };

// ESP32 (WROOM-32 / DevKit V1) pin facts
export const STRAPPING = { 0: 'boot mode select (must be high at reset, low enters download mode)',
  2: 'boot mode select (must be low/floating at reset; also the on-board LED)',
  5: 'boot timing / SDIO slave sampling', 12: 'MTDI: flash voltage select, driving it HIGH at boot can prevent booting',
  15: 'MTDO: silences boot log, boot-time pull-up' };
export const FLASH_PINS = [6, 7, 8, 9, 10, 11];
export const USB_SERIAL_PINS = { 1: 'TX0 (USB serial out)', 3: 'RX0 (USB serial in)' };
export const INPUT_ONLY = [34, 35, 36, 39];            // 37, 38 are not broken out on DevKit V1
export const NON_EXISTENT = [20, 24, 28, 29, 30, 31];  // numbers that have no GPIO on ESP32
export const WROVER_PSRAM = [16, 17];

export class Linter {
  /**
   * @param {object} o
   * @param {()=>number} o.now             virtual time in microseconds
   * @param {(w:object)=>void} o.onWarning called for each NEW warning (deduplicated by key)
   * @param {number} [o.spiMaxHz]
   */
  constructor({ now, onWarning, spiMaxHz = 10_000_000 }) {
    this.now = now;
    this.onWarning = onWarning || (() => {});
    this.spiMaxHz = spiMaxHz;
    this.seen = new Map();   // key -> warning (with count)
    this.list = [];
    this.pinChecked = new Set();
    this.resetSeen = false;      // any RES falling edge so far
    this.firstBusUseChecked = false;
    this.lastOnT = new Map();    // panel -> virtual time of last 0xAF
    this.gotVpp = new Set();     // panels that were sent 0xAD 0x8A
    this.csLowSince = new Map(); // panel -> time CS fell
    this.inTx = false;
    this.txWarnedNoCs = false;
    this.warnedPanelOnce = new Set();
  }

  add(level, code, message, key = code) {
    const t = this.now();
    const prev = this.seen.get(key);
    if (prev) { prev.count++; prev.lastT = t; return prev; }
    const w = { t, lastT: t, level, code, message, count: 1, key };
    this.seen.set(key, w);
    this.list.push(w);
    this.onWarning(w);
    return w;
  }

  // ---- static configuration checks (pins.json) ----
  checkConfig(cfg) {
    const cs = cfg.cs || [];
    if (cfg.dc != null && cs.includes(cfg.dc))
      this.add(LEVEL.error, 'DC_EQ_CS', `DC pin GPIO${cfg.dc} is also a chip-select pin (panel ${cs.indexOf(cfg.dc) + 1}). Toggling D/C will toggle that panel's CS (this bit the project on GPIO16).`);
    const roles = [];
    cs.forEach((p, i) => roles.push([p, `CS${i + 1}`]));
    if (cfg.dc != null) roles.push([cfg.dc, 'DC']);
    if (cfg.rst != null) roles.push([cfg.rst, 'RST']);
    if (cfg.sck != null) roles.push([cfg.sck, 'SCK']);
    if (cfg.mosi != null) roles.push([cfg.mosi, 'MOSI']);
    const byPin = new Map();
    for (const [p, r] of roles) { if (!byPin.has(p)) byPin.set(p, []); byPin.get(p).push(r); }
    for (const [p, rs] of byPin) {
      if (rs.length > 1)
        this.add(LEVEL.error, 'PIN_CLASH', `GPIO${p} is assigned to several signals in pins.json: ${rs.join(', ')}.`, `PIN_CLASH_${p}`);
    }
  }

  // ---- ESP32 pin hazards, checked when a pin is first used ----
  checkPinUse(pin, how, outputs) {
    const k = `${pin}:${how}`;
    if (this.pinChecked.has(k)) return;
    this.pinChecked.add(k);
    if (NON_EXISTENT.includes(pin) || pin < 0 || pin > 39)
      this.add(LEVEL.error, 'PIN_INVALID', `GPIO${pin} does not exist on the ESP32.`, `PIN_INVALID_${pin}`);
    // reading a strapping pin after boot is fine (GPIO0 is the BOOT button on most boards); driving one is the hazard
    if (STRAPPING[pin] !== undefined && outputs)
      this.add(LEVEL.warn, 'PIN_STRAPPING', `GPIO${pin} is a strapping pin: ${STRAPPING[pin]}. Avoid it for panel signals.`, `PIN_STRAP_${pin}`);
    if (FLASH_PINS.includes(pin))
      this.add(LEVEL.error, 'PIN_FLASH', `GPIO${pin} is connected to the SPI flash on ESP32 modules. Using it crashes the chip.`, `PIN_FLASH_${pin}`);
    if (USB_SERIAL_PINS[pin])
      this.add(LEVEL.warn, 'PIN_USB', `GPIO${pin} is ${USB_SERIAL_PINS[pin]}; driving it conflicts with Serial/flashing.`, `PIN_USB_${pin}`);
    if (outputs && INPUT_ONLY.includes(pin))
      this.add(LEVEL.error, 'PIN_INPUT_ONLY', `GPIO${pin} is input-only on the ESP32 but is driven as an output (it will never move).`, `PIN_INONLY_${pin}`);
    if (WROVER_PSRAM.includes(pin))
      this.add(LEVEL.info, 'PIN_WROVER', `GPIO${pin} is used for PSRAM on ESP32-WROVER modules. Fine on a DevKit V1 (WROOM-32), unusable on WROVER.`, `PIN_WROVER_${pin}`);
  }

  // ---- pin ownership (ESP32 core 3.x peripheral manager) ----
  /** A peripheral (SPI/I2C) took over a pin. role = pins.json role of that pin, if any. */
  pinClaimed(pin, what, role, wasOutput) {
    if (role)
      this.add(LEVEL.error, 'PIN_CLAIMED', `${what.split(' ')[0]}.begin() attached GPIO${pin} as ${what}, but GPIO${pin} is your ${role} pin. From now on digitalWrite(${pin}, ...) is ignored by the ESP32 core ("IO ${pin} is not set as GPIO"), so ${role === 'RST' ? 'RES is never pulsed' : role === 'DC' ? 'D/C can no longer switch between command and data' : 'that panel can no longer be selected'}. Call SPI.begin(SCK, -1, MOSI, -1) with explicit pins before the display library starts the bus.`, `PIN_CLAIMED_${pin}`);
    else if (wasOutput)
      this.add(LEVEL.warn, 'PIN_CLAIMED', `${what.split(' ')[0]}.begin() attached GPIO${pin} as ${what}; it was configured as a GPIO output before, and digitalWrite() on it is now ignored.`, `PIN_CLAIMED_${pin}`);
  }
  /** digitalWrite on a pin that is not (or no longer) a GPIO. */
  writeIgnored(pin, owner, role) {
    if (owner)
      this.add(LEVEL.error, 'WRITE_IGNORED', `digitalWrite(${pin}) ignored: GPIO${pin} belongs to ${owner}${role ? ` but is your ${role} pin` : ''}. The ESP32 core logs "IO ${pin} is not set as GPIO" and the pin does not move.`, `WRITE_IGNORED_${pin}`);
    else
      this.add(LEVEL.warn, 'WRITE_NO_PINMODE', `digitalWrite(${pin}) before pinMode(${pin}, OUTPUT): on the ESP32 core 3.x the write is ignored and the pin keeps floating${role ? ` (it is your ${role} pin)` : ''}.`, `WRITE_NO_PINMODE_${pin}`);
  }
  spiDefaults() {
    this.add(LEVEL.info, 'SPI_DEFAULT_PINS', 'SPI.begin() without pins: the ESP32 attaches its VSPI defaults SCK 18, MISO 19, MOSI 23 (also what u8g2 does if the bus is not started yet).');
  }
  spiNotBegun() {
    this.add(LEVEL.error, 'SPI_NOT_BEGUN', 'SPI transfer before SPI.begin(): on the ESP32 this does nothing.');
  }
  i2cClock(hz) {
    if (hz > 400_000)
      this.add(LEVEL.warn, 'I2C_FAST', `I2C clock ${(hz / 1000).toFixed(0)} kHz is above the SH1107's 400 kHz fast-mode limit.`);
  }

  // ---- bus events ----
  spiBeginTx(hz) {
    this.inTx = true;
    this.txWarnedNoCs = false;
    if (hz > this.spiMaxHz)
      this.add(LEVEL.warn, 'SPI_FAST', `SPI clock ${(hz / 1e6).toFixed(2)} MHz exceeds the configured maximum of ${(this.spiMaxHz / 1e6).toFixed(2)} MHz (SH1107 4-wire write limit; long flying leads often fail well below it).`);
  }
  spiEndTx() { this.inTx = false; }

  /** First bus use: all CS lines should have been driven high. csState = [{pin, driven, level}] */
  firstBusUse(csState) {
    if (this.firstBusUseChecked) return;
    this.firstBusUseChecked = true;
    const driven = csState.filter((c) => c.driven);
    for (const c of csState) {
      if (c.driven && c.level !== 1 && !c.skipLevel)
        this.add(LEVEL.warn, 'CS_NOT_IDLE', `CS${c.index + 1} (GPIO${c.pin}) is not idle-high before the first SPI transfer; that panel will listen to traffic meant for others.`, `CS_NOT_IDLE_${c.pin}`);
      else if (!c.driven && driven.length)
        this.add(LEVEL.info, 'CS_UNUSED', `CS${c.index + 1} (GPIO${c.pin}) is never configured as an output by the sketch. If a panel is wired to it, the CS line floats and may listen to the bus.`, `CS_UNUSED_${c.pin}`);
    }
  }

  csFell(panel, lowPanels) {
    this.csLowSince.set(panel, this.now());
    if (lowPanels.length > 1) {
      const names = lowPanels.map((p) => p + 1).join(' and ');
      this.add(LEVEL.error, 'CONTENTION', `Bus contention: CS of panels ${names} are low at the same time, so both listen to the same SPI bytes.`, `CONTENTION_${lowPanels.slice().sort().join('_')}`);
    }
  }
  csRose(panel) { this.csLowSince.delete(panel); }

  byteWithNoCs() {
    if (this.txWarnedNoCs) return;
    this.txWarnedNoCs = true;
    this.add(LEVEL.warn, 'NO_CS', 'SPI bytes were sent while no CS line was low; no panel received them.');
  }

  rstFell(panels) {
    this.resetSeen = true;
    const on = panels.map((p, i) => [p, i]).filter(([p]) => p.displayOn).map(([, i]) => i + 1);
    const init = panels.map((p, i) => [p, i]).filter(([p]) => p.initialized && !p.displayOn).map(([, i]) => i + 1);
    if (on.length)
      this.add(LEVEL.error, 'RES_AFTER_ON', `RES pulsed while panel${on.length > 1 ? 's' : ''} ${on.join(', ')} ${on.length > 1 ? 'are' : 'is'} on. RES is shared, so this wipes every panel's registers and the display state is lost.`, 'RES_AFTER_ON');
    else if (init.length)
      this.add(LEVEL.warn, 'RES_AFTER_INIT', `RES pulsed after panel${init.length > 1 ? 's' : ''} ${init.join(', ')} had been initialized. RES is shared, so every panel's init is lost.`, 'RES_AFTER_INIT');
  }
  rstRose(widthUs) {
    if (widthUs < 10)
      this.add(LEVEL.warn, 'RES_SHORT', `RES held low for only ${widthUs.toFixed(1)} us; the datasheet requires at least 10 us.`);
  }
  firstCommand(panelIdx) {
    if (!this.resetSeen)
      this.add(LEVEL.warn, 'NO_RESET', `Panel ${panelIdx + 1} was initialized without a RES pulse first. Power-up sequence: VDD/VPP on, RES low >= 10 us, RES high, then init.`, 'NO_RESET');
  }

  // ---- panel events ----
  panelActivity(panelIdx) {
    const t = this.lastOnT.get(panelIdx);
    if (t !== undefined) {
      this.lastOnT.delete(panelIdx);
      const dt = this.now() - t;
      if (dt < 100_000)
        this.add(LEVEL.warn, 'ON_TOO_SOON', `Panel ${panelIdx + 1}: only ${(dt / 1000).toFixed(1)} ms between 0xAF (display on) and the next activity; the datasheet asks for 100 ms.`, `ON_TOO_SOON_${panelIdx}`);
    }
  }
  panelCommand(panelIdx, byte, panel) {
    if (byte === 0xAF) {
      if (!panel.ramWritten)
        this.add(LEVEL.warn, 'ON_BEFORE_RAM', `Panel ${panelIdx + 1} turned on (0xAF) before any display data was written. GDDRAM is random at power-up, so it will show speckle.`, `ON_BEFORE_RAM_${panelIdx}`);
      if (!panel.dcdcSet || panel.dcdc !== 0x8A)
        this.add(LEVEL.error, 'NO_EXT_VPP', `Panel ${panelIdx + 1} turned on without 0xAD 0x8A (DC-DC off / external VPP mode). Power-up default is the internal DC-DC, which is not powered on this board.`, `NO_EXT_VPP_${panelIdx}`);
      this.lastOnT.set(panelIdx, this.now());
    }
  }

  /** Called periodically by the host with the panel list. */
  tick(panels) {
    panels.forEach((p, i) => {
      if (!p.displayOn) return;
      if (p.allOn)
        this.add(LEVEL.warn, 'ALL_ON', `Panel ${i + 1} has 0xA5 (entire display on) active; it ignores RAM and burns every pixel.`, `ALL_ON_${i}`);
      if (p.contrast < 0x30)
        this.add(LEVEL.warn, 'CONTRAST_LOW', `Panel ${i + 1} is on with contrast ${'0x' + p.contrast.toString(16).toUpperCase().padStart(2, '0')}, which is nearly invisible on a transparent panel${p.contrast === 0x2F ? ' (0x2F is what u8g2.begin() sets for the SH1107: call setContrast())' : ''}.`, `CONTRAST_LOW_${i}`);
    });
  }
}
