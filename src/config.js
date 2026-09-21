import 'dotenv/config';

const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
const list = (v, d) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);

// Approximate centres of Kano neighbourhoods — override with AREA_COORDS.
const DEFAULT_COORDS = {
  kabuga: [11.955, 8.54],
  hotoro: [11.995, 8.58],
  tarauni: [11.976, 8.548],
  'sabon gari': [12.0, 8.517],
};

function parseCoords(raw) {
  const out = { ...DEFAULT_COORDS };
  for (const part of (raw || '').split(';')) {
    const [name, lat, lng] = part.split(':').map((s) => s.trim());
    if (name && !Number.isNaN(Number(lat)) && !Number.isNaN(Number(lng))) {
      out[name.toLowerCase()] = [Number(lat), Number(lng)];
    }
  }
  return out;
}

const ALL_CATEGORIES = ['power', 'water', 'network', 'delivery', 'other'];
const categories = list(env.SUPPORTED_CATEGORIES, ALL_CATEGORIES).filter((c) => ALL_CATEGORIES.includes(c));
if (!categories.includes('other')) categories.push('other');

export const config = {
  businessName: env.BUSINESS_NAME || 'Korafi',
  ussdCode: env.USSD_CODE || '*384*1234#',
  senderId: env.SMS_SENDER_ID || '',
  language: env.DEFAULT_LANGUAGE === 'en' ? 'en' : 'ha',
  reward: num(env.DEFAULT_REWARD, 50),
  currency: env.REWARD_CURRENCY || 'NGN',
  maxRewardsPerDay: num(env.MAX_REWARDS_PER_PHONE_PER_DAY, 3),
  areas: list(env.SUPPORTED_AREAS, ['Kabuga', 'Hotoro', 'Tarauni', 'Sabon Gari']),
  areaCoords: parseCoords(env.AREA_COORDS),
  categories,
  mapCenter: [11.9964, 8.5167],
  countryCode: env.DEFAULT_COUNTRY_CODE || '+234',
  incident: {
    threshold: num(env.INCIDENT_THRESHOLD, 3),
    windowMinutes: num(env.INCIDENT_WINDOW_MINUTES, 20),
  },
  at: {
    username: env.AT_USERNAME || 'sandbox',
    apiKey: env.AT_API_KEY || '',
    voiceNumber: env.AT_VOICE_NUMBER || '',
    get sandbox() {
      return (env.AT_USERNAME || 'sandbox') === 'sandbox';
    },
    get live() {
      return Boolean(env.AT_API_KEY);
    },
  },
  publicUrl: (env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
  port: num(env.PORT, 3000),
  databaseUrl: env.DATABASE_URL || '',
  dashboardPassword: env.DASHBOARD_PASSWORD || 'korafi-demo',
  sessionSecret: env.SESSION_SECRET || 'korafi-dev-secret',
  webhookKey: env.WEBHOOK_KEY || '',
  isProd: env.NODE_ENV === 'production',
};

export function areaCoords(area) {
  const hit = config.areaCoords[String(area).toLowerCase()];
  if (hit) return hit;
  // Deterministic scatter around the map centre for areas without coordinates.
  let h = 0;
  for (const ch of String(area)) h = (h * 31 + ch.charCodeAt(0)) % 1000;
  return [config.mapCenter[0] + ((h % 40) - 20) / 400, config.mapCenter[1] + ((Math.floor(h / 7) % 40) - 20) / 400];
}
