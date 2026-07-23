export class LayoutHistory<T> {
  private future: T[] = [];
  private past: T[] = [];
  private present: T;

  constructor(initial: T) {
    this.present = initial;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get value(): T {
    return this.present;
  }

  commit(next: T): T {
    if (next === this.present) return this.present;
    this.past.push(this.present);
    this.present = next;
    this.future = [];
    return this.present;
  }

  redo(): T {
    const next = this.future.pop();
    if (next === undefined) return this.present;
    this.past.push(this.present);
    this.present = next;
    return this.present;
  }

  reset(next: T): T {
    this.present = next;
    this.past = [];
    this.future = [];
    return this.present;
  }

  undo(): T {
    const previous = this.past.pop();
    if (previous === undefined) return this.present;
    this.future.push(this.present);
    this.present = previous;
    return this.present;
  }
}
