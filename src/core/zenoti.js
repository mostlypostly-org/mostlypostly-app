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
      // GET /v1/Centers/{centerId}/employee_schedules
      const qs = `?start_date=${startDate}&end_date=${endDate}`;
      try {
        const data = await apiFetch(
          `/Centers/${encodeURIComponent(centerId)}/employee_schedules${qs}`
        );
        console.log('[Zenoti] employee_schedules raw keys:', Object.keys(data || {}));
        console.log('[Zenoti] employee_schedules sample:', JSON.stringify(data).slice(0, 600));

        // Normalize root — may be { employee_schedules: [...] }, { schedules: [...] }, or root array
        const raw = Array.isArray(data.employee_schedules) ? data.employee_schedules
                  : Array.isArray(data.schedules)          ? data.schedules
                  : Array.isArray(data)                    ? data
                  : [];

        // Find this employee's record (contains nested schedules array)
        const empRecord = raw.find(r =>
          (r.employee_id || r.therapist_id || r.id || '').toLowerCase() === employeeId.toLowerCase()
        );
        console.log(`[Zenoti] employee_schedules: ${raw.length} total, ${empRecord ? 'found' : 'not found'} for employee ${employeeId}`);

        if (empRecord && Array.isArray(empRecord.schedules)) {
          const results = [];
          for (const daySchedule of empRecord.schedules) {
            if (!Array.isArray(daySchedule.shifts) || !daySchedule.shifts.length) continue;
            const shift = daySchedule.shifts[0];
            // status -1 = day off / not scheduled
            if (shift.status === -1) continue;
            const dateStr = (daySchedule.date || '').slice(0, 10);
            // start_time/end_time are ISO datetimes: "2026-03-14T10:00:00"
            const start = (shift.start_time || '').slice(11, 16);
            const end   = (shift.end_time   || '').slice(11, 16);
            if (dateStr && start && end) {
              results.push({ date: dateStr, start, end });
              console.log(`[Zenoti] ${dateStr} shift: ${start}–${end}`);
            }
          }
          return results;
        }
      } catch (e) {
        console.warn('[Zenoti] employee_schedules failed:', e.message.slice(0, 120));
      }

      console.warn('[Zenoti] getWorkingHours: no shift data — will use salon hours as fallback');
      return [];
    },

    /**
     * Get the service catalog for a center, grouped by category.
     * Returns array of { categoryName, minDurationMin } — the minimum duration
     * of any service in that category is the threshold for block matching.
     * Also returns raw services for appointment-to-category mapping.
     */
    async getServiceCatalog(centerId) {
      try {
        // Fetch up to 200 services with category expansion
        const data = await apiFetch(
          `/Centers/${encodeURIComponent(centerId)}/services?size=200&expand=category_id`
        );
        console.log('[Zenoti] services raw keys:', Object.keys(data || {}));
        const raw = Array.isArray(data.services) ? data.services
                  : Array.isArray(data)           ? data
                  : [];
        console.log(`[Zenoti] services: ${raw.length} total`);
        if (raw.length) {
          // Log all keys of first service so we can see the exact field names
          console.log('[Zenoti] service[0] keys:', Object.keys(raw[0]));
          console.log('[Zenoti] service[0] sample:', JSON.stringify(raw[0]).slice(0, 400));
        }

        // Infer category from service name via keyword matching.
        // Zenoti doesn't expose category_name in this endpoint so we derive it.
        function inferCategory(name) {
          const n = (name || '').toLowerCase();
          if (n.includes('highlight') || n.includes('balayage') || n.includes('ombre')
              || n.includes('foil') || n.includes('blonding') || n.includes('bleach')
              || n.includes('lightener')) return 'Highlights';
          if (n.includes('color') || n.includes('colour') || n.includes('tint')
              || n.includes('gloss') || n.includes('toner')) return 'Color';
          if (n.includes('haircut') || n.includes('cut') || n.includes('trim')
              || n.includes('shampoo & style')) return 'Haircut';
          if (n.includes('blowout') || n.includes('blow dry') || n.includes('blow-dry')
              || n.includes('style') || n.includes('press')) return 'Blowout';
          if (n.includes('treatment') || n.includes('mask') || n.includes('bond')
              || n.includes('keratin') || n.includes('perm') || n.includes('relaxer')) return 'Treatment';
          if (n.includes('extension')) return 'Extensions';
          return null;
        }

        // Practical minimum block sizes per category — what a client actually needs
        // to book that type of service. Catalog minimums are too low (15min toners, etc.)
        // and don't reflect realistic booking windows worth advertising.
        const PRACTICAL_MINS = {
          'Extensions': 180,
          'Highlights':  90,
          'Color':       60,
          'Haircut':     45,
          'Blowout':     30,
          'Treatment':   30,
        };

        // Build category map using practical thresholds, not catalog minimums.
        // We still use the catalog to know which categories this salon offers.
        const categoryMap = {};
        for (const svc of raw) {
          const cat = inferCategory(svc.name);
          if (!cat || categoryMap[cat]) continue; // first match per category is enough
          categoryMap[cat] = { categoryName: cat, minDurationMin: PRACTICAL_MINS[cat] ?? 30 };
        }

        const categories = Object.values(categoryMap).filter(c => c.minDurationMin > 0);
        console.log('[Zenoti] service categories:', categories.length
          ? categories.map(c => `${c.categoryName}(${c.minDurationMin}min)`).join(', ')
          : '(none inferred — check service names)');

        // Name→category lookup for mapping appointment service names to categories
        const serviceNameToCategory = {};
        for (const svc of raw) {
          const cat = inferCategory(svc.name);
          if (svc.name && cat) serviceNameToCategory[svc.name.toLowerCase()] = cat;
        }

        return { categories, serviceNameToCategory };
      } catch (e) {
        console.warn('[Zenoti] getServiceCatalog failed:', e.message.slice(0, 120));
        return { categories: [], serviceNameToCategory: {} };
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
