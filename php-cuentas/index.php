<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');

const INVITATION_TTL_MS = 86400000;
const SESSION_TTL_MS = 28800000;
const MAX_PHOTO_BYTES = 524288;
const MAX_PASSWORD_BYTES = 256;

function respond(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function failRequest(string $message, int $status = 400): never
{
    throw new DomainException($message, $status);
}

function database(): PDO
{
    static $database = null;
    if ($database instanceof PDO) {
        return $database;
    }

    $path = getenv('CUENTAS_DB') ?: '/var/lib/swatt-cuentas/cuentas.sqlite';
    $database = new PDO('sqlite:' . $path, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    $database->exec('PRAGMA busy_timeout = 3000');
    $database->exec('PRAGMA journal_mode = WAL');
    $database->exec('PRAGMA foreign_keys = ON');
    $database->exec(
        'CREATE TABLE IF NOT EXISTS usuarios (
            id TEXT PRIMARY KEY,
            usuario TEXT NOT NULL COLLATE NOCASE UNIQUE,
            nombre TEXT NOT NULL,
            rol TEXT NOT NULL CHECK (rol IN ("administrador", "operador")),
            hash_contrasena TEXT NOT NULL,
            foto_perfil TEXT,
            creado_en INTEGER NOT NULL
        )'
    );
    $database->exec(
        'CREATE TABLE IF NOT EXISTS invitaciones (
            hash_token TEXT PRIMARY KEY,
            usuario TEXT NOT NULL COLLATE NOCASE UNIQUE,
            rol TEXT NOT NULL CHECK (rol IN ("administrador", "operador")),
            vence_en INTEGER NOT NULL
        )'
    );
    $database->exec(
        'CREATE TABLE IF NOT EXISTS sesiones (
            hash_token TEXT PRIMARY KEY,
            usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
            vence_en INTEGER NOT NULL
        )'
    );
    $database->exec('CREATE TABLE IF NOT EXISTS metadatos (clave TEXT PRIMARY KEY, valor TEXT NOT NULL)');
    return $database;
}

function migrarCuentas(PDO $database, mixed $datos): void
{
    $marcador = $database->query("SELECT valor FROM metadatos WHERE clave = 'migracion_json_v1'");
    if ($marcador->fetchColumn() !== false) {
        crearAdministradorInicial($database);
        return;
    }
    $database->beginTransaction();
    try {
        if ($datos !== null) {
            if (!is_array($datos) || !is_array($datos['usuarios'] ?? null) || !is_array($datos['invitaciones'] ?? null)) {
                throw new RuntimeException('El archivo anterior de cuentas no tiene un formato válido.');
            }
            $insertarUsuario = $database->prepare(
                'INSERT OR IGNORE INTO usuarios (id, usuario, nombre, rol, hash_contrasena, foto_perfil, creado_en)
                 VALUES (:id, :usuario, :nombre, :rol, :hash, :foto, :creado)'
            );
            foreach ($datos['usuarios'] as $usuario) {
                if (
                    !is_array($usuario)
                    || !isset($usuario['id'], $usuario['usuario'], $usuario['nombre'], $usuario['rol'], $usuario['hashContrasena'])
                    || !preg_match('/^[a-f0-9]{32}$/i', (string) $usuario['id'])
                    || !preg_match('/^[a-zA-Z0-9_.-]{1,32}$/', (string) $usuario['usuario'])
                    || !is_string($usuario['nombre'])
                    || !in_array($usuario['rol'], ['administrador', 'operador'], true)
                    || !is_string($usuario['hashContrasena'])
                    || strlen($usuario['hashContrasena']) > 512
                ) {
                    throw new RuntimeException('El archivo anterior contiene una cuenta inválida.');
                }
                $insertarUsuario->execute([
                    ':id' => $usuario['id'],
                    ':usuario' => $usuario['usuario'],
                    ':nombre' => $usuario['nombre'],
                    ':rol' => $usuario['rol'],
                    ':hash' => $usuario['hashContrasena'],
                    ':foto' => validarFoto($usuario['fotoPerfil'] ?? null),
                    ':creado' => $usuario['creadoEn'] ?? (int) floor(microtime(true) * 1000),
                ]);
            }
            $insertarInvitacion = $database->prepare(
                'INSERT OR IGNORE INTO invitaciones (hash_token, usuario, rol, vence_en)
                 VALUES (:hash, :usuario, :rol, :vence)'
            );
            foreach ($datos['invitaciones'] as $invitacion) {
                if (
                    !is_array($invitacion)
                    || !isset($invitacion['hashToken'], $invitacion['usuario'], $invitacion['rol'], $invitacion['venceEn'])
                    || !preg_match('/^[a-f0-9]{64}$/i', (string) $invitacion['hashToken'])
                    || !preg_match('/^[a-zA-Z0-9_.-]{1,32}$/', (string) $invitacion['usuario'])
                    || !in_array($invitacion['rol'], ['administrador', 'operador'], true)
                    || !is_numeric($invitacion['venceEn'])
                ) {
                    throw new RuntimeException('El archivo anterior contiene una invitación inválida.');
                }
                $insertarInvitacion->execute([
                    ':hash' => $invitacion['hashToken'],
                    ':usuario' => $invitacion['usuario'],
                    ':rol' => $invitacion['rol'],
                    ':vence' => $invitacion['venceEn'],
                ]);
            }
        }
        crearAdministradorInicial($database);
        $database->exec("INSERT OR REPLACE INTO metadatos (clave, valor) VALUES ('migracion_json_v1', 'completa')");
        $database->commit();
    } catch (Throwable $error) {
        if ($database->inTransaction()) {
            $database->rollBack();
        }
        throw $error;
    }
}

function crearAdministradorInicial(PDO $database): void
{
    $administrador = getenv('ADMIN_USERNAME') ?: '';
    $hash = getenv('ADMIN_PASSWORD_HASH') ?: '';
    if ($administrador !== '' && $hash !== '') {
        $insertar = $database->prepare(
            'INSERT OR IGNORE INTO usuarios (id, usuario, nombre, rol, hash_contrasena, creado_en)
             VALUES (:id, :usuario, :nombre, "administrador", :hash, :creado)'
        );
        $insertar->execute([
            ':id' => bin2hex(random_bytes(16)),
            ':usuario' => $administrador,
            ':nombre' => $administrador,
            ':hash' => $hash,
            ':creado' => (int) floor(microtime(true) * 1000),
        ]);
    }
}

function obtenerUsuario(PDO $database, string $usuario): ?array
{
    $consulta = $database->prepare(
        'SELECT id, usuario, nombre, rol, hash_contrasena, foto_perfil, creado_en
         FROM usuarios WHERE usuario = :usuario COLLATE NOCASE'
    );
    $consulta->execute([':usuario' => $usuario]);
    $resultado = $consulta->fetch();
    return $resultado === false ? null : $resultado;
}

function resumenUsuario(array $usuario): array
{
    return [
        'id' => $usuario['id'],
        'usuario' => $usuario['usuario'],
        'nombre' => $usuario['nombre'],
        'rol' => $usuario['rol'],
        'fotoPerfil' => $usuario['foto_perfil'] ?? null,
        'creadoEn' => (int) $usuario['creado_en'],
    ];
}

function validarUsuario(string $usuario): string
{
    $usuario = trim($usuario);
    if (!preg_match('/^[a-zA-Z0-9_.-]{1,32}$/', $usuario)) {
        failRequest('El usuario debe tener entre 1 y 32 caracteres válidos.');
    }
    return $usuario;
}

function validarFoto(mixed $foto): ?string
{
    if ($foto === null) {
        return null;
    }
    if (!is_string($foto) || strlen($foto) > (int) ceil(MAX_PHOTO_BYTES * 4 / 3) + 64) {
        failRequest('La foto debe ser PNG, JPEG o WebP de hasta 512 KiB.');
    }
    if (!preg_match('/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+\/]+={0,2})$/', $foto, $parts)) {
        failRequest('La foto debe ser PNG, JPEG o WebP de hasta 512 KiB.');
    }
    $bytes = base64_decode($parts[2], true);
    if ($bytes === false || strlen($bytes) > MAX_PHOTO_BYTES || base64_encode($bytes) !== $parts[2]) {
        failRequest('La foto debe ser PNG, JPEG o WebP de hasta 512 KiB.');
    }
    $signature = match ($parts[1]) {
        'png' => str_starts_with($bytes, "\x89PNG\r\n\x1a\n"),
        'jpeg' => str_starts_with($bytes, "\xff\xd8\xff"),
        'webp' => strlen($bytes) >= 12 && substr($bytes, 0, 4) === 'RIFF' && substr($bytes, 8, 4) === 'WEBP',
    };
    if (!$signature) {
        failRequest('El contenido no coincide con el formato de imagen indicado.');
    }
    return $foto;
}

function contrasenaHash(string $contrasena): string
{
    $algoritmo = defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT;
    $hash = password_hash($contrasena, $algoritmo);
    if (!is_string($hash)) {
        throw new RuntimeException('No se pudo generar el hash de contraseña.');
    }
    return $hash;
}

function cuentaPorId(PDO $database, string $id): ?array
{
    $consulta = $database->prepare(
        'SELECT id, usuario, nombre, rol, hash_contrasena, foto_perfil, creado_en FROM usuarios WHERE id = :id'
    );
    $consulta->execute([':id' => $id]);
    $usuario = $consulta->fetch();
    return $usuario === false ? null : $usuario;
}

function insertarSesion(PDO $database, string $id, int $ahora): array
{
    $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    $vence = $ahora + SESSION_TTL_MS;
    $limpiar = $database->prepare('DELETE FROM sesiones WHERE vence_en <= :ahora');
    $limpiar->execute([':ahora' => $ahora]);
    $insertar = $database->prepare(
        'INSERT INTO sesiones (hash_token, usuario_id, vence_en) VALUES (:hash, :id, :vence)'
    );
    $insertar->execute([':hash' => hash('sha256', $token), ':id' => $id, ':vence' => $vence]);
    return ['token' => $token, 'venceEn' => $vence];
}

function ejecutar(array $entrada): array
{
    $database = database();
    $accion = $entrada['accion'] ?? '';
    $ahora = (int) floor(microtime(true) * 1000);

    switch ($accion) {
        case 'iniciar_sesion': {
            $usuario = is_string($entrada['usuario'] ?? null) ? $entrada['usuario'] : '';
            $contrasena = is_string($entrada['contrasena'] ?? null) ? $entrada['contrasena'] : '';
            if (strlen($usuario) > 32 || strlen($contrasena) > MAX_PASSWORD_BYTES) {
                return ['correcto' => false];
            }
            $database->exec('BEGIN IMMEDIATE');
            try {
                $cuenta = obtenerUsuario($database, $usuario);
                if ($cuenta === null) {
                    $database->exec('ROLLBACK');
                    password_verify($contrasena, password_hash(random_bytes(16), PASSWORD_DEFAULT));
                    return ['correcto' => false];
                }
                if (str_starts_with($cuenta['hash_contrasena'], 'scrypt:')) {
                    $database->exec('ROLLBACK');
                    return [
                        'correcto' => false,
                        'hashLegado' => $cuenta['hash_contrasena'],
                        'cuenta' => resumenUsuario($cuenta),
                    ];
                }
                if (!password_verify($contrasena, $cuenta['hash_contrasena'])) {
                    $database->exec('ROLLBACK');
                    return ['correcto' => false];
                }
                $sesion = insertarSesion($database, $cuenta['id'], $ahora);
                $database->exec('COMMIT');
                return [
                    'correcto' => true,
                    'cuenta' => resumenUsuario($cuenta),
                    'tokenSesion' => $sesion['token'],
                    'venceEn' => $sesion['venceEn'],
                ];
            } catch (Throwable $error) {
                try {
                    $database->exec('ROLLBACK');
                } catch (Throwable) {
                }
                throw $error;
            }
        }

        case 'crear_sesion': {
            $id = (string) ($entrada['id'] ?? '');
            $cuenta = cuentaPorId($database, $id);
            if ($cuenta === null) {
                failRequest('La cuenta ya no existe.', 401);
            }
            return insertarSesion($database, $id, $ahora);
        }

        case 'obtener_sesion': {
            $token = (string) ($entrada['token'] ?? '');
            if (!preg_match('/^[A-Za-z0-9_-]{43}$/', $token)) {
                return ['sesion' => null];
            }
            $consulta = $database->prepare(
                'SELECT u.id, u.usuario, u.nombre, u.rol, u.foto_perfil, s.vence_en
                 FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
                 WHERE s.hash_token = :hash AND s.vence_en > :ahora'
            );
            $consulta->execute([':hash' => hash('sha256', $token), ':ahora' => $ahora]);
            $sesion = $consulta->fetch();
            if ($sesion === false) {
                return ['sesion' => null];
            }
            return ['sesion' => [
                'id' => $sesion['id'],
                'usuario' => $sesion['usuario'],
                'nombre' => $sesion['nombre'],
                'rol' => $sesion['rol'],
                ...(($entrada['incluirFoto'] ?? false) === true ? ['fotoPerfil' => $sesion['foto_perfil']] : []),
                'expira' => (int) $sesion['vence_en'],
            ]];
        }

        case 'cerrar_sesion': {
            $token = (string) ($entrada['token'] ?? '');
            if (preg_match('/^[A-Za-z0-9_-]{43}$/', $token)) {
                $eliminar = $database->prepare('DELETE FROM sesiones WHERE hash_token = :hash');
                $eliminar->execute([':hash' => hash('sha256', $token)]);
            }
            return ['correcto' => true];
        }

        case 'migrar_hash_legado': {
            $database->exec('BEGIN IMMEDIATE');
            try {
                $cuenta = cuentaPorId($database, (string) ($entrada['id'] ?? ''));
                if ($cuenta === null) {
                    $database->exec('ROLLBACK');
                    return ['correcto' => false];
                }
                if (!str_starts_with($cuenta['hash_contrasena'], 'scrypt:')) {
                    if (!password_verify((string) ($entrada['contrasena'] ?? ''), $cuenta['hash_contrasena'])) {
                        $database->exec('ROLLBACK');
                        return ['correcto' => false];
                    }
                    $sesion = insertarSesion($database, $cuenta['id'], $ahora);
                    $database->exec('COMMIT');
                    return [
                        'correcto' => true,
                        'tokenSesion' => $sesion['token'],
                        'venceEn' => $sesion['venceEn'],
                    ];
                }
                $actualizar = $database->prepare('UPDATE usuarios SET hash_contrasena = :hash WHERE id = :id AND hash_contrasena = :anterior');
                $actualizar->execute([
                    ':hash' => contrasenaHash((string) ($entrada['contrasena'] ?? '')),
                    ':id' => $cuenta['id'],
                    ':anterior' => $cuenta['hash_contrasena'],
                ]);
                if ($actualizar->rowCount() !== 1) {
                    $database->exec('ROLLBACK');
                    return ['correcto' => false];
                }
                $sesion = insertarSesion($database, $cuenta['id'], $ahora);
                $database->exec('COMMIT');
                return [
                    'correcto' => true,
                    'tokenSesion' => $sesion['token'],
                    'venceEn' => $sesion['venceEn'],
                ];
            } catch (Throwable $error) {
                try {
                    $database->exec('ROLLBACK');
                } catch (Throwable) {
                }
                throw $error;
            }
        }

        case 'crear_invitacion': {
            $usuario = validarUsuario((string) ($entrada['usuario'] ?? ''));
            $rol = $entrada['rol'] ?? 'operador';
            if (!in_array($rol, ['administrador', 'operador'], true)) {
                failRequest('Selecciona un rol válido para la invitación.');
            }
            $limpiar = $database->prepare('DELETE FROM invitaciones WHERE vence_en <= :ahora');
            $limpiar->execute([':ahora' => $ahora]);
            if (obtenerUsuario($database, $usuario) !== null) {
                failRequest('Ya existe una cuenta con ese nombre.');
            }
            $pendiente = $database->prepare('SELECT 1 FROM invitaciones WHERE usuario = :usuario COLLATE NOCASE AND vence_en > :ahora');
            $pendiente->execute([':usuario' => $usuario, ':ahora' => $ahora]);
            if ($pendiente->fetchColumn() !== false) {
                failRequest('Ya existe una invitación pendiente para ese nombre.');
            }
            $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
            $insertar = $database->prepare(
                'INSERT INTO invitaciones (hash_token, usuario, rol, vence_en) VALUES (:hash, :usuario, :rol, :vence)'
            );
            $insertar->execute([
                ':hash' => hash('sha256', $token),
                ':usuario' => $usuario,
                ':rol' => $rol,
                ':vence' => $ahora + INVITATION_TTL_MS,
            ]);
            return ['token' => $token, 'usuario' => $usuario, 'rol' => $rol, 'venceEn' => $ahora + INVITATION_TTL_MS];
        }

        case 'consultar_invitacion': {
            $token = (string) ($entrada['token'] ?? '');
            if (!preg_match('/^[A-Za-z0-9_-]{43}$/', $token)) {
                return ['invitacion' => null];
            }
            $consulta = $database->prepare(
                'SELECT usuario, rol, vence_en FROM invitaciones WHERE hash_token = :hash AND vence_en > :ahora'
            );
            $consulta->execute([':hash' => hash('sha256', $token), ':ahora' => $ahora]);
            $invitacion = $consulta->fetch();
            return ['invitacion' => $invitacion === false ? null : [
                'usuario' => $invitacion['usuario'],
                'rol' => $invitacion['rol'],
                'venceEn' => (int) $invitacion['vence_en'],
            ]];
        }

        case 'aceptar_invitacion': {
            $token = (string) ($entrada['token'] ?? '');
            $nombre = $entrada['nombre'] ?? null;
            $contrasena = $entrada['contrasena'] ?? null;
            if (!preg_match('/^[A-Za-z0-9_-]{43}$/', $token)) {
                failRequest('La invitación no es válida o ya venció.');
            }
            if (!is_string($nombre) || mb_strlen(trim($nombre), 'UTF-8') < 2 || mb_strlen(trim($nombre), 'UTF-8') > 60) {
                failRequest('El nombre visible debe tener entre 2 y 60 caracteres.');
            }
            if (!is_string($contrasena) || strlen($contrasena) < 14 || strlen($contrasena) > MAX_PASSWORD_BYTES) {
                failRequest('La contraseña debe tener entre 14 y 256 caracteres.');
            }
            $database->exec('BEGIN IMMEDIATE');
            try {
                $consulta = $database->prepare(
                    'SELECT usuario, rol FROM invitaciones WHERE hash_token = :hash AND vence_en > :ahora'
                );
                $consulta->execute([':hash' => hash('sha256', $token), ':ahora' => $ahora]);
                $invitacion = $consulta->fetch();
                if ($invitacion === false) {
                    failRequest('La invitación no es válida o ya venció.');
                }
                $eliminar = $database->prepare('DELETE FROM invitaciones WHERE hash_token = :hash');
                $eliminar->execute([':hash' => hash('sha256', $token)]);
                $insertar = $database->prepare(
                    'INSERT INTO usuarios (id, usuario, nombre, rol, hash_contrasena, creado_en)
                     VALUES (:id, :usuario, :nombre, :rol, :hash, :creado)'
                );
                $cuenta = [
                    'id' => bin2hex(random_bytes(16)),
                    'usuario' => $invitacion['usuario'],
                    'nombre' => trim($nombre),
                    'rol' => $invitacion['rol'],
                    'hash_contrasena' => contrasenaHash($contrasena),
                    'creado_en' => $ahora,
                ];
                $insertar->execute([
                    ':id' => $cuenta['id'],
                    ':usuario' => $cuenta['usuario'],
                    ':nombre' => $cuenta['nombre'],
                    ':rol' => $cuenta['rol'],
                    ':hash' => $cuenta['hash_contrasena'],
                    ':creado' => $ahora,
                ]);
                $sesion = insertarSesion($database, $cuenta['id'], $ahora);
                $database->exec('COMMIT');
                return [
                    'cuenta' => [
                        ...resumenUsuario($cuenta),
                        'tokenSesion' => $sesion['token'],
                        'expira' => $sesion['venceEn'],
                    ],
                ];
            } catch (Throwable $error) {
                try {
                    $database->exec('ROLLBACK');
                } catch (Throwable) {
                }
                throw $error;
            }
        }

        case 'actualizar_perfil': {
            $id = (string) ($entrada['id'] ?? '');
            $database->exec('BEGIN IMMEDIATE');
            try {
                $cuenta = cuentaPorId($database, $id);
                if ($cuenta === null) {
                    failRequest('La cuenta ya no existe.');
                }
                $nombre = $entrada['nombre'] ?? null;
                if (!is_string($nombre) || mb_strlen(trim($nombre), 'UTF-8') < 2 || mb_strlen(trim($nombre), 'UTF-8') > 60) {
                    failRequest('El nombre visible debe tener entre 2 y 60 caracteres.');
                }
                $nueva = $entrada['nuevaContrasena'] ?? '';
                $cambio = is_string($nueva) && $nueva !== '';
                if ($cambio) {
                    $actual = $entrada['contrasenaActual'] ?? '';
                    if (str_starts_with($cuenta['hash_contrasena'], 'scrypt:')) {
                        if (($entrada['hashLegadoVerificado'] ?? false) !== true) {
                            $database->exec('ROLLBACK');
                            return ['hashLegado' => $cuenta['hash_contrasena']];
                        }
                    } elseif (!is_string($actual) || !password_verify($actual, $cuenta['hash_contrasena'])) {
                        failRequest('La contraseña actual no coincide.');
                    }
                    if (!is_string($nueva) || strlen($nueva) < 14 || strlen($nueva) > MAX_PASSWORD_BYTES) {
                        failRequest('La nueva contraseña debe tener entre 14 y 256 caracteres.');
                    }
                }
                $foto = array_key_exists('fotoPerfil', $entrada) ? validarFoto($entrada['fotoPerfil']) : $cuenta['foto_perfil'];
                $hash = $cambio ? contrasenaHash($nueva) : $cuenta['hash_contrasena'];
                $actualizar = $database->prepare(
                    'UPDATE usuarios SET nombre = :nombre, foto_perfil = :foto, hash_contrasena = :hash WHERE id = :id'
                );
                $actualizar->execute([':nombre' => trim($nombre), ':foto' => $foto, ':hash' => $hash, ':id' => $id]);
                if ($cambio) {
                    $revocar = $database->prepare('DELETE FROM sesiones WHERE usuario_id = :id');
                    $revocar->execute([':id' => $id]);
                }
                $actualizada = cuentaPorId($database, $id);
                $database->exec('COMMIT');
                return ['cuenta' => resumenUsuario($actualizada), 'cambioContrasena' => $cambio];
            } catch (Throwable $error) {
                try {
                    $database->exec('ROLLBACK');
                } catch (Throwable) {
                }
                throw $error;
            }
        }

        case 'listar_usuarios': {
            $usuarios = $database->query(
                'SELECT id, usuario, nombre, rol, creado_en FROM usuarios ORDER BY creado_en, usuario'
            )->fetchAll();
            return ['usuarios' => array_map(static fn(array $usuario): array => [
                'id' => $usuario['id'],
                'usuario' => $usuario['usuario'],
                'nombre' => $usuario['nombre'],
                'rol' => $usuario['rol'],
                'creadoEn' => (int) $usuario['creado_en'],
            ], $usuarios)];
        }

        case 'listar_invitaciones': {
            $consulta = $database->prepare(
                'SELECT usuario, rol, vence_en FROM invitaciones WHERE vence_en > :ahora ORDER BY vence_en'
            );
            $consulta->execute([':ahora' => $ahora]);
            return ['invitaciones' => array_map(static fn(array $invitacion): array => [
                'usuario' => $invitacion['usuario'],
                'rol' => $invitacion['rol'],
                'venceEn' => (int) $invitacion['vence_en'],
            ], $consulta->fetchAll())];
        }

        case 'revocar_invitacion': {
            $eliminar = $database->prepare('DELETE FROM invitaciones WHERE usuario = :usuario COLLATE NOCASE');
            $eliminar->execute([':usuario' => (string) ($entrada['usuario'] ?? '')]);
            if ($eliminar->rowCount() === 0) {
                failRequest('No hay una invitación pendiente para ese usuario.');
            }
            return ['correcto' => true];
        }

        case 'eliminar_usuario': {
            $id = (string) ($entrada['id'] ?? '');
            $actual = (string) ($entrada['usuarioActual'] ?? '');
            $database->exec('BEGIN IMMEDIATE');
            try {
                $cuenta = cuentaPorId($database, $id);
                if ($cuenta === null) {
                    failRequest('La cuenta solicitada no existe.');
                }
                if ($cuenta['usuario'] === $actual) {
                    failRequest('No puedes eliminar tu propia cuenta.');
                }
                if ($cuenta['rol'] === 'administrador') {
                    $administradores = $database->query("SELECT COUNT(*) FROM usuarios WHERE rol = 'administrador'")->fetchColumn();
                    if ((int) $administradores <= 1) {
                        failRequest('No se puede eliminar al último administrador.');
                    }
                }
                $eliminar = $database->prepare('DELETE FROM usuarios WHERE id = :id');
                $eliminar->execute([':id' => $id]);
                $borrarInvitacion = $database->prepare('DELETE FROM invitaciones WHERE usuario = :usuario COLLATE NOCASE');
                $borrarInvitacion->execute([':usuario' => $cuenta['usuario']]);
                $database->exec('COMMIT');
            } catch (Throwable $error) {
                try {
                    $database->exec('ROLLBACK');
                } catch (Throwable) {
                }
                throw $error;
            }
            return ['usuario' => $cuenta['usuario'], 'id' => $id];
        }

        case 'inicializar':
            migrarCuentas($database, $entrada['cuentasLegadas'] ?? null);
            return ['correcto' => true];

        case 'estado_migracion':
            return [
                'completa' => $database->query(
                    "SELECT 1 FROM metadatos WHERE clave = 'migracion_json_v1'"
                )->fetchColumn() !== false,
            ];

        default:
            failRequest('Acción no permitida.', 404);
    }
}

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET' && parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) === '/health') {
    try {
        database();
        respond(200, ['estado' => 'correcto']);
    } catch (Throwable) {
        respond(503, ['error' => 'base_datos_no_disponible']);
    }
}

$secreto = getenv('CUENTAS_API_SECRETO') ?: '';
$recibido = $_SERVER['HTTP_X_CUENTAS_API_SECRETO'] ?? '';
if ($secreto === '' || !hash_equals($secreto, $recibido)) {
    respond(403, ['error' => 'no_autorizado']);
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    respond(405, ['error' => 'metodo_no_permitido']);
}
if (!preg_match('/^application\/json(?:\s*;|$)/i', $_SERVER['CONTENT_TYPE'] ?? '')) {
    respond(415, ['error' => 'tipo_contenido_no_permitido']);
}
if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 20971520) {
    respond(413, ['error' => 'solicitud_demasiado_grande']);
}
$cuerpo = file_get_contents('php://input', false, null, 0, 20971521);
if ($cuerpo !== false && strlen($cuerpo) > 20971520) {
    respond(413, ['error' => 'solicitud_demasiado_grande']);
}
try {
    $entrada = json_decode($cuerpo === false ? '' : $cuerpo, true, 32, JSON_THROW_ON_ERROR);
    if (!is_array($entrada)) {
        respond(400, ['error' => 'json_invalido']);
    }
    respond(200, ejecutar($entrada));
} catch (DomainException $error) {
    respond((int) $error->getCode() ?: 400, ['error' => 'solicitud_rechazada', 'mensaje' => $error->getMessage()]);
} catch (JsonException) {
    respond(400, ['error' => 'json_invalido']);
} catch (Throwable $error) {
    error_log('Falló una operación interna del servicio de cuentas: ' . $error->getMessage());
    respond(503, ['error' => 'cuentas_no_disponibles']);
}
