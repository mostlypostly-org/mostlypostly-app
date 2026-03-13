// src/core/zenoti.js — Zenoti POS API client

const ZENOTI_BASE = 'https://api.zenoti.com/v1';

/**
 * Create a Zenoti API client bound to a specific app_id and api secret.
 * Auth header: Authorization: apikey {apiSecret}
 */
export function createZenotiClient(appId, apiKey) {
  const headers = {
    'Authorization': `apikey ${apiKey}`,
    'application_id': appId,
    'Content-Type': 'application/json',
  };

  async function apiFetch(path) {
    const url = `${ZENOTI_BASE}${path}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Zenoti API error ${res.status}: ${text}`);
    }
    return res.json();
  }

  return {
    /**
     * Test connectivity by fetching the centers list.
     * Returns { ok: true, centers } on success, throws on failure.
     */
    async testConnection() {
      const data = await apiFetch('/centers');
      const centers = Array.isArray(data.centers) ? data.centers : (Array.isArray(data) ? data : []);
      return { ok: true, centers };
    },

    /**
     * Get all centers for this account.
     * Returns array of { id, name, city }.
     */
    async getCenters() {
      const data = await apiFetch('/centers');
      const raw = Array.isArray(data.centers) ? data.centers : (Array.isArray(data) ? data : []);
      return raw.map(c => ({
        id:   c.id   || c.center_id || '',
        name: c.name || c.display_name || '',
        city: c.city || (c.address && c.address.city) || '',
      }));
    },

    /**
     * Get employees (stylists/therapists) for a center.
     * Returns array of { id, name, email }.
     */
    async getEmployees(centerId) {
      const data = await apiFetch(`/catalog/employees?center_id=${encodeURIComponent(centerId)}`);
      const raw = Array.isArray(data.employees) ? data.employees : (Array.isArray(data) ? data : []);
      return raw.map(e => ({
        id:    e.id    || e.employee_id || '',
        name:  e.name  || [e.first_name, e.last_name].filter(Boolean).join(' ') || '',
        email: e.email || '',
      }));
    },

    /**
     * Get available appointment slots for an employee on a given date.
     * dateStr format: YYYY-MM-DD
     * Returns array of time strings (e.g. "09:00", "09:30").
     */
    async getAvailableSlots(centerId, employeeId, dateStr) {
      const path = `/appointments/v1/slots?center_id=${encodeURIComponent(centerId)}&therapist_id=${encodeURIComponent(employeeId)}&date=${encodeURIComponent(dateStr)}`;
      const data = await apiFetch(path);
      const raw = Array.isArray(data.slots) ? data.slots : (Array.isArray(data) ? data : []);
      return raw.map(s => {
        if (typeof s === 'string') return s;
        return s.time || s.start_time || s.slot_time || String(s);
      });
    },
  };
}
