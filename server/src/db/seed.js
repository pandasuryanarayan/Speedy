import config from '../config.js';
import logger from '../lib/logger.js';
import { get, closeDb } from './index.js';
import { migrate } from './migrate.js';
import * as auth from '../modules/auth/service.js';
import * as chats from '../modules/chats/service.js';
import * as messages from '../modules/messages/service.js';

const DEMO_PASSWORD = 'speedy-demo-123';

const PEOPLE = [
  { username: 'surya', displayName: 'Suryanarayan Panda', about: 'Building Speedy' },
  { username: 'alice', displayName: 'Alice Sharma', about: 'Design at Northwind' },
  { username: 'bob', displayName: 'Bob Mehta', about: 'Backend, coffee, cricket' },
  { username: 'carol', displayName: 'Carol Iyer', about: 'On the road' },
  { username: 'dev', displayName: 'Dev Patel', about: 'QA and chaos engineering' },
];

const DEMO_MESSAGES = [
  ['alice', 'Hey! The new chat UI is live on staging 👀'],
  ['surya', 'Just opened it. The message bubbles look so much cleaner.'],
  ['alice', 'Right? I kept it minimal — one accent colour, generous spacing.'],
  ['surya', 'Nice. Did you also fix the read receipts?'],
  ['alice', 'Yep, double ticks now actually update in real time.'],
  ['surya', 'Perfect. I will review the PR tonight.'],
];

export async function seed({ quiet = false } = {}) {
  await migrate({ quiet: true });

  const existing = await get('SELECT id FROM users LIMIT 1');
  if (existing) {
    if (!quiet) logger.warn('database already has data, skipping seed');
    return { skipped: true };
  }

  const ids = {};
  for (const person of PEOPLE) {
    const result = await auth.register({ ...person, password: DEMO_PASSWORD });
    ids[person.username] = result.user.id;
  }

  const direct = await chats.createDirectChat(ids.surya, ids.alice);
  for (const [from, body] of DEMO_MESSAGES) {
    await messages.sendMessage(ids[from], { chatId: direct.id, type: 'text', body });
  }

  const group = await chats.createGroupChat(ids.surya, {
    title: 'Weekend Trip 🏔',
    memberIds: [ids.alice, ids.bob, ids.carol],
  });
  const groupChat = [
    ['alice', 'Booked the cottage for Saturday. 4 beds, 2 baths.'],
    ['bob', 'Legend. I will drive, can take three people.'],
    ['carol', 'I am in. Bringing the trekking poles.'],
    ['surya', 'Adding a shared checklist tonight.'],
  ];
  for (const [from, body] of groupChat) {
    await messages.sendMessage(ids[from], { chatId: group.id, type: 'text', body });
  }

  const bobChat = await chats.createDirectChat(ids.surya, ids.bob);
  await messages.sendMessage(ids.bob, { chatId: bobChat.id, type: 'text', body: 'Deploy at 6pm? I can watch the dashboards.' });
  await messages.sendMessage(ids.surya, { chatId: bobChat.id, type: 'text', body: 'Works for me. I will trigger it.' });

  const carolChat = await chats.createDirectChat(ids.surya, ids.carol);
  await messages.sendMessage(ids.carol, { chatId: carolChat.id, type: 'text', body: 'Reached Manali. Sending photos soon!' });
  await messages.sendMessage(ids.carol, { chatId: carolChat.id, type: 'text', body: 'Also, the new app feels fast on 3G 👌' });

  if (!quiet) {
    logger.info(
      { accounts: PEOPLE.map((p) => p.username), password: DEMO_PASSWORD, db: config.dbFile },
      'seed complete',
    );
  }
  return { skipped: false };
}

const isMain = process.argv[1] && process.argv[1].endsWith('seed.js');
if (isMain) {
  seed()
    .then(() => closeDb())
    .catch((err) => {
      logger.error({ err }, 'seed failed');
      process.exitCode = 1;
    });
}
