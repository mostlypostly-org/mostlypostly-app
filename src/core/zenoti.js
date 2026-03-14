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
      // Try GET /v1/employees/{id}/schedules (same base URL as the POST update endpoint)
      const qs = `?center_id=${encodeURIComponent(centerId)}&start_date=${startDate}&end_date=${endDate}`;
      try {
        const data = await apiFetch(`/employees/${encodeURIComponent(employeeId)}/schedules${qs}`);
        console.log('[Zenoti] schedules raw keys:', Object.keys(data || {}));
        console.log('[Zenoti] schedules sample:', JSON.stringify(data).slice(0, 500));

        // Normalize — response may be { schedules: [...] } or a root array
        const raw = Array.isArray(data.schedules) ? data.schedules
                  : Array.isArray(data.shifts)    ? data.shifts
                  : Array.isArray(data)            ? data
                  : [];

        if (raw.length) {
          return raw.map(d => {
            // Each entry may have nested shifts array or flat start/end
            const shift = Array.isArray(d.shifts) && d.shifts[0] ? d.shifts[0] : d;
            const dateStr = (d.date || d.work_date || '').slice(0, 10);
            const start   = (shift.start_time || shift.start || shift.from || '').slice(11, 16) || (shift.start_time || shift.start || '').slice(0, 5);
            const end     = (shift.end_time   || shift.end   || shift.to   || '').slice(11, 16) || (shift.end_time   || shift.end   || '').slice(0, 5);
            return { date: dateStr, start, end };
          }).filter(d => d.date && d.start && d.end);
        }
      } catch (e) {
        console.warn('[Zenoti] schedules endpoint failed:', e.message.slice(0, 120));
      }

      // Fallback: try center-level schedules filtered by employee
      try {
        const data = await apiFetch(
          `/centers/${encodeURIComponent(centerId)}/employees/schedules${qs}`
        );
        console.log('[Zenoti] center schedules raw keys:', Object.keys(data || {}));
        console.log('[Zenoti] center schedules sample:', JSON.stringify(data).slice(0, 500));
      } catch (e) {
        console.warn('[Zenoti] center schedules endpoint failed:', e.message.slice(0, 120));
      }

      console.warn('[Zenoti] getWorkingHours: no shift data found — will use salon hours as fallback');
      return [];
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
