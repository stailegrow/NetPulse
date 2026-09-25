let ctx: AudioContext | null = null;

/** Короткий сигнал без файлов: два тона для критичных, один — для остальных. */
export function beep(severity: string) {
  try {
    ctx ??= new AudioContext();
    const tones = severity === "critical" ? [880, 660, 880] : severity === "ok" ? [660, 990] : [740];
    tones.forEach((f, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      const t = ctx!.currentTime + i * 0.16;
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g).connect(ctx!.destination);
      o.start(t);
      o.stop(t + 0.15);
    });
  } catch {
    /* звук недоступен */
  }
}
