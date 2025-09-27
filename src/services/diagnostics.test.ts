import { describe, expect, it } from "@jest/globals";
import { Diagnostics } from "./diagnostics";

describe("Diagnostics", () => {
  it("collects added messages and returns copies", () => {
    const diagnostics = new Diagnostics();
    diagnostics.add("first");
    diagnostics.add("second");

    const firstSnapshot = diagnostics.getAll();
    expect(firstSnapshot).toEqual(["first", "second"]);

    firstSnapshot.push("mutated");
    expect(diagnostics.getAll()).toEqual(["first", "second"]);
  });

  it("clears stored messages", () => {
    const diagnostics = new Diagnostics();
    diagnostics.add("message");
    expect(diagnostics.getAll()).toHaveLength(1);

    diagnostics.clear();
    expect(diagnostics.getAll()).toHaveLength(0);
  });
});