export class ExpandState {
  private readonly expanded = new Set<string>();

  setExpanded(uri: string): void {
    this.expanded.add(uri);
  }

  setCollapsed(uri: string): void {
    this.expanded.delete(uri);
  }

  isExpanded(uri: string): boolean {
    return this.expanded.has(uri);
  }

  clear(): void {
    this.expanded.clear();
  }

  getExpandedUris(): string[] {
    return Array.from(this.expanded);
  }
}
