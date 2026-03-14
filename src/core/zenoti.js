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
      console.log('[Zenoti] getEmployees raw response keys:', Object.keys(data || {}));
      // Zenoti may return employees under different keys depending on version
      const raw = Array.isArray(data.employees)  ? data.employees
               : Array.isArray(data.therapists)  ? data.therapists
               : Array.isArray(data.staff)        ? data.staff
               : Array.isArray(data)              ? data
               : [];
      console.log(`[Zenoti] getEmployees found ${raw.length} employees`);
      return raw.map(e => ({
        id:    e.id    || e.employee_id || e.therapist_id || '',
        name:  e.name  || [e.first_name, e.last_name].filter(Boolean).join(' ') || e.display_name || '',
        email: e.email || '',
      }));
    },

    /**
     * Get an employee's working hours for a date range using the center attendance endpoint.
     * GET /v1/centers/{centerId}/attendance?date={date} — one call per day.
     * Returns array of { date, start, end } where start/end are "HH:MM" strings.
     */
    async getWorkingHours(centerId, employeeId, startDate, endDate) {
      const results = [];

      // Enumerate each date in the range
      const start = new Date(startDate + 'T00:00:00');
      const end   = new Date(endDate   + 'T00:00:00');
      const dates = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        dates.push(d.toISOString().slice(0, 10));
      }

      // Only log first date to avoid flooding logs
      let logged = false;
      for (const dateStr of dates) {
        try {
          const data = await apiFetch(
            `/centers/${encodeURIComponent(centerId)}/attendance?date=${dateStr}`
          );
          if (!logged) {
            console.log(`[Zenoti] attendance raw keys (${dateStr}):`, Object.keys(data || {}));
            console.log(`[Zenoti] attendance sample (${dateStr}):`, JSON.stringify(data).slice(0, 500));
            logged = true;
          }
          // Response is an array of attendance records (one per employee)
          const records = Array.isArray(data) ? data
                        : Array.isArray(data.attendance) ? data.attendance
                        : Array.isArray(data.employees)  ? data.employees
                        : [];
          if (!logged) console.log(`[Zenoti] attendance records found: ${records.length}`);
          const record = records.find(r =>
            (r.employee_id || r.id || '').toLowerCase() === employeeId.toLowerCase()
          );
          if (!record) {
            if (records.length > 0 && !logged) {
              console.log(`[Zenoti] attendance first record keys:`, Object.keys(records[0]));
            }
            continue; // employee not scheduled this day
          }

          const start = record.expected_check_in_time  || record.check_in_time  || record.start_time || '';
          const end   = record.expected_check_out_time || record.check_out_time || record.end_time   || '';
          if (!start || !end) continue;

          results.push({ date: dateStr, start, end });
          console.log(`[Zenoti] ${dateStr} shift: ${start}–${end}`);
        } catch (e) {
          console.warn(`[Zenoti] attendance fetch failed for ${dateStr}: ${e.message.slice(0, 120)}`);
        }
      }

      if (!results.length) {
        console.warn('[Zenoti] getWorkingHours: no shift data found — will use salon hours as fallback');
      }
      return results;
    },

    /**
     * Get booked appointments for an employee over a date range.
     * Returns raw appointment array — calculateOpenBlocks handles normalization.
     */
    async getAppointments(centerId, employeeId, startDate, endDate) {
      const path = `/appointments`
        + `?center_id=${encodeURIComponent(centerId)}`
        + `&therapist_id=${encodeURIComponent(employeeId)}`
        + `&start_date=${startDate}&end_date=${endDate}`;
      try {
        const data = await apiFetch(path);
        console.log('[Zenoti] getAppointments raw keys:', Object.keys(data || {}));
        console.log('[Zenoti] getAppointments sample:', JSON.stringify(data).slice(0, 400));
        const raw = Array.isArray(data.appointments) ? data.appointments
                  : Array.isArray(data.bookings)     ? data.bookings
                  : Array.isArray(data)              ? data
                  : [];
        console.log(`[Zenoti] getAppointments found ${raw.length} appointments`);
        return raw;
      } catch (e) {
        console.warn('[Zenoti] getAppointments failed:', e.message);
        return [];
      }
    },
  };
}
