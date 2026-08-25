import { describe, expect, it } from "vitest";
import { splitRuleLine } from "../src/rule-line";

describe("rule line splitting", () => {
  it("keeps commas inside quotes and logical expressions", () => {
    expect(splitRuleLine('URL-REGEX,"^https://example\\.com/(foo,bar)$",Proxy')).toEqual([
      "URL-REGEX",
      '"^https://example\\.com/(foo,bar)$"',
      "Proxy"
    ]);
    expect(splitRuleLine("DOMAIN-KEYWORD,'foo,bar',DIRECT")).toEqual([
      "DOMAIN-KEYWORD",
      "'foo,bar'",
      "DIRECT"
    ]);
    expect(splitRuleLine('URL-REGEX,"foo\\\",bar",Proxy')).toEqual([
      "URL-REGEX",
      '"foo\\\",bar"',
      "Proxy"
    ]);
    expect(splitRuleLine("AND,((DOMAIN,a.example),(DOMAIN,b.example)),Proxy")).toEqual([
      "AND",
      "((DOMAIN,a.example),(DOMAIN,b.example))",
      "Proxy"
    ]);
  });
});
