// POST /api/order — السيرفر وحده يحسب السعر ويتحقق من الرصيد وينشئ الطلب (Vercel / Node)
// المتغير البيئي المطلوب: FIREBASE_SERVICE_ACCOUNT (JSON حساب الخدمة)
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))});
const db = admin.firestore(), FV = admin.firestore.FieldValue;
const PEG = 140, BASE_SYP = 10000, RATE_MIN = 98, RATE_MAX = 182;
const r2 = n => Math.round(n * 100) / 100, num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isOk = s => /قبول|مقبول/.test(String(s || '')), isNo = s => /رفض|مرفوض|ملغ/.test(String(s || ''));
const fail = (s, e) => Object.assign(new Error(e), {s, e});
const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
let cache = {t: 0};
async function loadCat() {
  if (Date.now() - cache.t < 30000) return cache;
  const [b, o, r] = await Promise.all([db.doc('catalog/base').get(), db.doc('config/shopc_catalog').get(), db.doc('config/rate').get()]);
  let items = {}, ov = {}; try { items = JSON.parse((b.data() || {}).v || '{}'); } catch (x) {} try { ov = JSON.parse((o.data() || {}).v || '{}'); } catch (x) {}
  let rate = num((r.data() || {}).syp); if (!(rate >= RATE_MIN && rate <= RATE_MAX)) rate = PEG;
  return (cache = {t: Date.now(), items, ov: ov || {}, rate});
}
// يرجع {title, label, usd?, syp?} من كتالوج السيرفر فقط (لا يثق بأي سعر من المتصفح)
function resolve(it, C) {
  const t = it && it.t, P = (C.ov && C.ov.price) || {}, ADD = (C.ov && C.ov.add) || {}, g = k => C.items[k];
  const sec = k => (C.ov.secs || []).find(s => 'cs_' + s.id === k);
  if (t === 'game') {
    const k = txt(it.k, 60), l = txt(it.l, 120), e = g(`game|${k}|${l}`);
    if (e) { const p = P[`${k}|${l}`] != null ? num(P[`${k}|${l}`]) : e.usd; return {title: e.t, label: l, usd: p}; }
    const a = (ADD[k] || []).find(x => x.label === l) || ((sec(k) || {}).items || []).find(x => x.label === l);
    return a ? {title: (sec(k) || {}).name || k, label: l, usd: a.price} : null;
  }
  if (t === 'live' || t === 'card') {
    const e = g(`${t}|${txt(it.k, 40)}|${txt(it.l, 120)}`); return e && {title: e.t, label: e.l, usd: e.usd};
  }
  if (t === 'social') { const e = g(`social|${txt(it.a, 20)}|${txt(it.y, 20)}|${Math.trunc(num(it.q))}`); return e && {title: e.t, label: e.l, syp: e.syp}; }
  if (t === 'wa') { const e = g(`wa|${txt(it.l, 120)}`); return e && {title: e.t, label: e.l, syp: e.syp}; }
  if (t === 'pc') {
    let e, p;
    if (it.m === 'steam') e = g(`pc|steam|${Math.trunc(num(it.v))}`);
    else if (it.m === 'game') e = g(`pc|game|${txt(it.k, 40)}|${Math.trunc(num(it.i))}`);
    else if (it.m === 'list') {
      const k = txt(it.k, 20), l = txt(it.l, 160); e = g(`pc|list|${k}|${l}`);
      if (e) p = P[`pc:${k}|${l}`] != null ? num(P[`pc:${k}|${l}`]) : e.usd;
      else { const a = (ADD['pc:' + k] || []).find(x => x.label === l && x.price != null); if (a) return {title: 'متجر PC', label: l, usd: a.price}; }
    }
    return e && {title: e.t, label: e.l, usd: p != null ? p : e.usd};
  }
  return null;
}
function typed(it, f) { // شحن رصيد / تطبيقات دفع: المبلغ يكتبه المستخدم بالليرة ويتحقق منه السيرفر
  const s = String((f && f[1]) || '').trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s) || !(Number(s) >= 1) || Number(s) > 2000000) throw fail(400, 'bad-amount');
  return {title: txt(it.op, 40) || 'خدمة', label: '', typedSyp: Number(s)};
}
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') throw fail(405, 'method');
    const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const au = await admin.auth().verifyIdToken(tok, true).catch(() => { throw fail(401, 'auth'); });
    if (au.email_verified !== true) throw fail(403, 'email-not-verified');
    const uid = au.uid, B = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}), now = Date.now();
    const uref = db.doc('users/' + uid);
    if (B.cancel != null) { // إلغاء طلب قيد المراجعة (بالسيرفر فقط)
      const oref = db.doc(`orders/${uid}_${Math.trunc(num(B.cancel))}`);
      await db.runTransaction(async tx => {
        const o = await tx.get(oref); if (!o.exists || o.data().uid !== uid) throw fail(404, 'not-found');
        if (o.data().status !== 'قيد المراجعة') throw fail(409, 'not-cancellable');
        tx.update(oref, {status: 'ملغاة', decAt: now});
      });
      return res.status(200).json({ok: true});
    }
    const id = Math.trunc(num(B.id)); if (!(id > 1e12 && id < 4e12)) throw fail(400, 'bad-id');
    const it = B.item && typeof B.item === 'object' ? B.item : {}, f = (Array.isArray(B.f) ? B.f : []).slice(0, 6).map(x => txt(x, 200));
    const us = await uref.get(), u = us.data() || {};
    if (u.banned) throw fail(403, 'banned');
    const lockDoc = (await db.doc('config/shopc_lock').get()).data() || {}; let lock = {}; try { lock = JSON.parse(lockDoc.v || '{}'); } catch (x) {}
    if (lock.on && u.role !== 'admin') throw fail(403, 'service-off');
    const C = await loadCat(); let amt = 0, title, lines = [];
    if (it.t === 'bal' || it.t === 'pay') {
      const r = typed(it, f); amt = r2(r.typedSyp / PEG); title = r.title; lines = [`البيانات: ${f.join(' | ')}`];
    } else if (it.t === 'soc1k') { title = 'رشق ' + txt(it.app, 30); lines = [`النوع: ${txt(it.y, 20)}`, `الكمية: ${Math.trunc(num(it.q))}`, `البيانات: ${f.join(' | ')}`]; // بلا سعر محدد بعد
    } else {
      const r = resolve(it, C); if (!r) throw fail(400, 'bad-item');
      if (r.usd == null && r.syp == null) throw fail(400, 'no-price');
      amt = r.usd != null ? r2(r.usd * C.rate / PEG) : r2(Math.round(r.syp * C.rate / PEG) / PEG);
      title = r.title; lines = [`الباقة: ${r.label}`, `البيانات: ${f.join(' | ')}`];
    }
    if (B.exp != null && Math.abs(num(B.exp) - amt) > 0.011) throw fail(422, 'price-changed');
    if (amt > 0) lines.push(`تم خصم ${Math.round(amt * PEG).toLocaleString('en-US')} SYP من رصيدك`);
    const oref = db.doc(`orders/${uid}_${id}`), code = /^[A-Za-z0-9\-]{4,20}$/.test(String(B.code || '')) ? B.code : 'EX-' + id.toString(36).toUpperCase();
    await db.runTransaction(async tx => {
      const [us2, os, ords, deps] = await Promise.all([tx.get(uref), tx.get(oref), tx.get(db.collection('orders').where('uid', '==', uid)), tx.get(db.collection('deposits').where('uid', '==', uid))]);
      if (os.exists) throw fail(409, 'duplicate');
      const u2 = us2.data() || {}; if (u2.banned) throw fail(403, 'banned');
      if (u2.lastOrderAt && now - u2.lastOrderAt < 1500) throw fail(429, 'rate');
      let bal = r2(BASE_SYP / PEG) + num(u2.adj);
      deps.forEach(d => { const x = d.data(); if (x.dec === 'ok') bal += num(x.amt); });
      ords.forEach(d => { const o = d.data(); if (o.mtn && isOk(o.status)) bal += r2(num(o.mtn.credited) / PEG); if (!isNo(o.status) && num(o.amt) > 0) bal -= num(o.amt); });
      if (amt > r2(bal) + 1e-9) throw fail(402, 'insufficient');
      tx.set(uref, {lastOrderAt: now, ordSeq: FV.increment(1)}, {merge: true}); // يمنع تنفيذ طلبين متزامنين لنفس الحساب
      tx.set(oref, {id, uid, em: au.email || '', code, title, lines, status: 'قيد المراجعة', amt, item: it, ts: now, time: new Date(now).toLocaleString('ar')});
    });
    res.status(200).json({ok: true, amt});
  } catch (e) { res.status(e.s || 500).json({error: e.s ? e.e : 'server'}); if (!e.s) console.error(e); }
};
