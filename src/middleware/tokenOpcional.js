const jwt = require('jsonwebtoken');
const db = require('../db');
const { asyncH } = require('../utils');

// Si hay un token valido carga req.usuario; si no, sigue como visitante (req.usuario = null)
module.exports = asyncH(async (req, res, next) => {
  req.usuario = null;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const { id } = jwt.verify(token, process.env.JWT_SECRET);
      const { rows } = await db.query(
        'SELECT id, nombre, correo, es_administrador FROM usuario WHERE id = $1',
        [id]
      );
      req.usuario = rows[0] || null;
    } catch { /* token invalido: se trata como visitante */ }
  }
  next();
});