const router = require('express').Router();
const db = require('../db');
const { asyncH, registrar } = require('../utils');
const { verificarToken, soloAdmin } = require('../middleware/auth');

// Epocas disponibles. Para agregar otra (por ejemplo navidad) se anade aqui y en el frontend
const EPOCAS = { halloween: 'Halloween', navidad: 'Navidad', genshin: 'Genshin Impact' };

// GET /api/configuracion (publico) -> { epoca: 'halloween' | null }
router.get('/', asyncH(async (req, res) => {
  const { rows } = await db.query("SELECT valor FROM configuracion WHERE clave = 'epoca'");
  res.json({ epoca: rows[0] && EPOCAS[rows[0].valor] ? rows[0].valor : null });
}));

// PUT /api/configuracion/epoca (solo administrador) body: { epoca: 'halloween' | null }
router.put('/epoca', verificarToken, soloAdmin, asyncH(async (req, res) => {
  const epoca = req.body.epoca || null;
  if (epoca !== null && !EPOCAS[epoca]) return res.status(400).json({ error: 'Epoca no valida' });
  if (epoca === null) {
    await db.query("DELETE FROM configuracion WHERE clave = 'epoca'");
  } else {
    await db.query(
      `INSERT INTO configuracion (clave, valor) VALUES ('epoca', $1)
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
      [epoca]
    );
  }
  await registrar(req.usuario.id, 'config.epoca',
    epoca ? `Activó la decoración de ${EPOCAS[epoca]}` : 'Desactivó la decoración de época');
  res.json({ epoca });
}));

module.exports = router;