/** A renderer owns one clock; idle screens never keep a repaint timer alive. */
export const MOTION_FRAME_MS = 32;
export type MotionPreference = "full" | "reduced";
export type MotionTask = (now: number) => boolean;

export class MotionClock {
  private tasks = new Set<MotionTask>();
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  constructor(private now: () => number = () => performance.now()) {}
  get activeTasks(): number {
    return this.tasks.size;
  }
  get running(): boolean {
    return this.timer !== undefined;
  }
  add(task: MotionTask): () => void {
    if (this.disposed) return () => {};
    this.tasks.add(task);
    this.timer ??= setInterval(() => this.step(this.now()), MOTION_FRAME_MS);
    return () => {
      this.tasks.delete(task);
      this.stopIfIdle();
    };
  }
  step(now: number): void {
    for (const task of [...this.tasks]) {
      if (!this.tasks.has(task)) continue;
      try {
        if (!task(now)) this.tasks.delete(task);
      } catch (error) {
        this.tasks.delete(task);
        this.stopIfIdle();
        throw error;
      }
    }
    this.stopIfIdle();
  }
  dispose(): void {
    this.disposed = true;
    this.tasks.clear();
    this.stopIfIdle();
  }
  private stopIfIdle(): void {
    if (this.tasks.size || !this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

export function motionEnabled(preference: MotionPreference): boolean {
  return preference === "full";
}
export const easeOut = (progress: number): number =>
  1 - (1 - Math.max(0, Math.min(1, progress))) ** 3;

/** Palette colors are validated RGB values; interpolation never changes geometry. */
export function mixColor(from: string, to: string, progress: number): string {
  if (!/^#[\da-f]{6}$/i.test(from) || !/^#[\da-f]{6}$/i.test(to)) return to;
  const t = Math.max(0, Math.min(1, progress));
  return `#${[1, 3, 5]
    .map((i) => {
      const a = Number.parseInt(from.slice(i, i + 2), 16);
      const b = Number.parseInt(to.slice(i, i + 2), 16);
      return Math.round(a + (b - a) * t)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}
