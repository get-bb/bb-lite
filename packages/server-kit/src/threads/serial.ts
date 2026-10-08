export class ThreadSerial {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(threadId: string, work: () => T | Promise<T>): Promise<T> {
    const result = (this.tails.get(threadId) ?? Promise.resolve()).then(work);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.tails.set(threadId, tail);
    void tail.then(() => {
      if (this.tails.get(threadId) === tail) this.tails.delete(threadId);
    });
    return result;
  }

  async idle(): Promise<void> {
    while (this.tails.size > 0) await Promise.all(this.tails.values());
  }
}
