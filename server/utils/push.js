// Push notifications to the team's phones (and desktops) when a lead arrives.
//
// Standard Web Push. The VAPID key pair is generated once on first boot and kept in the
// settings table on the Railway volume, so there is nothing to configure and the keys
// survive deploys. On iPhone, push only works for the installed home-screen app (iOS
// 16.4+), which the team already has.

const webpush = require('web-push');
const { db, settingGet2: get, settingSet2: set } = require('../db');

function keys() {
  let pub = get('vapid_public'), priv = get('vapid_private');
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    pub = k.publicKey; priv = k.privateKey;
    set('vapid_public', pub); set('vapid_private', priv);
    console.log('[push] generated VAPID keys');
  }
  const subject = process.env.VAPID_SUBJECT || 'mailto:' + (get('company_email') || 'enquiry@estatelandscapers.com.au');
  webpush.setVapidDetails(subject, pub, priv);
  return { pub, priv };
}

function subscribe(user, sub, ua) {
  if (!sub || !sub.endpoint) throw new Error('bad subscription');
  db.prepare(`INSERT INTO push_subscriptions (id,user,endpoint,keys_json,ua,created_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(endpoint) DO UPDATE SET user=excluded.user, keys_json=excluded.keys_json, ua=excluded.ua`)
    .run(require('crypto').randomUUID(), user || '', sub.endpoint, JSON.stringify(sub.keys || {}), String(ua || '').slice(0, 200));
}

function unsubscribe(endpoint) { db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(endpoint); }

// Send to every subscribed device. Dead subscriptions (phone removed the app, permission
// revoked) come back 404/410 and are deleted so they stop costing time.
async function notify({ title, body, url, tag }) {
  keys();
  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  const payload = JSON.stringify({ title, body, url: url || '/admin/', tag: tag || 'estate' });
  let sent = 0, dropped = 0;
  await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys_json || '{}') }, payload, { TTL: 60 * 60 * 12 });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { unsubscribe(s.endpoint); dropped++; }
      else console.log('[push] send failed:', e.statusCode || e.message);
    }
  }));
  if (subs.length) console.log(`[push] "${title}" -> ${sent} device(s)${dropped ? `, ${dropped} dropped` : ''}`);
  return { sent, dropped, total: subs.length };
}

function count() { return db.prepare('SELECT COUNT(*) c FROM push_subscriptions').get().c; }

module.exports = { keys, subscribe, unsubscribe, notify, count };
