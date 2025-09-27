export class Diagnostics {
  private readonly messages: string[] = [];

  add(message: string): void {
    this.messages.push(message);
  }

  getAll(): string[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages.length = 0;
  }
}
