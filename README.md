# Backend - Catalogo de personajes (Node.js + Express + PostgreSQL)

## Puesta en marcha
1. Crea la base de datos y ejecuta `catalogo_personajes.sql`.
2. `npm install`
3. Copia `.env.example` a `.env` y completa `DATABASE_URL` y `JWT_SECRET`.
4. `npm run dev`

## Primer administrador
El registro siempre crea usuarios normales. Registra tu usuario y conviertelo en administrador desde SQL:

    UPDATE usuario SET es_administrador = TRUE WHERE correo = 'tu@correo.com';

## Endpoints (todos menos registro y login requieren `Authorization: Bearer <token>`)
| Metodo | Ruta | Quien |
|---|---|---|
| POST | /api/auth/registro | publico |
| POST | /api/auth/login | publico |
| GET | /api/auth/me | autenticado |
| GET | /api/grupos | autenticado (admin ve todos) |
| POST | /api/grupos | admin |
| GET | /api/grupos/:id?universo=ID | miembro o admin (grupo + personajes) |
| GET | /api/grupos/:id/miembros | miembro o admin |
| POST | /api/grupos/:id/miembros | admin  `{ "id_usuario": 2 }` |
| DELETE | /api/grupos/:id/miembros/:idUsuario | admin |
| GET | /api/universos | autenticado |
| POST | /api/universos | autenticado |
| GET | /api/personajes/:id | miembro o admin |
| POST | /api/personajes | miembro o admin |
| PUT | /api/personajes/:id | jugador dueno o admin |
| DELETE | /api/personajes/:id | jugador dueno o admin |
