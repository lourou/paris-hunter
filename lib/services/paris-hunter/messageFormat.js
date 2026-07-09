/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: renders the Convos message text for a formatted listing.
 * Dispatches on listing.ph.kind ('match' | 'price_drop').
 *
 * STUB (lane 1) — real implementation is owned by lane 4 (mobile-first block,
 * French number formatting, cap markers, arrondissement from zipcode, price-drop
 * prefix — see build plan lane 4).
 *
 * @param {object} formattedListing Fredy-formatted listing (ph fields survive the spread)
 * @returns {string}
 */
export const buildMessage = (formattedListing) => {
  // TODO(lane 4): implement per the build plan; minimal placeholder until then.
  const title = formattedListing?.title ?? '';
  const link = formattedListing?.link ?? '';
  return `${title}\n${link}`.trim();
};
