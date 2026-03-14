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
     * Get an employee's working hours for a date range.
     * Returns array of { date, start, end } where start/end are "HH:MM" strings.
     * Logs raw response so endpoint shape can be confirmed and adjusted.
     */
    async getWorkingHours(centerId, employeeId, startDate, endDate) {
      // Try the most common Zenoti working-hours endpoint pattern
      const path = `/employees/${encodeURIComponent(employeeId)}/working_hours`
        + `?center_id=${encodeURIComponent(centerId)}&start_date=${startDate}&end_date=${endDate}`;
      try {
        const data = await apiFetch(path);
        console.log('[Zenoti] getWorkingHours raw keys:', Object.keys(data || {}));
        console.log('[Zenoti] getWorkingHours sample:', JSON.stringify(data).slice(0, 400));
        // Normalize — Zenoti may return working_hours, schedule, shifts, or a root array
        const raw = Array.isArray(data.working_hours) ? data.working_hours
                  : Array.isArray(data.schedule)      ? data.schedule
                  : Array.isArray(data.shifts)        ? data.shifts
                  : Array.isArray(data)               ? data
                  : [];
        return raw.map(d => ({
          date:  d.date  || d.work_date || d.day || '',
          start: d.start || d.start_time || d.from || d.open_time  || '09:00',
          end:   d.end   || d.end_time   || d.to  || d.close_time  || '17:00',
        }));
      } catch (e) {
        console.warn('[Zenoti] getWorkingHours failed:', e.message);
        return [];
      }
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
