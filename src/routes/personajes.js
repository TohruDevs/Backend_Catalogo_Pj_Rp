const router = require('express').Router();
const db = require('../db');
const { asyncH, puedeAccederGrupo, registrar } = require('../utils');
const { verificarToken, soloAdmin } = require('../middleware/auth');
const tokenOpcional = require('../middleware/tokenOpcional');

const IMAGENES = `COALESCE((SELECT json_agg(i.url ORDER BY i.orden, i.id)
                  FROM imagen_personaje i WHERE i.id_personaje = p.id), '[]'::json) AS imagenes`;

async function cargarPersonaje(id) {
  const { rows } = await db.query(
    `SELECT p.*, u.nombre AS universo_origen, j.nombre AS jugador, g.nombre AS grupo, ${IMAGENES}
     FROM personaje p
     JOIN universo_origen u ON u.id = p.id_universo_origen
     JOIN usuario j ON j.id = p.id_jugador
     JOIN grupo_rol g ON g.id = p.id_grupo AND g.eliminado_en IS NULL
     WHERE p.id = $1 AND p.eliminado_en IS NULL`,
    [id]
  );
  return rows[0];
}

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

async function guardarImagenes(client, idPersonaje, urls) {
  await client.query('DELETE FROM imagen_personaje WHERE id_personaje = $1', [idPersonaje]);
  if (urls.length) {
    await client.query(
      `INSERT INTO imagen_personaje (id_personaje, url, orden)
       SELECT $1, u, o - 1 FROM unnest($2::text[]) WITH ORDINALITY AS t(u, o)`,
      [idPersonaje, urls]
    );
  }
}

const esMiembro = (idUsuario, idGrupo) =>
  puedeAccederGrupo({ id: idUsuario, es_administrador: false }, idGrupo);

// GET /api/personajes/pendientes (solo administrador) -> solicitudes por aprobar
router.get('/pendientes', verificarToken, soloAdmin, asyncH(async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.id, p.nombre, p.descripcion, p.id_grupo, g.nombre AS grupo,
            u.nombre AS universo_origen, j.nombre AS jugador, ${IMAGENES}
     FROM personaje p
     JOIN grupo_rol g ON g.id = p.id_grupo
     JOIN universo_origen u ON u.id = p.id_universo_origen
     JOIN usuario j ON j.id = p.id_jugador
     WHERE p.estado = 'pendiente' AND p.eliminado_en IS NULL AND g.eliminado_en IS NULL
     ORDER BY p.id`
  );
  res.json(rows);
}));

// GET /api/personajes/:id (publico si esta aprobado; si no, solo su jugador o un administrador)
router.get('/:id', tokenOpcional, asyncH(async (req, res) => {
  const p = await cargarPersonaje(Number(req.params.id));
  const u = req.usuario;
  const puedeVer = p && (p.estado === 'aprobado' || (u && (u.es_administrador || u.id === p.id_jugador)));
  if (!puedeVer) return res.status(404).json({ error: 'Personaje no encontrado' });
  res.json(p);
}));

// POST /api/personajes  (un administrador puede enviar id_jugador para asignarlo a otro jugador)
router.post('/', verificarToken, asyncH(async (req, res) => {
  const { nombre, descripcion, imagenes, id_universo_origen, id_grupo, id_jugador } = req.body;
  if (!nombre || !id_universo_origen || !id_grupo) {
    return res.status(400).json({ error: 'nombre, id_universo_origen e id_grupo son obligatorios' });
  }
  const idGrupo = Number(id_grupo);
  if (!(await puedeAccederGrupo(req.usuario, idGrupo))) {
    return res.status(403).json({ error: 'No perteneces a este grupo' });
  }
  const g = await db.query('SELECT nombre FROM grupo_rol WHERE id = $1 AND eliminado_en IS NULL', [idGrupo]);
  if (!g.rows[0]) return res.status(404).json({ error: 'Grupo no encontrado' });
  const v = validarImagenes(imagenes);
  if (v.error) return res.status(400).json({ error: v.error });

  let jugador = req.usuario.id;
  if (id_jugador && Number(id_jugador) !== req.usuario.id) {
    if (!req.usuario.es_administrador) {
      return res.status(403).json({ error: 'Solo un administrador puede asignar personajes a otro jugador' });
    }
    if (!(await esMiembro(Number(id_jugador), idGrupo))) {
      return res.status(400).json({ error: 'El jugador debe ser miembro del grupo' });
    }
    jugador = Number(id_jugador);
  }

  const id = await conTransaccion(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO personaje (nombre, descripcion, id_jugador, id_universo_origen, id_grupo, estado)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      // Un administrador publica directo; un jugador queda pendiente de aprobacion
      [nombre, descripcion || null, jugador, id_universo_origen, idGrupo,
       req.usuario.es_administrador ? 'aprobado' : 'pendiente']
    );
    if (v.urls && v.urls.length) await guardarImagenes(client, rows[0].id, v.urls);
    return rows[0].id;
  });
  await registrar(req.usuario.id, 'personaje.crear',
    `Creó el personaje "${nombre}" en el grupo "${g.rows[0].nombre}"` + (req.usuario.es_administrador ? '' : ' (pendiente de aprobación)'));
  res.status(201).json(await cargarPersonaje(id));
}));

// PUT /api/personajes/:id  (dueno o administrador; solo el administrador puede cambiar id_jugador)
router.put('/:id', verificarToken, asyncH(async (req, res) => {
  const p = await cargarPersonaje(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Personaje no encontrado' });
  if (!(req.usuario.es_administrador || p.id_jugador === req.usuario.id)) {
    return res.status(403).json({ error: 'Solo el jugador dueno o un administrador pueden editarlo' });
  }
  const { nombre, descripcion, id_universo_origen, id_jugador, imagenes } = req.body;
  const v = validarImagenes(imagenes);
  if (v.error) return res.status(400).json({ error: v.error });

  let nuevoJugador = null;
  if (id_jugador && Number(id_jugador) !== p.id_jugador) {
    if (!req.usuario.es_administrador) {
      return res.status(403).json({ error: 'Solo un administrador puede reasignar el personaje' });
    }
    if (!(await esMiembro(Number(id_jugador), p.id_grupo))) {
      return res.status(400).json({ error: 'El jugador debe ser miembro del grupo' });
    }
    nuevoJugador = Number(id_jugador);
  }

  await conTransaccion(async (client) => {
    await client.query(
      `UPDATE personaje SET
         nombre = COALESCE($1, nombre),
         descripcion = COALESCE($2, descripcion),
         id_universo_origen = COALESCE($3, id_universo_origen),
         id_jugador = COALESCE($4, id_jugador),
         estado = COALESCE($6::varchar, estado),
         motivo_rechazo = CASE WHEN $6::varchar IS NULL THEN motivo_rechazo ELSE NULL END
       WHERE id = $5`,
      // Si edita un jugador (no administrador), vuelve a quedar pendiente de aprobacion
      [nombre, descripcion, id_universo_origen, nuevoJugador, p.id,
       req.usuario.es_administrador ? null : 'pendiente']
    );
    if (v.urls !== undefined) await guardarImagenes(client, p.id, v.urls);
  });
  const nj = nuevoJugador ? (await db.query('SELECT nombre FROM usuario WHERE id = $1', [nuevoJugador])).rows[0] : null;
  await registrar(req.usuario.id, 'personaje.editar',
    `Editó el personaje "${p.nombre}" del grupo "${p.grupo}"` + (nj ? ` y lo asignó a ${nj.nombre}` : ''));
  res.json(await cargarPersonaje(p.id));
}));

// PUT /api/personajes/:id/aprobar (solo administrador)
router.put('/:id/aprobar', verificarToken, soloAdmin, asyncH(async (req, res) => {
  const p = await cargarPersonaje(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Personaje no encontrado' });
  await db.query("UPDATE personaje SET estado = 'aprobado', motivo_rechazo = NULL WHERE id = $1", [p.id]);
  await registrar(req.usuario.id, 'personaje.aprobar', `Aprobó el personaje "${p.nombre}" de ${p.jugador} en el grupo "${p.grupo}"`);
  res.json(await cargarPersonaje(p.id));
}));

// PUT /api/personajes/:id/rechazar (solo administrador) body: { motivo }
router.put('/:id/rechazar', verificarToken, soloAdmin, asyncH(async (req, res) => {
  const p = await cargarPersonaje(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Personaje no encontrado' });
  const motivo = (req.body.motivo || '').trim() || null;
  await db.query("UPDATE personaje SET estado = 'rechazado', motivo_rechazo = $2 WHERE id = $1", [p.id, motivo]);
  await registrar(req.usuario.id, 'personaje.rechazar',
    `Rechazó el personaje "${p.nombre}" de ${p.jugador} en el grupo "${p.grupo}"` + (motivo ? `. Motivo: ${motivo}` : ''));
  res.json(await cargarPersonaje(p.id));
}));

// DELETE /api/personajes/:id
router.delete('/:id', verificarToken, asyncH(async (req, res) => {
  const p = await cargarPersonaje(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Personaje no encontrado' });
  if (!(req.usuario.es_administrador || p.id_jugador === req.usuario.id)) {
    return res.status(403).json({ error: 'Solo el jugador dueno o un administrador pueden eliminarlo' });
  }
  await db.query('UPDATE personaje SET eliminado_en = NOW() WHERE id = $1', [p.id]);
  await registrar(req.usuario.id, 'personaje.eliminar', `Envió a la papelera el personaje "${p.nombre}" del grupo "${p.grupo}"`);
  res.status(204).end();
}));

module.exports = router;