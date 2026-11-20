// Vercel serverless: حذف الحساب من قاعدة البيانات (وليس من المتصفح)
// المتغير المطلوب في Vercel: FIREBASE_SERVICE_ACCOUNT = محتوى مفتاح Service Account (JSON)
const admin = require('firebase-admin');
const crypto = require('crypto');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = admin.firestore();
const sha = s => crypto.createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex');

async function delQuery(q) {
  const sn = await q.get();
  for (let i = 0; i < sn.docs.length; i += 400) {
    const b = db.batch(); sn.docs.slice(i, i + 400).forEach(d => b.delete(d.ref)); await b.commit();
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return res.status(401).json({ error: 'unauthorized' });
    const tok = await admin.auth().verifyIdToken(m[1], true);
    const uid = tok.uid;
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    // يجب أن يكون التأكيد حديثاً: كلمة السر/Google خلال 5 دقائق، البصمة خلال 24 ساعة
    const age = Date.now() / 1000 - Number(tok.auth_time || 0);
    if (age > (body.bio === true ? 86400 : 300)) return res.status(403).json({ error: 'recent-login-required' });

    const ref = db.collection('users').doc(uid);
    const snap = await ref.get();
    const u = snap.exists ? snap.data() : {};
    if (u.role === 'admin') return res.status(403).json({ error: 'admin-protected' });

    const pend = await db.collection('orders').where('uid', '==', uid).where('status', '==', 'قيد المراجعة').limit(1).get();
    if (!pend.empty) return res.status(409).json({ error: 'pending-orders' });

    const email = String(tok.email || u.em || '').toLowerCase();
    const now = admin.firestore.FieldValue.serverTimestamp();
    // سجل الحظر: البريد (ورقم الهاتف إن وُجد) بصيغة مشفّرة SHA-256
    if (email) await db.collection('deletedAccounts').doc('e_' + sha(email)).set({ at: now });
    if (u.ph) await db.collection('deletedAccounts').doc('p_' + sha(u.ph)).set({ at: now });

    // حذف بيانات المستخدم (سجلات الطلبات المالية تبقى للمحاسبة)
    await delQuery(db.collection('chatmsgs').where('cid', '==', uid));
    if (email) await delQuery(db.collection('chatmsgs').where('cid', '==', email));
    await ref.delete();

    // تعطيل حساب Auth وإبقاؤه محجوزاً: يمنع تسجيل الدخول وإنشاء حساب جديد بنفس البريد (بريد/Google)
    await admin.auth().updateUser(uid, { disabled: true });
    await admin.auth().revokeRefreshTokens(uid);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('delete-account', e);
    return res.status(500).json({ error: 'server' });
  }
};
