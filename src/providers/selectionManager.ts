export class SelectionManager {
  private readonly selected = new Set<string>();

  toggle(uri: string): void {
    if (this.selected.has(uri)) {
      this.selected.delete(uri);
    } else {
      this.selected.add(uri);
    }
  }

  isSelected(uri: string): boolean {
    return this.selected.has(uri);
  }

  getSelectedUris(): string[] {
    return Array.from(this.selected);
  }

  select(uri: string): void {
    this.selected.add(uri);
  }

  deselect(uri: string): void {
    this.selected.delete(uri);
  }

  clear(): void {
    this.selected.clear();
  }
}
