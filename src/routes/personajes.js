const router = require('express').Router();
const db = require('../db');
const { asyncH, puedeAccederGrupo, puedeModerar, registrar } = require('../utils');
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

// Carga el personaje y exige ser administrador o moderador de su grupo
const moderador = asyncH(async (req, res, next) => {
  const p = await cargarPersonaje(Number(req.params.id));
  if (!p || (p.oculto && !req.usuario.es_administrador)) return res.status(404).json({ error: 'Personaje no encontrado' });
  if (!(await puedeModerar(req.usuario, p.id_grupo))) {
    return res.status(403).json({ error: 'Solo un administrador o un moderador del grupo puede hacer esto' });
  }
  next();
});

// GET /api/personajes/pendientes -> solicitudes por aprobar (administrador: todas; moderador: las de sus grupos)
router.get('/pendientes', verificarToken, asyncH(async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.id, p.nombre, p.descripcion, p.id_grupo, p.solicita_ingreso, g.nombre AS grupo,
            u.nombre AS universo_origen, j.nombre AS jugador, ${IMAGENES}
     FROM personaje p
     JOIN grupo_rol g ON g.id = p.id_grupo
     JOIN universo_origen u ON u.id = p.id_universo_origen
     JOIN usuario j ON j.id = p.id_jugador
     WHERE p.estado = 'pendiente' AND p.eliminado_en IS NULL AND g.eliminado_en IS NULL
       AND ($1::boolean OR EXISTS (SELECT 1 FROM miembro_grupo m
            WHERE m.id_usuario = $2 AND m.id_grupo = p.id_grupo AND m.rol = 'moderador'))
       AND ($1::boolean OR NOT p.oculto)
     ORDER BY p.id`,
    [req.usuario.es_administrador, req.usuario.id]
  );
  res.json(rows);
}));

// GET /api/personajes/:id (publico si esta aprobado; si no, solo su jugador o un administrador)
router.get('/:id', tokenOpcional, asyncH(async (req, res) => {
  const p = await cargarPersonaje(Number(req.params.id));
  const u = req.usuario;
  // Un personaje oculto solo lo ve un administrador
  const puedeVer = p && ((u && u.es_administrador) || (!p.oculto && (p.estado === 'aprobado' || (u && u.id === p.id_jugador))));
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
  // Quien no es miembro tambien puede crear: el personaje se envia junto con la solicitud para unirse al grupo
  const solicitaIngreso = !(await puedeAccederGrupo(req.usuario, idGrupo));
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
      `INSERT INTO personaje (nombre, descripcion, id_jugador, id_universo_origen, id_grupo, estado, solicita_ingreso)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      // Un administrador publica directo; un jugador queda pendiente de aprobacion
      [nombre, descripcion || null, jugador, id_universo_origen, idGrupo,
       req.usuario.es_administrador ? 'aprobado' : 'pendiente', solicitaIngreso]
    );
    if (v.urls && v.urls.length) await guardarImagenes(client, rows[0].id, v.urls);
    return rows[0].id;
  });
  await registrar(req.usuario.id, 'personaje.crear',
    `Creó el personaje "${nombre}" en el grupo "${g.rows[0].nombre}"` + (req.usuario.es_administrador ? '' : solicitaIngreso ? ' (pendiente de aprobación y solicita unirse al grupo)' : ' (pendiente de aprobación)'));
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
         motivo_rechazo = CASE WHEN $6::varchar IS NULL THEN motivo_rechazo ELSE NULL END,
         solicita_ingreso = CASE WHEN $6::varchar IS NULL THEN solicita_ingreso ELSE NOT EXISTS (
           SELECT 1 FROM miembro_grupo m WHERE m.id_usuario = personaje.id_jugador AND m.id_grupo = personaje.id_grupo) END
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
router.put('/:id/aprobar', verificarToken, moderador, asyncH(async (req, res) => {
  const p = await cargarPersonaje(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Personaje no encontrado' });
  await db.query("UPDATE personaje SET estado = 'aprobado', motivo_rechazo = NULL, solicita_ingreso = FALSE WHERE id = $1", [p.id]);
  await registrar(req.usuario.id, 'personaje.aprobar', `Aprobó el personaje "${p.nombre}" de ${p.jugador} en el grupo "${p.grupo}"`);
  // Si venia con solicitud para unirse al grupo, al aprobarlo el jugador pasa a ser miembro
  if (p.solicita_ingreso) {
    const { rowCount } = await db.query(
      `INSERT INTO miembro_grupo (id_usuario, id_grupo, agregado_por) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [p.id_jugador, p.id_grupo, req.usuario.id]
    );
    if (rowCount) {
      await registrar(req.usuario.id, 'miembro.agregar',
        `Agregó a ${p.jugador} al grupo "${p.grupo}" (solicitud enviada junto con su personaje)`);
    }
  }
  res.json(await cargarPersonaje(p.id));
}));

// PUT /api/personajes/:id/rechazar (solo administrador) body: { motivo }
router.put('/:id/rechazar', verificarToken, moderador, asyncH(async (req, res) => {
  const p = await cargarPersonaje(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Personaje no encontrado' });
  const motivo = (req.body.motivo || '').trim() || null;
  await db.query("UPDATE personaje SET estado = 'rechazado', motivo_rechazo = $2 WHERE id = $1", [p.id, motivo]);
  await registrar(req.usuario.id, 'personaje.rechazar',
    `Rechazó el personaje "${p.nombre}" de ${p.jugador} en el grupo "${p.grupo}"` + (motivo ? `. Motivo: ${motivo}` : ''));
  res.json(await cargarPersonaje(p.id));
}));

// PUT /api/personajes/:id/oculto (solo administrador) body: { oculto: true | false }
router.put('/:id/oculto', verificarToken, soloAdmin, asyncH(async (req, res) => {
  if (typeof req.body.oculto !== 'boolean') return res.status(400).json({ error: 'oculto debe ser true o false' });
  const p = await cargarPersonaje(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Personaje no encontrado' });
  await db.query('UPDATE personaje SET oculto = $1 WHERE id = $2', [req.body.oculto, p.id]);
  await registrar(req.usuario.id, req.body.oculto ? 'personaje.ocultar' : 'personaje.mostrar',
    `${req.body.oculto ? 'Ocultó' : 'Volvió a mostrar'} el personaje "${p.nombre}" del grupo "${p.grupo}"`);
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