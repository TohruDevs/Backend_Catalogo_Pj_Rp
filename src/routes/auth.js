const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { asyncH } = require('../utils');
const { verificarToken } = require('../middleware/auth');

// POST /api/auth/registro  (siempre crea un usuario normal, nunca administrador)
router.post('/registro', asyncH(async (req, res) => {
  const { nombre, correo, contrasena } = req.body;
  if (!nombre || !correo || !contrasena || contrasena.length < 6) {
    return res.status(400).json({ error: 'nombre, correo y contrasena (minimo 6 caracteres) son obligatorios' });
  }
  const hash = await bcrypt.hash(contrasena, 10);
  const { rows } = await db.query(
    `INSERT INTO usuario (nombre, correo, contrasena_hash)
     VALUES ($1, $2, $3)
     RETURNING id, nombre, correo, es_administrador`,
    [nombre, correo.toLowerCase(), hash]
  );
  res.status(201).json(rows[0]);
}));

// POST /api/auth/login
router.post('/login', asyncH(async (req, res) => {
  const { correo, contrasena } = req.body;
  if (!correo || !contrasena) {
    return res.status(400).json({ error: 'correo y contrasena son obligatorios' });
  }
  const { rows } = await db.query('SELECT * FROM usuario WHERE correo = $1', [correo.toLowerCase()]);
  const usuario = rows[0];
  if (!usuario || !(await bcrypt.compare(contrasena, usuario.contrasena_hash))) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }
  const token = jwt.sign({ id: usuario.id }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.json({
    token,
    usuario: { id: usuario.id, nombre: usuario.nombre, correo: usuario.correo, es_administrador: usuario.es_administrador },
  });
}));

// GET /api/auth/me
router.get('/me', verificarToken, (req, res) => res.json(req.usuario));

module.exports = router;
