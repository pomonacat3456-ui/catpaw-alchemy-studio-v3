import { describe, expect, it } from "vitest";
import { A_LINE_NEGATIVE, buildALinePrompt, buildBLinePrompt, inlineNegative, isMagicOnly } from "../src/lib/prompt";
import { checkCanon, parseSpec } from "../src/lib/validate";

// Fixture look only (no private CANON data in a public repo).
const LOOK = { name: "測試火焰喵", fur: "white long fur", eyes: "gold eyes", crown_hair: "gold crown, long red hair",
  costume: "black and gold robe with red ribbons", weapon: "未確認實體武器；火系術法", magic: "fire magic" };

describe("A-line prompt builder (a-line-v2)", () => {
  const b = buildALinePrompt(LOOK, { seconds: 5 });
  it("leads with single all-female cat identity, cat face and cat paws with paw pads", () => {
    expect(b.prompt.startsWith("Vertical 9:16 full-body shot, 5 seconds, one single character (測試火焰喵)")).toBe(true);
    expect(b.prompt).toContain("all-female");
    expect(b.prompt).toContain("real cat face");
    expect(b.prompt).toContain("cat paws with soft pink paw pads");
    expect(b.prompt.indexOf("Cat paws only")).toBeLessThan(b.prompt.indexOf("Keep exactly"));
  });
  it("locks 布袋戲偶 material and a modest costume, and keeps the CANON look verbatim", () => {
    expect(b.prompt).toContain("布袋戲偶");
    expect(b.prompt).toContain("Modest costume");
    for (const v of [LOOK.fur, LOOK.eyes, LOOK.crown_hair, LOOK.costume]) expect(b.prompt).toContain(v);
  });
  it("magic-only weapon cell => no weapon in hand, casts the magic from paw pads", () => {
    expect(isMagicOnly(LOOK.weapon)).toBe(true);
    expect(isMagicOnly("白玉劍")).toBe(false);
    expect(b.prompt).toContain("No weapon in hand: she casts fire magic");
    expect(buildALinePrompt({ ...LOOK, weapon: "白玉劍" }).prompt).toContain("Weapon: 白玉劍, held in cat paws");
  });
  it("negative prompt carries the anti-drift list; positive prompt does not name the negatives", () => {
    for (const t of ["human hands", "fingers", "nails", "human face", "cleavage", "deformed", "extra limbs", "anime"]) {
      expect(b.negative_prompt).toContain(t);
      expect(A_LINE_NEGATIVE).toContain(t);
    }
    expect(b.prompt.toLowerCase()).not.toMatch(/human|cleavage|anime/);
  });
  it("built prompt passes the CANON forbidden-term check (negatives are not checked)", () => {
    const s = parseSpec({ line: "A", mode: "live", protagonist: "X", master_url: "https://x.test/m.png", segments: [5], look: LOOK, provider: "pixverse" });
    expect(s.prompt_builder).toBe("a-line-v2");
    expect(s.provider).toBe("pixverse");
    expect(s.negative_prompt).toContain("human hands");
    const canon = new Map([["X", { id: "X", display_name: "X", sex: "female", species: "cat", master_url: "https://x.test/m.png", approved: 1, source: "canon-sheet-v3" }]]);
    expect(checkCanon(s, canon as any)).toEqual([]);
  });
  it("inlineNegative appends one Avoid clause within the length limit", () => {
    const s = inlineNegative(b);
    expect(s).toMatch(/ Avoid: human hands, /);
    expect(s.length).toBeLessThanOrEqual(2048);
  });
  it("rejects bad look/provider input", () => {
    expect(() => parseSpec({ line: "C", protagonist: "X", look: LOOK })).toThrow("look_only_for_line_A_or_B");
    expect(() => parseSpec({ line: "A", protagonist: "X", look: { fur: 3 } })).toThrow("invalid_look_field");
    expect(() => parseSpec({ line: "A", protagonist: "X", provider: "kling" })).toThrow("invalid_provider");
    expect(() => parseSpec({ line: "C", protagonist: "X", provider: "pixverse" })).toThrow("invalid_provider");
  });
});

describe("B-line prompt builder (b-line-v1)", () => {
  it("keeps identity from the reference, sets the scene, 9:16 still, no text; passes forbidden-term check", () => {
    const b = buildBLinePrompt(LOOK, "sitting on a carved throne");
    expect(b.prompt).toContain("Keep this exact character (測試火焰喵)");
    expect(b.prompt).toContain("New photo: sitting on a carved throne.");
    expect(b.prompt).toContain("Vertical 9:16 portrait photograph");
    expect(b.prompt).toContain("No weapon; fire magic effects only.");
    const s = parseSpec({ line: "B", mode: "live", protagonist: "X", master_url: "https://x.test/m.png", images: 1, look: LOOK, scene: "throne" });
    expect(s.prompt_builder).toBe("b-line-v1");
    const canon = new Map([["X", { id: "X", display_name: "X", sex: "female", species: "cat", master_url: "https://x.test/m.png", approved: 1, source: "canon-sheet-v3" }]]);
    expect(checkCanon(s, canon as any)).toEqual([]);
  });
});
