/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const EXCLUSIONS = [
  // Furnished keywords: meublé, avec meubles, mobilier, équipé (when clearly indicating furnished)
  ['meuble', /\bmeuble(?:e|es|s)?\b|\bmobilier\b|\bavec[-\s]+meubles?\b|\bfurnished\b/],
  // Colocation keywords: coloc, colocation, colocataire, coliving, flat-sharing
  ['coloc', /\bcoloc(?:ation|ataires?)?s?\b|\bcoliving\b|\bflat[-\s]?shar(?:e|ing)\b|\bcohabitation\b|\broommate/],
  ['bail mobilite', /\bbail[-\s]+mobilite\b/],
  ['courte duree', /\bcourte[-\s]+duree\b/],
  ['sous-location', /\bsous[-\s]?location\b/],
  ['saisonnier', /\bsaisonnier(?:e|es)?\b|\blocation[-\s]+saisonniere\b/],
];

// Matches explicit negations: "non meublé", "pas de meubles", "sans mobilier", etc.
const NEGATED_FURNISHED = /\b(?:non|pas|sans)(?:[-\s]+)(?:(?:de|du|un|une|le|les)(?:[-\s]+))?(?:meuble(?:e|es|s)?|mobilier|meubles)\b/g;

/**
 * Case/diacritic/whitespace normalization shared by every paris-hunter text
 * matcher (exclusions here, premium lease detection in scoring.js).
 *
 * @param {string} text
 * @returns {string}
 */
export const normalizeText = (text) =>
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
  const normalized = normalizeText(text).replace(NEGATED_FURNISHED, ' ');

  for (const [term, pattern] of EXCLUSIONS) {
    if (pattern.test(normalized)) {
      return term;
    }
  }

  return null;
};
