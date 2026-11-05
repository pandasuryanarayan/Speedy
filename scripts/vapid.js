#!/usr/bin/env node
/** Generates a VAPID keypair for Web Push. Paste the output into .env. */
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log('# Web Push keys — add to .env');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
