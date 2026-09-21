import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const AX = 'http://127.0.0.1:3198';

function getSigningSecret() {
  const keysFile = process.env.KEYWIRE_KEYS_FILE || path.join('C:', 'Users', 'User', 'Downloads', 'Uplift', 'Keywire', 'data', 'keywire-keys.json');
  if (fs.existsSync(keysFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(keysFile, 'utf8').replace(/^\uFEFF/, ''));
      if (typeof parsed?.jwtSecret === 'string' && parsed.jwtSecret) return parsed.jwtSecret;
    } catch { /* unreadable key file — fall through to the emergency key */ }
  }
  const emergencyPath = process.env.AXIOM_EMERGENCY_KEY_FILE || path.join(process.env.USERPROFILE || '', '.axiom', 'emergency-key.json');
  if (fs.existsSync(emergencyPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(emergencyPath, 'utf8'));
      if (typeof parsed?.key === 'string' && parsed.key) return parsed.key;
    } catch { /* corrupt emergency key — no secret available */ }
  }
  return '';
}

function mint() {
  const secret = getSigningSecret();
  if (!secret) return '';
  const nowS = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'openhub-audit', iss: 'axiom-agent', aud: 'axiom-api', iat: nowS, exp: nowS + 3600 })).toString('base64url');
  const input = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${sig}`;
}

const token = mint();
if (!token) {
  console.log('NO_TOKEN — could not resolve signing secret (keywire/emergency key missing)');
  process.exit(0);
}

const targetDir = path.join('C:', 'Users', 'User', 'Downloads', 'Uplift', 'Deepseek Harness', 'Axiom Agent', 'openhub');
const res = await fetch(`${AX}/api/harness/deep-audit`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ targetDir }),
});

console.log('HTTP', res.status);
const body = await res.text();
console.log(body.slice(0, 3000));
