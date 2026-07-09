/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * paris-hunter: hard-exclusion terms (meublé, coloc, bail mobilité, courte durée,
 * sous-location, saisonnier) with diacritics-insensitive matching and negation
 * handling ("non meublé" must NOT match).
 *
 * STUB (lane 1) — real implementation is owned by lane 4:
 *   normalize: lowercase -> NFD -> strip diacritics -> collapse whitespace;
 *   remove negated phrases BEFORE testing; return first matched term (for
 *   logging) or null.
 *
 * @param {string} text
 * @returns {string|null} matched exclusion term, or null when the text is clean
 */
export const findExclusion = (text) => {
  void text;
  // TODO(lane 4): implement per the build plan; nothing excluded until then.
  return null;
};
