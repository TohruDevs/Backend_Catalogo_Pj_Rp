const db = require('./db');

// Permite usar async/await en las rutas sin try/catch en cada una
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Un administrador accede a todos los grupos; los demas solo a los suyos
async function puedeAccederGrupo(usuario, idGrupo) {
  if (usuario.es_administrador) return true;
  const { rowCount } = await db.query(
    'SELECT 1 FROM miembro_grupo WHERE id_usuario = $1 AND id_grupo = $2',
    [usuario.id, idGrupo]
  );
  return rowCount > 0;
}

// Guarda una accion en el historial (si falla, no rompe la operacion principal)
async function registrar(idUsuario, accion, descripcion) {
  try {
    await db.query(
      'INSERT INTO historial (id_usuario, accion, descripcion) VALUES ($1, $2, $3)',
      [idUsuario, accion, descripcion]
    );
  } catch (e) {
    console.error('No se pudo guardar en el historial:', e.message);
  }
}

// Administrador, o moderador de ese grupo
async function puedeModerar(usuario, idGrupo) {
  if (usuario.es_administrador) return true;
  const { rowCount } = await db.query(
    "SELECT 1 FROM miembro_grupo WHERE id_usuario = $1 AND id_grupo = $2 AND rol = 'moderador'",
    [usuario.id, idGrupo]
  );
  return rowCount > 0;
}

module.exports = { asyncH, puedeAccederGrupo, puedeModerar, registrar };