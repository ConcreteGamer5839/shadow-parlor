/**
 * Tiny WebAudio synth so the scaffold ships with zero audio files.
 * Replace with recorded foley later (paper rustle, lamp hum, bell).
 */
export class Chimes {
  private ctx: AudioContext | null = null;

  private get audio(): AudioContext | null {
    if (!this.ctx) {
      try {
        const Ctor = window.AudioContext || (window as any).webkitAudioContext;
        this.ctx = Ctor ? new Ctor() : null;
      } catch {
        this.ctx = null;
      }
    }
    return this.ctx;
  }

  resume(): void {
    this.audio?.resume().catch(() => undefined);
  }

  private tone(freq: number, start: number, dur: number, gain = 0.15, type: OscillatorType = 'sine'): void {
    const ctx = this.audio;
    if (!ctx || ctx.state !== 'running') return;
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  tick(): void {
    this.tone(880, 0, 0.08, 0.08, 'triangle');
  }

  /** rising pentatonic pair; pitch climbs through the run */
  caught(step: number): void {
    const scale = [392, 440, 523.25, 587.33, 659.25, 783.99];
    const f = scale[step % scale.length];
    this.tone(f, 0, 0.9);
    this.tone(f * 1.5, 0.12, 1.1, 0.1);
  }

  finale(): void {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, i * 0.14, 1.4, 0.12));
  }
}
