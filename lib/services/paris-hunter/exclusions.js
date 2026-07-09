/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const EXCLUSIONS = [
  ['meuble', /\bmeuble/],
  ['coloc', /\bcoloc(?:ation)?s?\b/],
  ['bail mobilite', /\bbail[-\s]+mobilite\b/],
  ['courte duree', /\bcourte[-\s]+duree\b/],
  ['sous-location', /\bsous[-\s]?location\b/],
  ['saisonnier', /\bsaisonnier(?:e|es)?\b|\blocation[-\s]+saisonniere\b/],
];

const NEGATED_FURNISHED = /\b(?:non|pas)(?:[-\s]+)(?:(?:de|du|un|une)(?:[-\s]+))?meuble(?:e|es|s)?\b/g;

const normalize = (text) =>
  String(text ?? '')
    .toLocaleLowerCase('fr-FR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Finds the first hard-exclusion term after case/diacritic normalization.
 * Explicit "non/pas meublé" phrases are removed before furnished matching.
 * Stable canonical terms are returned so provider decisions remain queryable.
 *
 * @param {string} text
 * @returns {string|null} matched exclusion term, or null when the text is clean
 */
export const findExclusion = (text) => {
  const normalized = normalize(text).replace(NEGATED_FURNISHED, ' ');

  for (const [term, pattern] of EXCLUSIONS) {
    if (pattern.test(normalized)) {
      return term;
    }
  }

  return null;
};
