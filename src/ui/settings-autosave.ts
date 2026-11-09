import { useEffect, useRef, useState } from "react";

/** One writer per mounted form. Acknowledgements never own the editable draft. */
export class SettingsAutosave {
  private pending?: { key: string; write(): Promise<void> };
  private running?: Promise<boolean>;
  private timer?: ReturnType<typeof setTimeout>;
  private saved?: string;
  constructor(private readonly failed: (error: unknown) => void) {}
  schedule(
    key: string | undefined,
    write: () => Promise<void>,
    delay: number,
    dirty = true,
  ) {
    clearTimeout(this.timer);
    if (!dirty && !this.running) {
      this.saved = key;
      this.pending = undefined;
      return;
    }
    this.pending = key === undefined ? undefined : { key, write };
    if (this.pending && key !== this.saved) {
      if (delay > 0) this.timer = setTimeout(() => void this.flush(), delay);
      else void this.flush();
    }
  }
  flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.running) return this.running;
    const drain = async () => {
      while (this.pending && this.pending.key !== this.saved) {
        const next = this.pending;
        try {
          await next.write();
          this.saved = next.key;
        } catch (error) {
          this.failed(error);
          return false;
        }
      }
      return true;
    };
    this.running = drain().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  dispose() {
    clearTimeout(this.timer);
  }
}

export function useSettingsAutosave(
  key: string | undefined,
  write: () => Promise<void>,
  failed: (error: unknown) => void,
  delay = 0,
  cleanKey?: string,
) {
  const latest = useRef({ key, write, failed, cleanKey });
  latest.current = { key, write, failed, cleanKey };
  const [saving, setSaving] = useState(false);
  const queue = useRef<SettingsAutosave | undefined>(undefined);
  queue.current ??= new SettingsAutosave((error) =>
    latest.current.failed(error),
  );
  const capture = () => {
    const current = latest.current;
    queue.current!.schedule(
      current.key ?? current.cleanKey,
      async () => {
        setSaving(true);
        try {
          await current.write();
        } finally {
          setSaving(false);
        }
      },
      delay,
      current.key !== undefined,
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only changes to the draft schedule writes; focus/loading never do.
  useEffect(() => {
    capture();
  }, [key, cleanKey]);
  useEffect(() => () => queue.current?.dispose(), []);
  return {
    saving,
    flush: () => {
      capture();
      return queue.current!.flush();
    },
  };
}
