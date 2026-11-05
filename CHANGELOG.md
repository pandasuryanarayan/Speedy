# Changelog

All notable changes to Speedy. Versions follow [Semantic Versioning](https://semver.org); the format
loosely follows [Keep a Changelog](https://keepachangelog.com).

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
