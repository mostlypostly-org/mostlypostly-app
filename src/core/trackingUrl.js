// src/core/trackingUrl.js
import crypto from 'crypto';
import { db } from '../../db.js';

const BASE_URL = () => (process.env.PUBLIC_BASE_URL || 'https://app.mostlypostly.com').replace(/\/$/, '');

function randomToken() {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

export function buildTrackingToken({ salonId, postId = null, clickType, vendorName = null, utmContent = null, utmTerm = null, destination }) {
  const token = randomToken();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO utm_clicks (id, token, salon_id, post_id, click_type, vendor_name, utm_content, utm_term, destination, created_at)
    VALUES (@id, @token, @salon_id, @post_id, @click_type, @vendor_name, @utm_content, @utm_term, @destination, @created_at)
  `).run({ id: crypto.randomUUID(), token, salon_id: salonId, post_id: postId, click_type: clickType, vendor_name: vendorName, utm_content: utmContent, utm_term: utmTerm, destination, created_at: now });
  return token;
}

export function buildShortUrl(token) {
  return `${BASE_URL()}/t/${token}`;
}

export function buildBioUrl(salonSlug) {
  return `${BASE_URL()}/t/${salonSlug}/book`;
}
