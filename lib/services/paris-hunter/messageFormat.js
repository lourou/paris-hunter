/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: renders the Convos message text for a listing.
 * Single entry point; dispatches on ph.kind ('match' | 'price_drop') internally.
 *
 * NORMATIVE input rule (build plan v2 #8): `phListing = { title, link, ph }`.
 * Consume ONLY `title`, `link`, and `ph.*` NUMERICS (ph.priceHc, ph.surface,
 * ph.rooms, ph.zipcode, ph.score, ph.phone, drop fields). NEVER read
 * `listing.id` (Fredy mutates it to a DB nanoid in _save) and NEVER parse
 * Fredy-formatted `price`/`size`/`rooms` strings (formatListing stringifies them).
 * Called by the streamEstate PROVIDER inside its decision tx — keep pure and fast.
 *
 * STUB (lane 1) — real implementation is owned by lane 4 (mobile-first block,
 * French number formatting, cap markers, arrondissement from zipcode, price-drop
 * prefix — see build plan lane 4 + v2 amendment).
 *
 * @param {{ title: string|null, link: string|null, ph: object }} phListing
 * @returns {string}
 */
export const buildMessage = (phListing) => {
  // TODO(lane 4): implement per the build plan; minimal placeholder until then.
  const title = phListing?.title ?? '';
  const link = phListing?.link ?? '';
  return `${title}\n${link}`.trim();
};
