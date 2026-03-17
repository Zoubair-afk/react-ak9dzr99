import React, { useState, useEffect, useRef } from 'react';

// ═══════════════════════════════════════════════════════════════════════════════
// 🔧 SUPABASE CONFIG
// ═══════════════════════════════════════════════════════════════════════════════
const SUPABASE_URL = 'https://hilrbzzoazlfzywngnzp.supabase.co';
const SUPABASE_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhpbHJienpvYXpsZnp5d25nbnpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2OTUwMTUsImV4cCI6MjA4ODI3MTAxNX0.nupXzJHiAm8RaNzvgCRGuRWjy5dNueBw2FginlsEdbk';

// ─── ⚠️  Run this SQL in Supabase → SQL Editor before deploying v6 ───────────
// ALTER TABLE bookings    ADD COLUMN IF NOT EXISTS group_id  TEXT;
// ALTER TABLE instruments ADD COLUMN IF NOT EXISTS max_days  INTEGER;
// ALTER TABLE accounts    ADD COLUMN IF NOT EXISTS status    TEXT DEFAULT 'approved';
// -- To require approval for all NEW signups, change the default:
// -- ALTER TABLE accounts ALTER COLUMN status SET DEFAULT 'pending';
// ─────────────────────────────────────────────────────────────────────────────

// ─── Minimal Supabase client ──────────────────────────────────────────────────
function createClient(url, key) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
  async function from(table) {
    const base = `${url}/rest/v1/${table}`;
    return {
      async select(cols = '*', opts = {}) {
        let q = `${base}?select=${cols}`;
        if (opts.eq)
          Object.entries(opts.eq).forEach(([k, v]) => {
            q += `&${k}=eq.${encodeURIComponent(v)}`;
          });
        if (opts.neq)
          Object.entries(opts.neq).forEach(([k, v]) => {
            q += `&${k}=neq.${encodeURIComponent(v)}`;
          });
        if (opts.order) q += `&order=${opts.order}`;
        const r = await fetch(q, {
          headers: { ...headers, Prefer: 'return=representation' },
        });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      async insert(data) {
        const r = await fetch(base, {
          method: 'POST',
          headers: { ...headers, Prefer: 'return=representation' },
          body: JSON.stringify(data),
        });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      async update(data, match) {
        let q = `${base}?`;
        Object.entries(match).forEach(([k, v]) => {
          q += `${k}=eq.${encodeURIComponent(v)}&`;
        });
        const r = await fetch(q, {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=representation' },
          body: JSON.stringify(data),
        });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      async delete(match) {
        let q = `${base}?`;
        Object.entries(match).forEach(([k, v]) => {
          q += `${k}=eq.${encodeURIComponent(v)}&`;
        });
        const r = await fetch(q, { method: 'DELETE', headers });
        if (!r.ok) throw new Error(await r.text());
        return true;
      },
    };
  }
  function channel(name) {
    let ws,
      handlers = {};
    return {
      on(event, filter, cb) {
        handlers[filter?.event ?? event] = cb;
        return this;
      },
      subscribe() {
        const wsUrl = `${url.replace(
          'https',
          'wss'
        )}/realtime/v1/websocket?apikey=${key}&vsn=1.0.0`;
        ws = new WebSocket(wsUrl);
        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              topic: `realtime:${name}`,
              event: 'phx_join',
              payload: {},
              ref: '1',
            })
          );
        };
        ws.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data);
            const ev = msg.payload?.data?.type;
            if (ev && handlers[ev]) handlers[ev](msg.payload.data);
            if (handlers['*']) handlers['*'](msg.payload?.data);
          } catch {}
        };
        return this;
      },
      unsubscribe() {
        ws?.close();
      },
    };
  }
  return { from: (t) => from(t), channel };
}

const sb = createClient(SUPABASE_URL, SUPABASE_ANON);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function genId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}
const NOW = new Date();
const todayStr = NOW.toISOString().split('T')[0];
function toMins(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function minsToTime(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(
    m % 60
  ).padStart(2, '0')}`;
}
function durationMins(s, e) {
  return toMins(e) - toMins(s);
}
function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${
    h >= 12 ? 'PM' : 'AM'
  }`;
}
function fmtDate(
  d,
  opts = { weekday: 'short', month: 'short', day: 'numeric' }
) {
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', opts);
}
async function hashPw(pw) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(pw),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode('labbook-salt-v1'),
      iterations: 100000,
      hash: 'SHA-256',
    },
    key,
    256
  );
  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem('lb_session'));
    if (!s) return null;
    if (Date.now() - (s.lastActive || 0) > 24 * 60 * 60 * 1000) {
      localStorage.removeItem('lb_session');
      return null;
    }
    return s;
  } catch {
    return null;
  }
}
function saveSession(s) {
  try {
    localStorage.setItem(
      'lb_session',
      JSON.stringify(s ? { ...s, lastActive: Date.now() } : null)
    );
  } catch {}
}
function loadTheme() {
  try {
    return localStorage.getItem('lb_theme') || 'dark';
  } catch {
    return 'dark';
  }
}
function saveTheme(v) {
  try {
    localStorage.setItem('lb_theme', v);
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROOT APP
// ═══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [isDark, setIsDark] = useState(() => loadTheme() === 'dark');
  function toggleTheme() {
    setIsDark(function (d) {
      var n = !d;
      saveTheme(n ? 'dark' : 'light');
      return n;
    });
  }
  var T = isDark ? DARK : LIGHT;
  S = makeS(T);
  var CSS = makeCss(T);

  const [session, setSession] = useState(loadSession);
  const [accounts, setAccounts] = useState([]);
  const [instruments, setInstruments] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dbError, setDbError] = useState(null);
  const [view, setView] = useState('home');
  const [viewData, setViewData] = useState({});
  const [toast, setToast] = useState(null);
  const [notifs, setNotifs] = useState([]);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(tick);
  }, []);
  const realtimeRef = useRef(null);

  const currentAccount =
    accounts.find((a) => a.id === session?.accountId) ?? null;
  // Treat null/undefined status as 'approved' for backwards compatibility
  const currentStatus = currentAccount?.status ?? 'approved';
  const activeBookings = bookings.filter((b) => !b.cancelled);

  useEffect(() => {
    loadAll();
  }, []);

  async function loadAll() {
    setLoading(true);
    setDbError(null);
    try {
      const [accs, insts, bks] = await Promise.all([
        (await sb.from('accounts')).select('*'),
        (await sb.from('instruments')).select('*', { order: 'name.asc' }),
        (
          await sb.from('bookings')
        ).select('*', { order: 'date.asc,start_time.asc' }),
      ]);
      setAccounts(accs);
      setInstruments(insts);
      setBookings(bks);
    } catch (e) {
      setDbError(e.message || 'Could not connect to database.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const ch = sb
      .channel('public:all')
      .on('postgres_changes', { event: '*' }, (payload) => {
        const { type, table, new: row, old } = payload;
        if (table === 'bookings') {
          if (type === 'INSERT') {
            setBookings((p) => [...p, row]);
            if (row.user_display_name !== currentAccount?.display_name)
              pushNotif(
                `📅 ${row.user_display_name} booked ${
                  instruments.find((i) => i.id === row.instrument_id)?.name ??
                  ''
                } on ${fmtDate(row.date)}`
              );
          }
          if (type === 'UPDATE')
            setBookings((p) => p.map((b) => (b.id === row.id ? row : b)));
          if (type === 'DELETE')
            setBookings((p) => p.filter((b) => b.id !== old.id));
        }
        if (table === 'instruments') {
          if (type === 'INSERT') setInstruments((p) => [...p, row]);
          if (type === 'UPDATE')
            setInstruments((p) => p.map((i) => (i.id === row.id ? row : i)));
          if (type === 'DELETE')
            setInstruments((p) => p.filter((i) => i.id !== old.id));
        }
        if (table === 'accounts') {
          if (type === 'INSERT') setAccounts((p) => [...p, row]);
          if (type === 'UPDATE')
            setAccounts((p) => p.map((a) => (a.id === row.id ? row : a)));
          if (type === 'DELETE')
            setAccounts((p) => p.filter((a) => a.id !== old.id));
        }
      })
      .subscribe();
    realtimeRef.current = ch;
    async function poll() {
      try {
        const [bks, insts, accs] = await Promise.all([
          (
            await sb.from('bookings')
          ).select('*', { order: 'date.asc,start_time.asc' }),
          (await sb.from('instruments')).select('*', { order: 'name.asc' }),
          (await sb.from('accounts')).select('*'),
        ]);
        setBookings(bks);
        setInstruments(insts);
        setAccounts(accs);
      } catch (e) {
        /* silent */
      }
    }
    const pollInterval = setInterval(poll, 5000);

    return () => {
      ch.unsubscribe();
      clearInterval(pollInterval);
    };
  }, []);

  function showToast(msg, type = 'success') {
    setToast({ msg, type, id: genId() });
    setTimeout(() => setToast(null), 3200);
  }
  function pushNotif(msg) {
    setNotifs((p) =>
      [{ id: genId(), msg, ts: new Date().toLocaleTimeString() }, ...p].slice(
        0,
        30
      )
    );
  }
  function navigate(v, data = {}) {
    setView(v);
    setViewData(data);
  }

  // Reset inactivity timer on any navigation
  useEffect(() => {
    if (session) saveSession(session);
  }, [view]);

  // ── Auth ──────────────────────────────────────────────────────────────────
  async function login(username, password) {
    const acc = accounts.find(
      (a) => a.username.toLowerCase() === username.trim().toLowerCase()
    );
    if (!acc) return 'No account found with that username.';
    const newHash = await hashPw(password);
    const oldHash = (function (pw) {
      let h = 0;
      for (let i = 0; i < pw.length; i++) {
        h = (h << 5) - h + pw.charCodeAt(i);
        h |= 0;
      }
      return h.toString(16);
    })(password);
    if (acc.password_hash !== newHash && acc.password_hash !== oldHash)
      return 'Incorrect password.';
    const accStatus = acc.status ?? 'approved';
    if (accStatus === 'pending')
      return '⏳ Your account is awaiting admin approval.';
    if (accStatus === 'rejected')
      return '❌ Your account request was not approved. Contact a lab admin.';
    if (acc.password_hash === oldHash) {
      try {
        const db = await sb.from('accounts');
        await db.update({ password_hash: newHash }, { id: acc.id });
        setAccounts((p) =>
          p.map((a) => (a.id === acc.id ? { ...a, password_hash: newHash } : a))
        );
      } catch (e) {}
    }
    const s = { accountId: acc.id };
    setSession(s);
    saveSession(s);
    showToast(`Welcome back, ${acc.display_name.split(' ')[0]}! 👋`);
    return null;
  }

  async function signup(username, displayName, password) {
    if (!username.trim() || !displayName.trim() || !password)
      return 'All fields are required.';
    if (username.trim().length < 3)
      return 'Username must be at least 3 characters.';
    if (password.length < 4) return 'Password must be at least 4 characters.';
    if (
      accounts.find(
        (a) => a.username.toLowerCase() === username.trim().toLowerCase()
      )
    )
      return 'Username already taken.';
    try {
      const db = await sb.from('accounts');
      const [newAcc] = await db.insert({
        id: genId(),
        username: username.trim().toLowerCase(),
        display_name: displayName.trim(),
        password_hash: await hashPw(password),
        is_admin: false,
        status: 'pending',
      });
      setAccounts((p) => [...p, newAcc]);
      const s = { accountId: newAcc.id };
      setSession(s);
      saveSession(s);
      showToast(`Request submitted, ${newAcc.display_name.split(' ')[0]}! 🎉`);
      return null;
    } catch (e) {
      return e.message || 'Signup failed.';
    }
  }

  function logout() {
    setSession(null);
    saveSession(null);
    setView('home');
    setNotifs([]);
  }

  // ── Booking CRUD ───────────────────────────────────────────────────────────
  async function addBooking(b) {
    try {
      // Re-fetch caller's account to verify approval status hasn't changed
      const freshAccounts = await (await sb.from('accounts')).select('*');
      const callerAcc = freshAccounts.find((a) => a.id === session?.accountId);
      const callerStatus = callerAcc?.status ?? 'approved';
      if (callerStatus === 'pending' || callerStatus === 'rejected') {
        showToast('Your account is not approved to make bookings.', 'error');
        setAccounts(freshAccounts);
        return;
      }
      const freshBookings = await (
        await sb.from('bookings')
      ).select('*', { order: 'date.asc,start_time.asc' });
      setBookings(freshBookings);
      const db = await sb.from('bookings');
      const hasConflict = freshBookings.some((existing) => {
        if (
          existing.instrument_id !== b.instrumentId ||
          existing.date !== b.date ||
          existing.cancelled
        )
          return false;
        return !(
          b.endTime <= existing.start_time || b.startTime >= existing.end_time
        );
      });
      if (hasConflict) {
        showToast(
          'Slot just got booked by someone else — please pick another time',
          'error'
        );
        return;
      }
      const [nb] = await db.insert({
        id: genId(),
        group_id: b.groupId || null,
        instrument_id: b.instrumentId,
        user_display_name: b.user,
        date: b.date,
        start_time: b.startTime,
        end_time: b.endTime,
        note: b.note || '',
        cancelled: false,
        recurring: b.recurring ? JSON.stringify(b.recurring) : null,
      });
      setBookings((p) => [...p, nb]);
      showToast('Booking confirmed ✓');
    } catch (e) {
      showToast(e.message || 'Booking failed', 'error');
    }
  }

  async function cancelBooking(id) {
    try {
      const db = await sb.from('bookings');
      await db.update({ cancelled: true }, { id });
      setBookings((p) =>
        p.map((b) => (b.id === id ? { ...b, cancelled: true } : b))
      );
      showToast('Booking cancelled', 'warn');
    } catch (e) {
      showToast(e.message || 'Cancel failed', 'error');
    }
  }

  // Cancel entire multi-day group or a single booking
  async function cancelBookingGroup(groupId, singleId) {
    try {
      const db = await sb.from('bookings');
      const targets = groupId
        ? bookings.filter((b) => b.group_id === groupId).map((b) => b.id)
        : [singleId];
      await Promise.all(
        targets.map((id) => db.update({ cancelled: true }, { id }))
      );
      setBookings((p) =>
        p.map((b) => (targets.includes(b.id) ? { ...b, cancelled: true } : b))
      );
      showToast(
        targets.length > 1
          ? `${targets.length}-day booking cancelled`
          : 'Booking cancelled',
        'warn'
      );
    } catch (e) {
      showToast(e.message || 'Cancel failed', 'error');
    }
  }

  async function updateBooking(id, updates) {
    try {
      const db = await sb.from('bookings');
      await db.update(updates, { id });
      setBookings((p) =>
        p.map((b) => (b.id === id ? { ...b, ...updates } : b))
      );
      showToast('Booking updated ✓');
    } catch (e) {
      showToast(e.message || 'Update failed', 'error');
    }
  }

  async function addInstrument(inst) {
    try {
      const db = await sb.from('instruments');
      const [ni] = await db.insert({ id: genId(), ...inst });
      setInstruments((p) => [...p, ni]);
      showToast(`${inst.name} added ✓`);
    } catch (e) {
      showToast(e.message || 'Failed', 'error');
    }
  }

  async function updateInstrument(id, updates) {
    try {
      const db = await sb.from('instruments');
      await db.update(updates, { id });
      setInstruments((p) =>
        p.map((i) => (i.id === id ? { ...i, ...updates } : i))
      );
      showToast('Instrument updated ✓');
    } catch (e) {
      showToast(e.message || 'Update failed', 'error');
    }
  }

  async function deleteInstrument(id) {
    try {
      const db = await sb.from('instruments');
      await db.delete({ id });
      setInstruments((p) => p.filter((i) => i.id !== id));
      setBookings((p) =>
        p.map((b) => (b.instrument_id === id ? { ...b, cancelled: true } : b))
      );
      showToast('Instrument removed', 'warn');
    } catch (e) {
      showToast(e.message || 'Failed', 'error');
    }
  }

  async function deleteAccount(id) {
    try {
      const db = await sb.from('accounts');
      await db.delete({ id });
      setAccounts((p) => p.filter((a) => a.id !== id));
      if (id === currentAccount?.id) logout();
      showToast('Account removed', 'warn');
    } catch (e) {
      showToast(e.message || 'Failed', 'error');
    }
  }

  async function promoteAccount(id) {
    try {
      const db = await sb.from('accounts');
      await db.update({ is_admin: true }, { id });
      setAccounts((p) =>
        p.map((a) => (a.id === id ? { ...a, is_admin: true } : a))
      );
      showToast('User promoted to admin ✓');
    } catch (e) {
      showToast(e.message || 'Failed', 'error');
    }
  }

  async function approveAccount(id) {
    try {
      const db = await sb.from('accounts');
      await db.update({ status: 'approved' }, { id });
      setAccounts((p) =>
        p.map((a) => (a.id === id ? { ...a, status: 'approved' } : a))
      );
      showToast('Account approved ✓');
    } catch (e) {
      showToast(e.message || 'Failed', 'error');
    }
  }

  async function rejectAccount(id) {
    try {
      const db = await sb.from('accounts');
      await db.update({ status: 'rejected' }, { id });
      setAccounts((p) =>
        p.map((a) => (a.id === id ? { ...a, status: 'rejected' } : a))
      );
      showToast('Account rejected', 'warn');
    } catch (e) {
      showToast(e.message || 'Failed', 'error');
    }
  }

  // ── Guards ─────────────────────────────────────────────────────────────────
  const notConfigured = SUPABASE_URL.includes('YOUR_PROJECT');
  if (notConfigured)
    return (
      <div style={S.shell}>
        <style>{CSS}</style>
        <SetupScreen />
      </div>
    );
  if (loading)
    return (
      <div style={S.shell}>
        <style>{CSS}</style>
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
          }}
        >
          <div style={S.authLogoIcon}>
  <img src="/logo.png" alt="logo" style={{ width: 44, height: 44, objectFit: 'contain' }} />
</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#38BDF8' }}>
            Connecting to Lab Book…
          </div>
          <div className="spinnerLg" />
        </div>
      </div>
    );
  if (dbError)
    return (
      <div style={S.shell}>
        <style>{CSS}</style>
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: 28,
          }}
        >
          <div style={{ fontSize: 36 }}>⚠️</div>
          <div
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: '#EF4444',
              textAlign: 'center',
            }}
          >
            Database connection failed
          </div>
          <div style={{ fontSize: 12, color: '#475569', textAlign: 'center' }}>
            {dbError}
          </div>
          <div style={{ fontSize: 11, color: '#334155', textAlign: 'center' }}>
            Check your Supabase URL and anon key at the top of the file.
          </div>
          <button
            onClick={loadAll}
            style={{
              ...S.submitBtn,
              background: '#38BDF8',
              color: '#000',
              marginTop: 8,
              width: '100%',
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  if (!session || !currentAccount)
    return (
      <div style={S.shell}>
        <style>{CSS}</style>
        <AuthScreen onLogin={login} onSignup={signup} />
        {toast && <Toast key={toast.id} msg={toast.msg} type={toast.type} />}
      </div>
    );

  if (currentStatus === 'pending')
    return (
      <div style={S.shell}>
        <style>{CSS}</style>
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 32px',
            gap: 16,
            background: isDark ? '#0B1628' : '#F0F4F8',
          }}
        >
          <div style={{ fontSize: 48 }}>⏳</div>
          <div
            style={{
              fontSize: 18,
              fontWeight: 800,
              color: isDark ? '#E2E8F0' : '#0F172A',
              textAlign: 'center',
            }}
          >
            Awaiting Approval
          </div>
          <div
            style={{
              fontSize: 13,
              color: isDark ? '#475569' : '#64748B',
              textAlign: 'center',
              lineHeight: 1.7,
            }}
          >
            Hi{' '}
            <strong style={{ color: isDark ? '#94A3B8' : '#334155' }}>
              {currentAccount.display_name}
            </strong>
            !<br />
            Your account is pending approval by a lab admin.
            <br />
            You'll be able to log in once you've been approved.
          </div>
          <button
            onClick={logout}
            style={{
              marginTop: 8,
              padding: '12px 28px',
              borderRadius: 12,
              border: 'none',
              background: '#EF444420',
              color: '#EF4444',
              fontWeight: 700,
              fontSize: 13,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Sign Out
          </button>
        </div>
        {toast && <Toast key={toast.id} msg={toast.msg} type={toast.type} />}
      </div>
    );

  if (currentStatus === 'rejected')
    return (
      <div style={S.shell}>
        <style>{CSS}</style>
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 32px',
            gap: 16,
            background: isDark ? '#0B1628' : '#F0F4F8',
          }}
        >
          <div style={{ fontSize: 48 }}>❌</div>
          <div
            style={{
              fontSize: 18,
              fontWeight: 800,
              color: '#EF4444',
              textAlign: 'center',
            }}
          >
            Request Not Approved
          </div>
          <div
            style={{
              fontSize: 13,
              color: isDark ? '#475569' : '#64748B',
              textAlign: 'center',
              lineHeight: 1.7,
            }}
          >
            Your account request was not approved.
            <br />
            Please contact a lab admin for more information.
          </div>
          <button
            onClick={logout}
            style={{
              marginTop: 8,
              padding: '12px 28px',
              borderRadius: 12,
              border: 'none',
              background: '#EF444420',
              color: '#EF4444',
              fontWeight: 700,
              fontSize: 13,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Sign Out
          </button>
        </div>
        {toast && <Toast key={toast.id} msg={toast.msg} type={toast.type} />}
      </div>
    );

  return (
    <ThemeCtx.Provider value={T}>
      <div style={S.shell}>
        <style>{CSS}</style>
        <div style={S.statusBar}>
          <span className="mono" style={{ fontSize: 11, opacity: 0.4 }}>
            {now.toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 2,
              color: '#38BDF8',
            }}
          >
            ADELBOOK
          </span>
          <span style={{ fontSize: 11, color: '#22C55E', opacity: 0.7 }}>
            ● live
          </span>
        </div>
        <div style={S.content}>
          {view === 'home' && (
            <HomeView
              bookings={activeBookings}
              instruments={instruments}
              account={currentAccount}
              navigate={navigate}
            />
          )}
          {view === 'newBooking' && (
            <NewBookingView
              bookings={activeBookings}
              instruments={instruments}
              account={currentAccount}
              preselect={viewData.preselect}
              onSubmit={addBooking}
              onBack={() => navigate('home')}
              showToast={showToast}
            />
          )}
          {view === 'schedule' && (
            <ScheduleView
              bookings={activeBookings}
              instruments={instruments}
              account={currentAccount}
              initInst={viewData.instrument}
              navigate={navigate}
              onCancel={cancelBookingGroup}
              onSubmit={addBooking}
              onUpdate={updateBooking}
              showToast={showToast}
              isAdmin={currentAccount.is_admin}
            />
          )}
          {view === 'myBookings' && (
            <MyBookingsView
              bookings={activeBookings}
              instruments={instruments}
              account={currentAccount}
              onCancel={cancelBookingGroup}
              onUpdate={updateBooking}
              onBack={() => navigate('home')}
              navigate={navigate}
            />
          )}
          {view === 'admin' && (
            <AdminView
              instruments={instruments}
              accounts={accounts}
              bookings={activeBookings}
              currentAccount={currentAccount}
              onAddInstrument={addInstrument}
              onUpdateInstrument={updateInstrument}
              onDeleteInstrument={deleteInstrument}
              onDeleteAccount={deleteAccount}
              onPromote={promoteAccount}
              onApprove={approveAccount}
              onReject={rejectAccount}
              onCancelBooking={cancelBookingGroup}
              onLogout={logout}
              onBack={() => navigate('home')}
            />
          )}
          {view === 'notifs' && (
            <NotifsView
              notifs={notifs}
              onBack={() => navigate('home')}
              onClear={() => setNotifs([])}
            />
          )}
          {view === 'profile' && (
            <ProfileView
              account={currentAccount}
              bookings={activeBookings}
              instruments={instruments}
              onLogout={logout}
              onBack={() => navigate('home')}
              isDark={isDark}
              onToggleTheme={toggleTheme}
            />
          )}
        </div>
        <BottomNav
          view={view}
          navigate={navigate}
          notifCount={notifs.length}
          isAdmin={currentAccount.is_admin}
        />
        {toast && <Toast key={toast.id} msg={toast.msg} type={toast.type} />}
      </div>
    </ThemeCtx.Provider>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETUP SCREEN
// ═══════════════════════════════════════════════════════════════════════════════
function SetupScreen() {
  const steps = [
    {
      n: '1',
      title: 'Create a free Supabase project',
      body: 'Go to supabase.com → "New project". Takes ~1 minute.',
    },
    {
      n: '2',
      title: 'Run the SQL setup',
      body: 'Supabase → SQL Editor → paste and run lab-booking-setup.sql.',
    },
    {
      n: '3',
      title: 'Copy your credentials',
      body: 'Settings → API → copy "Project URL" and "anon public" key.',
    },
    {
      n: '4',
      title: 'Paste into the app',
      body: 'Replace SUPABASE_URL and SUPABASE_ANON at the top of this file.',
    },
  ];
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        padding: '32px 24px',
        overflowY: 'auto',
      }}
    >
      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🔧</div>
        <div style={{ fontSize: 20, fontWeight: 800 }}>Setup Required</div>
        <div style={{ fontSize: 12, color: '#475569', marginTop: 6 }}>
          Connect Lab Book to your Supabase database
        </div>
      </div>
      {steps.map((s) => (
        <div key={s.n} style={{ display: 'flex', gap: 14, marginBottom: 20 }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: '#1E3A5F',
              color: '#38BDF8',
              fontWeight: 800,
              fontSize: 14,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {s.n}
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3 }}>
              {s.title}
            </div>
            <div style={{ fontSize: 12, color: '#475569', lineHeight: 1.5 }}>
              {s.body}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH SCREEN
// ═══════════════════════════════════════════════════════════════════════════════
function AuthScreen({ onLogin, onSignup }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function switchMode(m) {
    setMode(m);
    setError('');
    setUsername('');
    setPassword('');
    setDisplayName('');
  }

  async function submit() {
    setError('');
    setLoading(true);
    const err =
      mode === 'login'
        ? await onLogin(username, password)
        : await onSignup(username, displayName, password);
    setLoading(false);
    if (err) setError(err);
  }

  return (
    <div style={S.authWrap}>
      <div style={S.authLogo}>
        <div style={S.authLogoIcon}>
  <img src="/logo.png" alt="logo" style={{ width: 44, height: 44, objectFit: 'contain' }} />
</div>
        <div
          style={{
            fontSize: 28,
            fontWeight: 800,
            letterSpacing: -0.5,
            marginTop: 10,
          }}
        >
          Adelbook
        </div>
        <div style={{ fontSize: 12, color: '#334155', marginTop: 4 }}>
          Instrument Booking System
        </div>
      </div>
      <div style={S.authTabs}>
        <button
          onClick={() => switchMode('login')}
          style={{ ...S.authTab, ...(mode === 'login' ? S.authTabActive : {}) }}
        >
          Sign In
        </button>
        <button
          onClick={() => switchMode('signup')}
          style={{
            ...S.authTab,
            ...(mode === 'signup' ? S.authTabActive : {}),
          }}
        >
          Create Account
        </button>
      </div>
      <div style={S.authForm}>
        {mode === 'signup' && (
          <div>
            <div style={S.authLabel}>DISPLAY NAME</div>
            <input
              placeholder="e.g. Grace Kim"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              style={S.authInput}
              className="inp"
              autoComplete="name"
            />
          </div>
        )}
        <div>
          <div style={S.authLabel}>USERNAME</div>
          <input
            placeholder={
              mode === 'login' ? 'your username' : 'choose a username'
            }
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            style={S.authInput}
            className="inp"
            autoCapitalize="none"
            spellCheck={false}
          />
        </div>
        <div>
          <div style={S.authLabel}>PASSWORD</div>
          <div style={{ position: 'relative' }}>
            <input
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              type={showPw ? 'text' : 'password'}
              style={{ ...S.authInput, paddingRight: 42 }}
              className="inp"
            />
            <button
              onClick={() => setShowPw((p) => !p)}
              style={{
                position: 'absolute',
                right: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: 16,
                color: '#475569',
              }}
            >
              {showPw ? '🙈' : '👁'}
            </button>
          </div>
        </div>
        {error && (
          <div style={S.authError} className="authErr">
            {error}
          </div>
        )}
        <button
          onClick={submit}
          disabled={loading}
          style={{ ...S.authSubmit, opacity: loading ? 0.7 : 1 }}
        >
          {loading ? (
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <span className="spinner" />
              Processing…
            </span>
          ) : mode === 'login' ? (
            'Sign In →'
          ) : (
            'Create Account →'
          )}
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// HOME VIEW
// ═══════════════════════════════════════════════════════════════════════════════
function HomeView({ bookings, instruments, account, navigate }) {
  const firstName = account.display_name.split(' ')[0];
  const hour = NOW.getHours();
  const greeting =
    hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const todayAll = bookings
    .filter((b) => b.date === todayStr)
    .sort((a, b) => a.start_time.localeCompare(b.start_time));
  const myUpcoming = bookings.filter(
    (b) => b.user_display_name === account.display_name && b.date >= todayStr
  ).length;

  function isInUse(id) {
    const n = NOW.getHours() * 60 + NOW.getMinutes();
    return bookings.some(
      (b) =>
        b.instrument_id === id &&
        b.date === todayStr &&
        toMins(b.start_time) <= n &&
        n < toMins(b.end_time)
    );
  }
  function nextFree(id) {
    const td = bookings
      .filter((b) => b.instrument_id === id && b.date === todayStr)
      .sort((a, b) => a.start_time.localeCompare(b.start_time));
    if (!td.length) return 'Available now';
    const last = td[td.length - 1].end_time;
    if (toMins(last) <= NOW.getHours() * 60 + NOW.getMinutes())
      return 'Available now';
    return `Free from ${fmt12(last)}`;
  }

  return (
    <div className="view">
      <div style={S.header}>
        <div>
          <div style={{ fontSize: 12, color: '#334155', marginBottom: 2 }}>
            {greeting},
          </div>
          <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.5 }}>
            {firstName} 👋
          </div>
        </div>
        <button
          className="iconBtn"
          onClick={() => navigate('newBooking')}
          style={{ background: '#38BDF8', color: '#000' }}
        >
          ＋
        </button>
      </div>
      <div style={{ display: 'flex', gap: 10, padding: '0 16px 16px' }}>
        {[
          { label: 'My upcoming', val: myUpcoming, color: '#38BDF8' },
          { label: 'Booked today', val: todayAll.length, color: '#FB923C' },
          { label: 'Instruments', val: instruments.length, color: '#4ADE80' },
        ].map((s) => (
          <div key={s.label} style={{ ...S.statCard, flex: 1 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>
              {s.val}
            </div>
            <div style={{ fontSize: 10, color: '#475569', marginTop: 1 }}>
              {s.label}
            </div>
          </div>
        ))}
      </div>
      {todayAll.length > 0 && (
        <Section label="TODAY'S ACTIVITY">
          {todayAll.map((b) => {
            const inst = instruments.find((i) => i.id === b.instrument_id);
            if (!inst) return null;
            return (
              <div
                key={b.id}
                style={{
                  ...S.card,
                  borderLeft: `3px solid ${inst.color}`,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{ fontSize: 12, fontWeight: 700, color: inst.color }}
                  >
                    {inst.icon} {inst.name}
                  </div>
                  <div style={{ fontSize: 11, color: '#64748B' }}>
                    {b.user_display_name}
                  </div>
                  {b.note && (
                    <div
                      style={{
                        fontSize: 10,
                        color: '#475569',
                        marginTop: 3,
                        fontStyle: 'italic',
                      }}
                    >
                      "{b.note}"
                    </div>
                  )}
                </div>
                <div style={S.timeTag}>
                  {fmt12(b.start_time)}
                  <br />
                  <span style={{ opacity: 0.5, fontSize: 9 }}>
                    {fmt12(b.end_time)}
                  </span>
                </div>
              </div>
            );
          })}
        </Section>
      )}
      <Section label="INSTRUMENTS">
        <div style={S.grid}>
          {instruments.map((inst, idx) => {
            const inUse = isInUse(inst.id);
            const todayCount = bookings.filter(
              (b) => b.instrument_id === inst.id && b.date === todayStr
            ).length;
            return (
              <div
                key={inst.id}
                className="instCard"
                style={{ animationDelay: `${idx * 60}ms` }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                  }}
                >
                  <div
                    style={{
                      ...S.iconBubble,
                      background: inst.color + '22',
                      color: inst.color,
                    }}
                  >
                    {inst.icon}
                  </div>
                  <div
                    style={{
                      ...S.pill,
                      background: inUse ? '#EF444422' : '#22C55E22',
                      color: inUse ? '#EF4444' : '#22C55E',
                    }}
                  >
                    {inUse ? '● In Use' : '● Free'}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    marginTop: 10,
                    lineHeight: 1.3,
                  }}
                >
                  {inst.name}
                </div>
                <div style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>
                  {inst.code} · {inst.category}
                </div>
                <div style={{ fontSize: 10, color: '#38BDF8', marginTop: 4 }}>
                  {nextFree(inst.id)}
                </div>
                {todayCount > 0 && (
                  <div style={{ fontSize: 10, color: '#64748B', marginTop: 2 }}>
                    {todayCount} booking{todayCount > 1 ? 's' : ''} today
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
                  <button
                    className="btnSec"
                    style={{ flex: 1 }}
                    onClick={() => navigate('schedule', { instrument: inst })}
                  >
                    Schedule
                  </button>
                  <button
                    className="btnPri"
                    style={{ flex: 1, background: inst.color }}
                    onClick={() =>
                      navigate('newBooking', { preselect: inst.id })
                    }
                  >
                    Book
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEW BOOKING VIEW  (supports multi-day)
// ═══════════════════════════════════════════════════════════════════════════════
function NewBookingView({
  bookings,
  instruments,
  account,
  preselect,
  onSubmit,
  onBack,
  showToast,
}) {
  const [instrumentId, setInstrumentId] = useState(
    preselect ?? instruments[0]?.id
  );
  const [startDate, setStartDate] = useState(todayStr);
  const [endDate, setEndDate] = useState(todayStr);
  const [startTime, setStart] = useState('09:00');
  const [endTime, setEnd] = useState('10:00');
  const [note, setNote] = useState('');
  const [recurring, setRecurring] = useState('none');
  const [recCount, setRecCount] = useState(4);
  const [showPicker, setShowPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const instrument =
    instruments.find((i) => i.id === instrumentId) || instruments[0];

  function dateRange(from, to) {
    const dates = [];
    const d = new Date(from + 'T12:00:00');
    const end = new Date(to + 'T12:00:00');
    while (d <= end) {
      dates.push(d.toISOString().split('T')[0]);
      d.setDate(d.getDate() + 1);
    }
    return dates;
  }
  const dates = dateRange(startDate, endDate);
  const multiDay = dates.length > 1;
  const dur = multiDay ? 1 : durationMins(startTime, endTime);

  const conflict = instrument
    ? dates.some((date) =>
        bookings.some((b) => {
          if (
            b.instrument_id !== instrument.id ||
            b.date !== date ||
            b.cancelled
          )
            return false;
          return !(endTime <= b.start_time || startTime >= b.end_time);
        })
      )
    : false;

  const invalid = (!multiDay && dur <= 0) || !instrument || endDate < startDate;

  function suggestSlot() {
    if (!instrument) return;
    const dayB = bookings
      .filter((b) => b.instrument_id === instrument.id && b.date === startDate)
      .sort((a, b) => a.start_time.localeCompare(b.start_time));
    let cursor = 480;
    for (const b of dayB) {
      const bs = toMins(b.start_time),
        be = toMins(b.end_time);
      if (cursor + 60 <= bs) break;
      if (be > cursor) cursor = be;
    }
    if (cursor + 60 > 1440) {
      showToast('No free 1h slots that day', 'warn');
      return;
    }
    setStart(minsToTime(cursor));
    setEnd(minsToTime(cursor + 60));
  }

  async function submit() {
    if (invalid || conflict || submitting) return;
    // Check booking day limit
    const maxDays = instrument?.max_days ?? null;
    if (maxDays && dates.length > maxDays) {
      showToast(`Max ${maxDays} day(s) allowed for ${instrument.name}`, 'warn');
      return;
    }
    setSubmitting(true);
    if (recurring !== 'none') {
      const step = recurring === 'daily' ? dates.length : 7;
      let added = 0;
      for (let r = 0; r < recCount; r++) {
        const gid = genId();
        for (const date of dates) {
          const d = new Date(date + 'T12:00:00');
          d.setDate(d.getDate() + r * step);
          await onSubmit({
            groupId: dates.length > 1 ? gid : null,
            instrumentId: instrument.id,
            user: account.display_name,
            date: d.toISOString().split('T')[0],
            startTime,
            endTime,
            note,
            recurring: { type: recurring, count: recCount },
          });
          added++;
        }
      }
      showToast(`${added} recurring bookings added ✓`);
    } else {
      const gid = multiDay ? genId() : null;
      for (const date of dates) {
        const s = date === startDate ? startTime : '00:00';
        const e = date === endDate ? endTime : '23:59';
        await onSubmit({
          groupId: gid,
          instrumentId: instrument.id,
          user: account.display_name,
          date,
          startTime: s,
          endTime: e,
          note,
          recurring: null,
        });
      }
      if (multiDay) showToast(`Booked ${dates.length} days ✓`);
      else showToast('Booking confirmed ✓');
    }
    setSubmitting(false);
    onBack();
  }

  const dayExisting = bookings
    .filter(
      (b) =>
        instrument &&
        b.instrument_id === instrument.id &&
        dates.includes(b.date)
    )
    .sort((a, b) =>
      a.date === b.date
        ? a.start_time.localeCompare(b.start_time)
        : a.date.localeCompare(b.date)
    );

  return (
    <div className="view">
      <SubHeader
        title="New Booking"
        subtitle={instrument?.name ?? 'Select instrument'}
        color={instrument?.color}
        onBack={onBack}
      />
      <div style={{ padding: '0 16px 4px' }}>
        <FieldLabel>INSTRUMENT</FieldLabel>
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowPicker((p) => !p)}
            style={{
              ...S.dropdownBtn,
              borderColor: (instrument?.color ?? '#38BDF8') + '55',
            }}
          >
            <span style={{ color: instrument?.color, fontSize: 18 }}>
              {instrument?.icon}
            </span>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                {instrument?.name ?? 'Choose…'}
              </div>
              {instrument && (
                <div style={{ fontSize: 10, color: '#64748B' }}>
                  {instrument.code} · {instrument.category}
                </div>
              )}
            </div>
            <span style={{ color: '#475569', fontSize: 11 }}>
              {showPicker ? '▲' : '▼'}
            </span>
          </button>
          {showPicker && (
            <div style={S.dropdown}>
              {instruments.map((inst) => (
                <button
                  key={inst.id}
                  onClick={() => {
                    setInstrumentId(inst.id);
                    setShowPicker(false);
                  }}
                  style={{
                    ...S.dropdownItem,
                    background:
                      instrumentId === inst.id
                        ? inst.color + '22'
                        : 'transparent',
                  }}
                >
                  <span style={{ color: inst.color, fontSize: 16 }}>
                    {inst.icon}
                  </span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {inst.name}
                    </div>
                    <div style={{ fontSize: 10, color: '#64748B' }}>
                      {inst.code}
                    </div>
                  </div>
                  {instrumentId === inst.id && (
                    <span style={{ color: inst.color, marginLeft: 'auto' }}>
                      ✓
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={S.formCard}>
        {/* Date range */}
        <div
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}
        >
          <div>
            <FieldLabel>START DATE</FieldLabel>
            <input
              type="date"
              value={startDate}
              min={todayStr}
              onChange={(e) => {
                setStartDate(e.target.value);
                if (e.target.value > endDate) setEndDate(e.target.value);
              }}
              style={S.input}
              className="inp"
            />
          </div>
          <div>
            <FieldLabel>END DATE</FieldLabel>
            <input
              type="date"
              value={endDate}
              min={startDate}
              onChange={(e) => setEndDate(e.target.value)}
              style={S.input}
              className="inp"
            />
          </div>
        </div>
        {multiDay && (
          <div
            style={{
              ...S.chip,
              color: '#4ADE80',
              background: '#4ADE8018',
              textAlign: 'center',
              justifyContent: 'center',
            }}
          >
            📅 {dates.length}-day booking
          </div>
        )}

        {/* Time slot */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <FieldLabel>TIME SLOT</FieldLabel>
          <button onClick={suggestSlot} style={S.suggBtn}>
            ⚡ Suggest free slot
          </button>
        </div>
        <div
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}
        >
          <div>
            <div style={{ fontSize: 10, color: '#475569', marginBottom: 4 }}>
              {multiDay ? 'FIRST DAY START' : 'START'}
            </div>
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStart(e.target.value)}
              style={S.input}
              className="inp"
            />
          </div>
          <div>
            <div style={{ fontSize: 10, color: '#475569', marginBottom: 4 }}>
              {multiDay ? 'LAST DAY END' : 'END'}
            </div>
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEnd(e.target.value)}
              style={S.input}
              className="inp"
            />
          </div>
        </div>
        {!multiDay && dur > 0 && (
          <div
            style={{
              ...S.chip,
              color: instrument?.color ?? '#38BDF8',
              background: (instrument?.color ?? '#38BDF8') + '18',
              textAlign: 'center',
              justifyContent: 'center',
            }}
          >
            ⏱ {Math.floor(dur / 60)}h{dur % 60 > 0 ? ` ${dur % 60}m` : ''}{' '}
            session
          </div>
        )}

        {/* Note */}
        <div>
          <FieldLabel>NOTE (optional)</FieldLabel>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Experiment description, sample ID, method…"
            style={{ ...S.input, height: 66, resize: 'none' }}
            className="inp"
          />
        </div>

        {/* Recurring */}
        <div>
          <FieldLabel>RECURRING</FieldLabel>
          <div style={{ display: 'flex', gap: 8 }}>
            {['none', 'daily', 'weekly'].map((r) => (
              <button
                key={r}
                onClick={() => setRecurring(r)}
                style={{
                  ...S.pill,
                  cursor: 'pointer',
                  flex: 1,
                  justifyContent: 'center',
                  padding: '8px 0',
                  fontSize: 11,
                  background:
                    recurring === r
                      ? (instrument?.color ?? '#38BDF8') + '33'
                      : '#0F172A',
                  color:
                    recurring === r
                      ? instrument?.color ?? '#38BDF8'
                      : '#64748B',
                  border: `1px solid ${
                    recurring === r
                      ? (instrument?.color ?? '#38BDF8') + '55'
                      : '#1E293B'
                  }`,
                }}
              >
                {r === 'none' ? 'Once' : r.charAt(0).toUpperCase() + r.slice(1)}
              </button>
            ))}
          </div>
          {recurring !== 'none' && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginTop: 8,
              }}
            >
              <span style={{ fontSize: 12, color: '#64748B' }}>Repeat</span>
              <input
                type="number"
                min={2}
                max={52}
                value={recCount}
                onChange={(e) => setRecCount(Number(e.target.value))}
                style={{ ...S.input, width: 60, textAlign: 'center' }}
                className="inp"
              />
              <span style={{ fontSize: 12, color: '#64748B' }}>times</span>
            </div>
          )}
        </div>

        {conflict && (
          <div style={S.conflictBanner}>
            ⚠ Slot conflict — another booking overlaps this time
          </div>
        )}
        {instrument?.max_days && (
          <div
            style={{
              ...S.chip,
              color: '#FB923C',
              background: '#FB923C18',
              justifyContent: 'center',
            }}
          >
            ⚠ Max {instrument.max_days} day{instrument.max_days > 1 ? 's' : ''}{' '}
            on {instrument.name}
            {dates.length > instrument.max_days ? ' — exceeded!' : ''}
          </div>
        )}

        <button
          onClick={submit}
          disabled={invalid || conflict || submitting}
          style={{
            ...S.submitBtn,
            background:
              invalid || conflict ? '#1E293B' : instrument?.color ?? '#38BDF8',
            color: invalid || conflict ? '#475569' : '#000',
          }}
        >
          {submitting ? (
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <span className="spinner" style={{ borderTopColor: '#000' }} />
              Saving…
            </span>
          ) : multiDay ? (
            `Book ${dates.length} days`
          ) : recurring !== 'none' ? (
            `Book ${recCount}× ${recurring}`
          ) : (
            'Confirm Booking'
          )}
        </button>
      </div>

      {dayExisting.length > 0 && (
        <Section label="EXISTING BOOKINGS IN RANGE">
          {dayExisting.map((b) => (
            <div
              key={b.id}
              style={{
                ...S.card,
                borderLeft: `3px solid ${instrument?.color}`,
                marginBottom: 8,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div>
                  <span
                    style={{ fontSize: 11, fontWeight: 700, color: '#64748B' }}
                  >
                    {fmtDate(b.date)} ·{' '}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>
                    {b.user_display_name}
                  </span>
                </div>
                <span style={S.timeTag}>
                  {fmt12(b.start_time)} – {fmt12(b.end_time)}
                </span>
              </div>
              {b.note && (
                <div
                  style={{
                    fontSize: 10,
                    color: '#475569',
                    marginTop: 4,
                    fontStyle: 'italic',
                  }}
                >
                  "{b.note}"
                </div>
              )}
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEDULE VIEW
// ═══════════════════════════════════════════════════════════════════════════════
function ScheduleView({
  bookings,
  instruments,
  account,
  initInst,
  navigate,
  onCancel,
  onSubmit,
  onUpdate,
  showToast,
  isAdmin,
}) {
  const t = useT();
  const [filterInst, setFilterInst] = useState(initInst ? initInst.id : 'all');
  const [selectedDate, setSelectedDate] = useState(todayStr);
  const [viewMode, setViewMode] = useState('day');
  const [calYear, setCalYear] = useState(NOW.getFullYear());
  const [calMonth, setCalMonth] = useState(NOW.getMonth());
  const [quickBook, setQuickBook] = useState(null);
  const [detailBook, setDetailBook] = useState(null);

  // Drag state — stored in refs to avoid re-render storms during move
  const dragStartDate = useRef(null);
  const dragStartMins = useRef(0);
  const dragEndDate = useRef(null);
  const dragEndMins = useRef(0);
  const dragStartY = useRef(0);
  const dragActivated = useRef(false);
  const [dragVis, setDragVis] = useState(null);
  const dragPointerEl = useRef(null);
  const dragPointerId = useRef(null);
  const dragStartX = useRef(0);
  const dragCancelled = useRef(false);

  const HOUR_H = 52; // px per hour
  const DRAG_PX = 10; // min pixels before drag activates
  const HOURS = Array.from({ length: 24 }, (_, i) => i);
  const inst = instruments.find((i) => i.id === filterInst);
  const themeColor = inst?.color ?? '#38BDF8';

  // ── Calendar helpers ──────────────────────────────────────────────────────
  const firstDayOfMonth = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const monthName = new Date(calYear, calMonth, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  function prevPeriod() {
    if (viewMode === 'month') {
      if (calMonth === 0) {
        setCalMonth(11);
        setCalYear((y) => y - 1);
      } else setCalMonth((m) => m - 1);
    } else if (viewMode === 'week') {
      const d = new Date(selectedDate + 'T12:00:00');
      d.setDate(d.getDate() - 7);
      setSelectedDate(d.toISOString().split('T')[0]);
    } else {
      const d = new Date(selectedDate + 'T12:00:00');
      d.setDate(d.getDate() - 1);
      setSelectedDate(d.toISOString().split('T')[0]);
    }
  }
  function nextPeriod() {
    if (viewMode === 'month') {
      if (calMonth === 11) {
        setCalMonth(0);
        setCalYear((y) => y + 1);
      } else setCalMonth((m) => m + 1);
    } else if (viewMode === 'week') {
      const d = new Date(selectedDate + 'T12:00:00');
      d.setDate(d.getDate() + 7);
      setSelectedDate(d.toISOString().split('T')[0]);
    } else {
      const d = new Date(selectedDate + 'T12:00:00');
      d.setDate(d.getDate() + 1);
      setSelectedDate(d.toISOString().split('T')[0]);
    }
  }
  function calDayStr(day) {
    return `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(
      day
    ).padStart(2, '0')}`;
  }
  function getWeekDays() {
    const d = new Date(selectedDate + 'T12:00:00');
    const dow = d.getDay();
    const mon = new Date(d);
    mon.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
    return Array.from({ length: 7 }, (_, i) => {
      const dd = new Date(mon);
      dd.setDate(mon.getDate() + i);
      return dd.toISOString().split('T')[0];
    });
  }
  const weekDays = getWeekDays();
  function hasBookings(date) {
    return bookings.some(
      (b) =>
        b.date === date &&
        (filterInst === 'all' || b.instrument_id === filterInst)
    );
  }
  function selectDay(ds) {
    setSelectedDate(ds);
    setViewMode('day');
  }

  const periodLabel =
    viewMode === 'month'
      ? monthName
      : viewMode === 'week'
      ? `${fmtDate(weekDays[0], {
          month: 'short',
          day: 'numeric',
        })} – ${fmtDate(weekDays[6], { month: 'short', day: 'numeric' })}`
      : fmtDate(selectedDate, {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        });

  // ── Drag logic ────────────────────────────────────────────────────────────
  function getMins(clientY, el) {
    const rect = el.getBoundingClientRect();
    const relY = Math.max(0, Math.min(clientY - rect.top, HOUR_H * 24));
    return Math.round(((relY / (HOUR_H * 24)) * 1440) / 15) * 15;
  }

  // Compare two "date+mins" positions, return -1/0/1
  function cmpPos(dateA, minsA, dateB, minsB) {
    if (dateA < dateB) return -1;
    if (dateA > dateB) return 1;
    return minsA < minsB ? -1 : minsA > minsB ? 1 : 0;
  }

  function onPointerDown(e, date, el) {
    if (e.target.closest('[data-booking]')) return;
    // Don't capture yet — wait until we confirm it's a drag, not a scroll
    const mins = getMins(e.clientY, el);
    dragStartDate.current = date;
    dragStartMins.current = mins;
    dragEndDate.current = date;
    dragEndMins.current = mins + 60;
    dragStartY.current = e.clientY;
    dragStartX.current = e.clientX;
    dragActivated.current = false;
    dragCancelled.current = false;
    dragPointerEl.current = e.currentTarget;
    dragPointerId.current = e.pointerId;
    setDragVis(null);
  }

  function onPointerMove(e, date, el) {
    if (!dragStartDate.current || dragCancelled.current) return;

    const dy = e.clientY - dragStartY.current;
    const dx = e.clientX - dragStartX.current;
    const dist = Math.abs(dy);
    const isTouch = e.pointerType === 'touch';
    const threshold = isTouch ? 28 : DRAG_PX;

    if (!dragActivated.current) {
      if (dist < threshold) return;
      // Straight downward touch = scroll intent, bail
      if (isTouch && Math.abs(dx) < 8 && dy > 0) {
        dragCancelled.current = true;
        dragStartDate.current = null;
        return;
      }
      // Confirmed drag — capture pointer now
      try { dragPointerEl.current?.setPointerCapture(dragPointerId.current); } catch {}
      dragActivated.current = true;
    }

    const mins = getMins(e.clientY, el);
    dragEndDate.current = date;
    dragEndMins.current = mins;
    let [sd, sm, ed, em] = [
      dragStartDate.current,
      dragStartMins.current,
      dragEndDate.current,
      dragEndMins.current,
    ];
    if (cmpPos(sd, sm, ed, em) > 0) {
      [sd, sm, ed, em] = [ed, em, sd, sm];
    }
    setDragVis({
      startDate: sd,
      startMins: sm,
      endDate: ed,
      endMins: Math.max(sm + 15, em),
    });
  }

  function onPointerUp() {
    if (!dragStartDate.current) return;
    const activated = dragActivated.current;
    dragActivated.current = false;
    dragCancelled.current = false;
    if (!activated) {
      dragStartDate.current = null;
      return;
    }
    let [sd, sm, ed, em] = [
      dragStartDate.current,
      dragStartMins.current,
      dragEndDate.current,
      dragEndMins.current,
    ];
    if (cmpPos(sd, sm, ed, em) > 0) {
      [sd, sm, ed, em] = [ed, em, sd, sm];
    }
    em = Math.max(sm + 15, em);
    dragStartDate.current = null;
    setDragVis(null);
    setQuickBook({ startDate: sd, startMins: sm, endDate: ed, endMins: em });
  }

  // ── Booking block (absolutely positioned, with overlap columns) ──────────
  function BookingBlock({ b, colIndex = 0, colTotal = 1 }) {
    const bi = instruments.find((i) => i.id === b.instrument_id);
    const isMe = b.user_display_name === account.display_name;
    const sM = toMins(b.start_time);
    const eM = b.end_time === '23:59' ? 1439 : toMins(b.end_time);
    const top = (sM / 1440) * 100;
    const h = (Math.max(15, eM - sM) / 1440) * 100;
    const dur2 = eM - sM;
    const isAllDay = b.start_time === '00:00' && b.end_time === '23:59';
    const colW = 100 / colTotal;
    const leftPct = colIndex * colW;
    return (
      <div
        data-booking="1"
        onClick={(e) => {
          e.stopPropagation();
          setDetailBook(b);
        }}
        style={{
          position: 'absolute',
          left: `calc(${leftPct}% + 2px)`,
          width: `calc(${colW}% - 4px)`,
          top: `${top}%`,
          height: `${h}%`,
          background: (bi?.color ?? '#38BDF8') + '30',
          borderLeft: `3px solid ${bi?.color ?? '#38BDF8'}`,
          borderRadius: 6,
          padding: '3px 5px',
          overflow: 'hidden',
          cursor: 'pointer',
          zIndex: 2,
          boxSizing: 'border-box',
          minHeight: 18,
          transition: 'filter 0.12s',
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.filter = 'brightness(1.35)')
        }
        onMouseLeave={(e) => (e.currentTarget.style.filter = '')}
      >
        <div
          style={{
            fontSize: 9,
            fontWeight: 700,
            color: bi?.color,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {bi?.icon} {colTotal > 1 ? bi?.code : bi?.name}
        </div>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: isMe ? t.text : t.textMid,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {b.user_display_name}
          {isMe ? ' ✓' : ''}
        </div>
        {dur2 >= 30 && colTotal === 1 && (
          <div style={{ fontSize: 9, color: '#64748B' }}>
            {isAllDay
              ? 'All day'
              : `${fmt12(b.start_time)}–${fmt12(b.end_time)}`}
          </div>
        )}
        {b.note && dur2 >= 45 && colTotal === 1 && (
          <div
            style={{
              fontSize: 9,
              color: '#38BDF855',
              fontStyle: 'italic',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            "{b.note}"
          </div>
        )}
      </div>
    );
  }

  // ── Time column ───────────────────────────────────────────────────────────
  const scrollRef = useRef(null);
  useEffect(() => {
    if (scrollRef.current) {
      const currentHour = new Date().getHours();
      scrollRef.current.scrollTop = (currentHour - 2) * HOUR_H;
    }
  }, []);
  function TimeColumn({ date, bkgs }) {
    const colRef = useRef(null);
    // Compute drag overlay for this column
    let dragOverlay = null;
    if (dragVis) {
      const { startDate, startMins, endDate, endMins } = dragVis;
      if (date >= startDate && date <= endDate) {
        const colStart = date === startDate ? startMins : 0;
        const colEnd = date === endDate ? endMins : 1440;
        const top = (colStart / 1440) * 100;
        const h = ((colEnd - colStart) / 1440) * 100;
        dragOverlay = (
          <div
            style={{
              position: 'absolute',
              left: 2,
              right: 2,
              top: `${top}%`,
              height: `${h}%`,
              background: themeColor + '30',
              border: `2px dashed ${themeColor}`,
              borderRadius: 6,
              zIndex: 10,
              pointerEvents: 'none',
              minHeight: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {date === startDate && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: themeColor,
                  pointerEvents: 'none',
                }}
              >
                {minsToTime(startMins)}
              </span>
            )}
            {date === endDate && date !== startDate && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: themeColor,
                  pointerEvents: 'none',
                }}
              >
                {minsToTime(endMins)}
              </span>
            )}
          </div>
        );
      }
    }
    // Current time line
    const nowLine =
      date === todayStr
        ? (() => {
            const pct = ((NOW.getHours() * 60 + NOW.getMinutes()) / 1440) * 100;
            return (
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: `${pct}%`,
                  height: 2,
                  background: '#EF4444',
                  zIndex: 5,
                  pointerEvents: 'none',
                }}
              >
                <div
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: '#EF4444',
                    position: 'absolute',
                    left: -3,
                    top: -2.5,
                  }}
                />
              </div>
            );
          })()
        : null;

    return (
      <div
        ref={colRef}
        style={{
          position: 'relative',
          height: HOUR_H * 24,
          touchAction: 'pan-y',
          userSelect: 'none',
        }}
        onPointerDown={(e) => onPointerDown(e, date, colRef.current)}
        onPointerMove={(e) => onPointerMove(e, date, colRef.current)}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragStartDate.current = null;
          dragActivated.current = false;
          setDragVis(null);
        }}
      >
        {/* Hour lines */}
        {HOURS.map((h) => (
          <div
            key={h}
            style={{
              position: 'absolute',
              top: h * HOUR_H,
              left: 0,
              right: 0,
              height: HOUR_H,
              borderTop: h === 0 ? 'none' : '1px solid ' + t.hourLine,
              pointerEvents: 'none',
            }}
          />
        ))}
        {dragOverlay}
        {(() => {
          // Compute side-by-side columns for overlapping bookings
          const sorted = [...bkgs].sort((a, z) => toMins(a.start_time) - toMins(z.start_time));
          // Assign column index using a greedy interval-graph coloring
          const cols = []; // cols[i] = end minute of last booking in column i
          const assignments = sorted.map((b) => {
            const sM = toMins(b.start_time);
            const eM = b.end_time === '23:59' ? 1439 : toMins(b.end_time);
            let slot = cols.findIndex((endM) => endM <= sM);
            if (slot === -1) { slot = cols.length; cols.push(eM); }
            else cols[slot] = eM;
            return slot;
          });
          // For each booking, count how many columns are active during its span
          const enriched = sorted.map((b, i) => {
            const sM = toMins(b.start_time);
            const eM = b.end_time === '23:59' ? 1439 : toMins(b.end_time);
            const maxCol = sorted.reduce((mx, bk, j) => {
              const s2 = toMins(bk.start_time);
              const e2 = bk.end_time === '23:59' ? 1439 : toMins(bk.end_time);
              if (!(e2 <= sM || s2 >= eM)) return Math.max(mx, assignments[j]);
              return mx;
            }, assignments[i]);
            return { b, colIndex: assignments[i], colTotal: maxCol + 1 };
          });
          return enriched.map(({ b, colIndex, colTotal }) => (
            <BookingBlock key={b.id} b={b} colIndex={colIndex} colTotal={colTotal} />
          ));
        })()}
        {nowLine}
      </div>
    );
  }

  return (
    <div className="view">
      {/* Header */}
      <div style={S.subHeader}>
        <button className="backBtn" onClick={() => navigate('home')}>
          ←
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>Schedule</div>
          <div style={{ fontSize: 11, color: themeColor }}>
            {inst ? inst.name : 'All instruments'}
          </div>
        </div>
        <button
          className="btnPri"
          style={{ background: themeColor, padding: '7px 14px', fontSize: 12 }}
          onClick={() =>
            navigate('newBooking', {
              preselect: filterInst !== 'all' ? filterInst : undefined,
            })
          }
        >
          + Book
        </button>
      </div>

      {/* Instrument dropdown filter */}
      <div style={{ padding: '4px 16px 10px' }}>
        <div style={{ position: 'relative' }}>
          <select
            value={filterInst}
            onChange={(e) => setFilterInst(e.target.value)}
            style={{
              width: '100%',
              background: t.bg1,
              border: `1px solid ${filterInst !== 'all' ? (instruments.find(i => i.id === filterInst)?.color ?? t.border) : t.border}`,
              borderRadius: 10,
              color: filterInst !== 'all' ? (instruments.find(i => i.id === filterInst)?.color ?? t.text) : t.text,
              fontSize: 13,
              fontWeight: 700,
              padding: '9px 36px 9px 12px',
              cursor: 'pointer',
              outline: 'none',
              fontFamily: 'inherit',
              appearance: 'none',
              WebkitAppearance: 'none',
            }}
          >
            <option value="all">🔬 All instruments</option>
            {instruments.map((i) => (
              <option key={i.id} value={i.id}>
                {i.icon} {i.name} ({i.code})
              </option>
            ))}
          </select>
          <div style={{
            position: 'absolute',
            right: 12,
            top: '50%',
            transform: 'translateY(-50%)',
            pointerEvents: 'none',
            color: t.textLow,
            fontSize: 12,
          }}>▾</div>
        </div>
      </div>

      {/* View switcher */}
      <div
        style={{
          display: 'flex',
          margin: '0 16px 10px',
          background: t.bg0,
          borderRadius: 10,
          padding: 3,
          border: '1px solid ' + t.border,
        }}
      >
        {['day', 'week', 'month'].map((m) => (
          <button
            key={m}
            onClick={() => setViewMode(m)}
            style={{
              flex: 1,
              padding: '7px 0',
              borderRadius: 8,
              border: 'none',
              fontSize: 11,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
              background: viewMode === m ? t.bg2 : 'transparent',
              color: viewMode === m ? themeColor : t.textLow,
            }}
          >
            {m.charAt(0).toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>

      {/* Period nav */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0 16px 12px',
          gap: 6,
        }}
      >
        <button
          onClick={prevPeriod}
          style={{
            background: t.bg1,
            border: '1px solid ' + t.border,
            color: t.textMid,
            borderRadius: 8,
            width: 32,
            height: 32,
            cursor: 'pointer',
            fontSize: 16,
            flexShrink: 0,
          }}
        >
          ‹
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, justifyContent: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{periodLabel}</div>
          {(viewMode === 'day' ? selectedDate !== todayStr : viewMode === 'week' ? !getWeekDays().includes(todayStr) : (calMonth !== NOW.getMonth() || calYear !== NOW.getFullYear())) && (
            <button
              onClick={() => {
                setSelectedDate(todayStr);
                setCalMonth(NOW.getMonth());
                setCalYear(NOW.getFullYear());
              }}
              style={{
                background: themeColor + '22',
                border: `1px solid ${themeColor}44`,
                color: themeColor,
                borderRadius: 6,
                padding: '2px 7px',
                cursor: 'pointer',
                fontSize: 10,
                fontWeight: 700,
                fontFamily: 'inherit',
                flexShrink: 0,
              }}
            >
              Today
            </button>
          )}
        </div>
        <button
          onClick={nextPeriod}
          style={{
            background: t.bg1,
            border: '1px solid ' + t.border,
            color: t.textMid,
            borderRadius: 8,
            width: 32,
            height: 32,
            cursor: 'pointer',
            fontSize: 16,
            flexShrink: 0,
          }}
        >
          ›
        </button>
      </div>

      {/* ── MONTH ── */}
      {viewMode === 'month' && (
        <div
          style={{
            margin: '0 16px 16px',
            background: t.bg1,
            borderRadius: 16,
            padding: '12px',
            border: '1px solid ' + t.border,
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(7,1fr)',
              marginBottom: 6,
            }}
          >
            {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => (
              <div
                key={d}
                style={{
                  textAlign: 'center',
                  fontSize: 9,
                  fontWeight: 700,
                  color: t.textLow,
                  padding: '2px 0',
                }}
              >
                {d}
              </div>
            ))}
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(7,1fr)',
              gap: 3,
            }}
          >
            {Array.from({ length: firstDayOfMonth }).map((_, i) => (
              <div key={'e' + i} />
            ))}
            {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((day) => {
              const ds = calDayStr(day);
              const isToday = ds === todayStr;
              const isSel = ds === selectedDate;
              const hasB = hasBookings(ds);
              return (
                <button
                  key={day}
                  onClick={() => selectDay(ds)}
                  style={{
                    aspectRatio: '1',
                    borderRadius: 8,
                    border: 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    position: 'relative',
                    fontSize: 13,
                    fontWeight: isToday || isSel ? 800 : 400,
                    background: isSel
                      ? themeColor
                      : isToday
                      ? themeColor + '33'
                      : 'transparent',
                    color: isSel ? '#000' : isToday ? themeColor : t.textMid,
                  }}
                >
                  {day}
                  {hasB && (
                    <div
                      style={{
                        width: 4,
                        height: 4,
                        borderRadius: '50%',
                        background: isSel ? '#000' : themeColor,
                        position: 'absolute',
                        bottom: 3,
                      }}
                    />
                  )}
                </button>
              );
            })}
          </div>
          <div
            style={{
              fontSize: 10,
              color: t.textLow,
              textAlign: 'center',
              marginTop: 10,
            }}
          >
            Tap a day to see its schedule
          </div>
        </div>
      )}

      {/* ── WEEK ── */}
      {viewMode === 'week' && (
        <div style={{ margin: '0 16px 0' }}>
          {/* Day headers */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '44px repeat(7,1fr)',
              gap: 2,
              marginBottom: 4,
            }}
          >
            <div />
            {weekDays.map((d) => {
              const dd = new Date(d + 'T12:00:00');
              const isToday = d === todayStr;
              const isSel = d === selectedDate;
              return (
                <button
                  key={d}
                  onClick={() => setSelectedDate(d)}
                  style={{
                    textAlign: 'center',
                    background: isSel
                      ? themeColor
                      : isToday
                      ? themeColor + '22'
                      : t.bg1,
                    borderRadius: 8,
                    border: `1px solid ${isSel ? themeColor : t.border}`,
                    padding: '5px 2px',
                    cursor: 'pointer',
                  }}
                >
                  <div
                    style={{
                      fontSize: 8,
                      fontWeight: 700,
                      color: isSel ? '#000' : isToday ? themeColor : t.textLow,
                    }}
                  >
                    {dd
                      .toLocaleDateString('en-US', { weekday: 'short' })
                      .toUpperCase()}
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 800,
                      color: isSel ? '#000' : isToday ? themeColor : t.textMid,
                    }}
                  >
                    {dd.getDate()}
                  </div>
                  {hasBookings(d) && (
                    <div
                      style={{
                        width: 4,
                        height: 4,
                        borderRadius: '50%',
                        background: isSel ? '#000' : themeColor,
                        margin: '2px auto 0',
                      }}
                    />
                  )}
                </button>
              );
            })}
          </div>
          {/* Scrollable grid */}
          <div
            ref={scrollRef}
            style={{ overflowY: 'auto', maxHeight: 'calc(100svh - 290px)' }}
            className="noScroll"
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '44px repeat(7,1fr)',
                gap: 0,
              }}
            >
              {/* Time labels */}
              <div style={{ position: 'relative', height: HOUR_H * 24 }}>
                {HOURS.map((h) => (
                  <div
                    key={h}
                    style={{
                      position: 'absolute',
                      top: h * HOUR_H,
                      right: 4,
                      transform: 'translateY(-50%)',
                    }}
                  >
                    <span className="timeLabel">
                      {fmt12(`${String(h).padStart(2, '0')}:00`)}
                    </span>
                  </div>
                ))}
              </div>
              {/* Day columns */}
              {weekDays.map((d) => {
                const colBkgs = bookings.filter(
                  (b) =>
                    b.date === d &&
                    (filterInst === 'all' || b.instrument_id === filterInst)
                );
                return (
                  <div
                    key={d}
                    style={{
                      borderLeft: '1px solid ' + t.hourLine,
                      position: 'relative',
                    }}
                  >
                    <TimeColumn date={d} bkgs={colBkgs} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── DAY ── */}
      {viewMode === 'day' && (
        <div style={{ margin: '0 16px 0' }}>
          <div
            ref={scrollRef}
            style={{ overflowY: 'auto', maxHeight: 'calc(100svh - 290px)' }}
            className="noScroll"
          >
            <div style={{ display: 'grid', gridTemplateColumns: '44px 1fr' }}>
              {/* Time labels */}
              <div style={{ position: 'relative', height: HOUR_H * 24 }}>
                {HOURS.map((h) => (
                  <div
                    key={h}
                    style={{
                      position: 'absolute',
                      top: h * HOUR_H,
                      right: 4,
                      transform: 'translateY(-50%)',
                    }}
                  >
                    <span className="timeLabel">
                      {fmt12(`${String(h).padStart(2, '0')}:00`)}
                    </span>
                  </div>
                ))}
              </div>
              <TimeColumn
                date={selectedDate}
                bkgs={bookings.filter(
                  (b) =>
                    b.date === selectedDate &&
                    (filterInst === 'all' || b.instrument_id === filterInst)
                )}
              />
            </div>
          </div>
        </div>
      )}

      {/* Popups */}
      {quickBook && (
        <QuickBookPopup
          dragInfo={quickBook}
          instruments={instruments}
          filterInst={filterInst}
          account={account}
          bookings={bookings}
          onConfirm={async (b) => {
            await onSubmit(b);
            setQuickBook(null);
            showToast('Booking confirmed ✓');
          }}
          onClose={() => setQuickBook(null)}
        />
      )}
      {detailBook && (
        <BookingDetailPopup
          b={detailBook}
          instruments={instruments}
          account={account}
          bookings={bookings}
          isAdmin={isAdmin}
          onCancel={(groupId, singleId) => {
            onCancel(groupId, singleId);
            setDetailBook(null);
          }}
          onUpdate={(id, updates) => {
            onUpdate(id, updates);
            setDetailBook(null);
          }}
          onClose={() => setDetailBook(null)}
        />
      )}
    </div>
  );
}

// ─── Quick book popup ─────────────────────────────────────────────────────────
function QuickBookPopup({
  dragInfo,
  instruments,
  filterInst,
  account,
  bookings,
  onConfirm,
  onClose,
}) {
  const multiDay = dragInfo.startDate !== dragInfo.endDate;
  const [instrumentId, setInstrId] = useState(
    filterInst !== 'all' ? filterInst : instruments[0]?.id
  );
  const [startTime, setStart] = useState(minsToTime(dragInfo.startMins));
  const [endTime, setEnd] = useState(minsToTime(dragInfo.endMins));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const inst = instruments.find((i) => i.id === instrumentId) || instruments[0];

  function dateRange(from, to) {
    const dates = [];
    const d = new Date(from + 'T12:00:00');
    const end = new Date(to + 'T12:00:00');
    while (d <= end) {
      dates.push(d.toISOString().split('T')[0]);
      d.setDate(d.getDate() + 1);
    }
    return dates;
  }
  const dates = dateRange(dragInfo.startDate, dragInfo.endDate);

  const conflict = inst
    ? dates.some((date) =>
        bookings.some((b) => {
          if (b.instrument_id !== inst.id || b.date !== date || b.cancelled)
            return false;
          const s = date === dragInfo.startDate ? startTime : '00:00';
          const e = date === dragInfo.endDate ? endTime : '23:59';
          return !(e <= b.start_time || s >= b.end_time);
        })
      )
    : false;

  const maxDays = inst?.max_days ?? null;
  const overLimit = maxDays !== null && dates.length > maxDays;

  async function confirm() {
    if (conflict || overLimit || saving || !inst) return;
    setSaving(true);
    const gid = dates.length > 1 ? genId() : null;
    for (const date of dates) {
      const s = date === dragInfo.startDate ? startTime : '00:00';
      const e = date === dragInfo.endDate ? endTime : '23:59';
      await onConfirm({
        groupId: gid,
        instrumentId: inst.id,
        user: account.display_name,
        date,
        startTime: s,
        endTime: e,
        note,
        recurring: null,
      });
    }
    setSaving(false);
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        zIndex: 400,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#152135',
          borderRadius: '20px 20px 0 0',
          padding: 20,
          width: '100%',
          maxWidth: 440,
          border: '1px solid #1E3A5F',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 800 }}>Quick Book</div>
            <div style={{ fontSize: 11, color: '#64748B' }}>
              {multiDay
                ? `${fmtDate(dragInfo.startDate, {
                    month: 'short',
                    day: 'numeric',
                  })} → ${fmtDate(dragInfo.endDate, {
                    month: 'short',
                    day: 'numeric',
                  })} (${dates.length} days)`
                : fmtDate(dragInfo.startDate, {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                  })}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: '#0B1628',
              border: '1px solid #1E3A5F',
              color: '#64748B',
              borderRadius: 8,
              width: 30,
              height: 30,
              cursor: 'pointer',
              fontSize: 16,
            }}
          >
            ✕
          </button>
        </div>

        {/* Instrument picker */}
        <div style={{ marginBottom: 12 }}>
          <FieldLabel>INSTRUMENT</FieldLabel>
          <div style={{ position: 'relative' }}>
            <select
              value={instrumentId}
              onChange={(e) => setInstrId(e.target.value)}
              style={{
                width: '100%',
                background: '#0B1628',
                border: `1px solid ${inst?.color ?? '#1E3A5F'}`,
                borderRadius: 10,
                color: inst?.color ?? '#E2E8F0',
                fontSize: 13,
                fontWeight: 700,
                padding: '10px 36px 10px 12px',
                cursor: 'pointer',
                outline: 'none',
                fontFamily: 'inherit',
                appearance: 'none',
                WebkitAppearance: 'none',
              }}
            >
              {instruments.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.icon} {i.name} ({i.code})
                </option>
              ))}
            </select>
            <div style={{
              position: 'absolute',
              right: 12,
              top: '50%',
              transform: 'translateY(-50%)',
              pointerEvents: 'none',
              color: inst?.color ?? '#64748B',
              fontSize: 12,
            }}>▾</div>
          </div>
        </div>

        {/* Time range */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 10,
            marginBottom: 12,
          }}
        >
          <div>
            <FieldLabel>{multiDay ? 'START (day 1)' : 'START'}</FieldLabel>
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStart(e.target.value)}
              style={S.input}
              className="inp"
            />
          </div>
          <div>
            <FieldLabel>{multiDay ? 'END (last day)' : 'END'}</FieldLabel>
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEnd(e.target.value)}
              style={S.input}
              className="inp"
            />
          </div>
        </div>

        {/* Duration or multi-day chip */}
        {multiDay ? (
          <div
            style={{
              ...S.chip,
              color: '#4ADE80',
              background: '#4ADE8015',
              marginBottom: 12,
              justifyContent: 'center',
            }}
          >
            📅 {dates.length}-day booking
          </div>
        ) : (
          toMins(endTime) > toMins(startTime) && (
            <div
              style={{
                ...S.chip,
                color: inst?.color,
                background: (inst?.color ?? '#38BDF8') + '18',
                marginBottom: 12,
                justifyContent: 'center',
              }}
            >
              ⏱{' '}
              {(() => {
                const d = durationMins(startTime, endTime);
                return `${Math.floor(d / 60)}h${
                  d % 60 > 0 ? ` ${d % 60}m` : ''
                }`;
              })()}
            </div>
          )
        )}

        {/* Note */}
        <div style={{ marginBottom: 12 }}>
          <FieldLabel>NOTE (optional)</FieldLabel>
          <input
            placeholder="Experiment, sample ID…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={S.input}
            className="inp"
            onKeyDown={(e) => e.key === 'Enter' && confirm()}
          />
        </div>

        {conflict && (
          <div style={{ ...S.conflictBanner, marginBottom: 12 }}>
            ⚠ Conflict with an existing booking
          </div>
        )}
        {overLimit && (
          <div
            style={{
              ...S.conflictBanner,
              marginBottom: 12,
              borderColor: '#FB923C55',
              background: '#FB923C15',
              color: '#FB923C',
            }}
          >
            ⚠ Max {maxDays} day{maxDays > 1 ? 's' : ''} allowed for {inst?.name}
          </div>
        )}

        <button
          onClick={confirm}
          disabled={conflict || overLimit || saving}
          style={{
            ...S.submitBtn,
            width: '100%',
            background:
              conflict || overLimit ? '#1E293B' : inst?.color ?? '#38BDF8',
            color: conflict || overLimit ? '#475569' : '#000',
          }}
        >
          {saving ? (
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <span className="spinner" style={{ borderTopColor: '#000' }} />
              Saving…
            </span>
          ) : multiDay ? (
            `Confirm ${dates.length}-day booking`
          ) : (
            'Confirm Booking'
          )}
        </button>
      </div>
    </div>
  );
}

// ─── Booking detail popup ─────────────────────────────────────────────────────
function BookingDetailPopup({
  b,
  instruments,
  account,
  bookings,
  onCancel,
  onClose,
  onUpdate,
  isAdmin,
}) {
  const inst = instruments.find((i) => i.id === b.instrument_id);
  const isMe = b.user_display_name === account.display_name;
  const dur = durationMins(b.start_time, b.end_time);
  const isAllDay = b.start_time === '00:00' && b.end_time === '23:59';
  const groupRows = b.group_id
    ? bookings.filter((bk) => bk.group_id === b.group_id && !bk.cancelled)
    : null;
  const isGroup = groupRows && groupRows.length > 1;
  const groupStart = isGroup
    ? groupRows.slice().sort((a, z) => a.date.localeCompare(z.date))[0].date
    : null;
  const groupEnd = isGroup
    ? groupRows.slice().sort((a, z) => z.date.localeCompare(a.date))[0].date
    : null;
  const canCancel = isMe || isAdmin;

  const [editing, setEditing] = useState(false);
  const [editTime0, setTime0] = useState(b.start_time);
  const [editTime1, setTime1] = useState(b.end_time);
  const [editNote, setEditNote] = useState(b.note || '');
  const [saving, setSaving] = useState(false);

  const editConflict =
    editing &&
    !isGroup &&
    bookings.some((bk) => {
      if (
        bk.id === b.id ||
        bk.instrument_id !== b.instrument_id ||
        bk.date !== b.date ||
        bk.cancelled
      )
        return false;
      return !(editTime1 <= bk.start_time || editTime0 >= bk.end_time);
    });

  async function saveEdit() {
    if (editConflict || saving) return;
    setSaving(true);
    if (isGroup) {
      const sorted = groupRows
        .slice()
        .sort((a, z) => a.date.localeCompare(z.date));
      for (let i = 0; i < sorted.length; i++) {
        const s = i === 0 ? editTime0 : '00:00';
        const e = i === sorted.length - 1 ? editTime1 : '23:59';
        await onUpdate(sorted[i].id, {
          start_time: s,
          end_time: e,
          note: editNote,
        });
      }
    } else {
      await onUpdate(b.id, {
        start_time: editTime0,
        end_time: editTime1,
        note: editNote,
      });
    }
    setSaving(false);
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        zIndex: 400,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#152135',
          borderRadius: '20px 20px 0 0',
          padding: 24,
          width: '100%',
          maxWidth: 440,
          border: '1px solid #1E3A5F',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            marginBottom: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                ...S.iconBubble,
                background: inst?.color + '22',
                color: inst?.color,
                width: 36,
                height: 36,
                fontSize: 18,
              }}
            >
              {inst?.icon}
            </div>
            <div>
              <div
                style={{ fontSize: 15, fontWeight: 800, color: inst?.color }}
              >
                {inst?.name}
              </div>
              <div style={{ fontSize: 11, color: '#475569' }}>{inst?.code}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {isMe && (
              <button
                onClick={() => setEditing((v) => !v)}
                style={{
                  background: editing ? '#38BDF822' : 'transparent',
                  border: '1px solid #1E3A5F',
                  color: editing ? '#38BDF8' : '#94A3B8',
                  borderRadius: 8,
                  padding: '4px 10px',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: 'inherit',
                }}
              >
                ✏ Edit
              </button>
            )}
            <button
              onClick={onClose}
              style={{
                background: '#0B1628',
                border: '1px solid #1E3A5F',
                color: '#94A3B8',
                borderRadius: 8,
                width: 30,
                height: 30,
                cursor: 'pointer',
                fontSize: 16,
                flexShrink: 0,
              }}
            >
              ✕
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Chip icon="👤">
              {b.user_display_name}
              {isMe ? ' (you)' : ''}
              {!isMe && isAdmin ? ' 🔑' : ''}
            </Chip>
            {isGroup ? (
              <>
                <Chip icon="📅">
                  {fmtDate(groupStart, { month: 'short', day: 'numeric' })} →{' '}
                  {fmtDate(groupEnd, { month: 'short', day: 'numeric' })}
                </Chip>
                <Chip icon="🗓">{groupRows.length} days</Chip>
              </>
            ) : (
              <>
                <Chip icon="📅">
                  {fmtDate(b.date, {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                  })}
                </Chip>
                {!editing && (
                  <Chip icon="🕐">
                    {isAllDay
                      ? 'All day'
                      : `${fmt12(b.start_time)} – ${fmt12(b.end_time)}`}
                  </Chip>
                )}
                {!editing && !isAllDay && (
                  <Chip icon="⏱">
                    {Math.floor(dur / 60)}h{dur % 60 > 0 ? ` ${dur % 60}m` : ''}
                  </Chip>
                )}
              </>
            )}
          </div>

          {editing && (
            <div
              style={{
                background: '#0B1628',
                borderRadius: 12,
                padding: 14,
                border: '1px solid #1E3A5F',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 10,
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: '#475569',
                      marginBottom: 4,
                    }}
                  >
                    {isGroup ? 'START (day 1)' : 'START'}
                  </div>
                  <input
                    type="time"
                    value={editTime0}
                    onChange={(e) => setTime0(e.target.value)}
                    style={{ ...S.input, fontSize: 13 }}
                  />
                </div>
                <div>
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: '#475569',
                      marginBottom: 4,
                    }}
                  >
                    {isGroup ? 'END (last day)' : 'END'}
                  </div>
                  <input
                    type="time"
                    value={editTime1}
                    onChange={(e) => setTime1(e.target.value)}
                    style={{ ...S.input, fontSize: 13 }}
                  />
                </div>
              </div>
              <div>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: '#475569',
                    marginBottom: 4,
                  }}
                >
                  NOTE
                </div>
                <input
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                  placeholder="Add a note…"
                  maxLength={200}
                  style={{ ...S.input, fontSize: 13 }}
                />
              </div>
              {editConflict && (
                <div style={S.conflictBanner}>
                  ⚠ Time conflicts with another booking
                </div>
              )}
              <button
                onClick={saveEdit}
                disabled={editConflict || saving}
                style={{
                  ...S.submitBtn,
                  width: '100%',
                  background: editConflict ? '#1E293B' : inst?.color,
                  color: editConflict ? '#475569' : '#000',
                }}
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          )}

          {!editing &&
            (b.note ? (
              <div
                style={{
                  background: '#0B1628',
                  borderRadius: 10,
                  padding: '12px 14px',
                  border: '1px solid #1E3A5F',
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 1.2,
                    color: '#475569',
                    marginBottom: 6,
                  }}
                >
                  NOTE
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: '#E2E8F0',
                    lineHeight: 1.6,
                    fontStyle: 'italic',
                  }}
                >
                  "{b.note}"
                </div>
              </div>
            ) : (
              <div
                style={{
                  background: '#0B1628',
                  borderRadius: 10,
                  padding: '12px 14px',
                  border: '1px solid #1E3A5F',
                  textAlign: 'center',
                }}
              >
                <div style={{ fontSize: 12, color: '#475569' }}>
                  No note left by booker
                </div>
              </div>
            ))}

          {canCancel && (
            <button
              onClick={() => onCancel(b.group_id || null, b.id)}
              style={{
                ...S.submitBtn,
                background: '#EF444420',
                color: '#F87171',
                border: '1px solid #EF444440',
                width: '100%',
                marginTop: 4,
              }}
            >
              {isGroup
                ? `Cancel all ${groupRows.length} days`
                : 'Cancel this booking'}
              {!isMe && isAdmin && ' (admin)'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MY BOOKINGS
// ═══════════════════════════════════════════════════════════════════════════════
function MyBookingsView({
  bookings,
  instruments,
  account,
  onCancel,
  onUpdate,
  onBack,
  navigate,
}) {
  const mine = bookings
    .filter((b) => b.user_display_name === account.display_name)
    .sort((a, b) =>
      a.date === b.date
        ? a.start_time.localeCompare(b.start_time)
        : a.date.localeCompare(b.date)
    );
  const upcoming = mine.filter((b) => b.date >= todayStr);
  const past = mine.filter((b) => b.date < todayStr);
  return (
    <div className="view">
      <SubHeader
        title="My Bookings"
        subtitle={`${upcoming.length} upcoming`}
        onBack={onBack}
      />
      {upcoming.length === 0 && (
        <div style={{ ...S.empty, margin: '24px 16px' }}>
          No upcoming —{' '}
          <span
            style={{ color: '#38BDF8', cursor: 'pointer' }}
            onClick={() => navigate('newBooking')}
          >
            book now?
          </span>
        </div>
      )}
      {upcoming.map((b) => (
        <BookingCard
          key={b.id}
          b={b}
          instruments={instruments}
          bookings={bookings}
          onCancel={onCancel}
          onUpdate={onUpdate}
        />
      ))}
      {past.length > 0 && (
        <>
          <div
            style={{
              ...S.sectionLabel,
              padding: '16px 16px 8px',
              opacity: 0.5,
            }}
          >
            PAST
          </div>
          {past.map((b) => (
            <BookingCard key={b.id} b={b} instruments={instruments} bookings={bookings} past />
          ))}
        </>
      )}
    </div>
  );
}

function BookingCard({ b, instruments, bookings, onCancel, onUpdate, past }) {
  const t = useT();
  const inst = instruments.find((i) => i.id === b.instrument_id);
  if (!inst) return null;
  const dur = durationMins(b.start_time, b.end_time);

  const [editing, setEditing] = useState(false);
  const [editStart, setEditStart] = useState(b.start_time);
  const [editEnd, setEditEnd] = useState(b.end_time);
  const [editNote, setEditNote] = useState(b.note || '');
  const [saving, setSaving] = useState(false);

  const editConflict = editing && bookings.some((bk) => {
    if (bk.id === b.id || bk.instrument_id !== b.instrument_id || bk.date !== b.date || bk.cancelled) return false;
    return !(editEnd <= bk.start_time || editStart >= bk.end_time);
  });

  async function saveEdit() {
    if (editConflict || saving) return;
    setSaving(true);
    await onUpdate(b.id, { start_time: editStart, end_time: editEnd, note: editNote });
    setSaving(false);
    setEditing(false);
  }

  return (
    <div
      style={{
        ...S.card,
        margin: '0 16px 10px',
        borderLeft: `4px solid ${past ? '#334155' : inst.color}`,
        opacity: past ? 0.55 : 1,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
        }}
      >
        <div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: past ? '#475569' : inst.color,
            }}
          >
            {inst.icon} {inst.name}
          </div>
          <div style={{ fontSize: 10, color: '#475569', marginTop: 1 }}>
            {inst.code}
          </div>
        </div>
        {!past && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {onUpdate && (
              <button
                onClick={() => { setEditing((e) => !e); setEditStart(b.start_time); setEditEnd(b.end_time); setEditNote(b.note || ''); }}
                style={{
                  ...S.pill,
                  background: editing ? inst.color + '33' : t.bg2,
                  color: editing ? inst.color : t.textMid,
                  cursor: 'pointer',
                  border: `1px solid ${editing ? inst.color + '55' : t.border}`,
                  fontSize: 10,
                }}
              >
                {editing ? 'Cancel edit' : '✏ Edit'}
              </button>
            )}
            {onCancel && (
              <button
                onClick={() => onCancel(b.group_id || null, b.id)}
                style={{
                  ...S.pill,
                  background: '#EF444422',
                  color: '#EF4444',
                  cursor: 'pointer',
                  border: '1px solid #EF444433',
                  fontSize: 10,
                }}
              >
                {b.group_id ? 'Cancel all days' : 'Cancel'}
              </button>
            )}
          </div>
        )}
      </div>

      {editing ? (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', marginBottom: 4 }}>START</div>
              <input type="time" value={editStart} onChange={(e) => setEditStart(e.target.value)} style={S.input} className="inp" />
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', marginBottom: 4 }}>END</div>
              <input type="time" value={editEnd} onChange={(e) => setEditEnd(e.target.value)} style={S.input} className="inp" />
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', marginBottom: 4 }}>NOTE</div>
            <input value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="Add a note…" maxLength={200} style={S.input} className="inp" />
          </div>
          {editConflict && <div style={S.conflictBanner}>⚠ Time conflicts with another booking</div>}
          <button
            onClick={saveEdit}
            disabled={editConflict || saving}
            style={{ ...S.submitBtn, background: editConflict ? '#1E293B' : inst.color, color: editConflict ? '#475569' : '#000' }}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
            <Chip icon="📅">{fmtDate(b.date)}</Chip>
            <Chip icon="🕐">
              {fmt12(b.start_time)} – {fmt12(b.end_time)}
            </Chip>
            <Chip icon="⏱">
              {Math.floor(dur / 60)}h{dur % 60 > 0 ? ` ${dur % 60}m` : ''}
            </Chip>
          </div>
          {b.note && (
            <div
              style={{
                fontSize: 11,
                color: '#475569',
                marginTop: 8,
                fontStyle: 'italic',
              }}
            >
              "{b.note}"
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROFILE VIEW
// ═══════════════════════════════════════════════════════════════════════════════
function ProfileView({
  account,
  bookings,
  instruments,
  onLogout,
  onBack,
  isDark,
  onToggleTheme,
}) {
  var t = useT();
  const mine = bookings.filter(
    (b) => b.user_display_name === account.display_name
  );
  const upcoming = mine.filter((b) => b.date >= todayStr).length;
  return (
    <div className="view">
      <SubHeader title="Profile" onBack={onBack} />
      <div style={{ margin: '0 16px 16px' }}>
        <div
          style={{ ...S.card, display: 'flex', alignItems: 'center', gap: 14 }}
        >
          <div style={S.avatar}>
            {account.display_name
              .split(' ')
              .map((w) => w[0])
              .join('')
              .slice(0, 2)}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 800 }}>
              {account.display_name}
            </div>
            <div style={{ fontSize: 12, color: '#475569', marginTop: 2 }}>
              @{account.username}
            </div>
            {account.is_admin && (
              <span
                style={{
                  ...S.pill,
                  background: '#FB923C22',
                  color: '#FB923C',
                  marginTop: 6,
                  display: 'inline-flex',
                }}
              >
                ⚙ Admin
              </span>
            )}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, padding: '0 16px 20px' }}>
        {[
          { label: 'Total bookings', val: mine.length, color: '#38BDF8' },
          { label: 'Upcoming', val: upcoming, color: '#4ADE80' },
        ].map((s) => (
          <div
            key={s.label}
            style={{ ...S.statCard, flex: 1, textAlign: 'center' }}
          >
            <div style={{ fontSize: 26, fontWeight: 800, color: s.color }}>
              {s.val}
            </div>
            <div style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>
              {s.label}
            </div>
          </div>
        ))}
      </div>
      <div style={{ padding: '0 16px 14px' }}>
        <div
          style={{
            ...S.card,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 16px',
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>
              {isDark ? '🌙 Dark mode' : '☀️ Light mode'}
            </div>
            <div style={{ fontSize: 11, color: t.textLow, marginTop: 2 }}>
              Switch appearance
            </div>
          </div>
          <div
            onClick={onToggleTheme}
            style={{
              width: 48,
              height: 28,
              borderRadius: 14,
              background: isDark ? t.accent : t.border,
              cursor: 'pointer',
              position: 'relative',
              transition: 'background 0.25s',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: 3,
                left: isDark ? 22 : 3,
                width: 22,
                height: 22,
                borderRadius: '50%',
                background: '#fff',
                transition: 'left 0.25s',
                boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
              }}
            />
          </div>
        </div>
      </div>
      <div style={{ padding: '0 16px' }}>
        <button
          onClick={onLogout}
          style={{
            ...S.submitBtn,
            background: '#EF444420',
            color: '#EF4444',
            border: '1px solid #EF444440',
            width: '100%',
          }}
        >
          Sign Out
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN VIEW
// ═══════════════════════════════════════════════════════════════════════════════
const ICON_OPTIONS = [
  '⚛',
  '⚗',
  '🧪',
  '🔬',
  '🌀',
  '🧬',
  '🧫',
  '🧲',
  '💡',
  '🔭',
  '🩻',
  '🩺',
  '💊',
  '🧴',
  '🧯',
  '🔩',
  '⚙️',
  '🖥️',
  '📡',
  '🌡️',
  '⚖️',
  '🔋',
  '🫧',
  '🏺',
  '🔐',
];

function AdminView({
  instruments,
  accounts,
  bookings,
  currentAccount,
  onAddInstrument,
  onUpdateInstrument,
  onDeleteInstrument,
  onDeleteAccount,
  onPromote,
  onApprove,
  onReject,
  onCancelBooking,
  onLogout,
  onBack,
}) {
  const [tab, setTab] = useState('instruments');
  const [newName, setNewName] = useState('');
  const [newCode, setNewCode] = useState('');
  const [newCat, setNewCat] = useState('Other');
  const [newIcon, setNewIcon] = useState('🔬');
  const [newColor, setNewColor] = useState('#38BDF8');
  const [showNewIconPicker, setShowNewIconPicker] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editCode, setEditCode] = useState('');
  const [editCat, setEditCat] = useState('');
  const [editIcon, setEditIcon] = useState('');
  const [editColor, setEditColor] = useState('');
  const [editMaxDays, setEditMaxDays] = useState('');
  const [showEditIconPicker, setShowEditIconPicker] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmCancelBooking, setConfirmCancelBooking] = useState(null);
  const [bookingFilter, setBookingFilter] = useState('all');

  function startEdit(inst) {
    setEditingId(inst.id);
    setEditName(inst.name);
    setEditCode(inst.code);
    setEditCat(inst.category);
    setEditIcon(inst.icon);
    setEditColor(inst.color);
    setEditMaxDays(inst.max_days ?? null);
    setShowEditIconPicker(false);
  }
  function submitEdit() {
    if (!editName.trim() || !editCode.trim()) return;
    onUpdateInstrument(editingId, {
      name: editName.trim(),
      code: editCode.trim(),
      category: editCat,
      icon: editIcon,
      color: editColor,
      max_days: editMaxDays ? Number(editMaxDays) : null,
    });
    setEditingId(null);
  }
  function submitAdd() {
    if (!newName.trim() || !newCode.trim()) return;
    onAddInstrument({
      name: newName.trim(),
      code: newCode.trim(),
      category: newCat,
      icon: newIcon,
      color: newColor,
      max_days: null,
    });
    setNewName('');
    setNewCode('');
    setNewIcon('🔬');
    setShowNewIconPicker(false);
  }

  const pendingAccounts = accounts.filter((a) => a.status === 'pending');

  const t = useT();
  const instStats = instruments
    .map((i) => ({
      ...i,
      count: bookings.filter((b) => b.instrument_id === i.id).length,
    }))
    .sort((a, b) => b.count - a.count);
  const userStats = accounts
    .map((a) => ({
      ...a,
      count: bookings.filter((b) => b.user_display_name === a.display_name)
        .length,
    }))
    .sort((a, b) => b.count - a.count);

  if (!currentAccount.is_admin)
    return (
      <div className="view">
        <SubHeader title="Admin" onBack={onBack} />
        <div style={{ ...S.empty, margin: '40px 16px' }}>
          🔒 Admin access only
        </div>
      </div>
    );

  return (
    <div className="view">
      <SubHeader
        title="Admin Panel"
        subtitle="Lab management"
        onBack={onBack}
      />
      <div style={{ display: 'flex', gap: 8, padding: '0 16px 12px' }}>
        <div
          style={{
            flex: 1,
            fontSize: 12,
            color: t.textLow,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span
            style={{ ...S.pill, background: '#FB923C22', color: '#FB923C' }}
          >
            ⚙ Admin
          </span>
          <span style={{ fontWeight: 700, color: t.text }}>
            {currentAccount.display_name}
          </span>
        </div>
        <button
          onClick={onLogout}
          style={{
            ...S.pill,
            background: '#EF444422',
            color: '#EF4444',
            border: '1px solid #EF444433',
            cursor: 'pointer',
            fontSize: 11,
            padding: '6px 12px',
          }}
        >
          Sign Out
        </button>
      </div>

      {/* Confirm delete modal */}
      {confirmDelete && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            zIndex: 300,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <div
            style={{
              background: '#0D1F33',
              borderRadius: 18,
              padding: 24,
              border: '1px solid #1E293B',
              width: '100%',
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 8 }}>
              Confirm removal
            </div>
            <div style={{ fontSize: 13, color: '#64748B', marginBottom: 20 }}>
              Remove{' '}
              <span style={{ color: '#EF4444', fontWeight: 700 }}>
                {confirmDelete.name}
              </span>
              ? This cannot be undone.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setConfirmDelete(null)}
                style={{
                  flex: 1,
                  padding: 12,
                  borderRadius: 10,
                  border: '1px solid #1E293B',
                  background: 'transparent',
                  color: '#64748B',
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (confirmDelete.type === 'instrument')
                    onDeleteInstrument(confirmDelete.id);
                  else onDeleteAccount(confirmDelete.id);
                  setConfirmDelete(null);
                }}
                style={{
                  flex: 1,
                  padding: 12,
                  borderRadius: 10,
                  border: 'none',
                  background: '#EF4444',
                  color: '#fff',
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          margin: '0 16px 16px',
          background: '#0B1628',
          borderRadius: 12,
          padding: 4,
          border: '1px solid #1E3A5F',
        }}
      >
        {['instruments', 'bookings', 'users', 'stats'].map((tabId) => (
          <button
            key={tabId}
            onClick={() => setTab(tabId)}
            style={{
              flex: 1,
              padding: '8px 0',
              borderRadius: 9,
              border: 'none',
              fontSize: 10,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
              background: tab === tabId ? '#1E3A5F' : 'transparent',
              color: tab === tabId ? '#38BDF8' : '#475569',
              position: 'relative',
            }}
          >
            {tabId.charAt(0).toUpperCase() + tabId.slice(1)}
            {tabId === 'users' && pendingAccounts.length > 0 && (
              <span
                style={{
                  position: 'absolute',
                  top: 4,
                  right: 6,
                  background: '#EF4444',
                  color: '#fff',
                  borderRadius: '50%',
                  width: 14,
                  height: 14,
                  fontSize: 8,
                  fontWeight: 800,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {pendingAccounts.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── INSTRUMENTS TAB ── */}
      {tab === 'instruments' && (
        <>
          {instruments.map((inst) => (
            <div key={inst.id}>
              {editingId === inst.id ? (
                <div
                  style={{
                    ...S.formCard,
                    margin: '0 16px 10px',
                    border: `1px solid ${editColor}55`,
                  }}
                >
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: editColor,
                      letterSpacing: 1,
                    }}
                  >
                    EDITING — {inst.name}
                  </div>
                  <div>
                    <FieldLabel>NAME</FieldLabel>
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      style={S.input}
                      className="inp"
                    />
                  </div>
                  <div>
                    <FieldLabel>CODE</FieldLabel>
                    <input
                      value={editCode}
                      onChange={(e) => setEditCode(e.target.value)}
                      style={S.input}
                      className="inp"
                    />
                  </div>
                  <div>
                    <FieldLabel>CATEGORY</FieldLabel>
                    <select
                      value={editCat}
                      onChange={(e) => setEditCat(e.target.value)}
                      style={S.input}
                      className="inp"
                    >
                      {[
                        'Spectroscopy',
                        'Chromatography',
                        'Microscopy',
                        'Sample Prep',
                        'Genomics',
                        'Other',
                      ].map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <FieldLabel>ICON</FieldLabel>
                    <button
                      onClick={() => setShowEditIconPicker((p) => !p)}
                      style={{
                        ...S.input,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{ fontSize: 22 }}>{editIcon}</span>
                      <span style={{ color: '#475569', fontSize: 12 }}>
                        tap to change ▼
                      </span>
                    </button>
                    {showEditIconPicker && (
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(6,1fr)',
                          gap: 6,
                          marginTop: 8,
                          background: '#060E1A',
                          borderRadius: 10,
                          padding: 10,
                          border: '1px solid #1E293B',
                        }}
                      >
                        {ICON_OPTIONS.map((ic) => (
                          <button
                            key={ic}
                            onClick={() => {
                              setEditIcon(ic);
                              setShowEditIconPicker(false);
                            }}
                            style={{
                              fontSize: 22,
                              background:
                                editIcon === ic
                                  ? editColor + '33'
                                  : 'transparent',
                              border:
                                editIcon === ic
                                  ? `1px solid ${editColor}`
                                  : '1px solid transparent',
                              borderRadius: 8,
                              padding: '6px 0',
                              cursor: 'pointer',
                            }}
                          >
                            {ic}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <FieldLabel>COLOR</FieldLabel>
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 10 }}
                    >
                      <input
                        type="color"
                        value={editColor}
                        onChange={(e) => setEditColor(e.target.value)}
                        style={{
                          width: 48,
                          height: 40,
                          borderRadius: 8,
                          border: '1px solid #1E293B',
                          background: 'none',
                          cursor: 'pointer',
                          padding: 2,
                        }}
                      />
                      <div
                        style={{
                          ...S.iconBubble,
                          background: editColor + '22',
                          color: editColor,
                        }}
                      >
                        {editIcon}
                      </div>
                      <span style={{ fontSize: 11, color: '#475569' }}>
                        preview
                      </span>
                    </div>
                  </div>
                  <div>
                    <FieldLabel>
                      MAX BOOKING DAYS (leave blank = no limit)
                    </FieldLabel>
                    <input
                      type="number"
                      min={1}
                      max={365}
                      placeholder="e.g. 3"
                      value={editMaxDays ?? ''}
                      onChange={(e) => setEditMaxDays(e.target.value)}
                      style={{ ...S.input, width: 120 }}
                      className="inp"
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => setEditingId(null)}
                      style={{
                        flex: 1,
                        padding: 11,
                        borderRadius: 10,
                        border: '1px solid #1E3A5F',
                        background: 'transparent',
                        color: '#64748B',
                        fontWeight: 700,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={submitEdit}
                      style={{
                        flex: 2,
                        padding: 11,
                        borderRadius: 10,
                        border: 'none',
                        background: editColor,
                        color: '#000',
                        fontWeight: 800,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      Save Changes
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    ...S.card,
                    margin: '0 16px 8px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      ...S.iconBubble,
                      background: inst.color + '22',
                      color: inst.color,
                      flexShrink: 0,
                    }}
                  >
                    {inst.icon}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>
                      {inst.name}
                    </div>
                    <div style={{ fontSize: 10, color: '#475569' }}>
                      {inst.code} · {inst.category}
                    </div>
                    {inst.max_days && (
                      <div
                        style={{
                          ...S.pill,
                          background: '#FB923C22',
                          color: '#FB923C',
                          marginTop: 4,
                          display: 'inline-flex',
                        }}
                      >
                        ⏱ max {inst.max_days}days
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                    <button
                      onClick={() => startEdit(inst)}
                      style={{
                        ...S.pill,
                        background: '#38BDF822',
                        color: '#38BDF8',
                        cursor: 'pointer',
                        border: 'none',
                        fontSize: 11,
                      }}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() =>
                        setConfirmDelete({
                          type: 'instrument',
                          id: inst.id,
                          name: inst.name,
                        })
                      }
                      style={{
                        ...S.pill,
                        background: '#EF444422',
                        color: '#EF4444',
                        cursor: 'pointer',
                        border: 'none',
                        fontSize: 11,
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
          <div style={S.formCard}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: '#64748B',
                letterSpacing: 1,
              }}
            >
              ADD NEW INSTRUMENT
            </div>
            <div>
              <FieldLabel>NAME</FieldLabel>
              <input
                placeholder="e.g. GC-MS System"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                style={S.input}
                className="inp"
              />
            </div>
            <div>
              <FieldLabel>CODE</FieldLabel>
              <input
                placeholder="e.g. GCMS-01"
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                style={S.input}
                className="inp"
              />
            </div>
            <div>
              <FieldLabel>CATEGORY</FieldLabel>
              <select
                value={newCat}
                onChange={(e) => setNewCat(e.target.value)}
                style={S.input}
                className="inp"
              >
                {[
                  'Spectroscopy',
                  'Chromatography',
                  'Microscopy',
                  'Sample Prep',
                  'Genomics',
                  'Other',
                ].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <FieldLabel>ICON</FieldLabel>
              <button
                onClick={() => setShowNewIconPicker((p) => !p)}
                style={{
                  ...S.input,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  cursor: 'pointer',
                }}
              >
                <span style={{ fontSize: 22 }}>{newIcon}</span>
                <span style={{ color: '#475569', fontSize: 12 }}>
                  tap to choose ▼
                </span>
              </button>
              {showNewIconPicker && (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(6,1fr)',
                    gap: 6,
                    marginTop: 8,
                    background: '#060E1A',
                    borderRadius: 10,
                    padding: 10,
                    border: '1px solid #1E293B',
                  }}
                >
                  {ICON_OPTIONS.map((ic) => (
                    <button
                      key={ic}
                      onClick={() => {
                        setNewIcon(ic);
                        setShowNewIconPicker(false);
                      }}
                      style={{
                        fontSize: 22,
                        background:
                          newIcon === ic ? newColor + '33' : 'transparent',
                        border:
                          newIcon === ic
                            ? `1px solid ${newColor}`
                            : '1px solid transparent',
                        borderRadius: 8,
                        padding: '6px 0',
                        cursor: 'pointer',
                      }}
                    >
                      {ic}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <FieldLabel>COLOR</FieldLabel>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  type="color"
                  value={newColor}
                  onChange={(e) => setNewColor(e.target.value)}
                  style={{
                    width: 48,
                    height: 40,
                    borderRadius: 8,
                    border: '1px solid #1E293B',
                    background: 'none',
                    cursor: 'pointer',
                    padding: 2,
                  }}
                />
                <div
                  style={{
                    ...S.iconBubble,
                    background: newColor + '22',
                    color: newColor,
                  }}
                >
                  {newIcon}
                </div>
                <span style={{ fontSize: 11, color: '#475569' }}>preview</span>
              </div>
            </div>
            <button
              onClick={submitAdd}
              style={{
                ...S.submitBtn,
                background: newName && newCode ? newColor : '#1E293B',
                color: newName && newCode ? '#000' : '#475569',
              }}
            >
              Add Instrument
            </button>
          </div>
        </>
      )}

      {/* ── BOOKINGS TAB ── */}
      {tab === 'bookings' &&
        (() => {
          const allB = bookings
            .slice()
            .sort((a, z) => z.date.localeCompare(a.date));
          const filtered =
            bookingFilter === 'all'
              ? allB
              : allB.filter((b) => b.instrument_id === bookingFilter);
          // Group multi-day: show only one row per group_id (the first day)
          const seen = new Set();
          const deduped = filtered.filter((b) => {
            if (!b.group_id) return true;
            if (seen.has(b.group_id)) return false;
            seen.add(b.group_id);
            return true;
          });
          return (
            <>
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  padding: '0 16px 10px',
                  overflowX: 'auto',
                }}
                className="noScroll"
              >
                <button
                  onClick={() => setBookingFilter('all')}
                  style={{
                    ...S.filterPill,
                    background: bookingFilter === 'all' ? '#38BDF8' : '#152135',
                    color: bookingFilter === 'all' ? '#000' : '#64748B',
                    border: `1px solid ${
                      bookingFilter === 'all' ? '#38BDF8' : '#1E3A5F'
                    }`,
                  }}
                >
                  All
                </button>
                {instruments.map((i) => (
                  <button
                    key={i.id}
                    onClick={() => setBookingFilter(i.id)}
                    style={{
                      ...S.filterPill,
                      background: bookingFilter === i.id ? i.color : '#152135',
                      color: bookingFilter === i.id ? '#000' : '#64748B',
                      border: `1px solid ${
                        bookingFilter === i.id ? i.color : '#1E3A5F'
                      }`,
                    }}
                  >
                    {i.icon} {i.code}
                  </button>
                ))}
              </div>
              {confirmCancelBooking && (
                <div
                  style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(0,0,0,0.75)',
                    zIndex: 300,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 24,
                  }}
                >
                  <div
                    style={{
                      background: '#152135',
                      borderRadius: 18,
                      padding: 24,
                      border: '1px solid #1E3A5F',
                      width: '100%',
                    }}
                  >
                    <div
                      style={{ fontSize: 15, fontWeight: 800, marginBottom: 8 }}
                    >
                      Cancel booking?
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        color: '#64748B',
                        marginBottom: 20,
                      }}
                    >
                      {confirmCancelBooking.groupSize > 1
                        ? `This will cancel all ${confirmCancelBooking.groupSize} days of this booking.`
                        : 'This will cancel the booking.'}
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button
                        onClick={() => setConfirmCancelBooking(null)}
                        style={{
                          flex: 1,
                          padding: 12,
                          borderRadius: 10,
                          border: '1px solid #1E3A5F',
                          background: 'transparent',
                          color: '#64748B',
                          fontWeight: 700,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        Keep
                      </button>
                      <button
                        onClick={() => {
                          onCancelBooking(
                            confirmCancelBooking.groupId,
                            confirmCancelBooking.id
                          );
                          setConfirmCancelBooking(null);
                        }}
                        style={{
                          flex: 1,
                          padding: 12,
                          borderRadius: 10,
                          border: 'none',
                          background: '#EF4444',
                          color: '#fff',
                          fontWeight: 700,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        Cancel it
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {deduped.length === 0 && (
                <div style={{ ...S.empty, margin: '24px 16px' }}>
                  No bookings
                </div>
              )}
              {deduped.map((b) => {
                const bi = instruments.find((i) => i.id === b.instrument_id);
                const groupRows = b.group_id
                  ? bookings.filter((bk) => bk.group_id === b.group_id)
                  : null;
                const groupSize = groupRows ? groupRows.length : 1;
                const dateLabel =
                  groupSize > 1
                    ? `${fmtDate(
                        groupRows
                          .slice()
                          .sort((a, z) => a.date.localeCompare(z.date))[0].date,
                        { month: 'short', day: 'numeric' }
                      )} → ${fmtDate(
                        groupRows
                          .slice()
                          .sort((a, z) => z.date.localeCompare(a.date))[0].date,
                        { month: 'short', day: 'numeric' }
                      )}`
                    : fmtDate(b.date, {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                      });
                return (
                  <div
                    key={b.group_id || b.id}
                    style={{
                      ...S.card,
                      margin: '0 16px 8px',
                      borderLeft: `3px solid ${bi?.color}`,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 700,
                            color: bi?.color,
                          }}
                        >
                          {bi?.icon} {bi?.name}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: '#94A3B8',
                            marginTop: 2,
                          }}
                        >
                          {b.user_display_name}
                        </div>
                        <div
                          style={{
                            fontSize: 10,
                            color: '#475569',
                            marginTop: 2,
                          }}
                        >
                          {dateLabel}
                          {groupSize > 1
                            ? ` · ${groupSize} days`
                            : ` · ${fmt12(b.start_time)}–${fmt12(b.end_time)}`}
                        </div>
                        {b.note && (
                          <div
                            style={{
                              fontSize: 10,
                              color: '#475569',
                              fontStyle: 'italic',
                              marginTop: 3,
                            }}
                          >
                            "{b.note}"
                          </div>
                        )}
                      </div>
                      <button
                        onClick={() =>
                          setConfirmCancelBooking({
                            id: b.id,
                            groupId: b.group_id || null,
                            groupSize,
                          })
                        }
                        style={{
                          ...S.pill,
                          background: '#EF444422',
                          color: '#EF4444',
                          cursor: 'pointer',
                          border: 'none',
                          fontSize: 10,
                          flexShrink: 0,
                        }}
                      >
                        ✕ Cancel
                      </button>
                    </div>
                  </div>
                );
              })}
            </>
          );
        })()}

      {/* ── USERS TAB ── */}
      {tab === 'users' && (
        <>
          {/* Pending approvals section */}
          {pendingAccounts.length > 0 && (
            <>
              <div
                style={{
                  fontSize: 10,
                  color: '#EF4444',
                  fontWeight: 700,
                  letterSpacing: 1.5,
                  padding: '0 16px 10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span
                  style={{
                    background: '#EF444422',
                    border: '1px solid #EF444440',
                    borderRadius: 20,
                    padding: '2px 8px',
                  }}
                >
                  ⏳ {pendingAccounts.length} PENDING APPROVAL
                </span>
              </div>
              {pendingAccounts.map((a) => (
                <div
                  key={a.id}
                  style={{
                    ...S.card,
                    margin: '0 16px 8px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    border: '1px solid #EF444433',
                    background: '#EF444408',
                  }}
                >
                  <div
                    style={{
                      ...S.avatar,
                      background: '#EF444422',
                      color: '#EF4444',
                    }}
                  >
                    {a.display_name
                      .split(' ')
                      .map((w) => w[0])
                      .join('')
                      .slice(0, 2)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>
                      {a.display_name}
                    </div>
                    <div style={{ fontSize: 10, color: '#475569' }}>
                      @{a.username}
                    </div>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 5,
                      flexShrink: 0,
                    }}
                  >
                    <button
                      onClick={() => onApprove(a.id)}
                      style={{
                        ...S.pill,
                        background: '#22C55E22',
                        color: '#22C55E',
                        cursor: 'pointer',
                        border: 'none',
                        fontSize: 10,
                      }}
                    >
                      ✓ Approve
                    </button>
                    <button
                      onClick={() => onReject(a.id)}
                      style={{
                        ...S.pill,
                        background: '#EF444422',
                        color: '#EF4444',
                        cursor: 'pointer',
                        border: 'none',
                        fontSize: 10,
                      }}
                    >
                      ✕ Reject
                    </button>
                  </div>
                </div>
              ))}
              <div
                style={{
                  height: 1,
                  background: '#1E3A5F',
                  margin: '4px 16px 14px',
                }}
              />
            </>
          )}

          <div
            style={{
              fontSize: 10,
              color: '#334155',
              fontWeight: 700,
              letterSpacing: 1.5,
              padding: '0 16px 10px',
            }}
          >
            {accounts.filter((a) => a.status !== 'pending').length} MEMBER
            {accounts.filter((a) => a.status !== 'pending').length !== 1
              ? 'S'
              : ''}
          </div>
          {accounts
            .filter((a) => a.status !== 'pending')
            .map((a) => (
              <div
                key={a.id}
                style={{
                  ...S.card,
                  margin: '0 16px 8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  opacity: a.status === 'rejected' ? 0.6 : 1,
                }}
              >
                <div style={S.avatar}>
                  {a.display_name
                    .split(' ')
                    .map((w) => w[0])
                    .join('')
                    .slice(0, 2)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>
                    {a.display_name}
                  </div>
                  <div style={{ fontSize: 10, color: '#475569' }}>
                    @{a.username} ·{' '}
                    {
                      bookings.filter(
                        (b) => b.user_display_name === a.display_name
                      ).length
                    }{' '}
                    bookings
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      gap: 4,
                      marginTop: 4,
                      flexWrap: 'wrap',
                    }}
                  >
                    {a.is_admin && (
                      <span
                        style={{
                          ...S.pill,
                          background: '#FB923C22',
                          color: '#FB923C',
                        }}
                      >
                        ⚙ Admin
                      </span>
                    )}
                    {a.status === 'rejected' && (
                      <span
                        style={{
                          ...S.pill,
                          background: '#EF444422',
                          color: '#EF4444',
                        }}
                      >
                        ✕ Rejected
                      </span>
                    )}
                    {a.id === currentAccount.id && (
                      <span
                        style={{
                          ...S.pill,
                          background: '#38BDF822',
                          color: '#38BDF8',
                        }}
                      >
                        you
                      </span>
                    )}
                  </div>
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 5,
                    flexShrink: 0,
                  }}
                >
                  {!a.is_admin && a.status !== 'rejected' && (
                    <button
                      onClick={() => onPromote(a.id)}
                      style={{
                        ...S.pill,
                        background: '#FB923C22',
                        color: '#FB923C',
                        cursor: 'pointer',
                        border: 'none',
                        fontSize: 10,
                      }}
                    >
                      ↑ Admin
                    </button>
                  )}
                  {a.status === 'rejected' && a.id !== currentAccount.id && (
                    <button
                      onClick={() => onApprove(a.id)}
                      style={{
                        ...S.pill,
                        background: '#22C55E22',
                        color: '#22C55E',
                        cursor: 'pointer',
                        border: 'none',
                        fontSize: 10,
                      }}
                    >
                      ✓ Approve
                    </button>
                  )}
                  {a.id !== currentAccount.id && (
                    <button
                      onClick={() =>
                        setConfirmDelete({
                          type: 'user',
                          id: a.id,
                          name: a.display_name,
                        })
                      }
                      style={{
                        ...S.pill,
                        background: '#EF444422',
                        color: '#EF4444',
                        cursor: 'pointer',
                        border: 'none',
                        fontSize: 10,
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}
        </>
      )}

      {/* ── STATS TAB ── */}
      {tab === 'stats' && (
        <>
          <div
            style={{
              ...S.card,
              margin: '0 16px 12px',
              display: 'flex',
              justifyContent: 'space-around',
              textAlign: 'center',
            }}
          >
            {[
              { v: bookings.length, l: 'Bookings', c: '#38BDF8' },
              { v: instruments.length, l: 'Instruments', c: '#4ADE80' },
              { v: accounts.length, l: 'Members', c: '#FB923C' },
            ].map((s) => (
              <div key={s.l}>
                <div style={{ fontSize: 26, fontWeight: 800, color: s.c }}>
                  {s.v}
                </div>
                <div style={{ fontSize: 10, color: '#475569' }}>{s.l}</div>
              </div>
            ))}
          </div>
          <Section label="TOP INSTRUMENTS">
            {instStats.map((i) => (
              <div
                key={i.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginBottom: 8,
                }}
              >
                <span
                  style={{
                    ...S.iconBubble,
                    background: i.color + '22',
                    color: i.color,
                    fontSize: 14,
                    width: 32,
                    height: 32,
                  }}
                >
                  {i.icon}
                </span>
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginBottom: 3,
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 600 }}>
                      {i.name}
                    </span>
                    <span style={{ fontSize: 11, color: i.color }}>
                      {i.count}
                    </span>
                  </div>
                  <div
                    style={{
                      height: 4,
                      background: '#1E293B',
                      borderRadius: 2,
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${
                          instStats[0].count > 0
                            ? (i.count / instStats[0].count) * 100
                            : 0
                        }%`,
                        height: '100%',
                        background: i.color,
                        borderRadius: 2,
                        transition: 'width .6s ease',
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </Section>
          <Section label="TOP USERS">
            {userStats.map((u) => (
              <div
                key={u.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginBottom: 8,
                }}
              >
                <div style={S.avatar}>
                  {u.display_name
                    .split(' ')
                    .map((w) => w[0])
                    .join('')
                    .slice(0, 2)}
                </div>
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginBottom: 3,
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 600 }}>
                      {u.display_name}
                    </span>
                    <span style={{ fontSize: 11, color: '#38BDF8' }}>
                      {u.count}
                    </span>
                  </div>
                  <div
                    style={{
                      height: 4,
                      background: '#1E293B',
                      borderRadius: 2,
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${
                          userStats[0].count > 0
                            ? (u.count / userStats[0].count) * 100
                            : 0
                        }%`,
                        height: '100%',
                        background: '#38BDF8',
                        borderRadius: 2,
                        transition: 'width .6s ease',
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </Section>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOTIFS VIEW
// ═══════════════════════════════════════════════════════════════════════════════
function NotifsView({ notifs, onBack, onClear }) {
  return (
    <div className="view">
      <SubHeader
        title="Notifications"
        subtitle={`${notifs.length} messages`}
        onBack={onBack}
        rightEl={
          <button
            onClick={onClear}
            style={{
              fontSize: 11,
              color: '#EF4444',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Clear all
          </button>
        }
      />
      {notifs.length === 0 && (
        <div style={{ ...S.empty, margin: '32px 16px' }}>
          No notifications yet
        </div>
      )}
      {notifs.map((n) => (
        <div key={n.id} style={{ ...S.card, margin: '0 16px 8px' }}>
          <div style={{ fontSize: 13 }}>{n.msg}</div>
          <div style={{ fontSize: 10, color: '#334155', marginTop: 4 }}>
            {n.ts}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Shared components ────────────────────────────────────────────────────────
function Section({ label, children }) {
  return (
    <div style={{ padding: '4px 16px 12px' }}>
      <div style={S.sectionLabel}>{label}</div>
      {children}
    </div>
  );
}
function SubHeader({ title, subtitle, color, onBack, rightEl }) {
  return (
    <div style={S.subHeader}>
      <button className="backBtn" onClick={onBack}>
        ←
      </button>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 16, fontWeight: 800 }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize: 11, color: color ?? '#64748B' }}>
            {subtitle}
          </div>
        )}
      </div>
      {rightEl}
    </div>
  );
}
function FieldLabel({ children }) {
  var t = useT();
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 1.3,
        color: t.textLow,
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}
function Chip({ icon, children }) {
  return (
    <span style={S.chip}>
      {icon} {children}
    </span>
  );
}

function BottomNav({ view, navigate, notifCount, isAdmin }) {
  const tabs = [
    { id: 'home', icon: '⊞', label: 'Home' },
    { id: 'schedule', icon: '📆', label: 'Schedule' },
    { id: 'newBooking', icon: '＋', label: 'Book', highlight: true },
    { id: 'myBookings', icon: '📋', label: 'Mine' },
    isAdmin
      ? { id: 'admin', icon: '⚙', label: 'Admin' }
      : { id: 'profile', icon: '👤', label: 'Profile' },
  ];
  return (
    <div style={S.bottomNav}>
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => navigate(t.id)}
          style={{
            ...S.navBtn,
            ...(view === t.id ? S.navBtnActive : {}),
            ...(t.highlight ? { color: '#38BDF8' } : {}),
          }}
        >
          <span style={{ fontSize: t.highlight ? 22 : 18, lineHeight: 1 }}>
            {t.icon}
          </span>
          <span style={{ fontSize: 9, marginTop: 2 }}>{t.label}</span>
          {t.id === 'profile' && notifCount > 0 && (
            <span style={S.navBadge}>{notifCount}</span>
          )}
        </button>
      ))}
    </div>
  );
}
function Toast({ msg, type }) {
  const bg =
    type === 'error' ? '#EF4444' : type === 'warn' ? '#F59E0B' : '#22C55E';
  return <div style={{ ...S.toast, background: bg }}>{msg}</div>;
}

// ─── Theme palettes ────────────────────────────────────────────────────────────
const DARK = {
  bg0: '#0B1628',
  bg1: '#152135',
  bg2: '#1E3A5F',
  border: '#1E3A5F',
  border2: '#2A4A6B',
  text: '#E2E8F0',
  textMid: '#94A3B8',
  textLow: '#475569',
  textFaint: '#2A4A6B',
  accent: '#38BDF8',
  accentText: '#000',
  inputBg: '#0B1628',
  dropdownBg: '#152135',
  shadow: '0 20px 40px rgba(0,0,0,0.5)',
  calInvert: 'invert(0.3) sepia(1) saturate(2) hue-rotate(180deg)',
  hourLine: 'rgba(255,255,255,0.05)',
};
const LIGHT = {
  bg0: '#F0F4F8',
  bg1: '#FFFFFF',
  bg2: '#E2EBF6',
  border: '#C8D9EE',
  border2: '#A8C0E0',
  text: '#0F172A',
  textMid: '#334155',
  textLow: '#64748B',
  textFaint: '#CBD5E1',
  accent: '#0284C7',
  accentText: '#FFFFFF',
  inputBg: '#F8FAFC',
  dropdownBg: '#FFFFFF',
  shadow: '0 20px 40px rgba(0,0,0,0.15)',
  calInvert: 'none',
  hourLine: 'rgba(0,0,0,0.15)',
};

const ThemeCtx = React.createContext(DARK);
function useT() {
  return React.useContext(ThemeCtx);
}

function makeS(t) {
  return {
    shell: {
      width: '100vw',
      height: '100svh',
      background: t.bg0,
      borderRadius: 0,
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: "'IBM Plex Sans','SF Pro Text',-apple-system,sans-serif",
      color: t.text,
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      margin: 0,
    },
    statusBar: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '14px 24px 6px',
      background: t.bg0,
      flexShrink: 0,
    },
    content: { flex: 1, overflowY: 'auto', overflowX: 'hidden' },
    header: {
      padding: '14px 20px 10px',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
    },
    subHeader: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '12px 16px 10px',
    },
    sectionLabel: {
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: 1.8,
      color: t.accent,
      marginBottom: 10,
      opacity: 0.7,
    },
    card: {
      background: t.bg1,
      borderRadius: 12,
      padding: '12px 14px',
      border: '1px solid ' + t.border,
    },
    statCard: {
      background: t.bg1,
      borderRadius: 12,
      padding: '12px 14px',
      border: '1px solid ' + t.border,
    },
    grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
    iconBubble: {
      width: 40,
      height: 40,
      borderRadius: 12,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 20,
    },
    avatar: {
      width: 36,
      height: 36,
      borderRadius: '50%',
      background: t.bg2,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 13,
      fontWeight: 800,
      color: t.accent,
      flexShrink: 0,
    },
    pill: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      fontSize: 9,
      fontWeight: 700,
      padding: '3px 8px',
      borderRadius: 20,
      whiteSpace: 'nowrap',
    },
    filterPill: {
      padding: '6px 12px',
      borderRadius: 20,
      fontSize: 11,
      fontWeight: 700,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      flexShrink: 0,
    },
    timeTag: {
      background: t.bg0,
      borderRadius: 6,
      padding: '4px 7px',
      fontSize: 11,
      color: t.textMid,
      textAlign: 'right',
      lineHeight: 1.6,
      flexShrink: 0,
    },
    chip: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      background: t.bg2,
      borderRadius: 7,
      padding: '4px 8px',
      fontSize: 11,
      color: t.textMid,
    },
    empty: {
      textAlign: 'center',
      color: t.textLow,
      fontSize: 13,
      padding: '24px 0',
    },
    formCard: {
      margin: '8px 16px 16px',
      background: t.bg1,
      borderRadius: 16,
      padding: '16px',
      border: '1px solid ' + t.border,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    },
    input: {
      width: '100%',
      background: t.inputBg,
      border: '1px solid ' + t.border,
      borderRadius: 10,
      color: t.text,
      fontSize: 14,
      padding: '10px 12px',
      boxSizing: 'border-box',
      outline: 'none',
      fontFamily: 'inherit',
    },
    dropdownBtn: {
      width: '100%',
      background: t.bg1,
      border: '1px solid ' + t.border,
      borderRadius: 12,
      color: t.text,
      padding: '11px 14px',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      cursor: 'pointer',
      marginBottom: 4,
    },
    dropdown: {
      position: 'absolute',
      top: '100%',
      left: 0,
      right: 0,
      background: t.dropdownBg,
      border: '1px solid ' + t.border,
      borderRadius: 12,
      zIndex: 100,
      overflow: 'hidden',
      boxShadow: t.shadow,
    },
    dropdownItem: {
      width: '100%',
      padding: '11px 14px',
      border: 'none',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      color: t.text,
      textAlign: 'left',
      fontFamily: 'inherit',
    },
    suggBtn: {
      fontSize: 10,
      color: t.accent,
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      fontWeight: 700,
      padding: 0,
      marginBottom: 6,
    },
    conflictBanner: {
      background: '#EF444418',
      border: '1px solid #EF444433',
      borderRadius: 10,
      padding: '10px 14px',
      color: '#EF4444',
      fontSize: 12,
      fontWeight: 600,
    },
    submitBtn: {
      padding: '13px',
      borderRadius: 12,
      border: 'none',
      fontWeight: 800,
      fontSize: 14,
      cursor: 'pointer',
      transition: 'opacity 0.2s',
      fontFamily: 'inherit',
    },
    bottomNav: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      background: t.bg0,
      borderTop: '1px solid ' + t.border,
      display: 'flex',
      paddingBottom: 20,
    },
    navBtn: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '10px 0 0',
      background: 'none',
      border: 'none',
      color: t.textFaint,
      cursor: 'pointer',
      fontSize: 9,
      fontFamily: 'inherit',
      position: 'relative',
      transition: 'color 0.15s',
    },
    navBtnActive: { color: t.accent },
    navBadge: {
      position: 'absolute',
      top: 6,
      right: 'calc(50% - 14px)',
      background: '#EF4444',
      color: '#fff',
      borderRadius: '50%',
      width: 14,
      height: 14,
      fontSize: 8,
      fontWeight: 800,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
    toast: {
      position: 'absolute',
      bottom: 92,
      left: 16,
      right: 16,
      borderRadius: 12,
      padding: '12px 16px',
      color: '#fff',
      fontWeight: 700,
      fontSize: 13,
      textAlign: 'center',
      animation: 'slideUp 0.3s ease',
      zIndex: 200,
    },
    authWrap: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0 28px',
      background: t.bg0,
      overflowY: 'auto',
    },
    authLogo: { textAlign: 'center', marginBottom: 32 },
    authLogoIcon: {
      width: 68,
      height: 68,
      borderRadius: 22,
      background: 'linear-gradient(135deg,' + t.bg1 + ',' + t.bg2 + ')',
      border: '1px solid ' + t.border,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 32,
      margin: '0 auto',
      boxShadow: '0 8px 32px ' + t.accent + '33',
    },
    authTabs: {
      display: 'flex',
      width: '100%',
      background: t.bg1,
      borderRadius: 14,
      padding: 4,
      border: '1px solid ' + t.border,
      marginBottom: 20,
    },
    authTab: {
      flex: 1,
      padding: '10px 0',
      borderRadius: 11,
      border: 'none',
      fontSize: 13,
      fontWeight: 700,
      cursor: 'pointer',
      fontFamily: 'inherit',
      background: 'transparent',
      color: t.textLow,
      transition: 'all 0.2s',
    },
    authTabActive: { background: t.bg2, color: t.accent },
    authForm: {
      width: '100%',
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
    },
    authLabel: {
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: 1.4,
      color: t.textLow,
      marginBottom: 6,
    },
    authInput: {
      width: '100%',
      background: t.bg1,
      border: '1px solid ' + t.border,
      borderRadius: 12,
      color: t.text,
      fontSize: 15,
      padding: '13px 14px',
      boxSizing: 'border-box',
      outline: 'none',
      fontFamily: 'inherit',
      transition: 'border-color 0.2s',
    },
    authError: {
      background: '#EF444418',
      border: '1px solid #EF444433',
      borderRadius: 10,
      padding: '10px 14px',
      color: '#EF4444',
      fontSize: 12,
      fontWeight: 600,
      textAlign: 'center',
    },
    authSubmit: {
      background: t.accent,
      color: t.accentText,
      padding: '14px',
      borderRadius: 13,
      border: 'none',
      fontWeight: 800,
      fontSize: 15,
      cursor: 'pointer',
      fontFamily: 'inherit',
      width: '100%',
      transition: 'opacity 0.2s',
    },
  };
}

function makeCss(t) {
  return [
    "@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500&display=swap');",
    'html,body{width:100%;height:100%;margin:0;padding:0;overflow:hidden;background:' +
      t.bg0 +
      ';}',
    ".timeLabel{font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:500;color:" +
      t.textLow +
      ';letter-spacing:0.2px;}',
    '#root{width:100%;height:100%;}',
    '*{box-sizing:border-box;margin:0;padding:0;}',
    '::-webkit-scrollbar{display:none;}',
    '.noScroll{scrollbar-width:none;}',
    ".mono{font-family:'IBM Plex Mono',monospace;}",
    '.view{padding-bottom:100px;}',
    '.instCard{background:' +
      t.bg1 +
      ';border-radius:16px;padding:14px 12px;border:1px solid ' +
      t.border +
      ';animation:fadeUp 0.4s ease both;transition:transform 0.15s,border-color 0.15s;cursor:default;}',
    '.instCard:hover{transform:translateY(-2px);border-color:' +
      t.accent +
      ';}',
    '.iconBtn{width:44px;height:44px;border-radius:14px;border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:22px;font-weight:800;}',
    '.backBtn{background:' +
      t.bg1 +
      ';border:1px solid ' +
      t.border +
      ';color:' +
      t.textMid +
      ';font-size:18px;width:38px;height:38px;border-radius:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
    '.btnPri{border:none;font-weight:700;font-size:12px;cursor:pointer;border-radius:10px;padding:8px 0;font-family:inherit;color:' +
      t.accentText +
      ';}',
    '.btnSec{border:1px solid ' +
      t.border +
      ';background:transparent;color:' +
      t.textMid +
      ';font-weight:600;font-size:12px;cursor:pointer;border-radius:10px;padding:8px 0;font-family:inherit;}',
    '.inp:focus{border-color:' + t.accent + ' !important;}',
    '.authErr{animation:shake 0.35s ease;}',
    '.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(0,0,0,0.2);border-top-color:' +
      t.accentText +
      ';border-radius:50%;animation:spin 0.7s linear infinite;}',
    '.spinnerLg{width:36px;height:36px;border:3px solid ' +
      t.border +
      ';border-top-color:' +
      t.accent +
      ';border-radius:50%;animation:spin 0.8s linear infinite;}',
    'input[type=date]::-webkit-calendar-picker-indicator,input[type=time]::-webkit-calendar-picker-indicator{filter:' +
      t.calInvert +
      ';}',
    'select option{background:' + t.bg1 + ';}',
    '@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}',
    '@keyframes slideUp{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}',
    '@keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}',
    '@keyframes spin{to{transform:rotate(360deg)}}',
  ].join('\n');
}

let S = makeS(DARK);
