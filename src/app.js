require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/grupos', require('./routes/grupos'));
app.use('/api/usuarios', require('./routes/usuarios'));
app.use('/api/papelera', require('./routes/papelera'));
app.use('/api/historial', require('./routes/historial'));
app.use('/api/universos', require('./routes/universos'));
app.use('/api/personajes', require('./routes/personajes'));

// Manejo de errores: traduce los errores mas comunes de PostgreSQL
app.use((err, req, res, next) => {
  if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un registro con esos datos' });
  if (err.code === '23503') return res.status(400).json({ error: 'Referencia invalida (usuario, grupo o universo no existe)' });
  if (err.code === '22P02') return res.status(400).json({ error: 'Parametro con formato invalido' });
  if (err.message && err.message.includes('administrador')) return res.status(403).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));