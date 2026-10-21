const router = require('express').Router();
const db = require('../db');
const { asyncH, puedeModerar, registrar } = require('../utils');
const { verificarToken, soloAdmin } = require('../middleware/auth');
const tokenOpcional = require('../middleware/tokenOpcional');

const IMAGENES = `COALESCE((SELECT json_agg(i.url ORDER BY i.orden, i.id)
                  FROM imagen_zona i WHERE i.id_zona = z.id), '[]'::json) AS imagenes`;

const cargarZona = async (id) => (await db.query(
  `SELECT z.id, z.id_grupo, z.nombre, z.descripcion, g.nombre AS grupo, ${IMAGENES}
   FROM zona z JOIN grupo_rol g ON g.id = z.id_grupo AND g.eliminado_en IS NULL
   WHERE z.id = $1`,
  [id]
)).rows[0];

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

async function guardarImagenes(client, idZona, urls) {
  await client.query('DELETE FROM imagen_zona WHERE id_zona = $1', [idZona]);
  if (urls.length) {
    await client.query(
      `INSERT INTO imagen_zona (id_zona, url, orden)
       SELECT $1, u, o - 1 FROM unnest($2::text[]) WITH ORDINALITY AS t(u, o)`,
      [idZona, urls]
    );
  }
}

const sinPermiso = (res) =>
  res.status(403).json({ error: 'Solo un administrador o un moderador del grupo puede hacer esto' });

// ---- Zonas (van antes de /:idGrupo para que no se confundan las rutas) ----

// PUT /api/trama/zonas/:id (administrador o moderador del grupo)
router.put('/zonas/:id', verificarToken, asyncH(async (req, res) => {
  const z = await cargarZona(Number(req.params.id));
  if (!z) return res.status(404).json({ error: 'Zona no encontrada' });
  if (!(await puedeModerar(req.usuario, z.id_grupo))) return sinPermiso(res);
  const { nombre, descripcion, imagenes } = req.body;
  if (nombre !== undefined && !String(nombre).trim()) return res.status(400).json({ error: 'El nombre no puede estar vacio' });
  if (descripcion && String(descripcion).length > 5000) return res.status(400).json({ error: 'La descripcion es demasiado larga (maximo 5000 caracteres)' });
  const v = validarImagenes(imagenes);
  if (v.error) return res.status(400).json({ error: v.error });

  await conTransaccion(async (client) => {
    await client.query(
      `UPDATE zona SET nombre = COALESCE($1, nombre), descripcion = COALESCE($2, descripcion) WHERE id = $3`,
      [nombre === undefined ? null : String(nombre).trim(), descripcion, z.id]
    );
    if (v.urls !== undefined) await guardarImagenes(client, z.id, v.urls);
  });
  await registrar(req.usuario.id, 'zona.editar', `Editó la zona "${z.nombre}" del grupo "${z.grupo}"`);
  res.json(await cargarZona(z.id));
}));

// DELETE /api/trama/zonas/:id (administrador o moderador del grupo)
router.delete('/zonas/:id', verificarToken, asyncH(async (req, res) => {
  const z = await cargarZona(Number(req.params.id));
  if (!z) return res.status(404).json({ error: 'Zona no encontrada' });
  if (!(await puedeModerar(req.usuario, z.id_grupo))) return sinPermiso(res);
  await db.query('DELETE FROM zona WHERE id = $1', [z.id]);
  await registrar(req.usuario.id, 'zona.eliminar', `Eliminó la zona "${z.nombre}" del grupo "${z.grupo}"`);
  res.status(204).end();
}));

// ---- Trama del grupo ----

// GET /api/trama/:idGrupo (publico) -> trama + zonas con sus imagenes
router.get('/:idGrupo', tokenOpcional, asyncH(async (req, res) => {
  const idGrupo = Number(req.params.idGrupo);
  const g = (await db.query(
    'SELECT id, nombre, trama FROM grupo_rol WHERE id = $1 AND eliminado_en IS NULL', [idGrupo]
  )).rows[0];
  if (!g) return res.status(404).json({ error: 'Grupo no encontrado' });
  const zonas = await db.query(
    `SELECT z.id, z.nombre, z.descripcion, ${IMAGENES}
     FROM zona z WHERE z.id_grupo = $1 ORDER BY z.orden, z.id`,
    [idGrupo]
  );
  res.json({
    ...g,
    es_admin: !!(req.usuario && req.usuario.es_administrador),
    puede_gestionar_zonas: req.usuario ? await puedeModerar(req.usuario, idGrupo) : false,
    zonas: zonas.rows,
  });
}));

// PUT /api/trama/:idGrupo (solo administrador) body: { trama }
router.put('/:idGrupo', verificarToken, soloAdmin, asyncH(async (req, res) => {
  const trama = String(req.body.trama ?? '');
  if (trama.length > 20000) return res.status(400).json({ error: 'La trama es demasiado larga (maximo 20000 caracteres)' });
  const { rows } = await db.query(
    'UPDATE grupo_rol SET trama = $1 WHERE id = $2 AND eliminado_en IS NULL RETURNING nombre',
    [trama.trim() || null, Number(req.params.idGrupo)]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Grupo no encontrado' });
  await registrar(req.usuario.id, 'grupo.trama', `Editó la trama del grupo "${rows[0].nombre}"`);
  res.json({ ok: true });
}));

// POST /api/trama/:idGrupo/zonas (administrador o moderador del grupo)
router.post('/:idGrupo/zonas', verificarToken, asyncH(async (req, res) => {
  const idGrupo = Number(req.params.idGrupo);
  if (!(await puedeModerar(req.usuario, idGrupo))) return sinPermiso(res);
  const { nombre, descripcion, imagenes } = req.body;
  if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: 'nombre es obligatorio' });
  if (descripcion && String(descripcion).length > 5000) return res.status(400).json({ error: 'La descripcion es demasiado larga (maximo 5000 caracteres)' });
  const g = (await db.query('SELECT nombre FROM grupo_rol WHERE id = $1 AND eliminado_en IS NULL', [idGrupo])).rows[0];
  if (!g) return res.status(404).json({ error: 'Grupo no encontrado' });
  const v = validarImagenes(imagenes);
  if (v.error) return res.status(400).json({ error: v.error });

  const id = await conTransaccion(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO zona (id_grupo, nombre, descripcion, orden)
       VALUES ($1, $2, $3, COALESCE((SELECT MAX(orden) + 1 FROM zona WHERE id_grupo = $1), 0)) RETURNING id`,
      [idGrupo, String(nombre).trim(), descripcion || null]
    );
    if (v.urls && v.urls.length) await guardarImagenes(client, rows[0].id, v.urls);
    return rows[0].id;
  });
  await registrar(req.usuario.id, 'zona.crear', `Creó la zona "${String(nombre).trim()}" en el grupo "${g.nombre}"`);
  res.status(201).json(await cargarZona(id));
}));

module.exports = router;