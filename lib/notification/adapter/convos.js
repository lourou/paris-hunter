/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { markdown2Html } from '../../services/markdown.js';
import { flushOutbox } from '../../services/paris-hunter/convos/index.js';

/**
 * paris-hunter Convos (XMTP) notification adapter — a FLUSH TRIGGER, not a sender.
 *
 * Listings arriving from Fredy's _notify are IGNORED as data (build plan v2 #8:
 * Fredy mutates listing.id to a DB nanoid and stringifies price/size/rooms). The
 * provider writes the durable convos_outbox rows inside its decision transaction;
 * this adapter merely nudges the single-flight drain (which is also driven by the
 * 'convos:flush' bus event and a 60 s timer). All secrets/config come from env —
 * no per-job fields.
 */
export const send = () => {
  void flushOutbox();
  return [];
};

export const config = {
  id: 'convos',
  name: 'Convos (XMTP)',
  description: 'Posts scored paris-hunter listings to a Convos group (photo + text) via the durable outbox.',
  readme: markdown2Html('lib/notification/adapter/convos.md'),
  fields: {},
};
