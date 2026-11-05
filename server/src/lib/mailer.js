import nodemailer from 'nodemailer';
import config from '../config.js';
import logger from './logger.js';

/**
 * SMTP is optional. Without it the app still works: verification and reset
 * links are written to the log so a self-hoster can copy them out during setup.
 */
let transport = null;

export const isMailConfigured = () => Boolean(config.smtp.host);

function getTransport() {
  if (!isMailConfigured()) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transport;
}

export async function sendMail({ to, subject, text, html }) {
  const t = getTransport();
  if (!t) {
    logger.warn({ to, subject }, `SMTP not configured - email not sent. Body: ${text}`);
    return { delivered: false, reason: 'smtp_not_configured' };
  }
  await t.sendMail({ from: config.smtp.from, to, subject, text, html });
  return { delivered: true };
}
