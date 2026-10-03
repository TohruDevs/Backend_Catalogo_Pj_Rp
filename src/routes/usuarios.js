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

// PUT /api/usuarios/:id (solo administrador) body: { nombre, correo, contrasena, es_administrador }
// Todos los campos son opcionales; la contrasena solo cambia si se envia una nueva
router.put('/:id', asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const { nombre, correo, contrasena, es_administrador } = req.body;
  if (nombre !== undefined && !String(nombre).trim()) return res.status(400).json({ error: 'El nombre no puede estar vacio' });
  if (correo !== undefined && !String(correo).trim()) return res.status(400).json({ error: 'El correo no puede estar vacio' });
  if (contrasena && contrasena.length < 6) return res.status(400).json({ error: 'La contrasena debe tener minimo 6 caracteres' });

  const actual = (await db.query('SELECT es_administrador FROM usuario WHERE id = $1', [id])).rows[0];
  if (!actual) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (es_administrador === false && actual.es_administrador) {
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM usuario WHERE es_administrador = TRUE');
    if (rows[0].n <= 1) return res.status(400).json({ error: 'Debe quedar al menos un administrador' });
  }

  const hash = contrasena ? await bcrypt.hash(contrasena, 10) : null;
  const { rows } = await db.query(
    `UPDATE usuario SET
       nombre = COALESCE($1, nombre),
       correo = COALESCE($2, correo),
       contrasena_hash = COALESCE($3, contrasena_hash),
       es_administrador = COALESCE($4, es_administrador)
     WHERE id = $5
     RETURNING id, nombre, correo, es_administrador`,
    [nombre === undefined ? null : String(nombre).trim(),
     correo === undefined ? null : String(correo).trim().toLowerCase(),
     hash, typeof es_administrador === 'boolean' ? es_administrador : null, id]
  );
  await registrar(req.usuario.id, 'usuario.editar',
    `Editó al usuario "${rows[0].nombre}"` + (hash ? ' (cambió su contraseña)' : ''));
  res.json(rows[0]);
}));

module.exports = router;