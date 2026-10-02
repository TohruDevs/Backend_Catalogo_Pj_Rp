const router = require('express').Router();
const db = require('../db');
const { asyncH, registrar } = require('../utils');
const { verificarToken, soloAdmin } = require('../middleware/auth');

router.use(verificarToken, soloAdmin);

// GET /api/papelera -> grupos y personajes eliminados
router.get('/', asyncH(async (req, res) => {
  const grupos = await db.query(
    `SELECT g.id, g.nombre, g.descripcion, g.eliminado_en,
            (SELECT COUNT(*)::int FROM personaje p WHERE p.id_grupo = g.id) AS total_personajes
     FROM grupo_rol g WHERE g.eliminado_en IS NOT NULL ORDER BY g.eliminado_en DESC`
  );
  const personajes = await db.query(
    `SELECT p.id, p.nombre, p.eliminado_en, g.nombre AS grupo,
            (g.eliminado_en IS NOT NULL) AS grupo_eliminado, j.nombre AS jugador
     FROM personaje p
     JOIN grupo_rol g ON g.id = p.id_grupo
     JOIN usuario j ON j.id = p.id_jugador
     WHERE p.eliminado_en IS NOT NULL ORDER BY p.eliminado_en DESC`
  );
  res.json({ grupos: grupos.rows, personajes: personajes.rows });
}));

// PUT /api/papelera/grupos/:id/restaurar
router.put('/grupos/:id/restaurar', asyncH(async (req, res) => {
  const { rows } = await db.query(
    'UPDATE grupo_rol SET eliminado_en = NULL WHERE id = $1 AND eliminado_en IS NOT NULL RETURNING nombre',
    [Number(req.params.id)]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Grupo no encontrado en la papelera' });
  await registrar(req.usuario.id, 'grupo.restaurar', `Restauró el grupo "${rows[0].nombre}"`);
  res.json({ ok: true });
}));

// PUT /api/papelera/personajes/:id/restaurar
router.put('/personajes/:id/restaurar', asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db.query(
    `SELECT p.nombre, g.nombre AS grupo, (g.eliminado_en IS NOT NULL) AS grupo_eliminado
     FROM personaje p JOIN grupo_rol g ON g.id = p.id_grupo
     WHERE p.id = $1 AND p.eliminado_en IS NOT NULL`,
    [id]
  );
  const p = rows[0];
  if (!p) return res.status(404).json({ error: 'Personaje no encontrado en la papelera' });
  if (p.grupo_eliminado) return res.status(400).json({ error: `Restaura primero el grupo "${p.grupo}"` });
  await db.query('UPDATE personaje SET eliminado_en = NULL WHERE id = $1', [id]);
  await registrar(req.usuario.id, 'personaje.restaurar', `Restauró el personaje "${p.nombre}" del grupo "${p.grupo}"`);
  res.json({ ok: true });
}));

// DELETE /api/papelera/grupos/:id -> borrado definitivo (solo si ya esta en la papelera)
router.delete('/grupos/:id', asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const client = await db.connect();
  let nombre;
  try {
    await client.query('BEGIN');
    const g = await client.query('SELECT nombre FROM grupo_rol WHERE id = $1 AND eliminado_en IS NOT NULL', [id]);
    if (!g.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Grupo no encontrado en la papelera' });
    }
    nombre = g.rows[0].nombre;
    await client.query('DELETE FROM personaje WHERE id_grupo = $1', [id]);
    await client.query('DELETE FROM miembro_grupo WHERE id_grupo = $1', [id]);
    await client.query('DELETE FROM grupo_rol WHERE id = $1', [id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await registrar(req.usuario.id, 'grupo.borrar_definitivo', `Borró definitivamente el grupo "${nombre}"`);
  res.status(204).end();
}));

// DELETE /api/papelera/personajes/:id -> borrado definitivo
router.delete('/personajes/:id', asyncH(async (req, res) => {
  const { rows } = await db.query(
    'DELETE FROM personaje WHERE id = $1 AND eliminado_en IS NOT NULL RETURNING nombre',
    [Number(req.params.id)]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Personaje no encontrado en la papelera' });
  await registrar(req.usuario.id, 'personaje.borrar_definitivo', `Borró definitivamente el personaje "${rows[0].nombre}"`);
  res.status(204).end();
}));

module.exports = router;