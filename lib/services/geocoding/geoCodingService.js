/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { getGeocoordinatesByAddress } from '../storage/listingsStorage.js';
import { geocode as banGeocode, isPaused as isBanPaused } from './client/banClient.js';
import { geocode as nominatimGeocode, isPaused as isNominatimPaused } from './client/nominatimClient.js';
import logger from '../logger.js';

/**
 * Geocodes an address using BAN (French addresses first), Nominatim as
 * fallback, or cached results from the database.
 * paris-hunter divergence: upstream goes straight to Nominatim.
 *
 * @param {string} address - The address to geocode.
 * @returns {Promise<{lat: number, lng: number}|null>} The geocoordinates or null if error. {lat: -1, lng: -1} if not found.
 */
export async function geocodeAddress(address) {
  if (!address) {
    return null;
  }

  try {
    // 1. Check if we already have this address geocoded in our database
    const cachedCoordinates = getGeocoordinatesByAddress(address);
    if (cachedCoordinates) {
      logger.debug(`Found cached geocoordinates for address: ${address}`);
      return cachedCoordinates;
    }

    // 2. BAN first — it only resolves French addresses (confident hit or null)
    const banCoordinates = await banGeocode(address);
    if (banCoordinates) {
      return banCoordinates;
    }

    // 3. Nominatim fallback — covers non-French queries (and BAN outages)
    return await nominatimGeocode(address);
  } catch (error) {
    logger.error('Error during geocoding:', error);
    return null;
  }
}

/**
 * paris-hunter addition: precision ladder for a normalized listing.
 *
 *   1. street tier — BAN on the provider's `geocodeHint` (street name from a
 *      structured field or extracted from the payload text, postcode-paired);
 *      only street/housenumber precision with a confident score is accepted.
 *      It OVERRIDES native payload coordinates because Stream Estate payloads
 *      carry no structured address field and their `locations` is typically
 *      just the arrondissement centroid (docs example: locations equals
 *      city.location exactly).
 *   2. native payload coordinates (`latitude`/`longitude` set by normalize).
 *   3. free-text `address` geocoding (BAN, then Nominatim) — existing path.
 *
 * @param {import('../../types/listing.js').ParsedListing & {geocodeHint?: string|null}} listing
 * @returns {Promise<{lat: number, lng: number, type?: string}|null>} Same contract as geocodeAddress.
 */
export async function geocodeListing(listing) {
  if (listing == null) {
    return null;
  }

  if (listing.geocodeHint) {
    try {
      // Number-less street queries are constrained to street centroids;
      // a leading house number allows BAN's full housenumber precision.
      const options = /^\d/.test(listing.geocodeHint) ? {} : { type: 'street' };
      const street = await banGeocode(listing.geocodeHint, options);
      if (street && (street.type === 'street' || street.type === 'housenumber')) {
        return street;
      }
    } catch (error) {
      logger.error('Error during street-tier geocoding:', error);
    }
  }

  if (listing.latitude != null && listing.longitude != null) {
    return { lat: listing.latitude, lng: listing.longitude, type: 'native' };
  }

  return geocodeAddress(listing.address);
}

/**
 * Checks if we are currently in a rate limit pause.
 * Only fully paused when BOTH geocoders are paused — BAN alone still serves
 * French addresses while Nominatim cools down, and vice versa.
 * @returns {boolean}
 */
export function isGeocodingPaused() {
  return isBanPaused() && isNominatimPaused();
}
