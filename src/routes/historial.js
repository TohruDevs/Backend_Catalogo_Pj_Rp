const router = require('express').Router();
const db = require('../db');
const { asyncH } = require('../utils');
const { verificarToken, soloAdmin } = require('../middleware/auth');

router.use(verificarToken, soloAdmin);

// GET /api/historial?tipo=grupo|personaje|miembro|usuario&antes=ID&limite=50
router.get('/', asyncH(async (req, res) => {
  const limite = Math.min(Number(req.query.limite) || 50, 200);
  const antes = req.query.antes ? Number(req.query.antes) : null;
  const tipo = ['grupo', 'personaje', 'miembro', 'usuario'].includes(req.query.tipo) ? req.query.tipo : null;
  const { rows } = await db.query(
    `SELECT h.id, h.accion, h.descripcion, h.fecha, u.nombre AS usuario
     FROM historial h LEFT JOIN usuario u ON u.id = h.id_usuario
     WHERE ($1::int IS NULL OR h.id < $1) AND ($2::text IS NULL OR h.accion LIKE $2 || '.%')
     ORDER BY h.id DESC LIMIT $3`,
    [antes, tipo, limite]
  );
  res.json(rows);
}));

module.exports = router;