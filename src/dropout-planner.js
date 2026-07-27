'use strict';
/**
 * DropoutPlanner — pure logic for Poisson-distributed vocal dropouts.
 *
 * Dropouts are NOT periodic: inter-dropout gaps are drawn from an exponential
 * distribution (Poisson process), so mute events feel random/unpredictable.
 *
 * - frequency: dropouts per minute (0 = disabled)
 * - duration: base mute length in seconds; each dropout gets ±20% uniform
 *   jitter, clamped to [0.5, 3.0] (the slider's absolute range)
 * - minGapSec: cooldown — minimum silence between the end of one dropout and
 *   the start of the next. Clamping the exponential draw up to this floor
 *   prevents two dropouts landing uncomfortably close.
 * - constraint (enforced by the UI): duration + minGapSec <= 60/perMinute.
 *   One cycle = duration + gap, so this guarantees the mean gap covers the
 *   cooldown floor and the observed rate really matches the slider. If the
 *   floor is set above the mean gap, it dominates and the rate drops.
 * - no overlaps: next gap is sampled from the END of the previous dropout
 */
class DropoutPlanner {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.durationSec = 1.0;
    this.perMinute = 10;
    this.minGapSec = 0;
    this.reset(0);
  }

  reset(now) {
    this.cursor = now;      // planned-up-to time (seconds, buffer domain)
    this.nextStart = null;  // start of next planned dropout
    this.events = [];       // all planned events (pruned lazily)
  }

  setParams({ durationSec, perMinute, minGapSec }) {
    if (durationSec !== undefined) this.durationSec = durationSec;
    if (perMinute !== undefined) this.perMinute = perMinute;
    if (minGapSec !== undefined) this.minGapSec = Math.max(0, minGapSec);
  }

  _sampleGap() {
    // Gap is sampled from the END of the previous dropout, so compensate:
    // cycle = gap + duration  =>  E[gap] = 60/perMinute - duration.
    // This makes the OBSERVED dropout rate match the slider (dropouts/min).
    // Clamped to a small positive mean for extreme settings (60/min + 3s).
    const mean = Math.max(0.15, 60 / this.perMinute - this.durationSec);
    const gap = -Math.log(1 - this.rng()) * mean;
    // Cooldown floor: never let two dropouts sit closer than minGapSec.
    return Math.max(this.minGapSec, gap);
  }

  _sampleDuration() {
    const d = this.durationSec * (0.8 + 0.4 * this.rng()); // ±20% jitter
    return Math.min(3.0, Math.max(0.5, d));
  }

  /**
   * Plan dropouts up to `horizon` (seconds). Idempotent: calling repeatedly
   * with a growing horizon only returns newly planned events.
   */
  plan(horizon) {
    if (!this.perMinute || this.perMinute <= 0) return [];
    if (this.nextStart === null) {
      this.nextStart = Math.max(this.cursor, 0) + this._sampleGap();
    }
    const fresh = [];
    while (this.nextStart < horizon) {
      const dur = this._sampleDuration();
      const ev = { start: this.nextStart, end: this.nextStart + dur };
      this.events.push(ev);
      fresh.push(ev);
      this.nextStart = ev.end + this._sampleGap(); // gap from end => no overlap
    }
    this.cursor = horizon;
    return fresh;
  }

  /** Is time `t` inside a planned dropout? */
  isMutedAt(t) {
    return this.events.some(ev => t >= ev.start && t < ev.end);
  }

  /** Drop events that ended before `t` (housekeeping). */
  pruneBefore(t) {
    this.events = this.events.filter(ev => ev.end >= t);
  }
}

module.exports = { DropoutPlanner };
