const router = require('express').Router();
const db = require('../db');
const { asyncH, puedeAccederGrupo, registrar } = require('../utils');
const { verificarToken, soloAdmin } = require('../middleware/auth');
const tokenOpcional = require('../middleware/tokenOpcional');

// Nombres del usuario y del grupo para el historial
async function nombres(idUsuario, idGrupo) {
  const { rows } = await db.query(
    `SELECT (SELECT nombre FROM usuario WHERE id = $1) AS usuario,
            (SELECT nombre FROM grupo_rol WHERE id = $2) AS grupo`,
    [idUsuario, idGrupo]
  );
  return rows[0];
}

// GET /api/grupos (publico)
router.get('/', asyncH(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM grupo_rol WHERE eliminado_en IS NULL ORDER BY nombre');
  res.json(rows);
}));

// POST /api/grupos (solo administrador)
router.post('/', verificarToken, soloAdmin, asyncH(async (req, res) => {
  const { nombre, descripcion } = req.body;
  if (!nombre) return res.status(400).json({ error: 'nombre es obligatorio' });
  const { rows } = await db.query(
    'INSERT INTO grupo_rol (nombre, descripcion, id_creador) VALUES ($1, $2, $3) RETURNING *',
    [nombre, descripcion || null, req.usuario.id]
  );
  await registrar(req.usuario.id, 'grupo.crear', `Creó el grupo "${rows[0].nombre}"`);
  res.status(201).json(rows[0]);
}));

// PUT /api/grupos/:id (solo administrador) body: { nombre, descripcion }
router.put('/:id', verificarToken, soloAdmin, asyncH(async (req, res) => {
  const { nombre, descripcion } = req.body;
  if (nombre !== undefined && !String(nombre).trim()) {
    return res.status(400).json({ error: 'El nombre no puede estar vacio' });
  }
  const { rows } = await db.query(
    `UPDATE grupo_rol SET nombre = COALESCE($1, nombre), descripcion = COALESCE($2, descripcion)
     WHERE id = $3 AND eliminado_en IS NULL RETURNING *`,
    [nombre === undefined ? null : String(nombre).trim(), descripcion, Number(req.params.id)]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Grupo no encontrado' });
  await registrar(req.usuario.id, 'grupo.editar', `Editó el grupo "${rows[0].nombre}"`);
  res.json(rows[0]);
}));

// DELETE /api/grupos/:id (solo administrador) -> lo envia a la papelera (se puede restaurar)
router.delete('/:id', verificarToken, soloAdmin, asyncH(async (req, res) => {
  const { rows } = await db.query(
    'UPDATE grupo_rol SET eliminado_en = NOW() WHERE id = $1 AND eliminado_en IS NULL RETURNING nombre',
    [Number(req.params.id)]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Grupo no encontrado' });
  await registrar(req.usuario.id, 'grupo.eliminar', `Envió a la papelera el grupo "${rows[0].nombre}"`);
  res.status(204).end();
}));

// GET /api/grupos/:id (publico) -> grupo + personajes con sus imagenes
router.get('/:id', tokenOpcional, asyncH(async (req, res) => {
  const idGrupo = Number(req.params.id);
  const grupo = await db.query('SELECT * FROM grupo_rol WHERE id = $1 AND eliminado_en IS NULL', [idGrupo]);
  if (!grupo.rows[0]) return res.status(404).json({ error: 'Grupo no encontrado' });

  // Visitantes: solo aprobados. Jugador: aprobados + los suyos. Administrador: todos.
  let cond = "p.estado = 'aprobado'";
  const params = [idGrupo];
  if (req.usuario && req.usuario.es_administrador) cond = 'TRUE';
  else if (req.usuario) { cond = "(p.estado = 'aprobado' OR p.id_jugador = $2)"; params.push(req.usuario.id); }

  const personajes = await db.query(
    `SELECT p.id, p.nombre, p.descripcion, p.estado, p.motivo_rechazo,
            u.id AS id_universo_origen, u.nombre AS universo_origen,
            j.id AS id_jugador, j.nombre AS jugador,
            COALESCE((SELECT json_agg(i.url ORDER BY i.orden, i.id)
                      FROM imagen_personaje i WHERE i.id_personaje = p.id), '[]'::json) AS imagenes
     FROM personaje p
     JOIN universo_origen u ON u.id = p.id_universo_origen
     JOIN usuario j ON j.id = p.id_jugador
     WHERE p.id_grupo = $1 AND p.eliminado_en IS NULL AND ${cond}
     ORDER BY p.nombre`,
    params
  );
  res.json({ ...grupo.rows[0], personajes: personajes.rows });
}));

// GET /api/grupos/:id/miembros (miembros del grupo o administrador; incluye correos)
router.get('/:id/miembros', verificarToken, asyncH(async (req, res) => {
  const idGrupo = Number(req.params.id);
  if (!(await puedeAccederGrupo(req.usuario, idGrupo))) {
    return res.status(403).json({ error: 'No perteneces a este grupo' });
  }
  const { rows } = await db.query(
    `SELECT u.id, u.nombre, u.correo, m.fecha_ingreso
     FROM miembro_grupo m JOIN usuario u ON u.id = m.id_usuario
     WHERE m.id_grupo = $1 ORDER BY u.nombre`,
    [idGrupo]
  );
  res.json(rows);
}));

// POST /api/grupos/:id/miembros (solo administrador) body: { id_usuario }
router.post('/:id/miembros', verificarToken, soloAdmin, asyncH(async (req, res) => {
  const { id_usuario } = req.body;
  if (!id_usuario) return res.status(400).json({ error: 'id_usuario es obligatorio' });
  const { rows } = await db.query(
    `INSERT INTO miembro_grupo (id_usuario, id_grupo, agregado_por)
     VALUES ($1, $2, $3) RETURNING *`,
    [id_usuario, Number(req.params.id), req.usuario.id]
  );
  const n = await nombres(id_usuario, Number(req.params.id));
  await registrar(req.usuario.id, 'miembro.agregar', `Agregó a ${n.usuario} al grupo "${n.grupo}"`);
  res.status(201).json(rows[0]);
}));

// DELETE /api/grupos/:id/miembros/:idUsuario (solo administrador)
router.delete('/:id/miembros/:idUsuario', verificarToken, soloAdmin, asyncH(async (req, res) => {
  const { rowCount } = await db.query(
    'DELETE FROM miembro_grupo WHERE id_grupo = $1 AND id_usuario = $2',
    [Number(req.params.id), Number(req.params.idUsuario)]
  );
  if (!rowCount) return res.status(404).json({ error: 'Miembro no encontrado' });
  const n = await nombres(Number(req.params.idUsuario), Number(req.params.id));
  await registrar(req.usuario.id, 'miembro.quitar', `Quitó a ${n.usuario} del grupo "${n.grupo}"`);
  res.status(204).end();
}));

module.exports = router;