const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { asyncH, registrar } = require('../utils');
const { verificarToken, soloAdmin } = require('../middleware/auth');

router.use(verificarToken, soloAdmin);

// GET /api/usuarios (solo administrador) -> para elegir a quien agregar a un grupo
router.get('/', asyncH(async (req, res) => {
  const { rows } = await db.query('SELECT id, nombre, correo, es_administrador FROM usuario ORDER BY nombre');
  res.json(rows);
}));

// POST /api/usuarios (solo administrador) body: { nombre, correo, contrasena, es_administrador }
router.post('/', asyncH(async (req, res) => {
  const { nombre, correo, contrasena, es_administrador } = req.body;
  if (!nombre || !correo || !contrasena || contrasena.length < 6) {
    return res.status(400).json({ error: 'nombre, correo y contrasena (minimo 6 caracteres) son obligatorios' });
  }
  const hash = await bcrypt.hash(contrasena, 10);
  const { rows } = await db.query(
    `INSERT INTO usuario (nombre, correo, contrasena_hash, es_administrador)
     VALUES ($1, $2, $3, $4) RETURNING id, nombre, correo, es_administrador`,
    [nombre.trim(), correo.trim().toLowerCase(), hash, es_administrador === true]
  );
  await registrar(req.usuario.id, 'usuario.crear',
    `Creó al usuario "${rows[0].nombre}"` + (rows[0].es_administrador ? ' (administrador)' : ''));
  res.status(201).json(rows[0]);
}));

module.exports = router;