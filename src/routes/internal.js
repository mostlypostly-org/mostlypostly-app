// src/routes/internal.js
// Internal API — used by ChairlyOS to sync stylist data
import { Router } from 'express';
import db from '../../db.js';

const router = Router();

// Protected by x-internal-secret header matching CHAIRLY_INTERNAL_SECRET env var
router.get('/stylists/:salonSlug', (req, res) => {
  const secret = req.headers['x-internal-secret'];
  if (!secret || secret !== process.env.CHAIRLY_INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const salon = db.prepare('SELECT slug FROM salons WHERE slug = ?').get(req.params.salonSlug);
  if (!salon) return res.status(404).json({ error: 'Salon not found' });

  const stylists = db.prepare(
    'SELECT id, name, phone, photo_url, instagram_handle, specialties FROM stylists WHERE salon_id = ? ORDER BY name'
  ).all(req.params.salonSlug);

  // Parse specialties JSON before returning
  const result = stylists.map(s => ({
    ...s,
    specialties: (() => { try { return JSON.parse(s.specialties || '[]'); } catch { return []; } })(),
  }));

  res.json(result);
});

export default router;
