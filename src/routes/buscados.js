const router = require('express').Router();
const db = require('../db');
const { asyncH, puedeModerar, registrar } = require('../utils');
const { verificarToken } = require('../middleware/auth');

const IMAGENES = `COALESCE((SELECT json_agg(i.url ORDER BY i.orden, i.id)
                  FROM imagen_buscado i WHERE i.id_buscado = b.id), '[]'::json) AS imagenes`;
const BASE = `SELECT b.id, b.id_grupo, b.nombre, b.descripcion, b.id_universo_origen, b.creado_en,
                     u.nombre AS universo_origen, g.nombre AS grupo, b.id_usuario, usr.nombre AS usuario, ${IMAGENES}
              FROM personaje_buscado b
              JOIN universo_origen u ON u.id = b.id_universo_origen
              JOIN grupo_rol g ON g.id = b.id_grupo AND g.eliminado_en IS NULL
              LEFT JOIN usuario usr ON usr.id = b.id_usuario`;

// Carga un personaje buscado (con el usuario al que esta asignado, si lo tiene)
const cargarBuscado = async (id) =>
  (await db.query(`${BASE} WHERE b.id = $1`, [id])).rows[0];

// Valida la lista de enlaces: maximo 10, solo http(s). undefined = no se envio
function validarImagenes(lista) {
  if (lista === undefined) return { urls: undefined };
  if (!Array.isArray(lista) || lista.length > 10) {
    return { error: 'imagenes debe ser una lista de maximo 10 enlaces' };
  }
  const urls = [];
  for (const u of lista) {
    const s = String(u).trim();
    if (!s) continue;
    let ok = false;
    try { ok = ['http:', 'https:'].includes(new URL(s).protocol); } catch { ok = false; }
    if (!ok) return { error: `Enlace de imagen invalido: ${s}` };
    urls.push(s);
  }
  return { urls };
}

async function conTransaccion(fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function guardarImagenes(client, idBuscado, urls) {
  await client.query('DELETE FROM imagen_buscado WHERE id_buscado = $1', [idBuscado]);
  if (urls.length) {
    await client.query(
      `INSERT INTO imagen_buscado (id_buscado, url, orden)
       SELECT $1, u, o - 1 FROM unnest($2::text[]) WITH ORDINALITY AS t(u, o)`,
      [idBuscado, urls]
    );
  }
}

// GET /api/buscados?grupo=ID (publico) -> personajes buscados de un grupo (primero los que no tienen usuario)
router.get('/', asyncH(async (req, res) => {
  const idGrupo = Number(req.query.grupo);
  if (!Number.isInteger(idGrupo)) return res.status(400).json({ error: 'Falta el parametro grupo' });
  const { rows } = await db.query(
    `${BASE} WHERE b.id_grupo = $1 ORDER BY (b.id_usuario IS NOT NULL), b.nombre`,
    [idGrupo]
  );
  res.json(rows);
}));

// POST /api/buscados (administrador o moderador del grupo)
router.post('/', verificarToken, asyncH(async (req, res) => {
  const { id_grupo, nombre, descripcion, id_universo_origen, imagenes } = req.body;
  if (!id_grupo || !nombre || !String(nombre).trim() || !id_universo_origen) {
    return res.status(400).json({ error: 'id_grupo, nombre e id_universo_origen son obligatorios' });
  }
  const idGrupo = Number(id_grupo);
  if (!(await puedeModerar(req.usuario, idGrupo))) {
    return res.status(403).json({ error: 'Solo un administrador o un moderador del grupo puede hacer esto' });
  }
  const g = await db.query('SELECT nombre FROM grupo_rol WHERE id = $1 AND eliminado_en IS NULL', [idGrupo]);
  if (!g.rows[0]) return res.status(404).json({ error: 'Grupo no encontrado' });
  const v = validarImagenes(imagenes);
  if (v.error) return res.status(400).json({ error: v.error });

  const id = await conTransaccion(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO personaje_buscado (id_grupo, nombre, descripcion, id_universo_origen, creado_por)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [idGrupo, String(nombre).trim(), descripcion || null, id_universo_origen, req.usuario.id]
    );
    if (v.urls && v.urls.length) await guardarImagenes(client, rows[0].id, v.urls);
    return rows[0].id;
  });
  await registrar(req.usuario.id, 'buscado.crear',
    `Agregó el personaje buscado "${String(nombre).trim()}" al grupo "${g.rows[0].nombre}"`);
  res.status(201).json(await cargarBuscado(id));
}));

// PUT /api/buscados/:id (administrador o moderador del grupo)
router.put('/:id', verificarToken, asyncH(async (req, res) => {
  const b = await cargarBuscado(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Personaje buscado no encontrado' });
  if (!(await puedeModerar(req.usuario, b.id_grupo))) {
    return res.status(403).json({ error: 'Solo un administrador o un moderador del grupo puede hacer esto' });
  }
  const { nombre, descripcion, id_universo_origen, imagenes } = req.body;
  if (nombre !== undefined && !String(nombre).trim()) {
    return res.status(400).json({ error: 'El nombre no puede estar vacio' });
  }
  const v = validarImagenes(imagenes);
  if (v.error) return res.status(400).json({ error: v.error });

  await conTransaccion(async (client) => {
    await client.query(
      `UPDATE personaje_buscado SET
         nombre = COALESCE($1, nombre),
         descripcion = COALESCE($2, descripcion),
         id_universo_origen = COALESCE($3, id_universo_origen)
       WHERE id = $4`,
      [nombre === undefined ? null : String(nombre).trim(), descripcion, id_universo_origen, b.id]
    );
    if (v.urls !== undefined) await guardarImagenes(client, b.id, v.urls);
  });
  await registrar(req.usuario.id, 'buscado.editar', `Editó el personaje buscado "${b.nombre}" del grupo "${b.grupo}"`);
  res.json(await cargarBuscado(b.id));
}));

// DELETE /api/buscados/:id (administrador o moderador del grupo)
router.delete('/:id', verificarToken, asyncH(async (req, res) => {
  const b = await cargarBuscado(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Personaje buscado no encontrado' });
  if (!(await puedeModerar(req.usuario, b.id_grupo))) {
    return res.status(403).json({ error: 'Solo un administrador o un moderador del grupo puede hacer esto' });
  }
  await db.query('DELETE FROM personaje_buscado WHERE id = $1', [b.id]);
  await registrar(req.usuario.id, 'buscado.eliminar', `Quitó el personaje buscado "${b.nombre}" del grupo "${b.grupo}"`);
  res.status(204).end();
}));

// POST /api/buscados/:id/asignar body: { id_usuario } (null = quitar la asignacion)
// El personaje buscado se queda en la lista de buscados, asignado a un usuario miembro del grupo
router.post('/:id/asignar', verificarToken, asyncH(async (req, res) => {
  const b = await cargarBuscado(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Personaje buscado no encontrado' });
  if (!(await puedeModerar(req.usuario, b.id_grupo))) {
    return res.status(403).json({ error: 'Solo un administrador o un moderador del grupo puede hacer esto' });
  }
  const idUsuario = req.body.id_usuario == null ? null : Number(req.body.id_usuario);
  let nombreUsuario = null;
  if (idUsuario !== null) {
    const { rows } = await db.query(
      `SELECT u.nombre FROM miembro_grupo m JOIN usuario u ON u.id = m.id_usuario
       WHERE m.id_grupo = $1 AND m.id_usuario = $2`,
      [b.id_grupo, idUsuario]
    );
    if (!rows[0]) return res.status(400).json({ error: 'El usuario debe ser miembro del grupo' });
    nombreUsuario = rows[0].nombre;
  }
  await db.query(
    'UPDATE personaje_buscado SET id_usuario = $1, asignado_en = CASE WHEN $1::int IS NULL THEN NULL ELSE NOW() END WHERE id = $2',
    [idUsuario, b.id]
  );
  await registrar(req.usuario.id, idUsuario ? 'buscado.asignar' : 'buscado.liberar',
    idUsuario ? `Asignó el personaje buscado "${b.nombre}" a ${nombreUsuario} en el grupo "${b.grupo}"`
              : `Quitó la asignación del personaje buscado "${b.nombre}" en el grupo "${b.grupo}"`);
  res.json(await cargarBuscado(b.id));
}));

module.exports = router;