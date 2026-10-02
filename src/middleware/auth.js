const jwt = require('jsonwebtoken');
const db = require('../db');
const { asyncH } = require('../utils');

// Valida el token y carga el usuario actual desde la base de datos
const verificarToken = asyncH(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token invalido o expirado' });
  }

  const { rows } = await db.query(
    'SELECT id, nombre, correo, es_administrador FROM usuario WHERE id = $1',
    [payload.id]
  );
  if (!rows[0]) return res.status(401).json({ error: 'Usuario no existe' });

  req.usuario = rows[0];
  next();
});

const soloAdmin = (req, res, next) => {
  if (!req.usuario.es_administrador) {
    return res.status(403).json({ error: 'Solo un administrador puede hacer esto' });
  }
  next();
};

module.exports = { verificarToken, soloAdmin };
