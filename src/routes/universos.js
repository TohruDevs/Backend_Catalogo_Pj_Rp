const router = require('express').Router();
const db = require('../db');
const { asyncH } = require('../utils');
const { verificarToken } = require('../middleware/auth');

// GET /api/universos (publico)
router.get('/', asyncH(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM universo_origen ORDER BY nombre');
  res.json(rows);
}));

// POST /api/universos (requiere sesion)
router.post('/', verificarToken, asyncH(async (req, res) => {
  const { nombre, descripcion } = req.body;
  if (!nombre) return res.status(400).json({ error: 'nombre es obligatorio' });
  const { rows } = await db.query(
    'INSERT INTO universo_origen (nombre, descripcion) VALUES ($1, $2) RETURNING *',
    [nombre, descripcion || null]
  );
  res.status(201).json(rows[0]);
}));

module.exports = router;