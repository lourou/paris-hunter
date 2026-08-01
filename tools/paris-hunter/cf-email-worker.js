/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Setup:
 * 1. Cloudflare: on a CF-hosted domain/subdomain with MX on Cloudflare (e.g. `parishunter.10u15.net`), enable Email Routing (Dashboard → the domain → Email Routing / Email Service).
 * 2. Create this Worker (Workers & Pages → Create → paste this file). No bindings needed.
 * 3. Set the two env vars as Secrets in the Worker: Settings → Variables & Secrets → add `PH_EMAIL_ENDPOINT` (full `/api/webhook/email/<secret>/alert` URL) and `PH_EMAIL_TOKEN` (the `X-PH-Email-Token` value). Both are secrets — do not use plaintext vars.
 * 4. Email Routing → Routing Rules → route a custom address (e.g. `seloger@parishunter.10u15.net`) → Send to a Worker → this Worker.
 * 5. Fastmail rule: messages From `annonces@alertes.seloger.com` → REDIRECT (NOT "forward as attachment" — redirect preserves the original raw RFC822 so the HTML parts survive intact for parsing) → the Cloudflare routing address above. The SeLoger account is untouched; the rule is one-toggle reversible.
 */

export default {
  /**
   * Relays one inbound Email Routing delivery to the Paris Hunter endpoint.
   *
   * @param {{ raw: ReadableStream }} message
   * @param {{ PH_EMAIL_ENDPOINT: string, PH_EMAIL_TOKEN: string }} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<void>}
   */
  async email(message, env, ctx) {
    void ctx;
    const rawMime = await new Response(message.raw).text();
    const res = await fetch(env.PH_EMAIL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'X-PH-Email-Token': env.PH_EMAIL_TOKEN,
      },
      body: rawMime,
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.log('PH email endpoint returned status', res.status);
      throw new Error('PH email endpoint returned ' + res.status);
    }
  },
};
