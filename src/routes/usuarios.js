const router = require('express').Router();
const db = require('../db');
const { asyncH } = require('../utils');
const { verificarToken, soloAdmin } = require('../middleware/auth');

router.use(verificarToken, soloAdmin);

// GET /api/usuarios (solo administrador) -> para elegir a quien agregar a un grupo
router.get('/', asyncH(async (req, res) => {
  const { rows } = await db.query('SELECT id, nombre, correo, es_administrador FROM usuario ORDER BY nombre');
  res.json(rows);
}));

module.exports = router;