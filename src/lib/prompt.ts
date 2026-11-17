/**
 * A-line (5s / 15s 9:16 image-to-video) prompt builder.
 *
 * Owner direction 2026-11-17 13:01: the Master is fine, the earlier prompt let the model drift to
 * humanoid hands/face, anime rendering and a revealing costume. The builder therefore:
 *  - LEADS with the identity locks (single all-female cat, real cat head and cat paws with paw pads),
 *  - locks the 布袋戲偶 (Taiwanese glove-puppet) material,
 *  - copies the CANON look (fur / eyes / crown+hair / costume / weapon) verbatim from the caller,
 *  - asks for a modest, fully covered costume,
 *  - keeps negative concepts OUT of the positive prompt (they go to negative_prompt; for providers
 *    without a negative field they are appended as a single "Avoid:" clause by `inlineNegative`).
 * Pure function, no I/O. Never put private CANON data in tests or logs: callers pass the look.
 */
export interface ALineLook {
  name?: string; // display name, e.g. 「焚天赤焰喵」
  fur?: string;
  eyes?: string;
  crown_hair?: string;
  costume?: string;
  weapon?: string; // e.g. 「未確認實體武器；火系術法」 -> no physical weapon
  magic?: string; // e.g. "fire magic"
  motion?: string; // what she does in the shot
  setting?: string;
}

export interface BuiltPrompt { prompt: string; negative_prompt: string }

export const A_LINE_NEGATIVE = [
  "human hands", "fingers", "fingernails", "nails", "long nails", "manicure", "human face", "human nose", "human skin",
  "bare skin", "cleavage", "exposed chest", "low neckline", "revealing outfit", "bare legs", "thigh slit",
  "deformed", "distorted anatomy", "extra limbs", "extra arms", "extra paws", "extra fingers", "mutated paws",
  "anime", "manga", "cartoon", "illustration", "3D game render", "plastic doll", "male", "man", "boy",
  "real person", "multiple characters", "crowd", "physical weapon", "sword", "staff", "text", "subtitles", "watermark", "logo",
];

const clean = (s?: string) => (s ?? "").replace(/\s+/g, " ").trim();

/** True when the CANON weapon cell says there is no confirmed physical weapon (magic only). */
export function isMagicOnly(weapon?: string): boolean {
  const w = clean(weapon);
  return !w || /未確認實體武器|無實體武器|無武器|術法|magic only|no weapon/i.test(w);
}

export function buildALinePrompt(look: ALineLook, opts: { seconds?: number; extraNegative?: string[] } = {}): BuiltPrompt {
  const name = clean(look.name);
  const parts: string[] = [];
  parts.push(
    `Vertical 9:16 full-body shot, ${opts.seconds ?? 5} seconds, one single character${name ? ` (${name})` : ""}: ` +
      "an all-female anthropomorphic cat queen, unmistakably a cat.",
  );
  parts.push(
    "Cat head: real cat face with a short cat muzzle, pink cat nose, cat whiskers, upright furry cat ears, fur covering the whole face.",
  );
  parts.push(
    "Cat paws only: both forelimbs end in round furry cat paws with soft pink paw pads, claws retracted, paw pads clearly visible when she raises a paw; fur covers the paws and forearms.",
  );
  parts.push(
    "Material: Taiwanese glove-puppet (布袋戲偶) look — hand-carved lacquered wooden puppet head, embroidered silk costume with gold thread, real fabric texture, stage-puppet proportions, practical stage lighting, live-action puppet theatre photography.",
  );
  const look_: string[] = [];
  if (clean(look.fur)) look_.push(`fur: ${clean(look.fur)}`);
  if (clean(look.eyes)) look_.push(`eyes: ${clean(look.eyes)}`);
  if (clean(look.crown_hair)) look_.push(`crown and hair: ${clean(look.crown_hair)}`);
  if (clean(look.costume)) look_.push(`costume: ${clean(look.costume)}`);
  if (look_.length) parts.push(`Keep exactly the reference image's design — ${look_.join("; ")}.`);
  parts.push(
    "Modest costume: high collar, layered robes fully covering chest, shoulders and legs; long sleeves; no exposed skin, only fur.",
  );
  if (isMagicOnly(look.weapon)) {
    parts.push(`No weapon in hand: she casts ${clean(look.magic) || "elemental magic"} from her open cat paw pads.`);
  } else {
    parts.push(`Weapon: ${clean(look.weapon)}, held in cat paws.`);
  }
  parts.push(`Action: ${clean(look.motion) || "a slow graceful turn toward the camera, then raises one cat paw"}.`);
  parts.push(`Setting: ${clean(look.setting) || "dark smoky stage background"}; slow cinematic camera push-in, stable identity matching the reference image in every frame.`);
  const negative = [...new Set([...A_LINE_NEGATIVE, ...(opts.extraNegative ?? []).map(clean).filter(Boolean)])];
  return { prompt: parts.join(" "), negative_prompt: negative.join(", ") };
}

/** For providers without a negative-prompt field: one trailing "Avoid:" clause. */
export function inlineNegative(b: BuiltPrompt, maxLen = 2048): string {
  const s = `${b.prompt} Avoid: ${b.negative_prompt}.`;
  return s.length <= maxLen ? s : b.prompt.slice(0, maxLen);
}
