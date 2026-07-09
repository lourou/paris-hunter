/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const integerFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const decimalFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

const isNumber = (value) => Number.isFinite(value);
const formatInteger = (value) => integerFormatter.format(value);
const formatDecimal = (value) => decimalFormatter.format(value);
const cleanText = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const cleaned = value.trim();
  return cleaned === '' ? null : cleaned;
};

const arrondissementFor = (zipcode) => {
  const match = /^750(\d{2})$/.exec(String(zipcode ?? '').trim());
  if (match == null) {
    return null;
  }

  const arrondissement = Number(match[1]);
  if (arrondissement < 1 || arrondissement > 20) {
    return null;
  }

  return `Paris ${arrondissement}${arrondissement === 1 ? 'er' : 'e'}`;
};

const buildDropPrefix = (ph) => {
  const oldPrice = isNumber(ph.oldPrice) ? ph.oldPrice : null;
  const newPrice = isNumber(ph.newPrice) ? ph.newPrice : null;
  let variation = isNumber(ph.pctVariation) ? Math.abs(ph.pctVariation) : null;

  if (variation == null && oldPrice > 0 && newPrice != null) {
    variation = Math.abs(((newPrice - oldPrice) / oldPrice) * 100);
  }

  let prefix = '⬇️ baisse de prix';
  if (variation != null) {
    prefix += ` −${formatDecimal(variation)} %`;
  }
  if (oldPrice != null && newPrice != null) {
    prefix += ` : ${formatInteger(oldPrice)} € → ${formatInteger(newPrice)} €`;
  }
  return prefix;
};

const buildSummary = (ph) => {
  const segments = [];
  const flags = Array.isArray(ph.score?.flags) ? ph.score.flags : [];
  const noSurface = flags.includes('NO_SURFACE') || !isNumber(ph.surface) || ph.surface <= 0;
  if (isNumber(ph.rooms)) {
    segments.push(`${formatDecimal(ph.rooms)}P`);
  }
  if (!noSurface) {
    segments.push(`${formatDecimal(ph.surface)} m²`);
  }
  if (isNumber(ph.priceHc)) {
    segments.push(`${formatInteger(ph.priceHc)} € HC`);
  } else if (isNumber(ph.priceCc)) {
    segments.push(`${formatInteger(ph.priceCc)} € CC?`);
  }
  if (!noSurface && isNumber(ph.score?.pricePerM2)) {
    segments.push(`${formatDecimal(ph.score.pricePerM2)} €/m²`);
  }

  let suffix = '';
  if (flags.includes('OVER_CAP')) {
    suffix += ' ⚠️ > plafond';
  } else if (flags.includes('GOOD_DEAL')) {
    suffix += ' ✅ bonne affaire';
  }
  if (noSurface) {
    suffix += ' (surface inconnue)';
  }

  return `🏠${segments.length > 0 ? ` ${segments.join(' · ')}` : ''}${suffix}`;
};

const buildLocation = (ph) => {
  const location = arrondissementFor(ph.zipcode) ?? cleanText(ph.city);
  const quartier = cleanText(ph.quartier);
  if (location == null && !quartier) {
    return null;
  }
  return `📍 ${location ?? 'Paris'}${quartier ? ` — ${quartier}` : ''}`;
};

/**
 * Renders the mobile-first Convos text from only {title, link, ph}. Fredy's
 * mutable/formatted top-level id, price, size, and rooms fields are ignored.
 *
 * @param {{ title: string|null, link: string|null, ph: object }} phListing
 * @returns {string}
 */
export const buildMessage = (phListing) => {
  if (phListing?.ph == null || typeof phListing.ph !== 'object') {
    throw new TypeError('buildMessage requires a listing with numeric ph fields');
  }

  const { ph } = phListing;
  const lines = [];
  if (ph.kind === 'price_drop') {
    lines.push(buildDropPrefix(ph));
  }
  lines.push(buildSummary(ph));

  const location = buildLocation(ph);
  if (location != null) {
    lines.push(location);
  }

  const title = cleanText(phListing.title);
  if (title != null) {
    lines.push(title);
  }

  const phone = cleanText(ph.phone);
  if (phone != null) {
    lines.push(`📞 ${phone}`);
  }

  const link = cleanText(phListing.link);
  if (link != null) {
    lines.push(`🔗 ${link}`);
  }

  return lines.join('\n');
};
