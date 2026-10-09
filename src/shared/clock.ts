export type Clock = {
  now(): Date;
};

export const systemClock: Clock = {
  now: () => new Date(),
};

export class FixedClock implements Clock {
  public constructor(private current: Date) {}

  public now(): Date {
    return new Date(this.current.getTime());
  }

  public set(value: Date): void {
    this.current = new Date(value.getTime());
  }

  public advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}
