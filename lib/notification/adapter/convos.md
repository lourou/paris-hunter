# Convos (XMTP)

Posts paris-hunter listings to a private [Convos](https://convos.org) group over XMTP: one encrypted photo bubble (`sendRemoteAttachment`) followed by one scored text bubble (`sendText`).

This adapter is intentionally different from the other Fredy adapters:

- **It does not read the listings it is called with.** The `streamEstate` provider writes every notification into the durable `convos_outbox` table inside its decision transaction; this adapter (like the `convos:flush` bus event and a 60 s timer) only triggers the single-flight outbox drain. Delivery is at-least-once — duplicates are possible only when the process dies exactly between a network send and the state write, and every such resend is WARN-logged (`possible duplicate`).
- **All configuration comes from environment variables**, not job fields: `CONVOS_ENABLED`, `XMTP_ENV`, `CONVOS_DATA_DIR`, `CONVOS_INVITE_URL` (one-shot, first boot only), `CONVOS_PROFILE_NAME`, plus the attachment storage block (`ATTACHMENT_STORE`, `SCW_*`, `ATTACHMENTS_*`). See `.env.example`.

## Identity and state

`CONVOS_DATA_DIR` (one Docker volume, ONE writer — a second process on the same dir exits non-zero):

- `identity.json` — wallet key + DB encryption key. Deleting it = brand-new identity (needs a fresh invite).
- `adapter-state.json` — the joined conversation. While it exists and is healthy, the join flow **never** re-runs (re-redeeming an invite re-DMs the creator and can burn it).
- `db/<env>/main.db3` — the XMTP client database. Back up the whole directory as one unit.

## First boot

1. Create the group in the Convos app and mint an invite.
2. Set `CONVOS_INVITE_URL` and start the adapter with an empty data dir; it sends a join request over a DM (the group stays silent) and polls up to 24 h for acceptance.
3. After the join, lock the conversation in the app (this rotates the invite tag — the only real invalidation of the outstanding invite URL).

Photos are encrypted before upload; the (Scaleway) bucket only ever stores ciphertext, so `public-read` leaks nothing but size. Objects are auto-expired by the `ph-attachments-30d` lifecycle rule.
