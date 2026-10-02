-- =====================================================
-- Base de datos: catalogo de personajes para grupo de rol
-- Motor: PostgreSQL
-- =====================================================

-- Usuario (el Administrador es un usuario con es_administrador = TRUE)
CREATE TABLE usuario (
    id                SERIAL PRIMARY KEY,
    nombre            VARCHAR(100) NOT NULL,
    correo            VARCHAR(150) NOT NULL UNIQUE,
    contrasena_hash   VARCHAR(255) NOT NULL,
    es_administrador  BOOLEAN NOT NULL DEFAULT FALSE,
    fecha_registro    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Grupo de rol (pestana principal)
CREATE TABLE grupo_rol (
    id           SERIAL PRIMARY KEY,
    nombre       VARCHAR(100) NOT NULL,
    descripcion  TEXT,
    id_creador   INT NOT NULL REFERENCES usuario(id),
    fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Universo de origen de los personajes (Marvel, Star Wars, original, etc.)
CREATE TABLE universo_origen (
    id           SERIAL PRIMARY KEY,
    nombre       VARCHAR(100) NOT NULL UNIQUE,
    descripcion  TEXT
);

-- Personaje
CREATE TABLE personaje (
    id                  SERIAL PRIMARY KEY,
    nombre              VARCHAR(100) NOT NULL,
    descripcion         TEXT,
    imagen              VARCHAR(255),
    id_jugador          INT NOT NULL REFERENCES usuario(id),
    id_universo_origen  INT NOT NULL REFERENCES universo_origen(id),
    id_grupo            INT NOT NULL REFERENCES grupo_rol(id) ON DELETE CASCADE
);

-- Relacion muchos a muchos: un usuario puede estar en varios grupos
CREATE TABLE miembro_grupo (
    id_usuario     INT NOT NULL REFERENCES usuario(id) ON DELETE CASCADE,
    id_grupo       INT NOT NULL REFERENCES grupo_rol(id) ON DELETE CASCADE,
    agregado_por   INT NOT NULL REFERENCES usuario(id),
    fecha_ingreso  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id_usuario, id_grupo)
);

-- Indices para las consultas mas comunes
CREATE INDEX idx_personaje_grupo    ON personaje(id_grupo);
CREATE INDEX idx_personaje_universo ON personaje(id_universo_origen);
CREATE INDEX idx_personaje_jugador  ON personaje(id_jugador);

-- Regla: solo un administrador puede agregar usuarios a un grupo
CREATE OR REPLACE FUNCTION validar_agregado_por_admin()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM usuario
        WHERE id = NEW.agregado_por AND es_administrador = TRUE
    ) THEN
        RAISE EXCEPTION 'Solo un administrador puede agregar usuarios a un grupo';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_miembro_grupo_solo_admin
BEFORE INSERT ON miembro_grupo
FOR EACH ROW
EXECUTE FUNCTION validar_agregado_por_admin();

-- =====================================================
-- Datos de ejemplo (opcional)
-- =====================================================
-- Las contrasenas deben guardarse con hash (bcrypt, argon2, etc.)
INSERT INTO usuario (nombre, correo, contrasena_hash, es_administrador) VALUES
    ('Admin',  'admin@rol.com',  'HASH_ADMIN',  TRUE),
    ('Laura',  'laura@rol.com',  'HASH_LAURA',  FALSE),
    ('Carlos', 'carlos@rol.com', 'HASH_CARLOS', FALSE);

INSERT INTO grupo_rol (nombre, descripcion, id_creador) VALUES
    ('Campana principal', 'Grupo de rol de los viernes', 1);

INSERT INTO universo_origen (nombre, descripcion) VALUES
    ('Marvel', 'Universo de superheroes'),
    ('Star Wars', 'Galaxia muy, muy lejana'),
    ('Original', 'Personajes creados por los jugadores');

INSERT INTO miembro_grupo (id_usuario, id_grupo, agregado_por) VALUES
    (2, 1, 1),
    (3, 1, 1);

INSERT INTO personaje (nombre, descripcion, imagen, id_jugador, id_universo_origen, id_grupo) VALUES
    ('Spider-Man', 'El heroe trepamuros', NULL, 2, 1, 1),
    ('Ahsoka Tano', 'Antigua padawan de Anakin', NULL, 3, 2, 1);

-- Consulta de ejemplo: personajes de un grupo con su universo y jugador
-- SELECT p.nombre, u.nombre AS universo, j.nombre AS jugador
-- FROM personaje p
-- JOIN universo_origen u ON u.id = p.id_universo_origen
-- JOIN usuario j ON j.id = p.id_jugador
-- WHERE p.id_grupo = 1;
