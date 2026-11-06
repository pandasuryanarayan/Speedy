# Changelog

All notable changes to Speedy. Versions follow [Semantic Versioning](https://semver.org); the format
loosely follows [Keep a Changelog](https://keepachangelog.com).

## [1.5.1]

### Changed
- **Locked chats now use a PIN, not the account password.** The first lock sets a 4–6 digit PIN
  (scrypt-hashed, stored per user); later locks reuse it. Removing a lock needs the PIN too.
  Migration 6 adds `users.pin_hash`.
- The composer stacks attachments **above** the input instead of beside it, so a queued file never
  squeezes the text field.
- The user list is 36 px wider (384 px) to fit longer names and previews.
- The contact panel's close button is pushed to the panel edge, away from the title.

### Added
- **Up to four attachments per pick**, uploaded one at a time and sent as separate messages.
- **Browser notifications** — the profile asks for permission once, and messages that arrive while
  the tab is in the background raise a system notification. Web Push still covers the closed-tab case
  when the instance has VAPID keys.

## [1.5.0]

### Changed
- **The whole interface was rebuilt against the Figma redesign.** The app is now two floating cards
  (sidebar 348 px, conversation) on a tinted canvas with 24 px gutters, and a third 328 px card for
  contact details when you open one.
- Chat header, message bubbles, composer, chat rows, filters, modals and the sign-in screen were all
  restyled to the new scale: 24 px cards, 16 px bubbles and composer, 14 px controls, 1.7-stroke icons.
- The contact panel gained a shared-media strip showing the three most recent photos with "See all",
  and its title now reads "Contact info".
- Sign-in uses the split brand layout with the feature list and a full-height gradient panel.

### Unchanged
- Every feature and endpoint from 1.4.0 — messaging, receipts, presence, attachments, search, pinning,
  locking, blocking, mentions, gallery, offline outbox, moderation, 2FA. This release only moves the
  pixels.

## [1.4.0]

### Added
- **Offline outbox.** A message sent with no connection is kept in `localStorage`, shown with a clock
  icon, and replayed in order when the socket reconnects or the browser reports `online`. Five failed
  attempts mark it as undelivered rather than losing it silently. Sends carry a `clientId` and the
  server treats them as idempotent, so a replay after a timeout cannot create a duplicate.
- **Shared media gallery** per conversation — photos in a grid, files in a list, opened from the chat
  header. Locked conversations still require the unlock token.
- **Delete for me.** Any member can hide a message from their own view without affecting anyone else.
  Hidden messages drop out of history, search, unread counts and the conversation preview.
- **@mentions** in groups: typing `@` opens a member picker, mentions are highlighted in the rendered
  text, `mentionsMe` is flagged for the mentioned user, and offline push says "mentioned you".
- **Dark mode** with a light / dark / follow-system switch in the profile. Built from the same design
  tokens, so type, spacing and layout are identical between themes.

### Changed
- Message menu now offers *Delete for me* for every message, and *Delete for everyone* only for your
  own.
- Theme cycling always changes what you see: from "system" the first click flips to the opposite of the
  current appearance.

### Database
- Migration 5: `messages.client_id` (unique per conversation), `message_hides`, `message_mentions`.

## [1.3.0]
- Two-factor authentication (TOTP with backup codes), email verification and password reset,
  breached-password screening, moderation queue, Web Push, Redis socket adapter, one-command
  self-hosting, CI security scanning.

## [1.2.0]
- Session idle and absolute lifetimes, encrypted attachments at rest, image re-encoding, SSRF guard,
  backup and restore scripts, account export and deletion.

## [1.1.0]
- Pin and lock conversations, single brand theme, invisible-button hover fix.

## [1.0.0]
- Initial release: real-time 1:1 and group messaging, receipts, presence, attachments, search,
  hardened sessions, 14 API tests.
