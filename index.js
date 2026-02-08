/* eslint-disable linebreak-style */
const bodyParser = require('body-parser');
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use((req, res, next) => {
  const start = Date.now();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[HTTP] ${res.statusCode} ${req.method} ${req.originalUrl} ${ms}ms ip=${ip}`);
  });
  next();
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db.json');
const TOKEN_ENC_KEY_B64 = process.env.TOKEN_ENC_KEY_B64 || '';

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sha256Base64Url(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('base64url');
}

function randomToken() {
  return base64url(crypto.randomBytes(32));
}

function ensureEncKey() {
  if (!TOKEN_ENC_KEY_B64) return null;
  const key = Buffer.from(TOKEN_ENC_KEY_B64, 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENC_KEY_B64 must be 32 bytes base64');
  return key;
}

const encKey = ensureEncKey();

function encryptString(plain) {
  if (!encKey) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function decryptString(enc) {
  if (!encKey) return enc;
  const raw = Buffer.from(enc, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `${salt.toString('base64')}:${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 2) return false;
  const salt = Buffer.from(parts[0], 'base64');
  const expected = Buffer.from(parts[1], 'base64');
  const actual = crypto.scryptSync(password, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function nowIso() {
  return new Date().toISOString();
}

function readDbFile() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data.users) data.users = [];
    if (!data.groups) data.groups = [];
    if (!data.groupMembers) data.groupMembers = [];
    return data;
  } catch {
    return { users: [], groups: [], groupMembers: [] };
  }
}

function writeDbFile(db) {
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_PATH);
}

const db = readDbFile();

function findUserByUsername(username) {
  const u = String(username || '').trim();
  if (!u) return null;
  return db.users.find((x) => x.username.toLowerCase() === u.toLowerCase()) || null;
}

function findUserByToken(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  const th = sha256Base64Url(t);
  return db.users.find((x) => x.tokenHash === th) || null;
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'missing_token' });
  const user = findUserByToken(m[1]);
  if (!user) return res.status(401).json({ error: 'invalid_token' });
  req.user = user;
  next();
}

function isMember(userId, groupId) {
  return db.groupMembers.some((m) => m.userId === userId && m.groupId === groupId);
}

function getMemberRole(userId, groupId) {
  const m = db.groupMembers.find((x) => x.userId === userId && x.groupId === groupId);
  return m ? m.role : null;
}

function getGroupById(groupId) {
  return db.groups.find((g) => g.id === groupId) || null;
}

function ensureDefaultGroupForUser(user) {
  const existing = db.groups.find((g) => g.isDefault === true && g.ownerUserId === user.id);
  if (existing) {
    const role = getMemberRole(user.id, existing.id);
    if (role !== 'owner') {
      db.groupMembers = db.groupMembers.filter((m) => !(m.userId === user.id && m.groupId === existing.id));
      db.groupMembers.push({ groupId: existing.id, userId: user.id, role: 'owner' });
      writeDbFile(db);
      console.log(`[DB] ensureDefaultGroupForUser fixed owner membership user=${user.username} groupId=${existing.id}`);
    }
    return existing;
  }

  const id = crypto.randomUUID();
  const name = `${user.username}LinkedGroup`;
  const group = {
    id, name, ownerUserId: user.id, isDefault: true,
  };
  db.groups.push(group);
  db.groupMembers.push({ groupId: id, userId: user.id, role: 'owner' });
  writeDbFile(db);
  console.log(`[DB] ensureDefaultGroupForUser created default group user=${user.username} groupId=${id}`);
  return group;
}

function groupFlagsForUser(userId, group) {
  const role = getMemberRole(userId, group.id);
  const isOwner = role === 'owner' && group.ownerUserId === userId;
  const isDefault = group.isDefault === true && group.ownerUserId === userId;
  return {
    isDefault,
    role,
    canLeave: role === 'member',
    canRename: isOwner && !isDefault,
    canDelete: isOwner && !isDefault,
    canManageMembers: isOwner,
  };
}
function generateTempPassword() {
  return crypto.randomBytes(9).toString('base64url');
}

function getSmtpConfig() {
  const host = process.env.SMTP_HOST || '';
  const port = parseInt(process.env.SMTP_PORT || '0', 10);
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  const from = process.env.SMTP_FROM || '';
  return {
    host, port, secure, user, pass, from,
  };
}

function smtpReady(cfg) {
  return !!(cfg.host && cfg.port && cfg.user && cfg.pass && cfg.from);
}

async function sendResetEmail(toEmail, username, newPassword) {
  const cfg = getSmtpConfig();
  if (!smtpReady(cfg)) throw new Error('smtp_not_configured');

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  const subject = 'LinkedLamp - Password recovery';
  const text = `Hello ${username},\n\nYour new password is:\n\n${newPassword}\n\nYou can change it later from the app.\n`;

  await transporter.sendMail({
    from: cfg.from,
    to: toEmail,
    subject,
    text,
  });
}

app.post('/register', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const email = req.body?.email ? String(req.body.email).trim() : null;

  console.log(`[API] register attempt username=${username || '(empty)'}`);

  if (!username) return res.status(400).json({ error: 'missing_username' });
  if (!password) return res.status(400).json({ error: 'missing_password' });
  if (findUserByUsername(username)) {
    console.log(`[API] register conflict username=${username}`);
    return res.status(409).json({ error: 'username_taken' });
  }

  const userId = crypto.randomUUID();
  const token = randomToken();
  const user = {
    id: userId,
    username,
    passwordHash: hashPassword(password),
    email: email || null,
    tokenHash: sha256Base64Url(token),
    tokenEnc: encryptString(token),
    createdAt: nowIso(),
  };

  db.users.push(user);
  ensureDefaultGroupForUser(user);
  writeDbFile(db);

  console.log(`[API] register success username=${username} userId=${userId}`);
  res.json({ token });
});

app.post('/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  console.log(`[API] login attempt username=${username || '(empty)'}`);

  if (!username) return res.status(400).json({ error: 'missing_username' });
  if (!password) return res.status(400).json({ error: 'missing_password' });

  const user = findUserByUsername(username);
  if (!user) {
    console.log(`[API] login invalid username=${username}`);
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  if (!verifyPassword(password, user.passwordHash)) {
    console.log(`[API] login invalid password username=${username}`);
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  ensureDefaultGroupForUser(user);
  writeDbFile(db);

  const token = decryptString(user.tokenEnc);
  console.log(`[API] login success username=${username} userId=${user.id}`);
  res.json({ token });
});
app.post('/forgot-password', async (req, res) => {
  const username = String(req.body?.username || '').trim();

  console.log(`[API] forgot password attempt username=${username || '(empty)'}`);

  if (!username) return res.status(400).json({ error: 'missing_username' });

  const user = findUserByUsername(username);
  if (!user) {
    console.log(`[API] forgot password user not found username=${username}`);
    return res.status(404).json({ error: 'user_not_found' });
  }

  const email = user.email ? String(user.email).trim() : '';
  if (!email) {
    console.log(`[API] forgot password email not set username=${username}`);
    return res.status(400).json({ error: 'email_not_set' });
  }

  const newPassword = generateTempPassword();
  user.passwordHash = hashPassword(newPassword);
  writeDbFile(db);

  try {
    await sendResetEmail(email, user.username, newPassword);
    console.log(`[API] forgot password success username=${username} email=${email}`);
    res.json({ ok: true });
  } catch (e) {
    console.log(`[API] forgot password email send failed username=${username} err=${e && e.message ? e.message : String(e)}`);
    res.status(500).json({ error: 'email_send_failed' });
  }
});

app.get('/groups', requireAuth, (req, res) => {
  console.log(`[API] groups list user=${req.user.username} userId=${req.user.id}`);

  const memberships = db.groupMembers.filter((m) => m.userId === req.user.id);
  const groups = memberships
    .map((m) => getGroupById(m.groupId))
    .filter(Boolean)
    .map((g) => ({
      id: g.id,
      name: g.name,
      ownerUserId: g.ownerUserId,
      isDefault: g.isDefault === true,
      ...groupFlagsForUser(req.user.id, g),
    }));

  res.json({ groups });
});

app.post('/groups', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim();
  console.log(`[API] group create attempt user=${req.user.username} name=${name || '(empty)'}`);

  if (!name) return res.status(400).json({ error: 'missing_name' });

  const id = crypto.randomUUID();
  const group = {
    id, name, ownerUserId: req.user.id, isDefault: false,
  };
  db.groups.push(group);
  db.groupMembers.push({ groupId: id, userId: req.user.id, role: 'owner' });
  writeDbFile(db);

  console.log(`[API] group create success user=${req.user.username} groupId=${id} name=${name}`);
  res.json({
    group: {
      id: group.id,
      name: group.name,
      ownerUserId: group.ownerUserId,
      isDefault: false,
      ...groupFlagsForUser(req.user.id, group),
    },
  });
});

app.patch('/groups/:groupId', requireAuth, (req, res) => {
  const groupId = String(req.params.groupId || '');
  const group = getGroupById(groupId);
  const name = String(req.body?.name || '').trim();

  console.log(`[API] group rename attempt user=${req.user.username} groupId=${groupId} name=${name || '(empty)'}`);

  if (!group) return res.status(404).json({ error: 'group_not_found' });

  const role = getMemberRole(req.user.id, groupId);
  const isOwner = role === 'owner' && group.ownerUserId === req.user.id;
  if (!isOwner) return res.status(403).json({ error: 'forbidden' });
  if (group.isDefault === true) return res.status(403).json({ error: 'cannot_rename_default_group' });
  if (!name) return res.status(400).json({ error: 'missing_name' });

  group.name = name;
  writeDbFile(db);

  console.log(`[API] group rename success user=${req.user.username} groupId=${groupId} name=${name}`);
  res.json({
    group: {
      id: group.id,
      name: group.name,
      ownerUserId: group.ownerUserId,
      isDefault: group.isDefault === true,
      ...groupFlagsForUser(req.user.id, group),
    },
  });
});

app.delete('/groups/:groupId', requireAuth, (req, res) => {
  const groupId = String(req.params.groupId || '');
  const group = getGroupById(groupId);

  console.log(`[API] group delete attempt user=${req.user.username} groupId=${groupId}`);

  if (!group) return res.status(404).json({ error: 'group_not_found' });

  const role = getMemberRole(req.user.id, groupId);
  const isOwner = role === 'owner' && group.ownerUserId === req.user.id;
  if (!isOwner) return res.status(403).json({ error: 'forbidden' });
  if (group.isDefault === true) return res.status(403).json({ error: 'cannot_delete_default_group' });

  db.groupMembers = db.groupMembers.filter((m) => m.groupId !== groupId);
  db.groups = db.groups.filter((g) => g.id !== groupId);
  writeDbFile(db);

  console.log(`[API] group delete success user=${req.user.username} groupId=${groupId}`);
  res.json({ ok: true });
});

app.post('/groups/:groupId/members', requireAuth, (req, res) => {
  const groupId = String(req.params.groupId || '');
  const group = getGroupById(groupId);
  const username = String(req.body?.username || '').trim();

  console.log(`[API] member add attempt user=${req.user.username} groupId=${groupId} target=${username || '(empty)'}`);

  if (!group) return res.status(404).json({ error: 'group_not_found' });

  const role = getMemberRole(req.user.id, groupId);
  const isOwner = role === 'owner' && group.ownerUserId === req.user.id;
  if (!isOwner) return res.status(403).json({ error: 'forbidden' });

  if (!username) return res.status(400).json({ error: 'missing_username' });

  const target = findUserByUsername(username);
  if (!target) return res.status(404).json({ error: 'user_not_found' });

  if (isMember(target.id, groupId)) return res.status(409).json({ error: 'already_member' });

  db.groupMembers.push({ groupId, userId: target.id, role: 'member' });
  writeDbFile(db);

  console.log(`[API] member add success owner=${req.user.username} groupId=${groupId} target=${username}`);
  res.json({ ok: true });
});

app.post('/groups/:groupId/leave', requireAuth, (req, res) => {
  const groupId = String(req.params.groupId || '');
  const group = getGroupById(groupId);

  console.log(`[API] group leave attempt user=${req.user.username} groupId=${groupId}`);

  if (!group) return res.status(404).json({ error: 'group_not_found' });

  const role = getMemberRole(req.user.id, groupId);
  if (!role) return res.status(404).json({ error: 'not_a_member' });
  if (role === 'owner') return res.status(403).json({ error: 'owner_cannot_leave' });

  db.groupMembers = db.groupMembers.filter((m) => !(m.userId === req.user.id && m.groupId === groupId));
  writeDbFile(db);

  console.log(`[API] group leave success user=${req.user.username} groupId=${groupId}`);
  res.json({ ok: true });
});

app.delete('/me', requireAuth, (req, res) => {
  const userId = req.user.id;
  const { username } = req.user;

  console.log(`[API] delete account attempt user=${username} userId=${userId}`);

  const ownedGroupIds = db.groups
    .filter((g) => g.ownerUserId === userId)
    .map((g) => g.id);

  if (ownedGroupIds.length > 0) {
    db.groupMembers = db.groupMembers.filter((m) => !ownedGroupIds.includes(m.groupId));
    db.groups = db.groups.filter((g) => !ownedGroupIds.includes(g.id));
  }

  db.groupMembers = db.groupMembers.filter((m) => m.userId !== userId);
  db.users = db.users.filter((u) => u.id !== userId);

  writeDbFile(db);

  console.log(`[API] delete account success user=${username} userId=${userId} deletedGroups=${ownedGroupIds.length}`);
  res.json({ ok: true });
});

app.get('/groups/:groupId/members', requireAuth, (req, res) => {
  const groupId = String(req.params.groupId || '');
  const group = getGroupById(groupId);

  console.log(`[API] members list attempt user=${req.user.username} groupId=${groupId}`);

  if (!group) return res.status(404).json({ error: 'group_not_found' });

  const role = getMemberRole(req.user.id, groupId);
  const isOwner = role === 'owner' && group.ownerUserId === req.user.id;
  if (!isOwner) return res.status(403).json({ error: 'forbidden' });

  const members = db.groupMembers
    .filter((m) => m.groupId === groupId)
    .map((m) => {
      const u = db.users.find((x) => x.id === m.userId) || null;
      return {
        userId: m.userId,
        username: u ? u.username : null,
        role: m.role,
      };
    })
    .filter((x) => x.username !== null);

  console.log(`[API] members list success user=${req.user.username} groupId=${groupId} count=${members.length}`);
  res.json({ members });
});

app.delete('/groups/:groupId/members/:userId', requireAuth, (req, res) => {
  const groupId = String(req.params.groupId || '');
  const targetUserId = String(req.params.userId || '');
  const group = getGroupById(groupId);

  console.log(`[API] member remove attempt user=${req.user.username} groupId=${groupId} targetUserId=${targetUserId}`);

  if (!group) return res.status(404).json({ error: 'group_not_found' });

  const role = getMemberRole(req.user.id, groupId);
  const isOwner = role === 'owner' && group.ownerUserId === req.user.id;
  if (!isOwner) return res.status(403).json({ error: 'forbidden' });

  const targetRole = getMemberRole(targetUserId, groupId);
  if (!targetRole) return res.status(404).json({ error: 'not_a_member' });

  if (targetRole === 'owner') return res.status(403).json({ error: 'cannot_remove_owner' });

  db.groupMembers = db.groupMembers.filter((m) => !(m.groupId === groupId && m.userId === targetUserId));
  writeDbFile(db);

  const targetUser = db.users.find((u) => u.id === targetUserId) || null;
  console.log(`[API] member remove success owner=${req.user.username} groupId=${groupId} target=${targetUser ? targetUser.username : targetUserId}`);
  res.json({ ok: true });
});
app.post('/me/change-password', requireAuth, (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');

  console.log(`[API] change password attempt user=${req.user.username} userId=${req.user.id}`);

  if (!currentPassword) return res.status(400).json({ error: 'missing_current_password' });
  if (!newPassword) return res.status(400).json({ error: 'missing_new_password' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'new_password_too_short' });

  const user = db.users.find((u) => u.id === req.user.id) || null;
  if (!user) return res.status(401).json({ error: 'invalid_token' });

  if (!verifyPassword(currentPassword, user.passwordHash)) {
    console.log(`[API] change password invalid current password user=${req.user.username}`);
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  user.passwordHash = hashPassword(newPassword);
  writeDbFile(db);

  console.log(`[API] change password success user=${req.user.username} userId=${req.user.id}`);
  res.json({ ok: true });
});

class RuntimeGroup {
  constructor(id) {
    this.id = id;
    this.clients = new Set();
    this.hue = 0;
  }
}

const runtimeGroups = new Map();
const clientState = new Map();

function getRuntimeGroup(groupId) {
  if (!runtimeGroups.has(groupId)) runtimeGroups.set(groupId, new RuntimeGroup(groupId));
  return runtimeGroups.get(groupId);
}

function setHue(increase, group) {
  group.hue += increase ? 1 : -1;
  if (group.hue >= 256) group.hue = 0;
  else if (group.hue < 0) group.hue = 255;
}

function safeClose(ws, code, reason) {
  try { ws.close(code, reason); } catch { }
}

function wsPeer(ws) {
  try {
    const s = ws._socket;
    const ip = s && s.remoteAddress ? s.remoteAddress : '';
    const port = s && s.remotePort ? s.remotePort : '';
    return `${ip}:${port}`;
  } catch {
    return '';
  }
}

wss.on('connection', (ws) => {
  const peer = wsPeer(ws);
  console.log(`[WS] connect peer=${peer}`);

  let authed = false;
  let groupId = null;

  ws.once('message', (raw) => {
    try {
      const msg = raw.toString();
      let data = null;
      try {
        data = JSON.parse(msg);
      } catch {
        console.log(`[WS] auth parse error peer=${peer}`);
        return safeClose(ws, 1008, 'auth_error');
      }

      if (!data || data.type !== 'auth') {
        console.log(`[WS] auth required peer=${peer}`);
        return safeClose(ws, 1008, 'auth_required');
      }

      const token = String(data.token || '').trim();
      const gid = String(data.groupId || '').trim();
      if (!token || !gid) {
        console.log(`[WS] auth missing fields peer=${peer}`);
        return safeClose(ws, 1008, 'auth_required');
      }

      const user = findUserByToken(token);
      if (!user) {
        console.log(`[WS] auth invalid token peer=${peer}`);
        return safeClose(ws, 1008, 'invalid_token');
      }

      const group = getGroupById(gid);
      if (!group) {
        console.log(`[WS] auth group not found peer=${peer} user=${user.username} groupId=${gid}`);
        return safeClose(ws, 1008, 'group_not_found');
      }

      if (!isMember(user.id, gid)) {
        console.log(`[WS] auth not member peer=${peer} user=${user.username} groupId=${gid}`);
        return safeClose(ws, 1008, 'not_member');
      }

      authed = true;
      groupId = gid;

      const rt = getRuntimeGroup(groupId);
      rt.clients.add(ws);
      clientState.set(ws, groupId);

      console.log(`[WS] auth ok peer=${peer} user=${user.username} groupId=${groupId} groupName=${group.name}`);

      ws.send(JSON.stringify({ type: 'ok', hue: rt.hue }));

      ws.on('message', (m2) => {
        if (!authed) return;
        const m = m2.toString();
        if (m === '+') setHue(true, rt);
        else if (m === '-') setHue(false, rt);
        else {
          console.log(`[WS] message ignored peer=${peer} groupId=${groupId} payload=${m.slice(0, 200)}`);
          return;
        }

        const payload = JSON.stringify({ type: 'hue', hue: rt.hue });
        console.log(`[WS] hue peer=${peer} groupId=${groupId} hue=${rt.hue} clients=${rt.clients.size}`);
        for (const c of rt.clients) c.send(payload);
      });

      ws.on('close', (code, reason) => {
        const gid2 = clientState.get(ws);
        clientState.delete(ws);
        if (gid2 && runtimeGroups.has(gid2)) runtimeGroups.get(gid2).clients.delete(ws);
        console.log(`[WS] close peer=${peer} code=${code} reason=${String(reason || '')} groupId=${gid2 || ''}`);
      });

      ws.on('error', (err) => {
        console.log(`[WS] error peer=${peer} err=${err && err.message ? err.message : String(err)}`);
      });
    } catch (e) {
      console.log(`[WS] auth error peer=${peer} err=${e && e.message ? e.message : String(e)}`);
      safeClose(ws, 1008, 'auth_error');
    }
  });
});

server.listen(3000);
console.log(`[BOOT] server listening port=3000 dbPath=${DB_PATH} tokenEnc=${encKey ? 'aes-256-gcm' : 'plain'}`);
