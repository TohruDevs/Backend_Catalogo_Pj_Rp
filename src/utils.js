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

module.exports = { asyncH, puedeAccederGrupo };
